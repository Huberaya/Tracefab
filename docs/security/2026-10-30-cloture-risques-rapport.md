# TRACEFAB — dernière clôture des risques avant commit (30/10/2026)

Document de clôture. Aucun commit n'a été créé, aucun changement n'a été fait en
production ni sur `main`, aucun secret n'a été affiché ou modifié.

- Branche : `arena/96848462-tracefab`
- `HEAD` : `5ed2745c8c38ea8eeb1b4f09140869611f0dc933` (arbre **non commité**)
- `main` de référence : `bf55f2ae6534cde84d072d9b975520216c7b6d4e`
- Toutes les expériences ont été faites sur des bases et des clusters **jetables**
  (PostgreSQL 17.10, ports 55432 et 5432, `sysid` 7702231702820447744 et
  7702234278948172588).

Sept points, dans l'ordre demandé. Chaque affirmation est étiquetée
**PROUVÉ** (mesuré dans cette session, avec le code de sortie), **NON EXÉCUTÉ**
(avec la cause) ou **NON PROUVÉ**.

---

## 1. Risques fermés, et la preuve

### 1.1 Migration `20261029180000_plm_erp_sync_jobs_policy_dedup` — atomique sans `BEGIN`/`COMMIT`

**Ce que contient le fichier (41 lignes, lu intégralement).** Cinq blocs, dans cet
ordre :

| # | Instruction | Effet |
|---|---|---|
| 1 | `DO $guard$ … $guard$` | fail-closed : si `to_regclass('public.plm_erp_sync_jobs') IS NULL`, `RAISE EXCEPTION` et rien ne s'applique |
| 2 | `DROP POLICY IF EXISTS plm_sync_jobs_insert_brand ON plm_erp_sync_jobs` | supprime l'ancienne politique d'insertion |
| 3 | `DROP POLICY IF EXISTS plm_sync_jobs_select_org ON plm_erp_sync_jobs` | supprime l'ancienne politique de lecture |
| 4 | `DROP POLICY IF EXISTS plm_sync_jobs_insert_brand ON plm_erp_sync_jobs` | redondant (idempotence défensive) |
| 5 | `DROP POLICY IF EXISTS plm_sync_jobs_select_org ON plm_erp_sync_jobs` | idem |
| 6 | `CREATE POLICY plm_sync_jobs_insert_brand … FOR INSERT` | owner/admin/manager via `tracefab_has_org_role`, `WITH CHECK` |
| 7 | `CREATE POLICY plm_sync_jobs_select_org … FOR SELECT` | `tracefab_is_org_member` |

Aucun `BEGIN`, aucun `COMMIT`, aucun autre DDL. **La question n'était donc pas
« faut-il ajouter une transaction » mais « y en a-t-il déjà une ».**

**PROUVÉ — le mécanisme réel encadre chaque migration.**

- Le projet applique les migrations **en une seule requête multi-instructions** :
  `scripts/test_compteurs_debit.mjs:137`, `scripts/test_neon_publication_deploiement.mjs:130`
  et `:262` font `readFileSync(<migration.sql>)` puis `await client.query(sql)`.
  Une requête simple PostgreSQL est une transaction implicite : tout ou rien.
- Le moteur Prisma fait de même de son côté : `node_modules/@prisma/schema-engine-wasm/schema_engine_bg.wasm`
  contient, à l'offset ≈ 3 979 380, les chaînes `BEGIN;`, `COMMIT;` et
  `Applying migration '' to shadow database.` — le moteur encadre lui-même
  chaque script (`apply_migrations.rs`).
- **Convention du dépôt mesurée** : `grep -l '^BEGIN;\|^COMMIT;' prisma/migrations/*/migration.sql`
  → **5 migrations sur 66** portent une transaction explicite
  (`20261012120000`, `20261014120000`, `20261014130000`, `20261014140000`,
  `20261028150000`) ; **61 sur 66** n'en portent pas. La migration jumelle
  `20261028150000_reconcile_plm_erp_sync_job_policies` — probable source du
  décalque — est l'une des cinq.

