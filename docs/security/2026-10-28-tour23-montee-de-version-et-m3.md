# Tour 23 — montée de version, exploitation reproduite, et M3 mesuré

Branche `arena/c27ddaa4-tracefab`, PR #102. Aucune fusion, aucun déploiement,
aucune écriture distante, aucune modification de production, aucun secret
manipulé. Toutes les mesures ci-dessous ont été **exécutées** sur des clusters
PostgreSQL 18.4 jetables locaux ; ce qui ne l'a pas été est marqué `NOT RUN` ou
`BLOCKED`.

## 0. Écart avec le SHA de départ annoncé

Le mandat fixe `2fce6c1c572fa93e5e4226af85b1afb5375c89ed` comme point de départ.
Le SHA distant mesuré avant toute modification était
**`4d4471b1818d0e192409ec37b68f5e317377e0d6`**, et `2fce6c1` en est un ancêtre :
quatre commits le séparent.

| Commit | Contenu |
|---|---|
| `2fce6c1` | correctif Clerk (tour 22) |
| `2634cc1` | GUC produit : périmètre colonne (le §2 du mandat) |
| `6637da0` | garde statique des écritures, consciente du périmètre colonne |
| `9d302df` | registre des chantiers : 63ᵉ migration |
| `4d4471b` | document de vérification finale |

Le §2 du mandat (corriger `tracefab_products`) était donc **déjà livré**. Il n'a
pas été refait. Ce tour a produit ce qui manquait réellement : la **preuve
avant/après sur une base de version précédente** (le §2.7, jusqu'ici seulement
fait depuis zéro), l'**exploitation telle que décrite au mandat**, l'extension du
test de non-régression aux quatre colonnes calculées, et la **mesure de M3**.

`/home/user/Tracefab` est resté intact (61 modifications préexistantes
préservées, branche inchangée). Aucun force-push.

## 1. Reproduction de l'exploitation — preuve AVANT

Base `tracefab_test` reconstituée à la **version précédente** : 62 migrations
(toutes sauf `20261028130000`), rôle `tracefab_app` créé, seed exécuté, puis
provisionnement ancien rejoué (`GRANT INSERT, UPDATE, DELETE ON tracefab_products`
— ce que faisait `TABLES_ECRITURE_DIRECTE` avant le correctif).

Exploitation, exactement celle du mandat, sous `tracefab_app` sans aucun
privilège d'administration :

```
session : current_user=tracefab_app bypassrls=false
set_config('tracefab.internal_product_revision', 'true', true)
UPDATE tracefab_products SET version = version + 100 WHERE id = ...
UPDATE accepte (1 ligne(s) touchee(s))
etat final : version 1 -> 101 (MODIFIEE)
VERDICT : base VULNERABLE
```

La réussite est constatée par une **relecture administrateur après `COMMIT`**,
et non par `RETURNING` : sous RLS, `RETURNING` dépend de la politique `SELECT`
et rendrait un faux négatif. Les deux premiers essais de l'instrument se sont
d'ailleurs trompés de cette façon, ce qui a été corrigé avant de conclure.

## 2. Preuve APRÈS — migration appliquée sur la base existante

La migration `20261028130000` a été appliquée **sur cette même base déjà
peuplée** — c'est la montée de version, pas une reconstruction :

```
privileges TABLE apres : SELECT
colonnes accordees : 20 | version incluse ? false | data_completion ? false
RESULTAT : contournement REFUSE — 42501 permission denied for table tracefab_products
etat final : version 101 (inchangee)
VERDICT : base CORRIGEE
```

Écritures légitimes sur cette même base mise à niveau, chacune dans sa
transaction, chaque refus devant être un refus de **privilège** `42501` (un
`42804` de type ou un `23502` de contrainte ne prouve rien) :

| Essai | Résultat |
|---|---|
| `UPDATE name` (champ métier) | accepté, 1 ligne |
| `UPDATE status = 'archived'` (archivage) | accepté, 1 ligne |
| `INSERT` avec les **colonnes exactes** de `bulk-importer.ts:110` | accepté, 1 ligne |
| `UPDATE version` sous GUC forgé | refusé `42501` |
| `UPDATE data_readiness` sous GUC forgé | refusé `42501` |
| `UPDATE data_completion` sous GUC forgé | refusé `42501` |
| `DELETE` produit | refusé `42501` |
| `tracefab_start_product_revision(...)` | accepté, 1 ligne |

