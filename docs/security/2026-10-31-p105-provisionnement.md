# P10.5 — Provisionnement : rôles, migrations, clé d'identité

Date : 2026-10-31 · Branche : `arena/96848462-tracefab`

Procédure exécutable par un opérateur autorisé, et **effectivement exécutée**
sur un cluster PostgreSQL 17.10 jetable pendant P10.5. Aucune étape ne demande
de secret à afficher : les valeurs passent par des variables d'environnement et
ne sont jamais relues en clair.

> Règle générale : tout ce qui suit est **idempotent** et **refuse de
> s'exécuter** si la cible n'est pas locale ou explicitement autorisée. Un
> refus n'est pas un incident ; c'est la garde qui fait son travail.

---

## 1. Le modèle de rôles (4 rôles, 3 fonctions distinctes)

| Rôle | LOGIN | SUPERUSER | BYPASSRLS | CREATEROLE | Appartenances | Rôle réel |
|---|---|---|---|---|---|---|
| `tracefab_app` | oui | non | non | non | **aucune** | runtime |
| `tracefab_migrator` | oui | non | **oui** (justifié) | oui | aucune hors fenêtre temporaire | migrations |
| `tracefab_worker` | non | non | non | non | — | propriétaire d'objets |
| `postgres` / propriétaire de branche | oui | oui | oui | oui | — | administration |

Trois points méritent d'être explicités, parce qu'ils sont contre-intuitifs :

- **`tracefab_migrator` porte BYPASSRLS**, et c'est mesuré comme nécessaire :
  les migrations écrivent dans `dpp_requirement_profiles`, qui est sous
  `FORCE ROW LEVEL SECURITY`. Sans BYPASSRLS, la migration échoue. Ce n'est pas
  une commodité, c'est une dépendance constatée.
- **`tracefab_app` n'a aucune appartenance.** C'est l'un des quatre blocages :
  une seule ligne dans `pg_auth_members` suffit à autoriser `SET ROLE`, donc à
  obtenir BYPASSRLS du rôle visé. P10.4 avait mesuré 0 → 4 produits visibles.
- **`tracefab_worker` est NOLOGIN.** Il possède des objets, il ne se connecte
  pas.
- **`tracefab_migrator` n'est jamais membre permanent de `tracefab_worker`.**
  Le runner accorde INHERIT/SET sans ADMIN uniquement pendant la chaîne, puis
  révoque et vérifie l'appartenance avant la garde terminale 20261108120700.

## 2. Séquence de référence (rejouée, 68/68)

```bash
# 0. base vierge (locale, jetable)
node /home/user/.work/reset_db.mjs

# 1. provisionner les rôles — exige une autorisation explicite
DATABASE_URL=postgresql://postgres@127.0.0.1:PORT/tf_p105 \
  TF_ALLOW_PROVISIONING=oui \
  TF_APP_PASSWORD=… TF_MIGRATOR_PASSWORD=… \
  node scripts/provisionner_roles_db.mjs

# 2. appliquer les migrations SOUS LE RÔLE DE MIGRATION
DATABASE_URL=postgresql://tracefab_migrator@127.0.0.1:PORT/tf_p105 \
  TF_ADMIN_URL=postgresql://postgres@127.0.0.1:PORT/tf_p105 \
  TF_ALLOW_ELEVATION=oui TF_ALLOW_WRITE=oui \
  node scripts/migrer_fidelement.mjs

# 3. provisionner la clé d'identité (jamais affichée)
DATABASE_URL=… TF_ALLOW_PROVISIONING=oui TF_IDENTITY_KEY_HEX=<64 hex> \
  node scripts/provisionner_cle_identite.mjs

# 4. vérifier, en lecture seule
node scripts/provisionner_cle_identite.mjs --verifier
node scripts/verifier_hierarchie_roles.mjs
node scripts/lire-disponibilite-role-app.mjs
```