**PROUVÉ — expérience sur base jetable (`scripts/test_migration_atomicite_plm_dedup.mjs`, 16/16, exit 0).**

| Section | Expérience | Résultat mesuré |
|---|---|---|
| A | le fichier **réel**, en une requête multi-instructions | 2 politiques, INSERT sans `contributor`, SELECT portée par `tracefab_is_org_member` |
| B | **panne au milieu** : même fichier, `tracefab_is_org_member(` → `tracefab_fonction_absente(`, donc le dernier `CREATE` échoue | **état résiduel identique à l'état initial** : la migration est atomique |
| C | **contrepoids** : les mêmes instructions, une par une en autocommit | panne reproduite, **état résiduel ≠ état initial** : **1 politique restante** (`plm_sync_jobs_insert_brand`) — la mesure B n'est donc pas un artefact |
| D | variante `BEGIN; … COMMIT;` | même atomicité, **plus** un effet de bord : l'échec laisse la session dans une transaction avortée (`25P02`), il faut un `ROLLBACK` explicite |
| E | second passage du fichier réel | idempotent, toujours 2 politiques, aucune surnuméraire |

**Décision : le fichier n'est pas modifié.** Ajouter `BEGIN`/`COMMIT` n'ajouterait
aucune garantie (B et D donnent le même état résiduel) et introduirait la
nécessité d'un `ROLLBACK` côté appelant en cas d'échec — un mécanisme dont
`query(sql)` n'a pas besoin aujourd'hui. Le mot-clé de `20261028150000` est un
style local, pas une exigence.

**État réel dans l'historique — PROUVÉ, sans toucher à la production.**
`docs/security/2026-10-29-plan-reconciliation-migrations.md:11` :
`| 20261029180000_plm_erp_sync_jobs_policy_dedup | NOUVELLE | NON DEPLOYEE | APPLIQUER SEULE (jamais deployee) |`. Aucun `_prisma_migrations`
ne la référence ; `scripts/matrice_migrations.mjs` la classe `NON DEPLOYEE`
(règle ligne 115/121). Elle n'a donc jamais été jouée : la question de
l'atomicité est préventive, et la réponse est « déjà couverte ».

Fichiers qui la lisent : `scripts/test_plm_erp_policy_dedup.mjs` (statique,
**7/7**, exit 0), `scripts/test_plm_migrations_correctives_jumelles.mjs`
(**13/13**, exit 0), `scripts/test_provenance_politiques_plm.mjs` (exit 0).

### 1.2 (a) `DROP DATABASE tracefab_test` nu dans les deux scripts shell — fermé

**Risque reproduit.** `scripts/audit_sql_privileges_catalog.sh` et
`scripts/test_migration_integration_34_36_41.sh` faisaient, avant tout contrôle :

```bash
psql -d postgres -c "DROP DATABASE IF EXISTS tracefab_test;"
psql -d postgres -c "CREATE DATABASE tracefab_test OWNER postgres;"
```

Nom **fixe**, `DROP` **avant** tout contrôle. Le préflight (mode jetable,
`PGDATABASE`, `DATABASE_URL` littérale, `DIRECT_URL` interdit) déclare la
*catégorie* de cible jetable ; il ne prouve pas que **cette** base l'est. Une
base `tracefab_test` remplie par un collègue était détruite.

**Reproduction (PROUVÉ, `scripts/test_ressources_fixes_garde.mjs` section A + essai direct du shell).**

- Base `tf_garde_remplie_*` créée hors garde avec une table : la garde **refuse**
  (`BaseJetableRefusee`, code 2), l'OID est inchangé, la table est intacte,
  **aucune marque** n'a été posée.
