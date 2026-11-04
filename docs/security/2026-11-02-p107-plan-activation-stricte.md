# P10.7 · Chantier E — Plan de migration vérifiable

Ce plan décrit **ce qu'un opérateur doit faire**, dans quel ordre, avec quel
rôle, et ce qui l'arrête. La phrase historique ci-dessous décrit l'état à la
clôture de la mission P10.7 ; elle ne décrit pas les essais du 04/11/2026.

**Mise à jour du 04/11/2026 :** le dépôt contient désormais 70 migrations ;
Production et Préproduction ont 56 migrations réussies, 13 migrations
historiques absentes et une correction forward PLM/GS1 post-snapshot. Onze
migrations SQL ont été exécutées manuellement sur une branche Neon de
validation distincte, sans écrire dans son historique _prisma_migrations.
Cette branche est un laboratoire de catalogue, pas une Préproduction.

À la date de rédaction de P10.7, aucune migration n'avait été appliquée hors du
cluster jetable.

Rappel des contraintes qui encadrent ce plan : la PR #105 n'est pas fusionnée,
`main` n'est pas modifiée, `strict` n'est pas activé, aucun secret n'est lu ni
recopié, et le préflight D6 n'est **jamais** contourné.

---

## 1 · Ordre exact des migrations

La chaîne compte **69** migrations dans `prisma/migrations` et s'applique dans
l'ordre lexicographique des noms de dossier. Une base qui a déjà l'historique
P10.5/P10.6 a **deux** migrations en attente :

| Rang | Migration | Ce qu'elle change |
|---|---|---|
| 68 | `20261031120000_identite_hmac_liee_au_contexte` | HMAC en base : jeton `v1|user|org|usage|exp`, clé illisible du runtime, vérification `SECURITY DEFINER` |
| 69 | `20261102120000_identite_stricte_email_et_rotation` | adresse non forgeable en mode strict, trois fonctions d'attestation sur l'identité signée, rotation sans coupure |

Une base plus ancienne appliquera, **dans l'ordre**, tout ce qui manque —
notamment 20261028120100_worker_identity_not_forgeable (rang 55). La version
présente dans cette branche est corrigée pour l'exécution Neon observée avec
neondb_owner (CREATEROLE, NOSUPERUSER) : elle ne demande pas d'élévation
SUPERUSER. Le test réel sur branche Neon est décrit dans le rapport du 04/11.

Ne jamais appliquer une migration hors de cet ordre, ni « en sautant » celles
qui échouent : le registre `_prisma_migrations` enregistre un échec avec
`finished_at = NULL`, et Prisma refuse alors d'aller plus loin.

---

## 2 · Commande, et ce qu'elle vérifie avant d'écrire

```
DATABASE_URL="<url du PROPRIÉTAIRE des objets>" \
TF_ALLOW_WRITE=oui \
node scripts/migrer_fidelement.mjs            # ajouter --etat pour un simple constat
```

Avant la première écriture, l'outil :

1. refuse une cible de production non reconnue (`REFUS — la cible est la base de
   PRODUCTION`, sortie 3) — pour toute autre cible distante, il exige
   `TF_ALLOW_WRITE=oui` ;
2. lit `_prisma_migrations` et n'exécute que les migrations **en attente** ;
3. **préflight D6** : lit, dans les fichiers en attente, les fonctions visées par
   `CREATE OR REPLACE FUNCTION` / `ALTER FUNCTION`, interroge le catalogue, et
   **refuse (sortie 3) si l'exécutant ne peut pas endosser leur propriétaire** ;
4. vérifie le registre MIGRATIONS_ASSISTEES : il est vide pour la chaîne
   actuelle, donc aucune élévation temporaire n'est demandée. Une migration
   future ne pourra utiliser TF_ADMIN_URL et TF_ALLOW_ELEVATION=oui qu'après
   inscription explicite et test dédié ;
5. prend un verrou avant les opérations de création de rôle et de transfert
   de propriété afin d'éviter deux exécutions concurrentes.

---