Isolation inter-organisations sur la base mise à niveau (un membre de A qui
vise un produit de B est filtré par RLS, il n'obtient pas d'erreur — c'est le
comportement attendu, et le compter comme un succès d'écriture aurait été une
faute d'instrument) :

| Essai | Résultat |
|---|---|
| membre de A écrit un produit de B | **0 ligne** (filtré par RLS) |
| lecture des produits de B depuis A | **0 ligne** |
| membre de A écrit un produit de A | 1 ligne |

**Le provisionnement ne réaccorde rien** : après ré-exécution du seed (qui
rejoue `TABLES_ECRITURE_DIRECTE`), les privilèges table restent `SELECT` seul et
le contournement est toujours refusé `42501`.

## 3. Non-régression renforcée

`scripts/test_produit_champs_calcules.mjs` passe de 11 à **19 assertions** :

- les refus 1 et 2b exigent désormais `code === '42501'` — un refus de
  privilège — et non un échec quelconque ;
- nouvelle section 2c : les **quatre** champs calculés (`version`,
  `data_completion`, `data_readiness`, `data_ready_at`) sont éprouvés sous les
  **deux** GUC (`internal_product_revision`, `internal_product_readiness_update`),
  soit 8 essais supplémentaires, chacun dans sa transaction.

Contrôle négatif exécuté sur la base reconstruite : privilège table rendu →
**13 échecs, exit 1** ; correctif réappliqué → exit 0.

## 4. M3 — mesuré, non tranché

Question posée : que se passe-t-il si le propriétaire du schéma n'est ni
superutilisateur ni `BYPASSRLS` ? Mesure sur un **cluster neuf** (les rôles sont
globaux au cluster : un cluster déjà utilisé par les autres bancs aurait faussé
la mesure, ce qui a été constaté puis corrigé).

| Propriétaire | Résultat des 63 migrations |
|---|---|
| superutilisateur (témoin) | **63/63** |
| `NOSUPERUSER NOBYPASSRLS NOCREATEROLE` | échec à `20261006160000_dpp_readiness_exposure` : `42501 new row violates row-level security policy for table "dpp_requirement_profiles"` — 30 tables créées avant l'arrêt |
| `NOSUPERUSER BYPASSRLS NOCREATEROLE` | échec à `20261028120100_worker_identity_not_forgeable` : `42501 permission denied to create role` |
| `NOSUPERUSER BYPASSRLS CREATEROLE`, worker préexistant avec `ADMIN OPTION` | échec à la même migration : `42501 permission denied to alter role` — la déclaration fautive est `ALTER ROLE tracefab_worker ... NOSUPERUSER` |
| `NOSUPERUSER BYPASSRLS CREATEROLE`, worker absent (branche `CREATE`) | échec à la même migration : `42501 must be able to SET ROLE "tracefab_worker"` |

Deux verrous distincts, tous deux mesurés :

1. **`FORCE ROW LEVEL SECURITY` + propriétaire sans `BYPASSRLS`** : la migration
   `20261006160000` insère dans `dpp_requirement_profiles`
   (`relrowsecurity = true`, `relforcerowsecurity = true`, propriétaire
   `tf_owner`) et se fait refuser par la RLS qu'elle vient d'activer.
2. **`20261028120100` exige une autorité de superutilisateur** : `ALTER ROLE …
   NOSUPERUSER` sur un rôle tiers est réservé aux superutilisateurs — mesuré
   attribut par attribut (`NOINHERIT` accepté, `NOBYPASSRLS` accepté,
   `NOSUPERUSER` refusé `42501`), et la branche `CREATE` échoue sur
   `GRANT`/`SET ROLE` pour un propriétaire non superutilisateur.

**Conclusion M3 : laisser M3 ouvert.** Retirer `BYPASSRLS` au propriétaire —
option B du tour 21 — **casserait la chaîne de migrations** avant même de parler
de RLS runtime : la mesure ci-dessus le démontre. L'option A (rôle helper
`NOLOGIN BYPASSRLS` à privilèges minimaux) reste théoriquement ouverte mais ne
résout pas le verrou 2 : elle ne donne ni le droit d'`ALTER ROLE … NOSUPERUSER`
ni celui de créer/gérer `tracefab_worker`. La voie D (aucun changement de
posture) est donc la seule tenable en l'état, et **la posture réelle de
production reste inconnue** : c'est M6, et M6 est `BLOCKED`.

