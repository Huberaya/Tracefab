# Levée des réserves — gardes des neuf scripts d'écriture, et tests Prisma jamais exécutés

Date : 2026-10-30 · Branche : `arena/96848462-tracefab` · HEAD : `5ed2745c8c38ea8eeb1b4f09140869611f0dc933`
Aucun commit, aucun push, aucune migration appliquée en production, aucun secret touché.

Ce document rend le contrôle final de la levée des réserves demandée après la revue de
livraison. Il ne remplace pas `2026-10-30-chantier-final-securite.md` : il le complète sur
les deux points restés ouverts.

---

## 1. Ce qui était ouvert

La revue de livraison avait relevé **un défaut concret** : neuf scripts du dépôt écrivent en
base **sans passer par le classifieur commun**, et **aucun n'est branché en CI**. Ils sont
tous antérieurs au chantier de sécurité. Deux tests Prisma n'avaient jamais été exécutés.

| Script | Lignes | Écritures |
|---|---:|---|
| `scripts/apply_migration_chantier2.mjs` | 691 | DDL, `GRANT … TO PUBLIC`, RLS |
| `scripts/apply_migration_chantier3.mjs` | 543 | DDL, RLS |
| `scripts/apply_migration_chantier4.mjs` | 426 | DDL, RLS |
| `scripts/apply_migration_chantier5.mjs` | 397 | DDL, RLS |
| `scripts/test_neon_bulk_operations_chantier8.mjs` | 191 | imports, produits, fournisseurs |
| `scripts/test_neon_chantier7_mass_balance.mjs` | 230 | écritures métier |
| `scripts/test_neon_document_ai.mjs` | 187 | documents, vérifications |
| `scripts/test_neon_plm_erp_gs1.mjs` | 177 | nœuds/liens de chaîne |
| `scripts/test_neon_supplier_advanced.mjs` | 160 | rôles, données, RLS |

## 2. Reconnaissance : ce qui a réellement été mesuré

Pour chacun des neuf scripts, **tous les chemins de connexion ont été recensés** — pas
seulement la première ligne :

- `new PrismaClient()` : **exactement 1** par script, aucun `new pg.Client`, aucun
  `createConnection`, aucun `spawn`/`execFile`/`child_process`, aucun `fetch` ;
- variables d'environnement lues : **aucune** pour huit scripts ; `DATABASE_URL` seule pour
  `test_neon_supplier_advanced` ;
- aucun `dotenv`, aucun `.env` dans le dépôt (seul `.env.example`) ;
- imports transitifs vérifiés : `bulk-importer.ts`, `compliance-exporter.ts`,
  `csv-parser.ts` n'ouvrent pas de connexion propre — ils passent tous par le client fourni ;
  les quatre `apply_migration_*` n'importent rien d'autre que `@prisma/client`.

**Le point qui a changé la solution.** La consigne prévoyait « une ligne en tête du corps ».
C'est insuffisant et la mesure le montre : en ESM, **tous les `import` sont évalués avant la
première instruction du corps**. Un module importé peut donc construire un client — voire
ouvrir une connexion — avant que la garde du corps n'ait la moindre occasion de s'exécuter.
`test_neon_supplier_advanced.mjs` en est l'exemple : il importe `@prisma/client` **et** un
module d'API (`api/_lib/prisma.ts` construit un client au chargement). Une garde posée dans le
corps arrive après eux.

## 3. La solution : garde évaluée à l'import

Nouveau module `scripts/lib/garde_import.mjs` (38 lignes), importé **en première position** de
chacun des neuf scripts :

```js
import './lib/garde_import.mjs';
```

Ordre d'évaluation ESM : profondeur d'abord, dans l'ordre des déclarations d'import. Le module
de garde est donc entièrement évalué — et refuse en `process.exit` si nécessaire — **avant**
`@prisma/client` et avant tout module d'API.

Il ne devine rien : il vérifie `DATABASE_URL`, seule variable de connexion que ces scripts
utilisent. Un script qui lirait une seconde variable devra appeler `requireThrowawayDb` avec la
liste complète — c'est écrit dans l'en-tête du module.

Codes de sortie conservés : **2** variable absente (rien à faire, donc rien exécuté), **3**
cible refusée. Aucun affichage de chaîne de connexion (empreinte SHA-256 tronquée seulement).

## 4. Preuves d'exécution

### 4.1 Contrôles négatifs — 36 lancements, **zéro écriture**

Une base locale **refusée par son nom** (`tracefab_prod`) est créée sur le cluster jetable avec
une table canari contenant une ligne. Les neuf scripts sont lancés **quatre fois** chacun
(cible refusée, variable absente, hôte managé, configuration incohérente `NODE_ENV=production`),
puis la base est détruite.

