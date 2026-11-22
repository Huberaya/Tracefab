# TRACEFAB — revue finale pré-commit (30/10/2026)

Revue de cohérence, du diff intégral et des preuves, sur l'arbre de travail **non
commité**.

> **État d'exécution de cette revue.** L'environnement a été réinitialisé entre
> les deux tours : `node_modules/` et les deux clusters PostgreSQL jetables
> (`/tmp/pgdata_tf`, `/tmp/pgdata_ci`) **n'existent plus**, et aucun serveur
> PostgreSQL ni `docker` n'est disponible. **Aucune exécution de base de données
> n'a donc été refaite dans ce tour.** Toutes les preuves d'exécution citées
> proviennent du tour précédent et **portent sur exactement les mêmes fichiers** :
> les SHA-256 des 33 fichiers de l'arbre sont identiques à ceux mesurés au moment
> des exécutions (relevé en §2.6). Ce tour ajoute des vérifications **statiques**
> (inventaires, recherches dans le diff, contrôles de syntaxe), pas de nouvelles
> mesures d'exécution.

---

## 1. Vérification de cohérence — qui utilise réellement quelle protection

### 1.1 Méthode

Inventaire exhaustif par recherche : tous les fichiers `scripts/**` ouvrant une
connexion PostgreSQL (`new pg.Client` / `new pg.Pool`), confrontés à trois
signaux : présence de la garde dans le fichier (`requireThrowawayDb` /
`assertThrowawayDb`), présence d'un `verrouillerCluster`, et mode d'invocation
réel (`package.json`, `.github/workflows/`, appels entre scripts).

### 1.2 Garde des bases éphémères (`scripts/lib/ephemeral-db.mjs`)

| Consommateur | Utilise | Preuve |
|---|---|---|
| `test_compteurs_debit.mjs` | `creerBaseEphemere` + `verrouillerCluster` | oui (import direct) |
| `test_isolation_lignes_reelles.mjs` | idem | oui |
| `test_neon_publication_deploiement.mjs` | idem | oui |
| `test_privileges_role_app.mjs` | idem | oui |
| `test_provisioning_role_app.mjs` | idem | oui |
| `test_sonde_identite_runtime.mjs` | idem | oui |
| `harnais_suites_rls.mjs` (nouveau) | `creerBaseEphemere`, `filetDeNettoyage` | oui |
| `test_base_ephemere_garde.mjs` | met la garde à l'épreuve | oui |
| `test_migration_atomicite_plm_dedup.mjs` (nouveau) | `creerBaseEphemere` | oui |
| `scripts/lib/base_jetable.mjs` (nouveau) | `deriverUrl` + `verrouillerCluster` | oui |
| `db-deploy-throwaway.mjs`, `migrer_fidelement.mjs`, `seed_rls_fixture.mjs` | `verrouillerCluster` seulement | oui (pas de base à créer) |

### 1.3 Garde des rôles éphémères (`scripts/lib/ephemeral-role.mjs`)

Consommateurs : `test_role_ephemere_garde.mjs`, `test_rls_bypass_controle_negatif.mjs`,
`test_rls_write_policies.mjs`, `test_neon_security.mjs`, `test_neon_product_flow.mjs`,
`test_neon_supplier_advanced.mjs`, `test_migration_owner_guard.mjs`,
`test_objectifs_…` (cf. `grep -l nomRoleEphemere scripts/*.mjs`).

Vérifié : **plus aucun `DROP ROLE IF EXISTS <nom fixe>` préventif** dans le diff
(suppressions comptées en §2.1).

### 1.4 Verrou consultatif de cluster (`738241901`)

| Chemin | Prend le verrou | Comment |
|---|---|---|
| `test_compteurs_debit`, `test_isolation_lignes_reelles`, `test_privileges_role_app`, `test_provisioning_role_app`, `test_neon_publication_deploiement`, `seed_rls_fixture`, `migrer_fidelement`, `db-deploy-throwaway`, `harnais_suites_rls` | oui | dans le script |
| `audit_sql_privileges_catalog.sh`, `test_migration_integration_34_36_41.sh` | oui (nouveau) | via `run-db-suite.mjs --verrou-cluster` |
| `test_ressources_fixes_garde.mjs` | oui (nouveau) | autour des sections qui touchent `pg_authid` |
| `test_verrou_cluster.mjs` | oui | éprouve le verrou lui-même |

### 1.5 Lanceur commun (`scripts/run-db-suite.mjs`)

Toutes les entrées `npm run test:neon:*` destructives passent par lui, **sauf
quatre** (voir §1.7). Le lanceur applique `requireThrowawayDb` sur les variables
**présentes** (`DATABASE_URL`, `TF_RLS_APP_URL`) : vérifié dans le code, et
éprouvé par `test_db_throwaway_entrypoints.mjs` (exit 0).

### 1.6 Scripts Prisma et shell

- **Prisma** : `test_neon_security`, `test_neon_product_flow`,
  `test_neon_supplier_advanced` (via `npm run test:neon:*` → lanceur), et
  `test_neon_publication_deploiement` (lanceur). Tous protégés par le lanceur ;
  aucun ne l'appelle directement.
- **Shell** : les deux scripts d'intégration ont été alignés ce tour
  (`reset_db()` → garde, `prepare_role()` → verrou). Vérifié verbatim :