- Fonction `reset_db()` **extraite verbatim** du script shell, exécutée sur un
  `tracefab_test` non marqué et contenant une table :
  `EXIT=2`, `REFUS: base tracefab_test non prouvee jetable — CONSERVEE (code 2)`,
  OID identique avant/après, table toujours présente.

**Protection (cohérente avec `scripts/lib/ephemeral-db.mjs`, 29/10).**
Nouveau module `scripts/lib/base_jetable.mjs`, exposé par
`scripts/reinitialiser_base_jetable.mjs`, utilisé par les deux scripts :

1. **liste fermée** de noms : `tracefab_test` ou `tf_*` — un test ne peut pas
   viser autre chose par cette porte (`reinitialiserBaseJetable({nom:'postgres'})`
   → refus, base `postgres` intacte) ;
2. **cible reclassifiée** par `require-throwaway-db.mjs` : un script shell qui
   exporterait une URL distante est refusé même s'il a oublié son préflight ;
3. **destruction seulement si la base est à nous** : marque
   `COMMENT ON DATABASE … IS 'tracefab:base-jetable'`, ou base **vide** (le cas
   d'un service PostgreSQL de CI neuf) ; une base préexistante remplie est
   **conservée** ;
4. **preuve d'OID** relue juste avant le `DROP` (refus si l'OID a changé) ;
5. **verrou de cluster** pendant la séquence (deux scripts en parallèle ne se
   recréent plus la base sous les pieds) ;
6. `DROP … WITH (FORCE)` et non `DROP` nu (le `57P01` mesuré le 30/10 venait de
   connexions encore attachées).

**Contrôle négatif.** Section A1/A3 du test : base préexistante remplie → refus
(2), conservation prouvée ; nom hors liste → refus ; CLI de bout en bout
(`TF_RESET_BASE=…`) → **`exit=2`** et table toujours là.

**Nettoyage.** Chaque base `tf_garde_*` créée par le test est détruite via
`detruireBaseProuvee` (OID vérifié), et la section D vérifie qu'il ne reste
**aucune** base `tf_garde_*` ni aucun rôle `tf_garde_*`.

### 1.3 (b) Rôles créés par les scripts Prisma sans preuve d'OID — fermé

**Risque reproduit.** `scripts/prepare_ci_db_role.mjs` : `select 1 from pg_roles`,
puis `CREATE ROLE` **ou** `ALTER ROLE tracefab_app … PASSWORD …`. Trois défauts :

1. un rôle `tracefab_app` **préexistant et étranger** voyait son **mot de passe
   réécrit** et ses attributs changés, sans preuve qu'il était « le nôtre » ;
2. aucune preuve d'OID : entre la lecture et l'`ALTER`, le rôle pouvait avoir
   été supprimé puis recréé ;
3. aucun enregistrement de ce qui avait été créé (rien à nettoyer, rien à
   distinguer d'un rôle préexistant).

**Reproduction (PROUVÉ).** Rôle `tf_garde_super_*` créé `SUPERUSER LOGIN PASSWORD 'avant_le_test'`,
puis exécution du script : refus **exit 2**, OID identique, `rolsuper` toujours
`true`, **`rolpassword` inchangé** (empreinte comparée avant/après).

**Protection.**
- lecture **unique** de l'état du rôle (OID, attributs, objets possédés via
  `pg_shdepend`) **avant** toute écriture ;
- rôle préexistant **privilégié** (`SUPERUSER`, `BYPASSRLS`, `CREATEROLE`,
  `CREATEDB`) ou **propriétaire d'objets** → **refus exit 2, aucune écriture** ;
- rôle préexistant ordinaire → réaffirmation (comportement idempotent
  historique), puis **OID relu et comparé** : s'il a changé, échec explicite ;
- création → OID relevé et **imprimé** ;
- **aucun `DROP ROLE`** dans le script (assertion statique) ;
- surcharge de nom (`TF_APP_ROLE_NAME`) bornée à `tf_*`, donc un test ne peut pas
  viser `postgres` ni un rôle d'exploitation (vérifié : refus 2, rôle `postgres`
  inchangé, empreinte du mot de passe identique).