Résultat historique mesuré de l'étape 2 : `68 migration(s) appliquee(s)`, puis,
en reprise, `68 deja appliquee(s)`, `0 en attente`. Le lot correctif ajoute une
garde terminale et des contrôles de sécurité du rôle migrateur.

### 2.1 L'élévation, bornée et refermée

`20261028120100_worker_identity_not_forgeable` exige un privilège que
`tracefab_migrator` n'a pas — et ne doit pas avoir en permanence. La liste des
migrations assistées est **fermée** (`scripts/lib/migrations_assistees.mjs`,
une seule entrée). Pour celle-ci et pour elle seule :

- `TF_ADMIN_URL` **et** `TF_ALLOW_ELEVATION=oui` sont requis, sinon sortie 3 ;
- l'élévation est temporaire, bornée à cette migration ;
- elle est **refermée** (`SUPERUSER` → `NOSUPERUSER`) puis **relue** dans
  `pg_roles` ; si la relecture ne confirme pas, sortie 1 ;
- après le bootstrap, le runner accorde temporairement `tracefab_worker` au
  rôle d'exécution avec `INHERIT TRUE, SET TRUE, ADMIN FALSE`, via la connexion
  administrative ; le rôle migrateur ne peut pas s'accorder ce droit lui-même ;
- l'appartenance est conservée uniquement pendant les migrations qui doivent
  remplacer des fonctions possédées par le worker ; elle est révoquée et
  vérifiée dans le catalogue avant `20261108120700`, puis revérifiée en fin de
  chaîne ;
- sur un échec de migration ou SIGINT/SIGTERM, le runner tente la révocation
  avant de sortir. SIGKILL ne peut pas être intercepté : une reprise reprend
  la chaîne et révoque avant la garde terminale. Si l'appartenance ne peut pas
  être révoquée, le runner s'arrête et ne valide pas la garde terminale.

Aucune migration historique n'a été réécrite pour obtenir ce résultat.

### 2.2 Garde terminale et reprise après interruption

La migration additive `20261108120700_assert_worker_membership_revoked` échoue
si `tracefab_migrator` peut encore endosser `tracefab_worker`. Le runner doit
révoquer cette appartenance avant de l'appliquer. Le contrôle porte sur
l'appartenance effective, pas seulement sur une entrée ACL directe.

Après SIGKILL ou perte brutale du processus, aucun gestionnaire Node ne peut
s'exécuter. L'appartenance peut donc rester présente jusqu'à la reprise suivante.
Le runner la détecte : si le bootstrap historique doit être rejoué, il nettoie
l'ancien octroi avant ce bootstrap ; sinon, il le conserve uniquement pour les
migrations restantes qui en dépendent, puis le révoque avant la garde terminale.
Une reprise ne doit jamais sauter cette garde.

### 2.3 La migration 68 et son point de rupture

`ALTER TABLE public.tracefab_identity_cles OWNER TO tracefab_worker` a échoué en
`42501 permission denied for schema public` : `tracefab_worker` **n'a pas**
`CREATE` sur `public`. Deux issues possibles : élargir les droits du worker, ou
ne pas transférer la propriété.

Décision : **la table reste au rôle de migration**, comme le registre runtime.
Ce qui protège la clé n'est pas son propriétaire mais (a) l'absence de tout
`GRANT` à `tracefab_app`, (b) `FORCE ROW LEVEL SECURITY` avec une politique
propriétaire-only, (c) l'usage exclusif par une fonction `SECURITY DEFINER` au
`search_path` figé. Élargir les droits du worker pour satisfaire une instruction
de confort aurait été exactement ce que la mission interdit. Le raisonnement est
écrit dans la migration, à l'endroit de l'instruction retirée.

## 3. Les refus, et ce qu'ils veulent dire

