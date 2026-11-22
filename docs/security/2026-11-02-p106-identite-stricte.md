# P10.6 — Revue finale de sécurité : ce qui a été mesuré, corrigé, et ce qui reste ouvert

Date : 2 novembre 2026 · Base : `53ee5f3` (`arena/96848462-tracefab`, PR #105) ·
Cluster jetable : PostgreSQL 17.10, port 55436, base `tracefab_test`, 69 migrations.

Ce document ne décrit pas une intention : chaque défaut ci-dessous a été
**reproduit**, puis **corrigé**, puis **re-mesuré**. Les commandes exactes sont
données pour que la mesure soit rejouable. Ce qui n'est **pas** prouvé est
listé au § 7 — rien n'y est présenté comme acquis.

---

## 1 · Défauts trouvés et corrigés dans cette revue

| # | Défaut | Preuve du défaut | Correction |
|---|---|---|---|
| D1 | `tracefab_current_user_email()` rendait le GUC `tracefab.user_email` : en mode strict, un jeton signé de A + une adresse forgée rendait **l'adresse forgée**. Trois surfaces en dépendent (acceptation d'invitation, auto-inscription fournisseur, politique `passport_access_select`). | `test:p105:hmac` S9 (avant) : `rendue=pirate@exemple.test` | Migration `20261102120000` : en mode strict, l'adresse est **lue** dans `public.users` sur l'identité signée ; `passport_access_select` ne compare plus au GUC. |
| D2 | Trois fonctions `SECURITY DEFINER` attribuaient leurs écritures au GUC brut : `tracefab_register_transaction_certificate`, `tracefab_allocate_tc_quantity`, `tracefab_reconcile_mass_balance`. | Contrôle structurel S10 : lecture de `current_setting('tracefab.user_id')` dans leur définition | `CREATE OR REPLACE` (OID, propriétaire et ACL préservés) : `v_user_id := public.tracefab_current_user_id()`. |
| D3 | La vérification ne retenait que la clé active de version la plus haute : **toute rotation invalidait les jetons en vol**, ce qui décourage de tourner la clé. | Mesure : jeton signé par l'ancienne clé refusé dès qu'une nouvelle clé est activée | Toute clé `actif` est essayée ; une clé `actif = false` ne vérifie plus rien. |
| D4 | Une clé malformée (`secret` trop court, non hexadécimal) n'était pas refusée au provisionnement. | `test:p105:jeton` : échecs fermés | `provisionner_cle_identite.mjs` refuse (sortie ≠ 0) au lieu d'écrire une clé inutilisable. |
| **D5** | **La chaîne de migrations n'était pas rejouable dans un même cluster.** `20261028120100` fait `GRANT tracefab_worker TO current_user` (§ 6) puis `REVOKE` (§ 6 bis) ; PostgreSQL refuse ce `REVOKE` en `2BP01 dependent privileges exist` dès qu'un **autre** rôle est membre. Or le rattrapage `apres` de l'exécution précédente créait exactement ce membre. | `.work-tmp/measure-2bp01.mjs` : échec **avec et sans** `ADMIN OPTION` ; puis bases jetables successives : 1ʳᵉ passe OK, 2ᵈᵉ en `2BP01` → `test_privileges_role_app`, `test_provisioning_role_app`, `test_verrou_cluster` rouges en cascade | Bloc `avant { appartenance, conserver, motifAutorise }` dans le registre fermé + helper partagé `preparerAppartenance()`, appelé par `migrer_fidelement.mjs` **et** `test_privileges_role_app.mjs`. `apres` passe à `GRANT … WITH INHERIT TRUE, SET TRUE` (sans ADMIN OPTION : mesuré suffisant pour `SET ROLE` **et** `ALTER … OWNER TO`). |
| **D6** | **Propriété des fonctions : une chaîne jouée par le rôle de migration ne peut remplacer que les fonctions qu'il a créées.** `CREATE OR REPLACE FUNCTION` exige d'être le propriétaire. | Cluster jetable, `tracefab_migrator` avec `CREATE` sur `public` : `CREATE OR REPLACE FUNCTION public.tf_sonde() …` → `42501 must be owner of function` ; `DROP FUNCTION` → idem. Sur une base de forme production (fonctions possédées par `postgres`, `20261102120000` en attente), la chaîne échouait **au milieu**, après 68 migrations appliquées. | Préflight **fail-closed** `scripts/lib/preflight_proprietaires.mjs`, branché dans `migrer_fidelement.mjs` **avant** la boucle : il lit dans les fichiers en attente les fonctions visées, interroge le catalogue, et refuse (sortie 3) en nommant la migration, la fonction et son propriétaire. **Rien n'est écrit**, pas même une ligne d'échec dans `_prisma_migrations`. |