**Nettoyage prouvé.** Le test crée des rôles `tf_garde_*`, les range lui-même, et
vérifie en section D qu'aucun ne subsiste.

### 1.4 (c) Provisioning appelé isolément sans verrou de cluster — fermé

**Risque reproduit (mesure du 30/10, conservée).** Deux `ALTER ROLE` concurrents
sur le même cluster → `XX000 tuple concurrently updated`, 1 exécution sur 3. Les
deux scripts shell appelaient `prepare_ci_db_role.mjs` **sans** verrou, alors
que `prepare_ci_db_role.mjs` ne le prend pas lui-même (le prendre ferait attendre
indéfiniment un appelant qui le détient déjà — un verrou consultatif n'est pas
réentrant entre deux sessions).

**Protection.** `scripts/run-db-suite.mjs` accepte `--verrou-cluster` : le
lanceur prend le verrou `738241901` (`verrouillerCluster`) pour toute la durée de
l'enfant, puis le relâche sur `exit`/`error`. Les deux scripts shell appellent
désormais `node scripts/run-db-suite.mjs --verrou-cluster scripts/prepare_ci_db_role.mjs`.

**Preuve (PROUVÉ, section C du test).** Une suite témoin compte, **depuis une
autre session**, les détenteurs du verrou :
- avec `--verrou-cluster` → `DETENTEURS=1` (exit 0) ;
- **contrôle négatif** sans l'option → `DETENTEURS=0` (exit 1).

`scripts/test_verrou_cluster.mjs` couvre maintenant aussi les chemins shell
(**27/27**, était 23/23) : les deux scripts doivent passer par le lanceur, et
aucun `.sh` ne peut appeler le provisioning sans `--verrou-cluster`.

### 1.5 Deux régressions trouvées et corrigées (non-régression des chantiers A et B)

Ces deux suites étaient listées « non exécutées » ; en les exécutant, elles ont
révélé une **régression** dans l'arbre non commité (import manquant introduit en
même temps que le passage aux noms de rôles éphémères) :

| Fichier | Symptôme | Correction |
|---|---|---|
| `scripts/test_rls_write_policies.mjs` | `ReferenceError: nomRoleEphemere is not defined` | `import { nomRoleEphemere } from './lib/ephemeral-role.mjs'` |
| `scripts/test_rls_bypass_controle_negatif.mjs` | même `ReferenceError` | même import |

Après correction, les deux suites **passent réellement** (voir §3).

### 1.6 Harnais manquant pour les suites RLS — construit