Il manque, pour trancher, la mesure du propriétaire effectif en production
(`rolsuper`, `rolbypassrls`, `rolcreaterole`, et la liste de ses `ADMIN OPTION`),
c'est-à-dire précisément les requêtes du script M6.

## 5. M6 — `BLOCKED`, sans tentative de contournement

Aucune connexion de production autorisée n'a été fournie. Aucune n'a été
cherchée, devinée, ni reconstituée depuis une variable d'environnement, une URL
ou un nom de branche : le mandat interdit de considérer une base comme non
productive sur la foi de son nom, et une erreur d'identité ici serait
irréversible.

**Script prêt** : `docs/security/2026-10-28-m6-lecture-seule.sql`, non destructif
(aucune table temporaire, aucun GUC, aucun `SET ROLE`, aucune écriture,
`_prisma_migrations` en dernier bloc). Il rend `current_user`, `session_user`,
`rolsuper`, `rolbypassrls`, `rolcreaterole`, les propriétaires, les politiques,
`relrowsecurity`/`relforcerowsecurity`, les privilèges effectifs de
`tracefab_app`, les héritages, les privilèges `PUBLIC` et par défaut, et
l'historique des migrations.

**Conditions d'accès nécessaires** : une connexion en lecture seule, sur la base
de production, explicitement autorisée, avec un rôle dont on connaît le nom
(jamais la chaîne), et l'accord de l'utilisateur sur la fenêtre d'exécution. Le
résultat à collecter est la sortie du script, expurgée de tout secret — le
script ne lit aucune donnée métier.

## 6. Validation du tour

Base jetable reconstruite **depuis zéro** : **63/63 migrations**, puis
`db:prepare-ci-role` et `db:seed-rls`.

| Suite | Résultat |
|---|---|
| `rls`, `privileges`, `privileges-role-app`, `ecarts-privileges`, `write-policies`, `security` | **PASS** |
| `cross-tenant`, `isolation-lignes`, `bypass-control` | **PASS** |
| `product`, `document-lifecycle`, `app-readiness` | **PASS** |
| `registre-fonctions`, `worker-non-forgeable` | **PASS** |
| `neon:produit-champs-calcules` | **PASS** — 19 assertions |
| `neon:dpp-lifecycle`, `neon:dpp-provenance`, `dpp:review-publication` | **PASS** |
| `bulk:chantier8` (contrat d'import) | **PASS** |
| `clerk-identity`, `clerk-proxy` | **PASS** |
| `dpp:role-applicatif` | **PASS** avec les identifiants fournis (branche « non applicable » faute de dossier) |
| `tables-ecriture-directe`, `chantiers`, `workflow-policy` | **PASS** |
| `security:chantier1`, `routes`, `production-readiness`, `route-context-coverage` | **PASS** |
| `npm test` | **PASS** (exit 0) |
| `typecheck`, `api:typecheck`, `schema:static` | **PASS** |
| `route-auth-coverage` | **FAIL d'instrument** — `P2038` adaptateur Prisma absent hors ligne ; vert en CI |
| `db:generate`, `build` | **BLOCKED** — moteurs Prisma non téléchargeables hors ligne ; couverts par le job *Socle* |
| `test:coherence`, `test:copy` | **NOT RUN** localement — Playwright absent ; verts dans le job *Parcours* |

## 7. Ce qui reste ouvert

1. **M3** — ouvert. Deux verrous mesurés (§4). La posture de production n'est
   pas établie, donc aucune modification de posture n'est justifiée.
2. **M6** — `BLOCKED`. Script livré, conditions d'accès écrites, aucune
   tentative de contournement.
3. **Portabilité de la chaîne de migrations** — nouveau constat de ce tour :
   `20261006160000` et `20261028120100` exigent un propriétaire
   superutilisateur. Ce n'est pas corrigé ici : modifier des migrations déjà
   livrées pour les rendre applicables par un propriétaire moins privilégié est
   un changement de posture qui demande une autorisation et une stratégie de
   compatibilité. C'est en revanche la condition technique préalable à toute
   application de l'option B de M3.
