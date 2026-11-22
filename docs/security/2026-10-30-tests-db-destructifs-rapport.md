# Tests DB destructifs — rapport final avant commit (30 octobre)

Branche `arena/96848462-tracefab`. **Aucun commit, aucun push, aucune fusion.**
SHA de tête : `5ed2745c8c38ea8eeb1b4f09140869611f0dc933` — les preuves ci-dessous
valent pour **l'arbre de travail non commité** construit sur ce SHA (empreinte en §6).

Pas de production, pas de `main`, aucun secret touché, aucune migration modifiée
(`git diff --name-only prisma/ api/ package.json .github` → **0 fichier**).

---

## 1. VÉRIFIÉ ET VERT

Cluster de preuve : PostgreSQL **17.10** réel, `/tmp/pgdata_tf`, port 55432,
`system_identifier = 7702231702820447744`, base de travail `tracefab_test`.
Lancement : `DATABASE_URL='postgresql://postgres@127.0.0.1:55432/tracefab_test' TF_APP_PASSWORD='jetable_local' node scripts/run-db-suite.mjs <suite>`.

| Suite | Exit | Résultat | Contrôle négatif | Nettoyage observé |
|---|---|---|---|---|
| `test_base_ephemere_garde.mjs` | 0 | 33/33 | collision de nom forcée (section F) | bases 1→1 |
| **`test_role_ephemere_garde.mjs`** (nouveau) | 0 | 25/25 | rôle homonyme préexistant + OID recyclé + identifiant invalide + hôte managé + sonde réelle | rôles `tf_*` 0→0 |
| **`test_verrou_cluster.mjs`** (nouveau) | 0 | 23/23 | verrou tenu de l'extérieur ⇒ suite bloquée ; `kill -9` ⇒ aucun orphelin | verrous 0 |
| **`test_concurrence_suites.mjs`** (nouveau) | 0 | 9/9 | sérialisation prouvée + 3 tours de 2 suites différentes | bases 1→1, rôles 0→0 |
| `test_db_throwaway_entrypoints.mjs` | 0 | 35 ok / 0 échec | 5 corps npm dangereux refusés | aucune ressource |
| `test_isolation_lignes_reelles.mjs` | 0 | 22/22 | `ISOLATION_CONTROLE_NEGATIF=desactive_rls_documents` → exit 1 | bases 1→1 |
| `test_compteurs_debit.mjs` | 0 | 52/52 | 6 injections → exit 1 | bases 1→1 |
| `test_privileges_role_app.mjs` | 0 | 40/40 | négatifs internes (EXECUTE futur, DML PUBLIC) | bases 1→1 |
| `test_provisioning_role_app.mjs` | 0 | 17/17 | sentinelle absente, 13/16 tables absentes | bases 1→1 |
| `test_sonde_identite_runtime.mjs` | 0 | 30/30 | rôle soumis vs propriétaire | base + rôle détruits |
| `test_migration_owner_guard.mjs` | 0 | PASS | garde refuse une routine publique étrangère | rollback transactionnel |

Contrôles négatifs (tous en `exit=1`, aucun résidu) : `politique_permissive` 48/52 ·
`politique_all` 42/52 · `politique_role_etendu` 47/52 · `declencheur_desactive` 44/52 ·
`declencheur_absent` 39/52 · `declencheur_renomme` 45/52 · `isolation/RLS off` 19/22.

Après la campagne complète : `bases restantes : tracefab_test` · `rôles tf_* : aucun` ·
`verrous consultatifs : 0`.

### 1.1 Chantier A — rôles PostgreSQL

Nouveau module `scripts/lib/ephemeral-role.mjs`, symétrique de la garde des bases :
nom **unique** par exécution (≤ 63 octets), **absence vérifiée avant `CREATE`**,
collision `42710`/`23505` ⇒ nouveau nom (jamais de suppression), **OID relevé après
création** et seul jeton autorisant `DROP ROLE`, refus si l'OID a changé, arrêt sans
suppression si la preuve est impossible.

Six scripts supprimaient un rôle **avant tout contrôle**. État après correction :