`scripts/harnais_suites_rls.mjs` : base **éphémère** (nom unique, preuve d'OID),
rôle `tracefab_app` **avant** les migrations, les **66 migrations** lues sur
disque et jouées sans CLI Prisma ni réseau, puis `seed_rls_fixture.mjs` (deux
locataires), puis les suites demandées avec `DATABASE_URL` + `TF_RLS_APP_URL`
pointant la même base. Le verrou de cluster ne couvre **que** la phase
rôle+migrations : le garder pendant les enfants les faisait attendre
indéfiniment (mesuré : 15 minutes, enfant tué par le timeout). La base est
détruite dans un `finally` (OID vérifié).

`20261029180000` n'a pas été appliquée « pour de vrai » dans ce harnais : la
chaîne complète des 66 migrations l'inclut, et le harnais indique
`66 migrations appliquees, 0 en echec`.

---

## 2. Risques encore ouverts

1. **Section F (Prisma) non exécutée** — voir §4. Ce n'est pas un défaut du
   dépôt mais une limite de l'environnement (moteurs Prisma non téléchargeables).
2. **Trois suites dépendantes de Prisma non exécutées** : `test_neon_security`,
   `test_neon_product_flow`, `test_neon_supplier_advanced`.
3. **Les deux scripts shell ne sont pas exécutés de bout en bout** dans cet
   environnement : ils exigent `node_modules/.bin/prisma` **et** des objets git
   (`SHA34`, `SHA36`, `SHA41`) absents d'un clone superficiel. Ce qui **est**
   prouvé : leur préflight, leur `reset_db()` (extrait verbatim et exécuté), et
   leurs assertions statiques (garde + verrou). Ce qui **n'est pas** prouvé :
   leurs scénarios A/B complets.
4. **Aucune suite n'est branchée dans la CI** parmi celles ajoutées ici
   (`test_ressources_fixes_garde.mjs`, `test_migration_atomicite_plm_dedup.mjs`,
   `harnais_suites_rls.mjs`, `test_verrou_cluster.mjs`, etc.) : c'est un choix de
   périmètre (aucun changement de `package.json` ni de `.github/`), pas une
   preuve de CI.
5. **Suite interrompue = base laissée** : une sortie brutale (SIGKILL, timeout
   externe) empêche le `finally`. Mesuré une fois (`tf_harnais_rls_*` laissée par
   un run tué à 900 s), détecté par `test_concurrence_suites.mjs`, puis supprimé
   à la main. Les verrous, eux, ne fuient pas (libérés avec la session).

---

## 3. Tests réellement exécutés, avec codes de sortie

Tous via `node scripts/run-db-suite.mjs <suite>` (garde de cible appliquée),
sur la base jetable `tracefab_test` (cluster 55432) et des bases éphémères.

| Suite | Exit | Résultat |
|---|---|---|
| `test_base_ephemere_garde.mjs` | 0 | garde des bases |
| `test_db_throwaway_entrypoints.mjs` | 0 | lanceur commun / garde de cible |
| `test_role_ephemere_garde.mjs` | 0 | garde des rôles |
| `test_verrou_cluster.mjs` | 0 | **27/27** assertions |
| `test_concurrence_suites.mjs` | 0 | **9/9** assertions |
| `test_ressources_fixes_garde.mjs` | 0 | **40/40** assertions **(nouveau)** |
| `test_migration_atomicite_plm_dedup.mjs` | 0 | **16/16** assertions **(nouveau)** |
| `test_plm_erp_policy_dedup.mjs` | 0 | 7/7 checks |
| `test_plm_migrations_correctives_jumelles.mjs` | 0 | 13/13 checks |
| `test_provenance_politiques_plm.mjs` | 0 | conforme |
| `test_migration_owner_guard.mjs` | 0 | PASS |
| `test_isolation_lignes_reelles.mjs` | 0 | conforme |
| `test_compteurs_debit.mjs` | 0 | conforme |
| `test_privileges_role_app.mjs` | 0 | **40/40** |
| `test_provisioning_role_app.mjs` | 0 | conforme |
| `test_sonde_identite_runtime.mjs` | 0 | conforme |
| `harnais_suites_rls.mjs` → `test_rls_write_policies.mjs` | 0 | **15 assertions**, WITH CHECK prouvé par exécution |
| `harnais_suites_rls.mjs` → `test_rls_bypass_controle_negatif.mjs` | 0 | **6 assertions**, contraste 0 vs 2 lignes |
| `test_neon_publication_deploiement.mjs` | **1** | sections A→E vertes, **section F impossible** (voir §4) |

**Contrôles négatifs exécutés (tous doivent échouer — ils échouent).**

| Contrôle | Exit attendu | Exit observé |
|---|---|---|
| `COMPTEURS_CONTROLE_NEGATIF=politique_permissive` | 1 | 1 |
| `…=politique_all` | 1 | 1 |
| `…=politique_role_etendu` | 1 | 1 |
| `…=declencheur_desactive` | 1 | 1 |
| `…=declencheur_absent` | 1 | 1 |
| `…=declencheur_renomme` | 1 | 1 |
| `run-db-suite.mjs` **sans** `--verrou-cluster` (témoin) | 1 | 1 |
| `prepare_ci_db_role.mjs` sur rôle `SUPERUSER` préexistant | 2 | 2 |
| `prepare_ci_db_role.mjs` avec `TF_APP_ROLE_NAME=postgres` | 2 | 2 |
| `reinitialiser_base_jetable.mjs` sur base remplie non marquée | 2 | 2 |
| `reset_db()` du shell sur `tracefab_test` remplie non marquée | 2 | 2 |

**Résidus après la campagne (mesuré) :** `SELECT datname … LIKE 'tf_%'` et
`SELECT rolname … LIKE 'tf_%'` → **0 ligne**.

---

## 4. Tests non exécutés, et causes exactes

### 4.1 `test_neon_publication_deploiement.mjs` — section F

**Cause mesurée** (sortie réelle, `exit=1`) :

```
PrismaClientInitializationError: The `adapter` option for `PrismaClient`
is required in this context (Node.js)
    at WasmLibraryLoader … at LibraryEngine.instantiateLibrary
```

**Chaîne causale complète, vérifiée :**

1. `prisma/schema.prisma` utilise `provider = "prisma-client-js"` sans
   `previewFeatures` ni `engineType` : en configuration nominale, le client
   charge le **moteur natif** `libquery_engine-*.so.node`.
2. Ce moteur est **téléchargé** par `prisma generate` depuis
   `binaries.prisma.sh` — hôte **non autorisé** dans cet environnement (seuls
   `github.com`, `codeload.github.com`, `api.github.com`, `registry.npmjs.org`,
   `pypi.org`, `files.pythonhosted.org`). `npm ci` installe le paquet
   `@prisma/engines` mais **pas** les binaires.
3. La génération a donc dû être forcée en WASM
   (`PRISMA_CLIENT_FORCE_WASM=1`, `PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1`,
   `PRISMA_SCHEMA_ENGINE_BINARY=/bin/true`, `PRISMA_QUERY_ENGINE_LIBRARY=/tmp/fake_query_engine.so`).
   Le client obtenu **exige** un `adapter` : c'est le message ci-dessus.
4. `api/_lib/prisma.ts` fait `new PrismaClient()` **sans** adapter, et
   `@prisma/adapter-pg@6.19.3` est bien une dépendance installée — mais
   l'application ne l'utilise pas. Ajouter un adapter **dans le test** (ou dans
   `api/_lib/prisma.ts`) pour verdir F reviendrait à changer ce qui est testé :
   **refusé**.

**Conditions nécessaires pour exécuter F réellement** (aucune n'est remplie ici) :

- accès réseau à `binaries.prisma.sh` (ou cache de moteurs pré-rempli) ;
- `npx prisma generate` **sans** `PRISMA_CLIENT_FORCE_WASM` ;
- un `DATABASE_URL` de préproduction jetable, comme le harnais le fait déjà.

**Statut : NON EXÉCUTÉ.** Aucun vert n'est revendiqué pour cette section.

### 4.2 Trois suites Prisma — NON EXÉCUTÉES

`test_neon_security.mjs`, `test_neon_product_flow.mjs`,
`test_neon_supplier_advanced.mjs` instancient `PrismaClient`
(`createTestPrisma(...)` ou `new PrismaClient()`). Même cause que §4.1 : sans
moteur natif, elles s'arrêtent à l'initialisation. Elles **ne comptent pas**
comme réussies.

### 4.3 Les deux scripts shell de bout en bout — NON EXÉCUTÉS

`bash scripts/audit_sql_privileges_catalog.sh` et
`bash scripts/test_migration_integration_34_36_41.sh` exigent
`node_modules/.bin/prisma` fonctionnel (moteurs, §4.1) et des objets git
(`19a867a…`, `384b18f…`, `c75ee3b…`) absents d'un clone superficiel. Seules
leurs parties sûres ont été exécutées (préflight, `reset_db()` extrait verbatim,
assertions statiques).

---

## 5. Liste exhaustive des fichiers modifiés

**19 fichiers suivis modifiés** (`git status`), **14 fichiers non suivis**.
Aucun changement dans `prisma/`, `api/`, `package.json`, `.github/`.

Modifiés :

```
scripts/audit_sql_privileges_catalog.sh
scripts/db-deploy-throwaway.mjs
scripts/lib/tracefab_app_role.mjs
scripts/migrer_fidelement.mjs
scripts/prepare_ci_db_role.mjs
scripts/run-db-suite.mjs
scripts/seed_rls_fixture.mjs
scripts/test_compteurs_debit.mjs
scripts/test_isolation_lignes_reelles.mjs
scripts/test_migration_integration_34_36_41.sh
scripts/test_migration_owner_guard.mjs
scripts/test_neon_product_flow.mjs
scripts/test_neon_publication_deploiement.mjs
scripts/test_neon_security.mjs
scripts/test_neon_supplier_advanced.mjs
scripts/test_privileges_role_app.mjs
scripts/test_rls_bypass_controle_negatif.mjs
scripts/test_rls_write_policies.mjs
scripts/test_sonde_identite_runtime.mjs
```

Non suivis (nouveaux) :

```
docs/security/2026-10-30-tests-db-destructifs-rapport.md      (rapport du tour precedent)
docs/security/2026-10-30-cloture-risques-rapport.md           (ce document)
scripts/harnais_suites_rls.mjs
scripts/lib/base_jetable.mjs
scripts/lib/ephemeral-db.mjs
scripts/lib/ephemeral-role.mjs
scripts/reinitialiser_base_jetable.mjs
scripts/test_base_ephemere_garde.mjs
scripts/test_concurrence_suites.mjs
scripts/test_migration_atomicite_plm_dedup.mjs
scripts/test_provisioning_role_app.mjs
scripts/test_ressources_fixes_garde.mjs
scripts/test_role_ephemere_garde.mjs
scripts/test_verrou_cluster.mjs
```

Modifications apportées **dans ce tour** (les autres venaient des tours
précédents et sont conservées intactes) :

| Fichier | Nature |
|---|---|
| `scripts/lib/base_jetable.mjs` | nouveau — garde de remise à zéro (marque, vide-ou-marquée, OID, verrou) |
| `scripts/reinitialiser_base_jetable.mjs` | nouveau — CLI utilisée par les deux scripts shell |
| `scripts/audit_sql_privileges_catalog.sh` | `reset_db()` → garde ; `prepare_role()` → `--verrou-cluster` |
| `scripts/test_migration_integration_34_36_41.sh` | idem |
| `scripts/run-db-suite.mjs` | option `--verrou-cluster` (verrou pris/relâché autour de l'enfant) |
| `scripts/prepare_ci_db_role.mjs` | lecture unique, refus sans écriture sur rôle privilégié/propriétaire, preuve d'OID, aucun `DROP ROLE`, surcharge bornée `tf_*` |
| `scripts/test_verrou_cluster.mjs` | couverture des chemins shell + harnais (23 → 27 assertions) |
| `scripts/test_rls_write_policies.mjs` | import manquant (régression corrigée) |
| `scripts/test_rls_bypass_controle_negatif.mjs` | import manquant (régression corrigée) |
| `scripts/test_ressources_fixes_garde.mjs` | nouveau — 40 assertions (A/B/C/D) |
| `scripts/test_migration_atomicite_plm_dedup.mjs` | nouveau — 16 assertions (A→E) |
| `scripts/harnais_suites_rls.mjs` | nouveau — base migrée + fixtures + suites |

---

## 6. Diff intégral

Le diff complet est dans **`/home/user/revue-diff-finale.md`**
(5 182 lignes, SHA-256 `d714346bac3390990e48f6cdb635dbdc41144fd81e46439bf8835df773cc08b8`) :
`git diff` des 19 fichiers suivis, puis le **contenu intégral** des fichiers
non suivis. Il vit hors du dépôt : rien n'est ajouté à l'index, aucun commit.

Résumé `git diff --stat` :

```
 19 files changed, 790 insertions(+), 153 deletions(-)
```

Diff des seuls changements de ce tour (fichiers suivis) :

```
scripts/audit_sql_privileges_catalog.sh | reset_db() garde + prepare_role() verrou
scripts/test_migration_integration_34_36_41.sh | idem
scripts/run-db-suite.mjs               | option --verrou-cluster
scripts/prepare_ci_db_role.mjs         | refonte (OID, conservation, refus)
scripts/test_verrou_cluster.mjs        | couverture shell (23 → 27)
scripts/test_rls_write_policies.mjs    | +1 import
scripts/test_rls_bypass_controle_negatif.mjs | +1 import
```

---

## 7. SHA et empreinte de l'arbre final

| Élément | Valeur |
|---|---|
| `HEAD` (inchangé, **aucun commit créé**) | `5ed2745c8c38ea8eeb1b4f09140869611f0dc933` |
| Branche | `arena/96848462-tracefab` |
| `git diff` (fichiers suivis), SHA-256 | `e62aea90c7074e78425643a0b89e2a9040d34ece786434657566b8ee80352e7e` |
| Revue intégrale (`/home/user/revue-diff-finale.md`), SHA-256 | `d714346bac3390990e48f6cdb635dbdc41144fd81e46439bf8835df773cc08b8` |
| `git diff --stat` | `19 files changed, 790 insertions(+), 153 deletions(-)` |
| Fichiers non suivis | 14 (hors revue intégrale, qui vit hors du dépôt) |

Empreintes SHA-256 des fichiers de ce tour :

```
c6563357eb51e951dd3b69fb7b24d2a6f0c5de2db903f04218ba112133f84aa8  scripts/lib/base_jetable.mjs
7b03c738da3b547d60d5526167882b969acbe4a91666cb78fc82dee5595db820  scripts/reinitialiser_base_jetable.mjs
a78bf9fbfd8c3fa163df2422009985c5e839c5a0e039f0279a76800de9a38735  scripts/seed_rls_fixture.mjs
ef1b7cdff613e83de6cd83fab22a517e9689d6acde9a8bd97cda69790d667355  scripts/audit_sql_privileges_catalog.sh
2b3a459410eba5a8be771173dd55fc826134df9e1332d71e8a432ea1cd01c295  scripts/test_migration_integration_34_36_41.sh
bcf3901fed281a103e2d049f3a37e84ffc6991afe09b5afe0f496ac6e50d6b09  scripts/run-db-suite.mjs
67d485098a0994c673b4e2fc971cc89c70ded07af0e04e0a7ef829bc0772e858  scripts/prepare_ci_db_role.mjs
9f80a785404f58a291cc1346f23cf6d1f00b5d68bec396485bceba41e55c0547  scripts/test_verrou_cluster.mjs
b54d5b1f82613563a448793c6da51d23581dcd217627581b914fe5d60a97b58b  scripts/test_rls_write_policies.mjs
616acc4deba0b908a64abcf9c448ceb5bb5b6e822aff4e243e7b76c873a1982c  scripts/test_rls_bypass_controle_negatif.mjs
ae6d9f9d9dd54924d5419170c15f96e39e903d6790d9b9f9faec1333a0eb18f6  scripts/test_ressources_fixes_garde.mjs
84d210aab1a72f8d6ecf01e5370f43a23cc2a5d1d3b32fe1788e41f775d67acd  scripts/test_migration_atomicite_plm_dedup.mjs
f588c6242e70d96c82cb40c3d04d3327fed2a2d0ba243a8a3b01eef41d16507a  scripts/harnais_suites_rls.mjs
```

**Aucun commit, aucun push, aucun changement de `main`, aucun secret affiché.**
En attente d'autorisation explicite avant toute création de commit.