Bugs d'outillage corrigés au passage (ils masquaient D5) : `test_p105_roles_et_migrations.mjs` purgeait ses rôles de sonde **avant** `DROP DATABASE`, ce qui laissait des `tf_p106_prov_*` derrière lui et faisait échouer `test_garde_cible_ecriture` ; l'ordre correct est base → `DROP OWNED BY` → `DROP ROLE`.

---

## 2 · Preuves des corrections (commandes et résultats)

### 2.1 Rejouabilité de la chaîne (D5)

```
# premier passage, cluster NEUF (port 55437, initdb vierge)
DATABASE_URL=…/vierge  node scripts/bootstrap_app_role.mjs && node scripts/migrer_fidelement.mjs
→ 16 migration(s) appliquee(s) · 69/69 dans _prisma_migrations

# second passage, MÊME cluster, base vierge2
DATABASE_URL=…/vierge2 node scripts/bootstrap_app_role.mjs && node scripts/migrer_fidelement.mjs
→ 69 migration(s) appliquee(s)      (avant correctif : 2BP01 sur 20261028120100)
```

Appartenance finale : `tracefab_worker` → membre unique `postgres` (l'exécutant) ;
`tracefab_app` membre de rien ; `tracefab_app` et `tracefab_worker` :
`rolsuper = false`, `rolbypassrls = false`.

### 2.2 Préflight de propriété (D6)

Base de forme production (`CREATE DATABASE … TEMPLATE tracefab_test`, ligne
`20261102120000` retirée du registre, fonctions possédées par `postgres`) :

```
DATABASE_URL=…/tf_forme_prod (tracefab_migrator) node scripts/migrer_fidelement.mjs
→ REFUS      propriete des fonctions visees par les migrations en attente
             20261102120000… : public.tracefab_current_user_id appartient a postgres,
             que tracefab_migrator ne peut pas endosser (SET ROLE refuse).
  … (cinq fonctions)
  Cette operation exige le PROPRIETAIRE de ces fonctions.
→ sortie 3 · SELECT … FROM _prisma_migrations WHERE migration_name LIKE '20261102%' → 0 ligne

# même base, connexion du PROPRIÉTAIRE :
DATABASE_URL=…/tf_forme_prod (postgres) node scripts/migrer_fidelement.mjs
→ appliquee  20261102120000_identite_stricte_email_et_rotation · 1 migration(s) appliquee(s)
```

### 2.3 Contrôle négatif permanent — `npm run test:p106:identite-negative`

37 assertions, **toutes des refus** (aucune ne décrit un chemin heureux) :

- `N1` mode strict, GUC `tracefab.user_id` / `tracefab.user_email` forgé sans jeton → rien ;
- `N2` jeton de A + GUC de B → l'identité est **A** ;
- `N3` jeton **présent mais invalide**, en mode **permissif** → aucune identité : un jeton présent n'est jamais remplacé par le GUC (c'est la garantie de transition) ; contrôle positif : sans jeton, le permissif garde le GUC ;
- `N4` sept formes malformées (sans séparateur, 4 champs, MAC vide, MAC tronqué, identifiant non UUID, jeton de 10 ko, version inconnue) → refus **sans exception** remontée ;
- `N5` organisation signée ≠ organisation de session, ou absente → refus ;
- `N6` expiration (horloge de la base) ;
- `N7` usage signé détourné (`tracefab_impersonation`, casse, espace) → refus ;
- `N8` **aucune clé active** → refus même avec un jeton correctement signé : l'absence de clé ne rouvre pas la porte du GUC ;
- `N9` rotation : ancienne clé active acceptée, nouvelle acceptée, clé **présente mais inactive** ignorée, révocation effective ;
- `N10`/`N11` adresse non forgeable en mode strict ;
- `N12` structurel : aucune fonction de `public` hors des deux points de passage ne lit `current_setting('tracefab.user_id'|'tracefab.user_email')` (commentaires retirés avant analyse — mesuré : `tracefab_ingest_plm_erp_payload` remontait à tort) ; les trois fonctions d'attestation passent par l'identité signée ; le point de passage n'est **pas** `SECURITY DEFINER` et verrouille son `search_path` ;
- `N13` aucune politique RLS ne compare à un GUC d'identité ;
- `N14` la clé reste illisible par `tracefab_app` (`42501`) ;
- `N15` état rendu (politique d'identité, clés de test supprimées).

### 2.4 Rejouabilité prouvée par un test permanent — `npm run test:p106:rejouabilite-chaine`

24 assertions : cohérence du registre (toute entrée qui accorde une
appartenance doit fournir un bloc `avant`, avec un motif ancré et sans révoquer
l'exécutant), idempotence, révocation des membres `tracefab_*` hors périmètre,
**refus** sur un membre étranger (il est conservé, pas retiré en silence),
préflight de propriété (refus si l'exécutant ne peut pas endosser le
propriétaire, aucun faux refus pour le propriétaire, aucune gêne pour une
migration assistée), puis **chaîne 69/69 sur une base vierge créée dans le
cluster déjà migré**, appartenance finale vérifiée, base détruite.

---

## 3 · État de la hiérarchie des rôles (mesuré)

| Rôle | `rolsuper` | `rolbypassrls` | `rolcreaterole` | Membre de |
|---|---|---|---|---|
| `tracefab_app` (runtime) | false | **false** | false | **rien** |
| `tracefab_worker` (propriétaire de 6 fonctions) | false | false | false | — |
| `tracefab_migrator` (chaîne) | false | true (attribut requis par le provisioning) | true | rien en dehors du rattrapage borné |

Le runtime n'atteint **aucun** rôle privilégié : `verifier_hierarchie_roles.mjs`
le prouve dans les deux sens (refus de `SET ROLE` vers le migrator, le worker et
le propriétaire, puis contrôle positif GRANT → `SET ROLE` → lecture → REVOKE).

## 4 · Hygiène SQL (mesurée sur la chaîne complète)

| Contrôle | Résultat |
|---|---|
| fonctions `public` | 176 |
| dont `SECURITY DEFINER` | 125 |
| `SECURITY DEFINER` sans `search_path` figé | **0** |
| fonctions exécutables par `PUBLIC` | **0** |
| fonctions exécutables par `tracefab_app` | 92 |
| possédées par `tracefab_worker` | 6 (`tracefab_archive_clerk_organization`, `tracefab_clerk_organization_uuid`, `tracefab_ensure_clerk_user`, `tracefab_notification_outbox_health`, `tracefab_soft_delete_clerk_user`, `tracefab_upsert_clerk_user`) |
| possédées par `postgres` | 170 |
| `search_path` des `SECURITY DEFINER` | `public` seul ; `tracefab_app` n'a **pas** `CREATE` sur `public` (`{tracefab_migrator=UC/…,=U/…,tracefab_worker=U/…,tracefab_app=U/…}`) |

---

## 5 · Liste courte des opérations qui exigent encore le propriétaire

C'est la seule liste qui reste, et elle est mesurée, pas supposée.

1. **Appliquer une migration qui fait `CREATE OR REPLACE` (ou `DROP`) sur une
   fonction héritée** — c'est-à-dire sur une fonction que le rôle de migration
   n'a pas créée lui-même. Concerne aujourd'hui `20261102120000` si la base
   cible a été migrée par un autre rôle (`neondb_owner`, `postgres`…). Le
   préflight refuse avant d'écrire ; il faut relancer avec `DATABASE_URL` du
   propriétaire, ou transférer la propriété par une décision explicite.
2. **`20261028120100`** (`CREATE ROLE tracefab_worker`, `ALTER ROLE …
   NOSUPERUSER`, `ALTER FUNCTION … OWNER TO`) : élévation bornée, opt-in
   (`TF_ADMIN_URL` + `TF_ALLOW_ELEVATION=oui`), révoquée et vérifiée après coup.
3. **Création initiale de `tracefab_app` / `tracefab_migrator`**
   (`provisionner_roles_db.mjs`, `bootstrap_app_role.mjs`) : rôles = objets de
   **cluster**, hors du périmètre d'une migration.
4. **Bascule de `tracefab_identity_politique.strict`** : décision
   d'exploitation, à prendre une fois `identityTokens.configured = true`
   constaté sur le déploiement réel. Non faite ici, volontairement.
5. **Rotation de la clé HMAC** (`provisionner_cle_identite.mjs`) : opération
   d'exploitation, avec chevauchement de deux clés actives.

---

## 6 · Ce qui a changé dans le dépôt

| Fichier | Nature |
|---|---|
| `prisma/migrations/20261102120000_identite_stricte_email_et_rotation/` | nouvelle migration (D1, D2, D3) — **aucune migration publiée n'est modifiée** |
| `scripts/lib/migrations_assistees.mjs` | bloc `avant`, `apres` sans `ADMIN OPTION`, `preparerAppartenance()` |
| `scripts/lib/preflight_proprietaires.mjs` | nouveau : préflight de propriété (D6) |
| `scripts/migrer_fidelement.mjs` | préparation d'appartenance (après l'élévation) + préflight de propriété avant la boucle |
| `scripts/test_p106_identite_negative.mjs` | **nouveau test négatif permanent** (37 assertions) |
| `scripts/test_p106_rejouabilite_chaine.mjs` | **nouveau test permanent** de rejouabilité + préflight (24 assertions) |
| `scripts/test_privileges_role_app.mjs`, `scripts/test_p105_roles_et_migrations.mjs` | préparation partagée ; purge des rôles de sonde après destruction de la base |
| `scripts/provisionner_roles_db.mjs`, `scripts/lib/tracefab_roles.mjs` | garde B4 fail-closed, attributs attendus déclarés |
| `api/_lib/identite-jeton.ts`, `api/_routes/internal/p2-readiness.ts` | signature d'identité, disponibilité de la configuration |
| `package.json`, `.github/workflows/ci.yml` | entrées `test:p106:*` et deux étapes CI nommées (aucune en `continue-on-error`) |

---

## 7 · Ce qui n'est PAS prouvé

- **État de la production** : identité runtime réellement configurée
  (`identityTokens.configured`), appartenances sur Neon, `DATABASE_URL` et clé
  côté Vercel, contenu de `_prisma_migrations` en production, version de
  PostgreSQL, PITR, comportement du pooler. Aucune de ces informations n'a été
  lue en production dans cette revue.
- **Mode strict** : `tracefab_identity_politique.strict` reste `false`. Tant
  qu'il n'est pas basculé, un appel **sans jeton** garde le comportement
  antérieur (identité issue du GUC). C'est la seule faille résiduelle connue du
  dispositif, elle est bornée à cette condition, et elle est mesurée par le
  contrôle positif `N3`. **On ne peut donc pas déclarer que « l'identité n'est
  plus forgeable en production »** : on peut seulement déclarer que, jeton
  présent, aucune identité ne vient du GUC, et qu'en mode strict aucune identité
  n'en vient du tout.
- **Propriété des fonctions en production** : 170 fonctions sont possédées par
  `postgres` sur le cluster jetable ; qui les possède sur Neon n'a pas été lu.
  C'est précisément ce que le préflight D6 refuse de deviner.
- **Neon Production, secrets Vercel, migrations de production** : non touchés.

---

## 8 · Conditions d'arrêt — état

| Condition | État |
|---|---|
| identité encore forgeable en mode strict | **non** (jeton présent → vérifié ; sans jeton → aucune identité) |
| appartenance permettant de prendre un rôle privilégié | **non** (`tracefab_app` n'est membre de rien ; refus de `SET ROLE` prouvés) |
| migration exigeant une élévation non prévue | **oui, et c'est traité** : D6, refus explicite avant écriture, propriétaire documenté (§ 5) |
| parcours applicatif légitime cassé | **non** (mode permissif conservé ; 16 suites vertes) |
| régression CI | à constater sur le SHA final (§ 9) |

## 9 · CI

Les deux étapes P10.6 sont câblées dans le job « Base » :
`test:p106:identite-negative` et `test:p106:rejouabilite-chaine`. Elles ne sont
pas en `continue-on-error`, et elles sont exclues de la boucle dynamique du job
`Verification` (sans base) pour la même raison que `test:p105:*` : hors
`DATABASE_URL` elles sortiraient en 2, ce qu'une boucle lirait à tort comme un
échec de code. La conclusion des quatre jobs est reportée dans la description de
la PR **après** exécution, sur le SHA exact.