## 3 · Rôle propriétaire requis, migration par migration

| Migration | Rôle requis | Pourquoi, mesuré |
|---|---|---|
| 20261028120100_worker_identity_not_forgeable | **CREATEROLE + propriété des fonctions transférées** ; pas SUPERUSER | La migration crée un rôle worker NOLOGIN sans attributs élevés, accorde explicitement INHERIT/SET sans ADMIN OPTION, puis transfère six fonctions. Sur Neon, CREATE ROLE ajoute aussi une appartenance bootstrap gérée par cloud_admin (ADMIN=true, INHERIT/SET=false) ; le contrôle distingue cette ligne de l'octroi explicite. Testée sur branche Neon avec neondb_owner NOSUPERUSER/CREATEROLE. | `CREATE ROLE tracefab_worker`, `ALTER ROLE … NOSUPERUSER`, `ALTER FUNCTION … OWNER TO` : PostgreSQL 16+ refuse les deux branches à un rôle non superutilisateur (`42501`) |
| `20261031120000_identite_hmac_liee_au_contexte` | **propriétaire** des fonctions et tables qu'elle crée/remplace (sur Neon : le rôle d'administration du projet, ex. `neondb_owner`) | `CREATE TABLE`, `CREATE OR REPLACE FUNCTION`, `GRANT` |
| `20261102120000_identite_stricte_email_et_rotation` | **le même propriétaire** — c'est le point dur | `CREATE OR REPLACE FUNCTION` exige d'être propriétaire (mesuré P10.6 : `42501 must be owner of function`) ; la migration remplace `tracefab_current_user_email`, `tracefab_identity_jeton_utilisateur` et trois fonctions d'attestation |
| toutes les autres | rôle de migration (peut rester non superutilisateur) | aucune ne change de propriétaire |

**Conséquence pratique** : si les fonctions de la base réelle appartiennent à un
rôle que `tracefab_migrator` ne peut pas endosser, la chaîne **s'arrêtera au
préflight**, avant toute écriture. C'est le comportement voulu. Deux issues
seulement, dans cet ordre : (a) relancer avec `DATABASE_URL` du propriétaire ;
(b) décider explicitement d'un transfert de propriété, avec sa trace. Aucune
troisième voie ne doit être improvisée sur la base réelle.

Le registre MIGRATIONS_ASSISTEES est actuellement vide. Le mécanisme
d'élévation bornée est conservé pour un besoin futur explicitement déclaré,
mais aucune migration de cette chaîne ne doit l'utiliser.

---

## 4 · Préconditions (à mesurer, pas à supposer)

Toutes se mesurent avec la sonde de lecture seule :

```
node scripts/sonde_p107_etat_cible.mjs --url "$TRACEFAB_LECTURE_URL" --role-runtime <rôle du runtime>
```

| # | Précondition | Preuve exigée | Arrêt si |
|---|---|---|---|
| P1 | historique complet et sain | `b1_historique.en_echec = 0`, `annulees = 0` | une migration en échec subsiste |
| P2 | aucune migration P10.5/P10.6 déjà en échec | `b2_migrations_p105_p106[*].en_echec = false` | une est en échec |
| P3 | propriétaires connus | `b4_proprietaires` liste six fonctions **et** leur propriétaire | une fonction manque, ou le propriétaire est inattendu |
| P4 | hygiène des `SECURITY DEFINER` | `b5_hygiene.definer_sans_search_path = 0`, `executables_par_public = 0` | l'un des deux est non nul |
| P5 | absence d'élévation non déclarée | MIGRATIONS_ASSISTEES = {} et b6_droits_migration.migrator_superuser = false | une migration demande une élévation non inscrite ou l'exécutant reste SUPERUSER | `superuser = true` = état d'exploitation anormal |
| P6 | mode d'identité | `b7_identite.mode_identite = 'permissif'` au moment du déploiement | déjà `strict` sans avoir mesuré l'identité |
| P7 | clé hors de portée du runtime | `b8_portee_de_la_cle.app_lit_les_cles = false` | le runtime lit ou écrit la table des clés |
| P8 | **identité réelle du runtime** | `GET /api/internal/p2-readiness?identity=1` **ou** `node scripts/sonde_p107_runtime.mjs`, verdict `IDENTITE_CONFORME` | le runtime est propriétaire, `SUPERUSER`, `BYPASSRLS`, `CREATEROLE`, `CREATEDB`, ou peut prendre un rôle privilégié |
| P9 | pooler | `sonde_p107_runtime.mjs` : `contexte_transactionnel.absent_apres = true` | le contexte survit à la transaction (incompatible avec un pooler en mode transaction) |
| P10 | sauvegarde | instantané PITR pris **avant** la fenêtre, horodatage consigné | pas d'instantané |

