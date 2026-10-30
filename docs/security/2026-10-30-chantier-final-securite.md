# TRACEFAB — Chantier final de sécurité : R9, R7, R11/R12/R13, R6

Branche `arena/96848462-tracefab`, HEAD `5ed2745c8c38ea8eeb1b4f09140869611f0dc933`.
**Aucun commit, aucun push, aucun merge, aucun rebase, aucun reset.** Aucun accès
en écriture à la production, aucun secret lu ni modifié, aucune migration touchée.

Serveur de preuve, utilisé pour **toutes** les mesures de ce rapport :

| Élément | Valeur |
|---|---|
| PostgreSQL | **17.10** (`@embedded-postgres/linux-x64@17.10.0-beta.17`) |
| Identité du cluster | `system_identifier = 7702258422838901652` |
| Adresse / port | `127.0.0.1` / **55433** |
| Base de travail | `tracefab_test` (recréée par la garde, 66 migrations, 0 échec) |
| Rôles | `tracefab_app` (non privilégié), `tracefab_worker` |

---

## 1. R9 — destruction protégée, prouvée

### 1.1 Défaut mesuré avant correction

`base.fermer()` détruisait une base en **119 ms** alors qu'une session tierce
détenait le verrou de cluster, tuant la session de travail attachée
(`57P01 terminating connection due to administrator command`) et les écritures
non validées avec elle. Le chemin de *remise à zéro*, lui, attendait le verrou :
l'invariant n'existait que sur la moitié des chemins.

### 1.2 Chemins de destruction cartographiés

| Chemin | Fonction | État avant | État après |
|---|---|---|---|
| Nettoyage d'une base éphémère | `nettoyageProuve` / `fermer()` (`lib/ephemeral-db.mjs`) | **aucun verrou** | section critique, fail-closed |
| Destruction explicite | `detruireBaseProuvee` (`lib/base_jetable.mjs`) | **aucun verrou** | section critique, fail-closed |
| Remise à zéro | `reinitialiserBaseJetable` | verrou (attente non bornée) | inchangé (validé R3/R4/R5) |
| Reprise après interruption | `nettoyer_ressources_jetables.mjs` (**nouveau**) | — | section critique, fail-closed |

### 1.3 Correction

Nouvelle section critique `avecVerrouDeCluster()` dans `scripts/lib/ephemeral-db.mjs`,
avec un ordre de preuves explicite :