```bash
reset_db() {
  local code=0
  node scripts/run-db-suite.mjs scripts/reinitialiser_base_jetable.mjs || code=$?
  case "$code" in
    0) ;;
    2|3) refuse "base tracefab_test non prouvee jetable — CONSERVEE (code $code)" ;;
    *) fail "remise a zero de tracefab_test (code $code)" ;;
  esac
  echo "ok    base tracefab_test recreee vide"
}
prepare_role() { node scripts/run-db-suite.mjs --verrou-cluster scripts/prepare_ci_db_role.mjs; }
```

**Invariant à ne pas casser** : `reset_db()` ne doit **jamais** ajouter
`--verrou-cluster` — `reinitialiserBaseJetable()` prend déjà le verrou
lui-même, et un verrou consultatif n'est pas réentrant entre deux sessions
(interblocage). Documenté ici, pas encore asserté par un test.

### 1.7 Chemins qui contournent encore les protections (identifiés, **non corrigés**)

Recherche : scripts ouvrant une connexion PostgreSQL, **sans** garde dans le
fichier, **et** invoqués directement par `package.json` ou la CI.

| Chemin | Invocation | Écrit ? | Garde actuelle | Verdict |
|---|---|---|---|---|
| `test_dpp_role_applicatif.mjs` | `npm run test:dpp:role-applicatif` → `node scripts/…` | oui (`UPDATE dpp_records`) | liste noire d'**un** hôte de production + `TF_RLS_APP_URL` obligatoire | **contourne** le classifieur : tout autre hôte est accepté |
| `valider_branche_dpp.mjs` | `npm run test:dpp:branche` | oui (DELETE/INSERT/UPDATE) | même liste noire + `DATABASE_URL` | **contourne** |
| `mesure_effet_migrations_dpp.mjs` | `npm run db:mesure-dpp` | oui (INSERT/UPDATE, parc synthétique) | même liste noire | **contourne** |
| `test_registre_fonctions_runtime.mjs` | `npm run test:neon:registre-fonctions` | **non** (lectures seules ; les `GRANT`/`INSERT` trouvés sont dans des commentaires) | aucune | lecture seule : risque faible, écart de cohérence |
| `test_worker_non_forgeable.mjs` | `npm run test:neon:worker-non-forgeable` | non | exige `DATABASE_URL` + `TF_RLS_APP_URL`, refuse un rôle privilégié | lecture seule |
| `test_migration_owner_guard.mjs` | **directement dans `ci.yml`** | oui (CREATE/DROP role de sonde, DROP/CREATE FUNCTION) | garde **maison** : `localhost` + base littérale `/tracefab_test`, nom de rôle unique + OID | refus par défaut, mais **ne passe pas** par `requireThrowawayDb` (pas de `hostaddr`, pas de `host=`, pas de liste noire d'hôtes managés) |
| scripts `db:lire-*`, `db:preflight`, `audit:privileges`, `verifier:identite-cible`, `preuve:bypass-worker`, `simuler:recalcul-dpp` | directs | non (vérifié : 0 écriture) | aucune | lecture seule |

Aucun de ces chemins n'a été introduit par ce chantier : ils existent sur `main`.
Ils ne sont **pas** corrigés ici (périmètre validé, et aucune exécution possible
ce tour pour prouver une correction). Recommandation en §5.

### 1.8 Chemin non protégé par OID qui subsiste : `ensureAppRole`

`scripts/lib/tracefab_app_role.mjs` → `ensureAppRole()` reste, pour le rôle
`tracefab_app` **partagé**, sur le schéma historique : lecture `pg_roles`, puis
`CREATE` **ou** `ALTER ROLE … PASSWORD …`, avec reprise sur `XX000`/`42710`,
**sans** refus d'un rôle préexistant privilégié et **sans** comparaison d'OID.
`prepare_ci_db_role.mjs` a été durci ; son homologue `ensureAppRole` non.

Portée du risque : il réécrirait le mot de passe d'un `tracefab_app`
préexistant (et rabaisserait ses attributs à `NOSUPERUSER NOBYPASSRLS…`), pas
d'un rôle arbitraire. Consommateurs : `db-deploy-throwaway.mjs`,
`seed_rls_fixture.mjs`, `migrer_fidelement.mjs`, `bootstrap_app_role.mjs`.
**Constat, non corrigé** : la correction toucherait trois chemins validés et
n'est pas mesurable ce tour.

---

## 2. Revue du diff intégral

Périmètre : 19 fichiers suivis (`git diff`) + 14 fichiers non suivis, soit
`+790 / −153`.

### 2.1 Suppressions de bases et de rôles

**Avant → après**, mesuré sur le diff :

- lignes **supprimées** contenant `DROP DATABASE … IF EXISTS` : **9** ;
- lignes **supprimées** contenant `DROP ROLE IF EXISTS` : **5** ;
- toute instruction `DROP DATABASE` **ajoutée** est de la forme
  `DROP DATABASE ${ident(nom)} WITH (FORCE)` — identifiant validé par
  `^[a-z][a-z0-9_]*$` **et** nom en liste fermée, précédé d'une preuve d'OID
  (`base_jetable.mjs:194`, `:241`, `ephemeral-db.mjs:235`) ;
- `DROP OWNED BY ${ident(nom)}` / `DROP ROLE ${ident(nom)}`
  (`ephemeral-role.mjs:177-178`) : OID revérifié juste avant ;
- **aucun** `DROP … IF EXISTS` de nettoyage préventif n'a été ajouté.

Occurrences restantes de `DROP DATABASE IF EXISTS` : uniquement dans
`test_base_ephemere_garde.mjs` (le test qui **crée exprès** des homonymes pour
prouver le refus) et dans des commentaires.

### 2.2 Interpolations SQL (recherche exhaustive des `query(\`…${…}\`)`)

| Fichier | Sites | Protection |
|---|---|---|
| `scripts/lib/base_jetable.mjs` | 4 | `ident()` (liste fermée + regex) ; `MARQUE` est une **constante** du module |
| `scripts/prepare_ci_db_role.mjs` | 2 (`CREATE`/`ALTER ROLE`) | `ident(APP_ROLE)` + `quote(password)` ; `APP_ROLE` borné à `tracefab_app` ou `tf_*` |
| `scripts/lib/ephemeral-role.mjs` | 1 | `ident()` + `litteral()` (mot de passe) |
| `scripts/harnais_suites_rls.mjs`, `run-db-suite.mjs`, `reinitialiser_base_jetable.mjs` | **0** | — |

**Contrôle hostile** (exécuté au tour précédent, traces conservées) :
`test_role_ephemere_garde.mjs` passe des noms tels que
`x"; DROP ROLE postgres; --` et `1 interdit; DROP ROLE postgres` : refus attendu
et obtenu. Côté bases, `test_ressources_fixes_garde.mjs` prouve le refus de
`postgres` (hors liste fermée) et la conservation de la base `postgres`.

### 2.3 Créations de rôles

Tous les `CREATE ROLE` ajoutés passent par un nom **unique** et/ou une liste
fermée : `ephemeral-role.mjs` (nom généré + OID), `prepare_ci_db_role.mjs`
(liste fermée + OID + refus si privilégié), `test_ressources_fixes_garde.mjs`
(`tf_garde_*`, fixture du test), `test_role_ephemere_garde.mjs` (fixtures
volontairement hostiles). Les autres `CREATE ROLE` du dépôt sont dans des scripts
**PGlite** (base en mémoire, aucun cluster).

### 2.4 Connexions PostgreSQL non protégées

- Les **nouveaux** fichiers déclarent tous `import { requireThrowawayDb }` et
  l'appellent ; `base_jetable.mjs` reclassifie **en interne** chaque URL
  (source, maintenance, base de travail) — vérifié par lecture.
- Les modules `base_jetable.mjs`, `ephemeral-db.mjs`, `ephemeral-role.mjs`
  n'appellent pas `requireThrowawayDb` : ce sont eux qui **appliquent**
  `classifyTarget` (vérifié : `classifyTarget` importé et testé dans les trois).
- Les connexions sans garde sont celles du §1.7 (préexistantes).

### 2.5 Applications de migrations hors verrou

| Script | Applique la chaîne ? | Verrou |
|---|---|---|
| `test_compteurs_debit.mjs` | oui (66 fichiers) | oui |
| `test_isolation_lignes_reelles.mjs` | oui | oui |
| `test_neon_publication_deploiement.mjs` | oui | oui |
| `harnais_suites_rls.mjs` | oui (66) | **oui, puis relâché avant les suites** (sinon interblocage mesuré : 15 min) |
| `db-deploy-throwaway.mjs`, `migrer_fidelement.mjs` | oui (`prisma migrate deploy`) | oui |
| `test_migration_owner_guard.mjs` | **partiel** : rejoue un unique bloc `DO $owner_guard$` extrait d'une migration | **non** — mais ne modifie pas la chaîne, et garde maison localhost |
| `test_registre_fonctions_runtime.mjs` | non (lit les fichiers) | — |

Aucun chemin n'applique la chaîne de migrations sur un cluster partagé sans
verrou, à l'exception du cas partiel documenté ci-dessus.

### 2.6 Nettoyage et interruptions

| Fichier | Nettoyage | Interruption |
|---|---|---|
| `base_jetable.mjs` | `finally` (4) : `admin.end()` + `verrou.relacher()`, même si le refus est levé | verrou libéré avec la session |
| `harnais_suites_rls.mjs` | `finally` + `filetDeNettoyage` (uncaught/unhandled) ; base détruite avec OID vérifié | **SIGKILL = fuite** (mesuré une fois, détecté puis supprimé à la main) |
| `test_ressources_fixes_garde.mjs` | nettoyage explicite après chaque phase + section D qui vérifie l'absence de résidu | **SIGINT = résidu `tf_garde_*`** (noms uniques, sans effet sur les autres) |
| `test_migration_atomicite_plm_dedup.mjs` | `finally` + `base.fermer()` | idem garde |
| `run-db-suite.mjs` | `verrou.relacher()` sur `exit` **et** `error` | verrou rendu avec la session |
| `prepare_ci_db_role.mjs` | `finally` : `client.end()` | aucune ressource créée hors rôle applicatif |

### 2.7 Dépendances entre scripts (graphe)

```
run-db-suite.mjs ──> lib/require-throwaway-db.mjs, lib/choose-suite-loader.mjs
                 └─(--verrou-cluster)─> lib/ephemeral-db.mjs

reinitialiser_base_jetable.mjs ──> lib/base_jetable.mjs ──> lib/ephemeral-db.mjs
                                                        └─> lib/require-throwaway-db.mjs, lib/pg-ssl.mjs

harnais_suites_rls.mjs ──> lib/ephemeral-db.mjs, lib/tracefab_app_role.mjs
                       └─(enfants)─> seed_rls_fixture.mjs ──> lib/tracefab_app_role.mjs
                                                                lib/ephemeral-db.mjs

audit_sql_privileges_catalog.sh ──> run-db-suite ──> reinitialiser_base_jetable.mjs
                                └─> run-db-suite --verrou-cluster ──> prepare_ci_db_role.mjs
idem pour test_migration_integration_34_36_41.sh

test_ressources_fixes_garde.mjs ──> lib/base_jetable.mjs, lib/ephemeral-db.mjs
                               └─(enfants)─> prepare_ci_db_role.mjs, run-db-suite.mjs, reinitialiser_base_jetable.mjs
```

**Aucun cycle d'import** ; aucun script n'appelle un porteur de verrou en le
détenant déjà (les seuls appels imbriqués passent par des processus distincts
sans verrou transmis).

### 2.8 Absence de régression — contrôles statiques

- `node --check` sur les 33 fichiers `.mjs` de l'arbre : **0 erreur**.
- `bash -n` sur les 18 scripts `.sh` : **0 erreur**.
- `git status` : **19 modifiés / 14 non suivis**, inchangé (aucun fichier
  `prisma/`, `api/`, `package.json`, `.github/` touché).
- Les deux régressions trouvées au tour précédent (imports manquants dans
  `test_rls_write_policies.mjs` et `test_rls_bypass_controle_negatif.mjs`) sont
  corrigées ; les deux suites sont passées vertes (cf. §3).

---

## 3. Vérification des résultats — matrice stricte

Quatre catégories, sans mélange.

### 3.1 Tests exécutés et réussis (exit 0, tour précédent, fichiers identiques)

| # | Suite | Exit | Assertions |
|---|---|---|---|
| 1 | `test_base_ephemere_garde.mjs` | 0 | garde des bases |
| 2 | `test_db_throwaway_entrypoints.mjs` | 0 | lanceur / garde de cible |
| 3 | `test_role_ephemere_garde.mjs` | 0 | garde des rôles |
| 4 | `test_verrou_cluster.mjs` | 0 | **27/27** |
| 5 | `test_concurrence_suites.mjs` | 0 | **9/9** |
| 6 | `test_ressources_fixes_garde.mjs` | 0 | **40/40** |
| 7 | `test_migration_atomicite_plm_dedup.mjs` | 0 | **16/16** |
| 8 | `test_plm_erp_policy_dedup.mjs` | 0 | 7/7 |
| 9 | `test_plm_migrations_correctives_jumelles.mjs` | 0 | 13/13 |
| 10 | `test_provenance_politiques_plm.mjs` | 0 | conforme |
| 11 | `test_migration_owner_guard.mjs` | 0 | PASS |
| 12 | `test_isolation_lignes_reelles.mjs` | 0 | conforme |
| 13 | `test_compteurs_debit.mjs` | 0 | conforme |
| 14 | `test_privileges_role_app.mjs` | 0 | **40/40** |
| 15 | `test_provisioning_role_app.mjs` | 0 | conforme |
| 16 | `test_sonde_identite_runtime.mjs` | 0 | conforme |
| 17 | `harnais_suites_rls.mjs` → `test_rls_write_policies.mjs` | 0 | 15 assertions |
| 18 | `harnais_suites_rls.mjs` → `test_rls_bypass_controle_negatif.mjs` | 0 | 6 assertions |

**Contrôles négatifs exécutés, qui échouent comme attendu** : 6 dérives
`COMPTEURS_CONTROLE_NEGATIF` (exit 1 chacune), témoin sans `--verrou-cluster`
(exit 1), `prepare_ci_db_role` sur rôle SUPERUSER (exit 2), sur `postgres`
(exit 2), `reinitialiser_base_jetable` sur base remplie (exit 2), `reset_db()`
extrait verbatim (exit 2).

### 3.2 Tests exécutés et échoués

| Suite | Exit | Cause |
|---|---|---|
| `test_neon_publication_deploiement.mjs` | **1** | sections A→E vertes ; **section F** : `PrismaClientInitializationError: The adapter option is required` — moteurs Prisma non téléchargeables ici (§4) |
| `test_concurrence_suites.mjs` (1er passage) | 1 | base `tf_harnais_rls_*` laissée par un run tué à 900 s → résidu détecté, puis supprimé ; repassé à **9/9** |
| `test_verrou_cluster.mjs` (passage intermédiaire) | 1 | `harnais_suites_rls.mjs` non encore classé parmi les porteurs → ajouté ; repassé à **27/27** |
| `test_ressources_fixes_garde.mjs` (passages intermédiaires) | 1 | deux défauts **du test lui-même** (comptage d'une table après recréation ; rôle `tf_garde_refus` laissé par un essai manuel) ; corrigés, puis **40/40** |

### 3.3 Tests non exécutés

| Suite | Raison exacte |
|---|---|
| `test_neon_security.mjs` | `PrismaClient` sans adapter (même cause que §4) |
| `test_neon_product_flow.mjs` | idem |
| `test_neon_supplier_advanced.mjs` | idem |
| `bash scripts/audit_sql_privileges_catalog.sh` (bout en bout) | exige `node_modules/.bin/prisma` fonctionnel **et** les objets git `19a867a…`, `6d785dc…`, `c75ee3e…` (clone superficiel) |
| `bash scripts/test_migration_integration_34_36_41.sh` (bout en bout) | idem |
| Section F du harnais de publication | §4 |
| Toute la campagne ce tour | environnement réinitialisé (ni `node_modules`, ni serveur PostgreSQL) |

### 3.4 Protections testées **uniquement sur des fonctions extraites** ou statiquement

| Preuve | Ce qu'elle prouve | Ce qu'elle **ne** prouve pas |
|---|---|---|
| `reset_db()` **extrait verbatim** des deux `.sh`, exécuté | la garde s'applique et sort en 2 sur base remplie | que le script complet va jusqu'au bout (préflight, migrations, scénarios A/B) |
| assertions statiques sur les `.sh` | la garde et `--verrou-cluster` sont **câblés** | qu'ils s'exécutent sans erreur |
| témoin `--verrou-cluster` (DETENTEURS=1 / 0) | le lanceur prend et relâche vraiment le verrou | que `prepare_ci_db_role` se comporte bien sous collision réelle |
| `test_verrou_cluster.mjs` §A | chaque chemin **déclaré** porte le verrou | qu'aucun chemin inconnu ne l'omet (la découverte ne couvre que les marqueurs listés) |
| `prepare_ci_db_role.mjs` | testé **entier**, en vrai (refus SUPERUSER, OID, mot de passe conservé) | son comportement sous `XX000` concurrent (reprise non exercée) |

### 3.5 Chemins nominaux non exécutés

1. `prisma migrate deploy` réel (`db-deploy-throwaway.mjs`, `migrer_fidelement.mjs`) : non exécuté ce tour.
2. Les scénarios A (installation neuve) et B (10120000 tardif) des deux `.sh`.
3. `prepare_ci_db_role.mjs` sur une base **vierge** de CI réelle (testé sur cluster local).
4. La création du rôle par `ensureAppRole` avec collision simultanée (reprise `XX000`) : non rejouée ce tour.
5. Application réelle de `20261029180000` par Prisma (elle est incluse, non exécutée, dans la chaîne des 66 du harnais : le harnais compte « 66 migrations appliquées » en lisant les fichiers, sans CLI Prisma).

---

## 4. Prisma et migration

### 4.1 Conditions précises pour exécuter la section F **avec le comportement réel de l'application**

Constat de départ, vérifié :

- `prisma/schema.prisma` : `generator client { provider = "prisma-client-js" }`, **sans** `engineType` ni `previewFeatures` ;
- `api/_lib/prisma.ts` : `new PrismaClient()` — **aucun** `adapter` ;
- `@prisma/adapter-pg@6.19.3` est **installé** mais **jamais importé** par le code applicatif ;
- le client actuellement généré dans cet environnement l'a été en WASM (contrainte réseau), d'où l'exigence d'un adapter qu'il ne peut pas recevoir.

**Pour exécuter F tel que l'application fonctionne réellement (moteur natif)** :

1. accès réseau à `binaries.prisma.sh` (ou cache de moteurs pré-rempli) ;
2. `npx prisma generate` **sans** `PRISMA_CLIENT_FORCE_WASM` / `PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING` ;
3. vérifier la présence de `node_modules/.prisma/client/libquery_engine-*.so.node` ;
4. une base PostgreSQL ≥ 16 **jetable**, migrée (66 migrations) et peuplée des fixtures de publication ;
5. `DATABASE_URL` (propriétaire) + `TF_RLS_APP_URL` (rôle `tracefab_app`) sur la **même** base, `TF_APP_PASSWORD` posé ;
6. lancer `node scripts/run-db-suite.mjs scripts/test_neon_publication_deploiement.mjs`.

**Variante « adapter réel »** (`@prisma/adapter-pg`), si l'on voulait exécuter F
sans moteur natif : elle exige de **modifier le code applicatif** —
`new PrismaClient({ adapter: new PrismaPg({ connectionString }) })` dans
`api/_lib/prisma.ts` (et l'alignement de `prisma/schema.prisma`). Cela
changerait ce que F mesure (ce ne serait plus le client de production) et
contreviendrait à la consigne « ne pas modifier l'architecture applicative pour
faire passer le test ». **Refusé.** Aucun contournement de type mock/loader n'a
été tenté pour la même raison.

**Statut de F : NON EXÉCUTÉ.** Aucun vert n'est revendiqué.

### 4.2 La migration `20261029180000` n'a subi aucune modification — **prouvé**

```
sha256sum prisma/migrations/20261029180000_plm_erp_sync_jobs_policy_dedup/migration.sql
  896dfad2f465908a8299f3639eb246292ba1b806ae13bfd3b3cf6218fdf6801f
git show HEAD:prisma/migrations/…/migration.sql | sha256sum
  896dfad2f465908a8299f3639eb246292ba1b806ae13bfd3b3cf6218fdf6801f
git diff --stat -- prisma/      → (vide)
git status --porcelain -- prisma/ → (vide)
```

Les 66 dossiers de migration sont présents, **aucun** n'est modifié, ajouté ou
supprimé. Aucune preuve n'a nécessité d'accès à la production : toutes les
mesures viennent de bases jetables locales.

---

## 5. Livrable

### 5.1 SHA exact

| Élément | Valeur |
|---|---|
| `HEAD` | `5ed2745c8c38ea8eeb1b4f09140869611f0dc933` (**inchangé, aucun commit créé**) |
| Branche | `arena/96848462-tracefab` |
| `main` de référence | `bf55f2ae6534cde84d072d9b975520216c7b6d4e` |

### 5.2 État Git complet

```
 M scripts/audit_sql_privileges_catalog.sh
 M scripts/db-deploy-throwaway.mjs
 M scripts/lib/tracefab_app_role.mjs
 M scripts/migrer_fidelement.mjs
 M scripts/prepare_ci_db_role.mjs
 M scripts/run-db-suite.mjs
 M scripts/seed_rls_fixture.mjs
 M scripts/test_compteurs_debit.mjs
 M scripts/test_isolation_lignes_reelles.mjs
 M scripts/test_migration_integration_34_36_41.sh
 M scripts/test_migration_owner_guard.mjs
 M scripts/test_neon_product_flow.mjs
 M scripts/test_neon_publication_deploiement.mjs
 M scripts/test_neon_security.mjs
 M scripts/test_neon_supplier_advanced.mjs
 M scripts/test_privileges_role_app.mjs
 M scripts/test_rls_bypass_controle_negatif.mjs
 M scripts/test_rls_write_policies.mjs
 M scripts/test_sonde_identite_runtime.mjs
?? docs/security/2026-10-30-revue-precommit.md
?? docs/security/2026-10-30-cloture-risques-rapport.md
?? docs/security/2026-10-30-tests-db-destructifs-rapport.md
?? scripts/harnais_suites_rls.mjs
?? scripts/lib/base_jetable.mjs
?? scripts/lib/ephemeral-db.mjs
?? scripts/lib/ephemeral-role.mjs
?? scripts/reinitialiser_base_jetable.mjs
?? scripts/test_base_ephemere_garde.mjs
?? scripts/test_concurrence_suites.mjs
?? scripts/test_migration_atomicite_plm_dedup.mjs
?? scripts/test_provisioning_role_app.mjs
?? scripts/test_ressources_fixes_garde.mjs
?? scripts/test_role_ephemere_garde.mjs
?? scripts/test_verrou_cluster.mjs
```

Hors `scripts/` et `docs/security/` : **aucun** fichier modifié (ni `prisma/`,
ni `api/`, ni `package.json`, ni `.github/`).

### 5.3 Fichiers modifiés et nouveaux

**Modifiés (19)** — voir la liste `M` ci-dessus.
**Nouveaux (14)** :

| Fichier | Rôle |
|---|---|
| `scripts/lib/base_jetable.mjs` | garde de remise à zéro d'une base fixe (marque, OID, verrou) |
| `scripts/reinitialiser_base_jetable.mjs` | CLI utilisée par les deux `.sh` |
| `scripts/lib/ephemeral-db.mjs` | garde des bases éphémères + verrou de cluster + filet |
| `scripts/lib/ephemeral-role.mjs` | garde des rôles éphémères |
| `scripts/harnais_suites_rls.mjs` | base migrée + fixtures + suites RLS |
| `scripts/test_base_ephemere_garde.mjs` | épreuve de la garde des bases |
| `scripts/test_role_ephemere_garde.mjs` | épreuve de la garde des rôles |
| `scripts/test_verrou_cluster.mjs` | couverture / détention / libération du verrou |
| `scripts/test_concurrence_suites.mjs` | deux suites en parallèle, sérialisation |
| `scripts/test_ressources_fixes_garde.mjs` | bases fixes + rôles préexistants + verrou du provisioning |
| `scripts/test_provisioning_role_app.mjs` | provisioning par table, idempotent |
| `scripts/test_migration_atomicite_plm_dedup.mjs` | atomicité de `20261029180000` |
| `docs/security/2026-10-30-tests-db-destructifs-rapport.md` | rapport du 30/10 (tour précédent) |
| `docs/security/2026-10-30-cloture-risques-rapport.md` | rapport de clôture (7 points) |

### 5.4 Résumé du diff

`19 files changed, 790 insertions(+), 153 deletions(-)`.

| Thème | Fichiers | Effet |
|---|---|---|
| Gardes des bases / rôles | `lib/base_jetable.mjs`, `reinitialiser_base_jetable.mjs`, `lib/ephemeral-db.mjs`, `lib/ephemeral-role.mjs` | noms uniques, preuve d'OID, aucun `DROP` préventif, refus par défaut |
| Verrou de cluster | `run-db-suite.mjs`, deux `.sh`, `db-deploy-throwaway`, `migrer_fidelement`, `seed_rls_fixture`, suites | `--verrou-cluster` + verrou dans chaque porteur |
| Provisioning du rôle | `prepare_ci_db_role.mjs`, `lib/tracefab_app_role.mjs` | refus sans écriture, OID comparé, reprise `XX000` |
| Suites migrées vers la garde | 9 suites `test_*` | plus de nom fixe, plus de `DROP IF EXISTS` |
| Documentation | 2 rapports | preuves et matrice |
| Tests nouveaux | 6 suites + 1 harnais | 40 + 16 + 27 + 9 + 15 + 6 assertions |

### 5.5 Empreinte SHA-256

| Objet | SHA-256 |
|---|---|
| `git diff` (fichiers suivis) | `e62aea90c7074e78425643a0b89e2a9040d34ece786434657566b8ee80352e7e` |
| `prisma/migrations/20261029180000_…/migration.sql` | `896dfad2f465908a8299f3639eb246292ba1b806ae13bfd3b3cf6218fdf6801f` |
| `scripts/lib/base_jetable.mjs` | `c6563357eb51e951dd3b69fb7b24d2a6f0c5de2db903f04218ba112133f84aa8` |
| `scripts/reinitialiser_base_jetable.mjs` | `7b03c738da3b547d60d5526167882b969acbe4a91666cb78fc82dee5595db820` |
| `scripts/prepare_ci_db_role.mjs` | `67d485098a0994c673b4e2fc971cc89c70ded07af0e04e0a7ef829bc0772e858` |
| `scripts/run-db-suite.mjs` | `bcf3901fed281a103e2d049f3a37e84ffc6991afe09b5afe0f496ac6e50d6b09` |
| `scripts/harnais_suites_rls.mjs` | `f588c6242e70d96c82cb40c3d04d3327fed2a2d0ba243a8a3b01eef41d16507a` |
| `scripts/test_ressources_fixes_garde.mjs` | `ae6d9f9d9dd54924d5419170c15f96e39e903d6790d9b9f9faec1333a0eb18f6` |
| `scripts/test_migration_atomicite_plm_dedup.mjs` | `84d210aab1a72f8d6ecf01e5370f43a23cc2a5d1d3b32fe1788e41f775d67acd` |
| `scripts/test_verrou_cluster.mjs` | `9f80a785404f58a291cc1346f23cf6d1f00b5d68bec396485bceba41e55c0547` |
| `scripts/test_concurrence_suites.mjs` | `330305457ee63fcb7120714d0679f43e4d456c0591273d481d3e1e455a7b6d21` |
| `scripts/lib/ephemeral-db.mjs` | `bc2f9300f3099593874f6fdb69698c76ac9cf979645944779449ee3dfdacc927` |
| `scripts/lib/ephemeral-role.mjs` | `a400247bc4bfd2491bdfa020f65e8759bced77d3ebae028add13a34ea117c935` |
| `scripts/audit_sql_privileges_catalog.sh` | `ef1b7cdff613e83de6cd83fab22a517e9689d6acde9a8bd97cda69790d667355` |
| `scripts/test_migration_integration_34_36_41.sh` | `2b3a459410eba5a8be771173dd55fc826134df9e1332d71e8a432ea1cd01c295` |

(Empreintes complètes des 33 fichiers : `git status` + `sha256sum`, reproductible.)

### 5.6 Matrice finale des tests

| Suite | Garde | Verrou | Exécutée | Exit | Porte sur |
|---|---|---|---|---|---|
| `test_base_ephemere_garde` | oui | — | oui | 0 | garde bases |
| `test_role_ephemere_garde` | oui | — | oui | 0 | garde rôles |
| `test_verrou_cluster` | oui | oui | oui | 0 (27/27) | verrou |
| `test_concurrence_suites` | oui | oui | oui | 0 (9/9) | sérialisation |
| `test_ressources_fixes_garde` | oui | oui | oui | 0 (40/40) | bases fixes + rôles + verrou |
| `test_db_throwaway_entrypoints` | oui | — | oui | 0 | lanceur |
| `test_migration_atomicite_plm_dedup` | oui | — | oui | 0 (16/16) | atomicité migration |
| `test_plm_erp_policy_dedup` | — | — | oui | 0 (7/7) | statique |
| `test_plm_migrations_correctives_jumelles` | — | — | oui | 0 (13/13) | statique |
| `test_provenance_politiques_plm` | — | — | oui | 0 | statique |
| `test_migration_owner_guard` | maison | non | oui | 0 | garde SQL propriétaire |
| `test_isolation_lignes_reelles` | oui | oui | oui | 0 | RLS sur lignes |
| `test_compteurs_debit` | oui | oui | oui | 0 | limiteur |
| `test_privileges_role_app` | oui | oui | oui | 0 (40/40) | privilèges |
| `test_provisioning_role_app` | oui | oui | oui | 0 | provisioning |
| `test_sonde_identite_runtime` | oui | oui | oui | 0 | identité runtime |
| `test_rls_write_policies` | lanceur | — | oui (harnais) | 0 | politiques d'écriture |
| `test_rls_bypass_controle_negatif` | lanceur | — | oui (harnais) | 0 | contrôle négatif RLS |
| **`test_neon_publication_deploiement`** | **lanceur** | oui | **oui** | **1** | A→E vertes, **F impossible** |
| `test_neon_security` | lanceur | — | **non** | — | Prisma |
| `test_neon_product_flow` | lanceur | — | **non** | — | Prisma |
| `test_neon_supplier_advanced` | lanceur | — | **non** | — | Prisma |
| deux scripts `.sh` | garde + lanceur | oui | **non** (bout en bout) | — | intégration 34/36/41 |
| `test_dpp_role_applicatif` | **aucune** (liste noire) | — | non | — | — |
| `valider_branche_dpp` | **aucune** (liste noire) | — | non | — | — |
| `mesure_effet_migrations_dpp` | **aucune** (liste noire) | — | non | — | — |

### 5.7 Risques résiduels

| # | Risque | Gravité | État |
|---|---|---|---|
| R1 | Section F non exécutée (moteurs Prisma indisponibles) | moyenne (preuve manquante, pas défaut produit) | ouvert, conditions en §4.1 |
| R2 | 3 suites Prisma non exécutées | moyenne | ouvert |
| R3 | 3 scripts destructifs hors garde, sur liste noire d'un seul hôte (`test_dpp_role_applicatif`, `valider_branche_dpp`, `mesure_effet_migrations_dpp`) | **élevée** si lancés avec `DATABASE_URL` d'un environnement non prévu | **ouvert, préexistant** (§1.7) |
| R4 | `ensureAppRole` sans refus d'un rôle préexistant privilégié ni preuve d'OID | moyenne | **ouvert, préexistant** (§1.8) |
| R5 | `--verrou-cluster` est **fail-open** : si le verrou ne peut pas être pris, le lanceur avertit et exécute quand même | faible (reprise `XX000` côté `prepare_ci_db_role`) | ouvert, choix documenté |
| R6 | Interruption brutale d'un test ⇒ base `tf_*` ou rôles `tf_garde_*` laissés | faible (noms uniques) | ouvert, détecté par `test_concurrence_suites` |
| R7 | Aucune suite de ce chantier n'est branchée dans la CI | moyenne (non-régression non gardée) | ouvert, choix de périmètre |
| R8 | `test_verrou_cluster` §A ne découvre que les marqueurs listés | faible | accepté |
| R9 | Invariant « `reset_db()` sans `--verrou-cluster` » non asserté | faible | ouvert (§1.6) |
| R10 | Reprise `XX000` de `prepare_ci_db_role` jamais exercée sous concurrence réelle | faible | non prouvé |

### 5.8 Recommandation motivée sur l'opportunité d'un commit

**Recommandation : commit de l'arbre actuel dans un commit unique, sans attendre
la fermeture de R1/R2, puis traiter R3/R4 dans un chantier dédié.**

Motifs **pour** :

1. Les trois risques P0 de la mission sont **fermés et mesurés** : migration
   atomique sans modification, `DROP DATABASE` fixe supprimé des deux `.sh`,
   rôles préexistants conservés, provisioning isolé verrouillé.
2. Le diff est **exclusivement** dans `scripts/` et `docs/security/` ; aucun
   fichier applicatif, aucune migration, aucun workflow, aucun `package.json`
   n'est touché — le risque de régression applicative est nul par construction.
3. Les preuves sont **datées et attachées à des empreintes** : les 33 fichiers
   ont les mêmes SHA-256 qu'au moment des 18 exécutions vertes et des 11
   contrôles négatifs ; l'arbre est cohérent (`node --check` 33/33, `bash -n`
   18/18).
4. Laisser l'arbre non commité plus longtemps fait courir le risque de perdre
   des travaux volumineux (14 fichiers nouveaux) sans possibilité de relancer
   les tests dans cet environnement.
5. R1/R2 ne sont **pas** des régressions : ils sont identiques avant et après
   (`main` ne les exécute pas non plus dans cet environnement). Les inclure
   n'aggrave rien.

Motifs **contre**, à assumer explicitement dans le message de commit :

- R3 et R4 sont **réels** et restent ouverts : trois scripts destructifs ne
  passent pas par la garde, et `ensureAppRole` n'a pas la protection de son
  homologue `prepare_ci_db_role`. Un commit qui présente le chantier comme
  « gardes complètes » serait trompeur.
- R7 : sans branchement CI, la non-régression dépend de la discipline.

**Formulation proposée pour le commit (si vous l'autorisez)** : un seul commit,
message indiquant (a) ce qui est fermé, (b) que la section F et 3 suites Prisma
sont **non exécutées** et pourquoi, (c) que R3/R4 sont identifiés et reportés.
Suggestion de découpage si vous préférez deux commits : (1) gardes + verrou +
tests ; (2) rapports. Aucun commit ne sera créé sans votre autorisation.

---

## 6. Ce que cette revue ne prouve pas

- Elle ne prouve pas que les deux scripts `.sh` fonctionnent de bout en bout :
  seules leurs briques (garde, verrou, assertions statiques) sont prouvées.
- Elle ne prouve pas le comportement de `prisma migrate deploy` réel, ni la
  section F, ni les trois suites Prisma.
- Elle ne prouve pas l'absence de chemins de contournement **futurs** : seuls
  les chemins présents dans l'arbre ont été inventoriés.
- Les inventaires §1 et §2 sont **statiques** : ils portent sur le texte des
  scripts et sur le diff, pas sur des exécutions faites ce tour.