P8 est la précondition qui **n'a pas été mesurée en production** par cette
mission : elle exige un accès au déploiement. Tant qu'elle n'est pas faite, le
déploiement reste en attente.

---

## 5 · Contrôles avant et après

**Avant** (les dix préconditions ci-dessus, dans cet ordre, sortie conservée
avec sa date).

**Après** :

| Contrôle | Attendu |
|---|---|
| `sonde_p107_etat_cible.mjs --json` | `b1_historique.terminees = 69`, `en_echec = 0` |
| `b2_migrations_p105_p106` | les deux migrations `appliquee = true` |
| `b4_proprietaires` | six fonctions présentes, propriétaires **inchangés** pour celles qui l'étaient |
| `b5_hygiene` | `definer_sans_search_path = 0`, `executables_par_public = 0` |
| `b7_identite` | `mode_identite = 'permissif'` (l'activation est une décision séparée), `fonction_verification = true` |
| `sonde_p107_runtime.mjs --url "$URL_RUNTIME"` | `IDENTITE_CONFORME` |
| parcours nominal | une route authentifiée lit les données du locataire, un appel d'ingestion PLM/ERP passe (sans jeton toujours accepté en permissif ; avec jeton, vérifié) |
| `GET /api/internal/p2-readiness` | `identityTokens.configured = true`, `mode = 'signe'` |

---

## 6 · Comportement attendu quand le préflight D6 refuse

Mesuré sur une base de forme production (fonctions possédées par `postgres`,
migration en attente) :

```
REFUS      propriete des fonctions visees par les migrations en attente
           20261102120000… : public.tracefab_current_user_id appartient a postgres,
           que tracefab_migrator ne peut pas endosser (SET ROLE refuse).
           …
           Cette operation exige le PROPRIETAIRE de ces fonctions.
→ sortie 3 · aucune ligne dans _prisma_migrations
```

Ce que l'opérateur fait alors :

1. **ne touche à rien** ; relève la liste exacte des fonctions et de leur
   propriétaire (la sortie la nomme) ;
2. relance avec une connexion **de ce propriétaire** ;
3. si ce n'est pas possible, ouvre une décision explicite de transfert de
   propriété — avec sa justification et sa trace — **hors** de la chaîne ;
4. ne désactive jamais le préflight, ne le rend pas « avertissement », ne passe
   pas `TF_ALLOW_*` pour l'éviter : ce serait exactement l'affaiblissement
   interdit.

---

## 7 · Plan de retour arrière

La migration est **forward-only** : on ne « défait » pas une migration. Trois
niveaux, du moins cher au plus cher :

| Niveau | Action | Réversible ? | Délai |
|---|---|---|---|
| **R1 — mode d'identité** | `UPDATE public.tracefab_identity_politique SET strict = false, modifie_le = now() WHERE singleton;` par le **propriétaire** (le runtime ne l'écrit pas) | oui, immédiat, une ligne | secondes |
| **R2 — application** | redéploiement de la révision Vercel précédente (aucune migration défaite) | oui | minutes |
| **R3 — restauration** | restauration PITR à l'instantané pris en P10 | destructif pour les écritures postérieures | selon le fournisseur |