| Script | Avant | Après |
|---|---|---|
| `test_sonde_identite_runtime.mjs` | `DROP ROLE IF EXISTS tracefab_sonde_soumis` | garde complète (nom unique + OID) |
| `test_rls_bypass_controle_negatif.mjs` | `DROP OWNED` + `DROP ROLE IF EXISTS sonde_bypass_probe` | nom unique, pas de DROP préventif |
| `test_rls_write_policies.mjs` | `rls_probe_write_policy` créé « si absent » puis supprimé | nom unique |
| `test_migration_owner_guard.mjs` | `tracefab_owner_guard_probe` + DROP préventif | nom unique + **preuve d'OID dans la transaction** |
| `test_neon_product_flow/security/supplier_advanced.mjs` | `..._${process.pid}` (réutilisable) + DROP préventif | nom unique, pas de DROP préventif |

Contrôle négatif de bout en bout : un rôle `tracefab_sonde_soumis` (ancien nom fixe)
est créé avec des attributs témoins, la **sonde réelle** est lancée : elle aboutit
(30/30) et le rôle garde **son OID et ses attributs** (assertions vertes, section G).

### 1.2 Chantier B — verrou de cluster

Opérations concurrentes au niveau **cluster** (et non base) : `CREATE/ALTER ROLE`,
`ALTER DEFAULT PRIVILEGES FOR ROLE`, et la migration `20261028120100_worker_identity_not_forgeable`.
Mesure du 30/10 : `XX000 tuple concurrently updated` sur 1 exécution sur 3.

Un seul verrou consultatif (`738241901`), pris **au niveau le plus externe** :