| Situation | Sortie | Message |
|---|---|---|
| clé absente ou < 64 hexadécimaux | 3 | `REFUS — TF_IDENTITY_KEY_HEX doit être au moins 64 caractères hexadécimaux` |
| provisioning sans `TF_ALLOW_PROVISIONING=oui` | 3 | refus explicite |
| migration assistée sans `TF_ADMIN_URL` | 3 | refus explicite |
| rôle préexistant non conforme (BYPASSRLS/SUPERUSER/…) | 1 | `RolePreexistantRefuse: … REFUSE : BYPASSRLS — aucune modification` |
| élévation non refermée à la relecture | 1 | sortie immédiate, aucune migration supplémentaire |
| `tracefab_app` tente de migrer | — | `42501 permission denied for schema public` |
| `tracefab_app` tente `SET ROLE` | — | `42501 permission denied to set role` |

`RolePreexistantRefuse` est une correction de P10.5 : `ensureAppRole` émettait
un `ALTER ROLE` même sur un rôle déjà conforme, c'est-à-dire **modifiait un rôle
qu'il n'avait pas à modifier**. Il se contente désormais de vérifier.

## 4. Reprise sur une base déjà migrée

Deux cas, et un seul est un vrai problème.

**Cas normal** — reprise : `migrer_fidelement.mjs` compare le disque au registre
et n'applique que ce qui manque. Mesuré : `68 deja appliquee(s)`.

**Cas d'un enregistrement en échec** — une ligne de `_prisma_migrations` avec
`finished_at IS NULL` **et** `rolled_back_at IS NULL`. `migrer_fidelement.mjs`
l'ignore (il ne retient que les lignes terminées et non annulées), mais
`prisma migrate deploy` **s'arrête** avec `P3009`. C'est un état à traiter, pas
à contourner :

```sql
-- 1. constater, et lire le journal de la tentative
SELECT migration_name, started_at, finished_at, rolled_back_at, applied_steps_count
  FROM public._prisma_migrations WHERE finished_at IS NULL;

-- 2. si l'effet de la migration est ABSENT de la base (à vérifier par une
--    sonde d'effet, pas par intuition), marquer la tentative comme annulée :
UPDATE public._prisma_migrations SET rolled_back_at = now()
 WHERE finished_at IS NULL AND rolled_back_at IS NULL;
```

`rolled_back_at` est exactement ce que pose `prisma migrate resolve
--rolled-back` : on ne réécrit pas l'historique, on constate qu'une tentative
n'a rien appliqué. **Ne jamais supprimer la ligne** : elle fait partie de
l'historique, et sa disparition rendrait la base indiscernable d'une base saine.

Mesuré pendant P10.5 : après un rejeu manuel de la migration 68 dans une
transaction annulée, la base portait **une ligne en échec et une ligne
réussie** pour la même migration. La ligne en échec a été marquée annulée ; la
sonde `echouees` est revenue à 0.

## 5. Ce que le provisionnement ne fait pas

- il ne pose **aucun** `GRANT` sur `tracefab_identity_cles` ;
- il ne modifie **jamais** un rôle préexistant non conforme : il refuse ;
- il n'accorde **jamais** `SUPERUSER` au runtime, ni `BYPASSRLS` ;
- il ne crée **aucune** appartenance pour `tracefab_app` ;
- il n'affiche **aucune** clé, ne l'écrit **dans aucun fichier**, ne la journalise
  pas. Seul un booléen de présence et des longueurs sont rendus.

## 6. Non vérifié en production

L'identité réelle du runtime, les appartenances effectives de la base Neon, la
valeur de `DATABASE_URL` côté Vercel et l'état de `_prisma_migrations` sur la
base réelle ne sont **pas** connus de ce dépôt. Ils se lisent avec
`docs/security/2026-10-31-p105-sonde-connexions-lecture-seule.sql`. Tant que
cette lecture n'a pas été faite par un opérateur autorisé, la bascule n'est pas
« prête » : elle est « réalisable sur base jetable ».