| Mesure | Avant | Après | Delta |
|---|---:|---:|---:|
| lignes dans `canari_r3` | 1 | 1 | **0** |
| `n_tup_ins` / `n_tup_upd` / `n_tup_del` | 0 / 0 / 0 | 0 / 0 / 0 | **0** |
| `xact_commit` de la base | 1 | 3 | **2** |
| `xact_rollback` | 0 | 0 | 0 |

Le delta de 2 transactions est exactement le coût des **deux requêtes de la mesure elle-même**
(`count(*)` et `pg_stat_user_tables`) : aucune transaction n'a été ouverte par un script.

Codes de sortie observés sur 36 lancements : **24 × `3`**, **8 × `2`**, **4 × `1`**. Les quatre
`1` sont les quatre lancements de `test_neon_bulk_operations_chantier8`, dont le graphe de
modules **ne se lie pas** (voir §6.2) : le code n'est alors pas évalué du tout, donc la garde
n'est pas atteignable — et aucune écriture n'est possible.

### 4.2 Cas nominaux réellement exécutés

| Suite | Résultat | Code |
|---|---|---|
| `scripts/test_neon_supplier_advanced.mjs` | vert — « tenant isolation, data-point versioning, role RLS and owner invariants » | **0** |
| `scripts/test_neon_publication_deploiement.mjs` | vert — 48 assertions, section **F** incluse | **0** |

### 4.3 Non-régression de l'étape CI