| Prend le verrou | Ne le prend pas (justifié) |
|---|---|
| `test_compteurs_debit.mjs`, `test_isolation_lignes_reelles.mjs`, `test_privileges_role_app.mjs`, `test_provisioning_role_app.mjs`, `test_neon_publication_deploiement.mjs` | `bootstrap_app_role.mjs`, `prepare_ci_db_role.mjs` — **section critique** appelée par un porteur déjà verrouillé (un verrou consultatif n'est pas ré-entrant : le poser là provoquerait une attente infinie) |
| `seed_rls_fixture.mjs`, `migrer_fidelement.mjs`, `db-deploy-throwaway.mjs` | `test_routes_*` (cluster `embedded-postgres` privé) · gardes (aucun objet partagé) |

Vérifications : connexion dédiée **maintenue** pendant toute l'opération ; libération
explicite sur succès, sur erreur (`finally`) et sur `SIGINT`/`SIGTERM` ; `kill -9`
⇒ PostgreSQL libère (prouvé) ; suite complète ⇒ 0 verrou résiduel (prouvé).
Un test statique interdit qu'un nouveau chemin de provisioning échappe au verrou.

Correctif complémentaire : `ensureAppRole` reprend (6 essais bornés) sur `XX000` —
15/15 rounds de provisioning concurrent verts (avant : 2 échecs sur 3).

---

## 2. VÉRIFIÉ ET BLOQUÉ

### 2.1 Section F de `test_neon_publication_deploiement.mjs` — bloquée, **pas verte**

Progrès réels obtenus **sans toucher au dépôt** :

```
prisma generate   →  ✔ Generated Prisma Client (v6.19.3)
```

obtenu avec les binaires **déjà présents** (`@prisma/schema-engine-wasm`,
`@prisma/prisma-schema-wasm`) et des chemins d'engine neutralisés :

```
PRISMA_SCHEMA_ENGINE_BINARY=/bin/true
PRISMA_QUERY_ENGINE_LIBRARY=/tmp/fake_query_engine.so   # fichier vide
PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1
PRISMA_CLIENT_FORCE_WASM=1
```

Conséquence sur la suite (env CI exact, `TF_RLS_APP_URL` compris) : **25 assertions
vertes, 0 ECHEC de A à E**, la section F **s'exécute** désormais… et échoue :

```
DPP data resolution error: PrismaClientInitializationError:
  The `adapter` option for `PrismaClient` is required in this context (Node.js)
ECHEC route réelle : GET /api/dpp/PUB-001 rend 200 … — status=500
ECHEC route réelle : BROUILLON-001 reste inaccessible par défaut — status=500
```

Cause exacte : le client généré en mode WASM/queryCompiler exige un **driver adapter**
(`@prisma/adapter-pg` est installé), alors que `api/_lib/prisma.ts` fait
`new PrismaClient()` sans adapter. Les trois issues possibles sont hors périmètre :

1. moteur Rust natif (`libquery_engine.so.node`) → **téléchargement
   `binaries.prisma.sh` bloqué** par la politique réseau ;
2. adapter dans `api/_lib/prisma.ts` → **modification du code applicatif**, refusée ;
3. `previewFeatures = ["queryCompiler","driverAdapters"]` → **modification du schéma
   Prisma**, interdite.

Donc : **section F non validée**. Aucun contournement n'a été appliqué.

### 2.2 Chemin nominal des deux scripts shell — bloqué

`scripts/audit_sql_privileges_catalog.sh` et `test_migration_integration_34_36_41.sh`
sont **inchangés**. `psql` réel a été rendu disponible hors dépôt
(`/tmp/pgserver/…/psql`, binaires zonky via PyPI) et un cluster PG 17.10 dédié au port
**5432** (celui qu'ils exigent) a été monté : `/tmp/pgdata_ci`,
`system_identifier = 7702234278948172588`.

Les **16 refus** (8 cas × 2 scripts) sont exécutés et conformes : mode jetable absent,
URL Neon, `PGDATABASE=postgres`, `DIRECT_URL`, hôte non local, `NODE_ENV=production`,
autre base locale, `psql` absent → tous `exit=2` avec le message attendu.

Le chemin nominal s'arrête **avant le `DROP`**, sur deux blocages d'environnement :

```
preflight: jetable, tracefab_test, hote local.
ok    serveur 17, base tracefab_test (17.10)
ECHEC: 10120000 absent de 19a867a19d6e569f3b68a0969eab8b45ff341a73
```

1. **clone superficiel** (`is-shallow-repository = true`, 1 commit) : les commits
   épinglés (`19a867a`, `384b18f`, `6d785dc`, `c75ee3e`, `76298b2`) sont absents ;
2. **moteur Prisma** : `deploy()` → `db-deploy-throwaway.mjs` → `prisma migrate deploy`
   exige `schema-engine`, non téléchargeable.

Conformément à la consigne, les scripts restent **inchangés** et le blocage est signalé
ici plutôt que contourné.

---

## 3. NON EXÉCUTÉ

| Élément | Raison |
|---|---|
| Section F de la suite publication | §2.1 — adapter Prisma requis, moteur natif introuvable |
| Chemin nominal des deux scripts shell | §2.2 — clone superficiel + moteur Prisma |
| `test_rls_bypass_controle_negatif.mjs` (modifié) | exige un harnais ensemencé + rôle BYPASSRLS ; non disponible ici |
| `test_rls_write_policies.mjs` (modifié) | exige les fixtures RLS complètes |
| `test_neon_product_flow.mjs`, `test_neon_security.mjs`, `test_neon_supplier_advanced.mjs` (modifiés) | clients Prisma + base ensemencée |

Ces cinq fichiers portent un changement **mécanique et relisible** (nom de rôle unique,
suppression du `DROP` préventif) vérifié par `node --check` et par revue de diff, mais
**non exécuté** : ils ne sont pas comptés comme verts.

---

## 4. RISQUES RÉSIDUELS

1. **Prisma / section F** : le client ne peut pas être généré en mode « library » ici ;
   la validation de bout en bout du handler DPP reste à faire dans un environnement
   avec `binaries.prisma.sh` accessible.
2. **Deux scripts shell** gardent `DROP DATABASE IF EXISTS tracefab_test` sur nom fixe.
   Encadré par leurs gardes (nom exact, URL exacte, mode jetable, hôte local) et, en CI,
   par un conteneur `postgres:17` créé pour le job. Correctif proposé (non appliqué) :
   marqueur `_throwaway_marker`, à arbitrer avec l'équipe CI car le conteneur crée
   `tracefab_test` **sans** marqueur.
3. **Rôles des trois scripts Prisma** : noms uniques, mais pas de preuve d'OID (le
   `DROP ROLE IF EXISTS` de nettoyage subsiste, sur un nom qui ne peut être que le leur).
4. **`bootstrap_app_role.mjs` / `prepare_ci_db_role.mjs` ne prennent pas le verrou**
   par conception ; appelés **seuls** et en parallèle, ils restent exposés — atténué par
   la reprise sur `XX000` (15/15).
5. **Base « créée mais non prouvée »** : volontairement non supprimée (message explicite).
6. Migration `20261029180000_plm_erp_sync_jobs_policy_dedup` : toujours sans
   `BEGIN`/`COMMIT` — hors périmètre, inchangée.

---

## 5. FICHIERS MODIFIÉS ET DIFF

### 5.1 Nouveaux fichiers (7)

| Fichier | Rôle |
|---|---|
| `scripts/lib/ephemeral-role.mjs` | garde des rôles : nom unique, preuve d'OID, destruction réservée |
| `scripts/test_role_ephemere_garde.mjs` | 25 assertions, dont le rôle homonyme et la sonde réelle |
| `scripts/test_verrou_cluster.mjs` | couverture du verrou + détention + `kill -9` + 0 orphelin |
| `scripts/test_concurrence_suites.mjs` | deux suites **différentes** en concurrence + preuve de sérialisation |
| `scripts/lib/ephemeral-db.mjs` | (créé au tour précédent) garde des bases + `verrouillerCluster` + `filetDeNettoyage` |
| `scripts/test_base_ephemere_garde.mjs` | (créé au tour précédent) 33 assertions |
| `scripts/test_provisioning_role_app.mjs` | (créé au tour précédent) 17 assertions |

### 5.2 Fichiers modifiés (15)

```
 scripts/db-deploy-throwaway.mjs               |  25 ++-
 scripts/lib/tracefab_app_role.mjs             |  76 ++++++--
 scripts/migrer_fidelement.mjs                 |   7 +
 scripts/seed_rls_fixture.mjs                  |  10 +-
 scripts/test_compteurs_debit.mjs              | 267 +++++++++++++++++++++++---
 scripts/test_isolation_lignes_reelles.mjs     |  69 +++++--
 scripts/test_migration_owner_guard.mjs        |  18 +-
 scripts/test_neon_product_flow.mjs            |   6 +-
 scripts/test_neon_publication_deploiement.mjs |  79 ++++++--
 scripts/test_neon_security.mjs                |   6 +-
 scripts/test_neon_supplier_advanced.mjs       |   6 +-
 scripts/test_privileges_role_app.mjs          |  53 +++--
 scripts/test_rls_bypass_controle_negatif.mjs  |   8 +-
 scripts/test_rls_write_policies.mjs           |   5 +-
 scripts/test_sonde_identite_runtime.mjs       |  72 +++++--
 15 files changed, 581 insertions(+), 126 deletions(-)
```

Aucune modification hors `scripts/` et `docs/` : `package.json`, `.github/`,
`prisma/`, `api/` → **0 fichier modifié**.

Le diff intégral est reproduit dans `/home/user/revue-diff-chantiers-A-E.md`
(hors dépôt, pour ne pas polluer l'arbre).

---

## 6. SHA EXACT TESTÉ

- Tête de branche : **`5ed2745c8c38ea8eeb1b4f09140869611f0dc933`**
- Les preuves portent sur l'arbre de travail **modifié et non commité** bâti sur ce SHA.
- Empreinte de l'arbre **scripts** testé — `sha256` de (diff suivi + contenu des
  fichiers non suivis, sous `scripts/` uniquement, pour rester stable si ce rapport
  est édité) : **`b89ad84e154c5aab57889f03337d35a3c4713d91e778a16ef9a07c69a604541e`**
- Reproduction exacte :
  `{ git diff -- scripts; for f in $(git status --porcelain -- scripts | grep '^??' | awk '{print $2}'); do echo "### $f"; cat "$f"; done; } | sha256sum`

**Aucun commit créé. En attente d'autorisation explicite.**