Ce que R1 fait et ne fait pas : il rétablit le comportement **antérieur**
(un appel sans jeton reprend l'identité du GUC `tracefab.user_id`, donc
forgeable). C'est un retour arrière, pas un état sûr — à n'utiliser que pour
arrêter une panne, et à refermer ensuite.

Les `CREATE OR REPLACE` de fonctions **ne sont pas** automatiquement
réversibles. Avant toute application sur une base réelle, l'opérateur conserve
une copie des définitions courantes :

```sql
SELECT p.proname, pg_catalog.pg_get_functiondef(p.oid)
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('tracefab_current_user_id','tracefab_current_user_email',
                     'tracefab_identity_jeton_utilisateur',
                     'tracefab_register_transaction_certificate',
                     'tracefab_allocate_tc_quantity','tracefab_reconcile_mass_balance');
```

Cette copie contient des définitions, **aucun secret** : elle se conserve hors du
dépôt, dans l'espace d'exploitation.

---

## 8 · Conditions d'arrêt immédiat

Une seule de ces conditions suffit : **arrêter, documenter, ne pas corriger à
chaud**.

1. la sonde de catalogue rend `ARRET` (A3, A4, B5, B8, ou une migration en échec) ;
2. la sonde runtime ne rend pas `IDENTITE_CONFORME` — en particulier : rôle
   propriétaire, `SUPERUSER`, `BYPASSRLS`, `CREATEROLE`, `CREATEDB`, ou
   appartenance atteignable vers un rôle privilégié ;
3. le préflight D6 refuse ;
4. le contexte n'est pas transactionnel (`absent_apres = false`) — pooler
   incompatible ;
5. `TRACEFAB_IDENTITY_KEY` est **inexistante** au moment d'activer `strict` (le
   runtime ne pourrait plus signer, tous les appels perdraient leur identité) ou
   **malformée** ;
6. un parcours métier légitime casse après déploiement ;
7. une élévation non prévue est nécessaire (toute demande d'élévation hors du
   registre fermé).

---

## 9 · Plan d'activation de `strict` en préproduction

À exécuter **uniquement** sur un environnement isolé disposant de sa propre base
et de sa propre clé, jamais sur la production, et après accord explicite.

| Étape | Action | Contrôle de sortie |
|---|---|---|
| E1 | versionner la révision applicative qui signe (`signerIdentite`) sur l'environnement isolé | `GET /api/internal/p2-readiness` → `identityTokens.configured = true`, `mode = 'signe'` |
| E2 | provisionner **deux** clés actives (chevauchement) via `provisionner_cle_identite.mjs` | `sonde_p107_etat_cible.mjs` → `cles_actives = 2` |
| E3 | rejouer la démonstration complète sur l'environnement isolé | `test:p107:demonstration` (ou son équivalent exécuté sur cet environnement) : D1..D9 vertes |
| E4 | activer `strict` **sur l'environnement isolé** (`UPDATE … SET strict = true` par le propriétaire) | `mode_identite = 'strict'` |
| E5 | parcours de bout en bout : connexion, lecture, écriture, ingestion PLM/ERP, invitations | aucune régression fonctionnelle, aucun `authentication_required` inattendu |
| E6 | provoquer les refus : sans jeton, jeton invalide, GUC forgé, autre organisation | refus attendus, aucune écriture |
| E7 | rotation : désactiver l'ancienne clé, vérifier que le nouveau jeton passe et que l'ancien est refusé | pas de coupure |
| E8 | observation d'une fenêtre complète (au moins une durée de vie de jeton + un cycle de tâches) | aucune erreur `authentication_required` anormale |

Le retour arrière de cette activation est **R1** (§ 7) : une ligne, par le
propriétaire.

---

## 10 · Ce que ce plan ne prétend pas

Il ne prétend pas que la production est prête : **aucune des mesures P1-P10 n'a
été faite sur la base réelle** dans cette mission, faute d'accès, et
`identityTokens.configured` n'a pas pu être lu (le connecteur Vercel a refusé la
lecture des variables du projet — voir le rapport § 3). Le plan est vérifiable :
chaque case a une commande et un critère.