1. le verrou est **déjà tenu par ce processus** → on continue ;
2. il est tenu par un **lanceur ancêtre**, dont le PID est **prouvé** dans
   `pg_locks` (et non déclaré par une variable d'environnement) → on continue ;
3. sinon, acquisition avec **attente bornée** (`ATTENTE_DESTRUCTION_MS = 5000`) ;
4. sinon, **REFUS** : `TF_VERROU_INDISPONIBLE`, code de sortie 3, **aucune
   ressource touchée**.

La preuve d'OID (identité de la ressource) est relue **à l'intérieur** de la
section critique : la relire dehors laissait une fenêtre où la base pouvait être
supprimée puis recréée entre la vérification et le `DROP`.
`scripts/run-db-suite.mjs` transmet désormais `TF_VERROU_CLUSTER_DETENEUR` (PID du
backend détenteur) à l'enfant, pour que les suites filles sous `--verrou-cluster`
continuent de fonctionner — sans jamais se fier à la déclaration seule.

### 1.4 Test : `scripts/test_destruction_verrouillee.mjs`

```
$ DATABASE_URL='postgresql://postgres@127.0.0.1:55433/tracefab_test' \
  node scripts/run-db-suite.mjs scripts/test_destruction_verrouillee.mjs
exit = 0   —   30/30 assertions vertes   (≈ 16 s)
```

| Scénario demandé | Résultat mesuré |
|---|---|
| A détient le verrou, B demande une destruction | B **échoue** (`TF_VERROU_INDISPONIBLE`), après **5016 ms** d'attente bornée |
| B ne détruit rien pendant la détention | base **toujours présente**, session de travail **non tuée** (aucun `57P01`) |
| Libération de A | B détruit la base, absence vérifiée |
| Perte de connexion (kill -9 du détenteur) | verrou libéré par PostgreSQL, destruction possible ensuite |
| SIGTERM | sortie propre, verrou rendu, 0 verrou résiduel |
| SIGINT (interruption brutale) | base **intacte**, **même OID** (aucune destruction partielle), 0 verrou |
| Aucune base préexistante supprimée | OID divergent → refus ; `tracefab_test` → refus (nom hors `tf_*`) ; `tracefab_app`/`tracefab_worker` intacts |

### 1.5 État avant / après (cluster)

```
AVANT : bases = postgres, template0, template1, tracefab_test ; verrous advisory = 0
APRÈS : bases = postgres, template0, template1, tracefab_test ; verrous advisory = 0
        bases tf_* = 0 · rôles tf_* = 0
```

---

## 2. R7 — branchement CI

### 2.1 Plan présenté avant modification

`docs/security/2026-10-30-plan-r7-ci.md` (écrit **avant** l'édition du workflow) :
suites branchées, emplacement, effets attendus, effets de bord évités, sort des
31 suites jamais exécutées.

### 2.2 Modification appliquée — `.github/workflows/ci.yml` uniquement

Deux étapes ajoutées au job `base-de-donnees`, **après** `db:seed-rls` :

1. **`Identite applicative — refus du superutilisateur (R13)`** →
   `node scripts/verifier_identite_app_ci.mjs` ;
2. **`Gardes des ressources jetables, du verrou et de la reprise (R6/R7/R9)`** →
   les 12 suites, séquentielles, via `node scripts/run-db-suite.mjs`.

Aucune entrée `test:*` n'a été créée : le job `verification` lance sans base tous
les `test:*` non exclus, ce qui aurait rendu ces suites rouges pour une raison
d'environnement.

Validation statique du fichier :

```
$ node -e "require('yaml').parse(fs.readFileSync('.github/workflows/ci.yml','utf8'))"
YAML valide — job base-de-donnees : 46 étapes, dans l'ordre attendu
$ bash -n <run de l'étape 12>            → OK
$ node scripts/test_workflow_policy.mjs  → exit 0 (« Politique des workflows : OK »)
$ node scripts/test_inventaire_consommateurs.mjs → exit 0 (aucune violation)
```

### 2.3 Mesure : l'étape CI exécutée telle quelle, sur le cluster de preuve

```
$ DATABASE_URL=…55433/tracefab_test TF_RLS_APP_URL=…tracefab_app… node …/bash /tmp/etape_gardes.sh
EXIT=0   durée 41 s
```

| Suite | Assertions | Sortie |
|---|---|---|
| `test_garde_cible_ecriture` | 39/39 | 0 |
| `test_verrou_fail_closed` | 29/29 | 0 |
| `test_verrou_cluster` | 28/28 | 0 |
| `test_concurrence_suites` | 9/9 | 0 |
| `test_ressources_fixes_garde` | 40/40 | 0 |
| `test_migration_atomicite_plm_dedup` | 16/16 | 0 |
| `test_base_ephemere_garde` | 33/33 | 0 |
| `test_role_ephemere_garde` | 25/25 | 0 |
| `test_ensure_app_role_garde` | 30/30 | 0 |
| `test_provisioning_role_app` | 17/17 | 0 |
| `test_destruction_verrouillee` (R9) | 30/30 | 0 |
| `test_reprise_ressources_jetables` (R6) | 38/38 | 0 |
| **Total** | **334** | **12 × 0** |

### 2.4 Identité PostgreSQL — correction obligatoire

`scripts/verifier_identite_app_ci.mjs` (nouveau, bloquant) vérifie **par
connexion** : `TF_RLS_APP_URL` présente, différente de `DATABASE_URL`, session
`tracefab_app` sans `SUPERUSER`/`BYPASSRLS`/`CREATEROLE`/`CREATEDB`, et **même
`system_identifier`** des deux côtés.

```
$ node scripts/verifier_identite_app_ci.mjs                    (sans TF_RLS_APP_URL) → exit 2
  identite applicative : tracefab_app — SUPERUSER=false BYPASSRLS=false
  identite d administration : postgres — SUPERUSER=true BYPASSRLS=true
  meme cluster : oui (system_identifier identique)                                    → exit 0
$ TF_RLS_APP_URL="$DATABASE_URL" node scripts/verifier_identite_app_ci.mjs           → exit 3
```

Aucun repli silencieux n'est possible : `test_neon_publication_deploiement.mjs`
ne retombe plus sur l'URL propriétaire (§3.3).

### 2.5 Sort des 31 suites jamais exécutées

| Catégorie | Nombre | Décision |
|---|---|---|
| Environnement spécialisé (moteur Prisma natif : `test_neon_bulk_operations`, `pef`, `quality_cap`, `supplier_advanced`, `wallet_chantier9`, …) | 10 | job dédié si besoin confirmé — **hors périmètre** |
| Staging déployé (`test_p1_staging`, `test_p2_staging`, `test_p2_certification`) | 3 | hors CI par nature |
| Exclusion assumée (régression visuelle, identifiants réels, suites historiques remplacées) | 9 | documentées, non branchées |
| Doublons évités | — | aucune des 12 suites branchées ne recouvre une suite existante |

---

## 3. R11 / R12 / R13 — gardes communes

### 3.1 R11 — deux suites CI connectées sans garde de cible

| Suite | Avant | Après |
|---|---|---|
| `test_registre_fonctions_runtime.mjs` (phase E) | `pg.Client` sur `DATABASE_URL`, **aucun contrôle d'hôte** | `requireThrowawayDb` + contrôle négatif section G |
| `test_worker_non_forgeable.mjs` | écrit via fonctions `SECURITY DEFINER`, **aucun contrôle** | `requireThrowawayDb` + preuves d'identité + contrôle négatif section 10 |

Nouveau module `scripts/lib/identite_app.mjs` : `assertRoleApplicatif`,
`assertMemeCluster`, `ouvrirRoleApplicatif` — **identité vérifiée avant les
assertions métier**, jamais après.

```
$ node scripts/run-db-suite.mjs scripts/test_registre_fonctions_runtime.mjs → exit 0 (24 ok)
$ node scripts/run-db-suite.mjs scripts/test_worker_non_forgeable.mjs       → exit 0 (38 ok)
```

**Contrôle négatif — preuve qu'aucune écriture n'a lieu quand la garde refuse**
(la preuve n'est pas le message, c'est le compteur de transactions du serveur visé) :

| Cas | Sortie | Transactions sur la cible |
|---|---|---|
| `DATABASE_URL` joignable mais en contexte de production | **3** | `avant=5417 apres=5417` → **aucune** |
| `TF_RLS_APP_URL` absente | **2** | `avant=5417 apres=5417` → **aucune** |

### 3.2 R12 — garde maison dupliquée supprimée

`test_migration_owner_guard.mjs` recopiait à la main la liste d'hôtes et le nom
de base. Remplacé par `requireThrowawayDb` (seule définition de « cible jetable »
du dépôt) :

```
$ node scripts/run-db-suite.mjs scripts/test_migration_owner_guard.mjs
  garde cible : DATABASE_URL -> ACCEPTEE | classe=throwaway_local | base=tracefab_test
PASS — owner guard refuses a foreign-owned PUBLIC EXECUTE routine …  → exit 0
```

### 3.3 R13 — identité propriétaire, plus jamais par défaut

`test_neon_publication_deploiement.mjs` : suppression du repli
`TF_RLS_APP_URL || URL_DB(PREPROD)` ; `TF_RLS_APP_URL` obligatoire, identité
prouvée par `assertRoleApplicatif` **avant** toute assertion métier.

| Commande | Sortie |
|---|---|
| `TF_RLS_APP_URL='' … test_neon_publication_deploiement.mjs` | **2** (arrêt avant assertions, message explicite) |
| avec `TF_RLS_APP_URL` (rôle `tracefab_app`) | identité prouvée, sections A→E vertes, section F **NON EXÉCUTÉE** (moteur Prisma natif absent) |

Effet de bord corrigé au passage : la sortie 2 passait par `process.exit(2)`
direct, **laissant deux bases `tf_preprod_*`** derrière elle — désormais elle
passe par le filet de nettoyage. Vérifié : `bases tf_* restantes : (aucune)`.

---

## 4. R6 — récupération après `SIGKILL`

### 4.1 Stratégie retenue

**Jamais de suppression sur un préfixe.** Une reprise qui ferait
`DROP … LIKE 'tf_%'` serait plus dangereuse que le résidu. La preuve de création
est donc enregistrée **au moment de la création** par
`scripts/lib/manifeste_jetable.mjs` :

```json
{"genre":"base","nom":"tf_r6_…","oid":"225746",
 "systemIdentifier":"7702258422838901652","createur":"…","cree_le":"…","pid":…}
```

Triplet exigé avant toute destruction : **identité du cluster + nom + OID**,
tous revalidés en direct. Le manifeste est un JSONL **hors dépôt**
(`os.tmpdir()`), best-effort : une écriture ratée ne fait jamais échouer une suite.

`scripts/nettoyer_ressources_jetables.mjs` : **simulation par défaut**,
`--confirmer` obligatoire, refus du lot entier si une seule entrée n'est pas
prouvée (sortie 3, **rien n'est détruit**), liste de noms protégés
(`tracefab_test`, `tracefab_app`, `tracefab_worker`, `postgres`, `template*`),
destruction sous verrou de cluster, puis **vérification d'absence**.

### 4.2 Test : `scripts/test_reprise_ressources_jetables.mjs`

```
$ node scripts/run-db-suite.mjs scripts/test_reprise_ressources_jetables.mjs
exit = 0   —   38/38 assertions vertes
```

| Scénario demandé | Résultat mesuré |
|---|---|
| interruption brutale (`SIGKILL`) | base orpheline **présente**, retrouvée par le manifeste (pas par le préfixe) |
| détection des ressources orphelines | simulation : l'orphelin est listé, **rien n'est détruit** |
| nettoyage manuel contrôlé | `--confirmer` : orphelin détruit, **absence vérifiée**, 2<sup>e</sup> passe = « déjà absente » |
| conservation des ressources préexistantes | base `tf_*` **non manifestée** → intacte ; `tracefab_test` → refusée |
| preuve d'identité | OID divergent → **refus du lot (sortie 3)**, base homonyme intacte ; entrée d'un autre cluster → refus |
| absence de verrous résiduels | 0 verrou après `SIGKILL`, 0 à l'état final |
| robustesse du manifeste | une ligne tronquée est ignorée et **n'avale plus l'entrée suivante** (défaut trouvé et corrigé pendant ce chantier) |

---

## 5. Matrice CI complète

| Workflow | Base | Identité applicative | Suites exécutées | Secrets |
|---|---|---|---|---|
| `ci.yml` / `socle` | aucune | — | types, lint, isolation statique | aucun |
| `ci.yml` / `verification` | aucune | — | tous les `test:*` **sans base** (exclusions documentées) | aucun |
| `ci.yml` / `parcours` | aucune | — | navigateur réel (Playwright) | aucun |
| `ci.yml` / `base-de-donnees` | service `postgres:17`, `tracefab_test` | `DATABASE_URL` = `postgres` (admin) · `TF_RLS_APP_URL` = `tracefab_app` · **prouvé par l'étape R13** | migrations, audit catalogue, privilèges, seed, **12 suites de garde (R6/R7/R9)**, RLS, registre, worker, DPP, quotas… | aucun |
| `audit-sql-privileges.yml` | service `postgres:17` | `postgres` (audit catalogue) | `audit_sql_privileges_catalog.sh` | aucun |
| `h1-4-postgres.yml` | service `postgres:17` **et** `18` | `postgres` | `test_h1_4_engine.sh`, `test_h1_4_diagnostic.mjs` | aucun |
| `migrations-34-36-41.yml` | service `postgres:17` | `postgres` | `test_migration_integration_34_36_41.sh` | aucun |
| `diagnose-public-config.yml` | aucune | — | `smoke_clerk_production.mjs` (lecture seule, sans identifiant) | aucun |
| `sondage-preview.yml` | aucune | — | sondage HTTP preview | aucun |
| `vercel-log-search.yml` | aucune | — | `diagnose_production_incident.mjs` | `VERCEL_READONLY_TOKEN` (lecture seule) |

**Aucun workflow ne lit `secrets.DATABASE_URL`** (seule occurrence : un
commentaire qui documente sa suppression). **Aucune suite ne dispose d'un
identifiant de production.**

### Suites exécutées / échouées / non exécutées pendant ce chantier

| Statut | Détail |
|---|---|
| **Exécutées, vertes (35)** | 12 suites de garde (334 assertions) · 10 suites de garde antérieures (266) · `test_registre_fonctions_runtime`, `test_worker_non_forgeable`, `test_migration_owner_guard`, `test_neon_security`, `test_neon_product_flow`, `test_rls_isolation`, `test_rls_write_policies`, `test_privileges_role_app`, `test_sonde_identite_runtime`, `test_isolation_lignes_reelles`, `test_ecarts_privileges_role_app`, `test_produit_champs_calcules`, `test_dpp_review_and_publication`, `test_compteurs_debit` · `test_workflow_policy`, `test_inventaire_consommateurs`, `verifier_identite_app_ci` (3 modes) |
| **Contrôles négatifs exécutés (exit ≠ 0 attendu)** | `politique_permissive`, `politique_all`, `declencheur_desactive` → exit 1 ; garde R11 → exit 3 ; `TF_RLS_APP_URL` absente → exit 2 ; `TF_RLS_APP_URL` = `DATABASE_URL` → exit 3 ; OID divergent → exit 3 |
| **Non exécutées (dépendance manquante, jamais comptées comme réussies)** | `test_neon_publication_deploiement.mjs` **section F** (moteur Prisma natif indisponible : `binaries.prisma.sh` hors réseau) · `test_neon_supplier_advanced.mjs` (même cause, et non branchée en CI) |

---

## 6. Risques résiduels

| # | Risque | Gravité | Ce qui le limite |
|---|---|---|---|
| 1 | Le job CI garde `postgres` (superutilisateur) pour `DATABASE_URL` — nécessaire pour `CREATE ROLE` | moyenne | l'identité applicative est **prouvée** distincte (étape bloquante) ; les suites RLS passent par `TF_RLS_APP_URL` ; contrôle négatif `test:neon:bypass-control` |
| 2 | Le manifeste R6 ne couvre que les bases créées par `creerBaseEphemere` | faible | les rôles orphelins restent à traiter à la main ; le reaper les gère **s'ils sont manifestés**, jamais au préfixe |
| 3 | Le manifeste est local (`os.tmpdir()`) : perdu avec le runner | faible | sur un runner CI la ressource meurt avec la machine ; le manifeste sert au cluster de développement partagé |
| 4 | `TF_VERROU_CLUSTER_DETENEUR` repose sur un PID transmis | faible | le PID est **revérifié dans `pg_locks`** ; un PID forgé ne prouve rien et la destruction est refusée |
| 5 | `test_concurrence_suites` exige « aucune base éphémère résiduelle » : un orphelin d'une suite tuée le fait rougir | faible | c'est un signal, pas un faux positif ; le reaper est là pour ça |
| 6 | Section F de la publication non rejouable hors CI | faible | non comptée comme réussie ; dépendance documentée |
| 7 | `test_neon_supplier_advanced` toujours non branchée | faible | listée au §2.5 (environnement spécialisé) |

---

## 7. État Git, SHA, empreintes

| Élément | Valeur |
|---|---|
| Branche | `arena/96848462-tracefab` |
| HEAD | `5ed2745c8c38ea8eeb1b4f09140869611f0dc933` (**aucun commit de ce chantier**) |
| `main` | `bf55f2ae6534cde84d072d9b975520216c7b6d4e` (inchangée) |
| `git status --porcelain` | **54 entrées** : 25 `M` + 29 `??` (dont ce rapport) |
| `git diff` (suivi) | **25 fichiers, +1191 / −208** |
| SHA-256 de `git diff` | `fb6a9a91c143d042f1fdd109fd9a16a175797a8b7177c529af44d09da324eee1` |
| Diff complet (suivi + non suivis) | `/home/user/diff-chantier-final.md`, 7978 lignes, `426f0b2882010043402127af66c6871d9c8e432307bc759dc541302ddd376646` |
| Workflow modifié | `.github/workflows/ci.yml` — `57d9981c87cf048ecc60576fe4c2ea04b5ad2661be7f866b37a862bd69873d8c` |
| Migration P0 | `896dfad2f465908a8299f3639eb246292ba1b806ae13bfd3b3cf6218fdf6801f` (intacte) |
| `api/_lib/prisma.ts` | sans `@prisma/adapter-pg` (intact) |
| Cluster final | bases `postgres, template0, template1, tracefab_test` · rôles `tf_*` : 0 · verrous advisory : 0 |

Empreintes des pièces créées ou modifiées dans ce chantier (SHA-256, 16 premiers
caractères) :

```
0ab8477f29768932  scripts/lib/manifeste_jetable.mjs        (nouveau, R6)
2a16a28e502ceada  scripts/lib/identite_app.mjs             (nouveau, R11/R13)
457a1681cbe63eef  scripts/nettoyer_ressources_jetables.mjs (nouveau, R6)
7fd98c8c80573957  scripts/test_destruction_verrouillee.mjs (nouveau, R9)
f5b56fb3e88ca587  scripts/test_reprise_ressources_jetables.mjs (nouveau, R6)
5ba6492457182ce1  scripts/verifier_identite_app_ci.mjs     (nouveau, R13)
b86b3de325e6b437  scripts/lib/ephemeral-db.mjs             (R9, R6)
f7a5d7331e9a9d2a  scripts/lib/base_jetable.mjs             (R9)
0cb6198ec41808a5  scripts/run-db-suite.mjs                 (R9)
28783ce68fd54a7e  scripts/test_registre_fonctions_runtime.mjs (R11)
fd6015462be48465  scripts/test_worker_non_forgeable.mjs    (R11)
d85f7b2a9b146c03  scripts/test_migration_owner_guard.mjs   (R12)
c4df8ed42248678a  scripts/test_neon_publication_deploiement.mjs (R13, R6)
57d9981c87cf048e  .github/workflows/ci.yml                 (R7, R13)
```

---

## 8. Livraison

Les quatre risques du chantier sont traités : **R9 corrigé et prouvé**, **R7
branché et mesuré** (12 suites, 334 assertions, 41 s), **R11/R12/R13 corrigés**
avec contrôles négatifs mesurables, **R6 traité** par preuve de création plutôt
que par préfixe.

**Aucun commit, aucun push.** J'attends votre autorisation explicite.