L'étape des gardes (les 12 suites du job `base-de-donnees`) rejouée telle quelle :
**EXIT=0, 44 s, 395 assertions vertes** (334 avant l'ajout des cas B3/B4, +61).

`scripts/test_garde_cible_ecriture.mjs` : **39 → 100 assertions**.
Nouvelles sections : **B3** (9 scripts × refus + preuve canari, 43 assertions) et **B4**
(ordre d'évaluation et unicité du client, 18 assertions).

### 4.4 État du cluster après campagne

`postgres, template0, template1, tracefab_test` · rôles `tf_*` : **0** · verrous advisory : **0**.
Deux rôles `tf_rls_adv_*` laissés par mes propres exécutions interrompues ont été supprimés
nommément (jamais par préfixe), après contrôle du `system_identifier` du cluster.

## 5. Chantier B — les deux tests Prisma

### 5.1 `test_neon_supplier_advanced.mjs` — exécuté

Trois obstacles, tous mesurés puis levés **sans toucher à une assertion** :

1. `new PrismaClient()` sans `datasourceUrl` exige un moteur Prisma **natif**, indisponible
   ici → remplacé par `createTestPrisma()`, utilitaire **déjà présent dans HEAD** et employé
   par neuf suites du dépôt (moteur standard en CI, WASM + `pg` sinon).
2. `permission denied for function tracefab_current_user_email` : depuis la migration
   `20261021120000`, `PUBLIC` n'a plus `EXECUTE` sur les fonctions. Le rôle de sonde
   s'arrêtait en `42501` **avant** la RLS — le test ne mesurait plus l'isolation. Ajout de
   `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public` et du `REVOKE` correspondant.
3. `cannot be dropped because some objects depend on it` : le `DRIVER` du `finally` révoquait
   tables, séquences et schéma, mais **pas les fonctions**. Révoqué aussi.

### 5.2 `test_neon_publication_deploiement.mjs`, section F — exécutée

La section importe la **vraie route** `api/_routes/dpp/[gtin].ts`, donc `api/_lib/prisma.ts`,
donc un client sans adaptateur :

```
PrismaClientInitializationError: The `adapter` option for `PrismaClient` is required in this context (Node.js)
```

Le test utilise désormais le **point d'injection prévu par le dépôt** : `api/_lib/prisma.ts`
réutilise `globalThis.tracefabPrisma` s'il existe. Le client est créé par `createTestPrisma`
sur l'URL du **rôle applicatif** (`tracefab_app`, sans `BYPASSRLS`) et injecté avant l'import de
la route. L'application n'est pas modifiée d'une ligne ; la RLS reste réellement évaluée, ce que
prouvent les cinq assertions (`PUB-001` rend 200 ; `BROUILLON-001`, `NON-RELU-001`,
`SANS-ETAT-001`, `PRIVE-001` rendent 404 `product_passport_not_found`).

### 5.3 Défaut découvert au passage : le pool n'était pas fermé

Sur le chemin WASM, `$disconnect()` **ne ferme pas** le pool `pg` (mesure : 1 connexion encore
ouverte dans `pg_stat_activity`). Conséquence observée : `DROP DATABASE … WITH (FORCE)`
tuait la connexion survivante (`57P01`), puis le nettoyage échouait en `3D000`. Correctif :
`fermerPrismaDeTest(client)` dans `scripts/lib/test_prisma_client.mjs` (ferme le client **et**
le pool). Utilisé par les deux suites concernées.

## 6. Tests non exécutés, et pourquoi

### 6.1 Moteur Prisma natif indisponible (environnement, pas code)

`binaries.prisma.sh` est injoignable depuis ce sandbox (`SSL_ERROR_SYSCALL`) ; le client généré
est en `engineType=client` (WASM). Les scripts suivants échouent donc **avant leur première
assertion** sur `The 'adapter' option for PrismaClient is required in this context` :

- `apply_migration_chantier2|3|4|5.mjs` (4) ;
- `test_neon_chantier7_mass_balance.mjs`, `test_neon_document_ai.mjs`,
  `test_neon_plm_erp_gs1.mjs` (3).

Pour ces sept scripts, **seuls les refus sont prouvés** (§4.1) ; le chemin nominal n'est pas
prouvé ici. Ils fonctionneraient en CI, où `npm ci` installe les moteurs natifs — mais **aucun
n'y est branché**.

### 6.2 `test_neon_bulk_operations_chantier8.mjs` : ne peut pas s'exécuter, même en CI

```
ERR_MODULE_NOT_FOUND  file:///…/api/_lib/plm-erp/gtin-engine.js
```

`bulk-importer.ts` importe `'../plm-erp/gtin-engine.js'` (convention du bundler Next : la
résolution `.js` → `.ts`). Node ESM ne la fait pas. C'est un **défaut préexistant**, non
introduit ici : `npm run test:bulk-operations:chantier8` échoue de la même façon. La
conséquence est double et opposée :

- **avantage** : le graphe ne se lie pas, aucun module n'est évalué, aucune écriture n'est
  possible — la suite est inoffensive par accident ;
- **inconvénient** : sa garde n'est pas exercable, et **le test ne mesure rien**. Il ne doit pas
  être compté comme vert.

### 6.3 Constat sur les suites de gardes

Dix des douze suites de l'étape CI n'acceptent de tourner que si le nom de base est
littéralement `tracefab_test` (`prepare_ci_db_role` refuse tout autre nom, sortie 2). Lancées
sur une base éphémère, quatre d'entre elles échouent — c'était une erreur de mon harnais, pas
une régression : relancées sur `tracefab_test`, elles sont vertes (266 assertions cumulées).

## 7. Risques résiduels

1. **Sept scripts jamais exécutés de bout en bout** (4 + 3) : garde prouvée en refus, chemin
   nominal non prouvé. Risque : la garde pourrait précéder une écriture qui ne fonctionne pas ;
   aucune preuve de correction fonctionnelle.
2. **`test_neon_bulk_operations_chantier8` ne mesure rien** et son import est cassé pour Node
   aussi bien que pour `npm run`. À réparer (résolution `.js` → `.ts`) ou à retirer — décision
   hors périmètre de cette levée de réserves.
3. **Aucun des neuf scripts n'est branché en CI** : les gardes protègent, elles ne surveillent
   pas. Une régression de la garde ne serait détectée que par
   `test_garde_cible_ecriture` (quatre lancements par script, dont un inopérant).
4. **`garde_import.mjs` ne vérifie que `DATABASE_URL`.** Un script qui lira demain une autre
   variable de connexion passera la garde sans être vu : c'est un choix explicite (ne rien
   deviner) et une dette documentée dans l'en-tête du module.
5. **Neuf autres suites `test_neon_*` laissent un pool `pg` ouvert à la sortie** (le défaut du
   §5.3). Sans effet aujourd'hui — aucune ne détruit sa base — mais un `DROP DATABASE` ajouté
   demain les ferait tomber en `57P01`.
6. **Les dix suites de gardes dépendent du nom `tracefab_test`.** Une base éphémère correcte
   mais autrement nommée les fait échouer : couplage non documenté jusqu'ici.

## 8. Proposition de découpage en commits

À appliquer **après autorisation explicite** ; rien n'est commité à ce stade.

| # | Contenu | Fichiers | Message proposé |
|---|---|---|---|
| C1 | Garde d'import sur les 9 scripts | `scripts/lib/garde_import.mjs` (nouveau) + 9 scripts | `fix(scripts): garde de cible evaluee a l'import sur les neuf scripts d'ecriture` |
| C2 | Fermeture du pool + supplier exécutable | `scripts/lib/test_prisma_client.mjs`, `scripts/test_neon_supplier_advanced.mjs` | `fix(test): fermer le pool Prisma de test et rendre supplier_advanced executable` |
| C3 | Section F exécutable | `scripts/test_neon_publication_deploiement.mjs` | `test(publication): executer la section F via le singleton injecte` |
| C4 | Cas du classifieur | `scripts/test_garde_cible_ecriture.mjs` | `test(gardes): refus des neuf scripts sans ecriture (B3/B4)` |
| C5 | Documentation | ce document | `docs(security): levee des reserves — gardes des scripts et tests Prisma` |

C1 est indépendant de C2–C4. C2 doit précéder C3 (C3 utilise `fermerPrismaDeTest`). C4 dépend
de C1 (il lance les neuf scripts).

---

**Ce qui reste à décider** : brancher ou non les neuf scripts en CI, réparer ou retirer
`test_neon_bulk_operations_chantier8`, et l'autorisation de commit.
