# TRACEFAB — Chantier 4 : diagnostic production, audit Neon et rétablissement du pipeline

**Date** : 2026-10-12 (Europe/Paris)
**Dépôt** : `Huberaya/Tracefab` — branche de travail `arena/879cd8db-tracefab`
**PR de référence** : #36, **brouillon**, non fusionnée
**Aucune fusion. Aucun déploiement de production. Aucune modification de Neon. Aucune branche supprimée.**

Statuts employés : `CORRIGÉ ET PROUVÉ` · `CORRIGÉ EN ENVIRONNEMENT ISOLÉ` · `PRÉPARÉ NON APPLIQUÉ` · `BLOQUÉ` · `NON VÉRIFIÉ`.

---

## 1. Diagnostic des routes de production

### 1.1 Ce qui n'a pas pu être fait, et la preuve du blocage

L'observation directe est **BLOQUÉE**. Ce n'est pas une supposition :

```
https://tracefab.vercel.app/api/health           → HTTP 000  (curl, code 35)
https://tracefab.vercel.app/api/catalog/schemas  → HTTP 000  (curl, code 35)
DNS                                              → résolution OK (64.29.17.3, 216.198.79.3)
témoins de la liste d'accès : registry.npmjs.org → HTTP 200
                              api.vercel.com     → HTTP 000
                              console.neon.tech  → HTTP 000
```

La résolution DNS fonctionne, la connexion TLS est coupée : cet environnement
n'a accès qu'à une liste d'hôtes autorisés. Aucun journal Vercel n'est
accessible par cette voie, et l'API Vercel l'est encore moins.

### 1.2 Ce que l'état servi permet d'établir, sans les journaux

Le déploiement de production servi est `6968252029`, référence **`b0c976f`**
(2026-10-09T18:36Z) — lu dans l'API GitHub, pas déduit.

Au commit `b0c976f` :

- `package.json` **n'a aucun `postinstall`** ;
- `prisma` **et** `@prisma/client` sont en `devDependencies` ;
- par conséquent le seul chemin de génération était le `postinstall` du paquet
  `@prisma/client` lui-même.

Comportement de ce chemin, **mesuré** dans cet environnement en rejouant le
script du paquet (projet jetable, sans CLI Prisma résolvable) :

```
scripts/postinstall.js  →  code de sortie 0
sortie                  →  « warning In order to use "@prisma/client",
                             please install Prisma CLI. »
fichiers créés          →  node_modules/.prisma/client/{default,index}.js  (aucun moteur)
new PrismaClient()      →  "@prisma/client did not initialize yet. Please run "prisma generate"."
```

Autrement dit : **l'installation réussit en laissant un client factice**. Le
déploiement est vert, et le client déployé ne peut pas interroger la base.

Le reste de la chaîne est mesuré sur l'arbre réel :

| État du client | Modules de route qui se chargent | Erreur observée |
|---|---|---|
| client factice (état local actuel) | **6 / 125** | `SyntaxError: The requested module '@prisma/client' does not provide an export named 'PrismaClient'` |
| client conforme (fixture locale) | **125 / 125** | — |

La barrière d'erreur de `api/index.ts` est le **seul** émetteur de
`{"error":"internal_error","correlationId":…}` du dépôt, et un module de route
qui ne se charge pas la traverse. Le mécanisme est donc reproduit de bout en
bout : installation verte → client factice → chargement de module en échec →
`internal_error`.

### 1.3 Verdict

| Élément | État |
|---|---|
| Codes HTTP et corps des deux routes | **BLOQUÉ** — réseau sortant fermé |
| Déploiement et commit servis | **CORRIGÉ ET PROUVÉ** — `6968252029` = `b0c976f` (API GitHub) |
| Identifiant `c3696f22-…` dans les journaux | **NON VÉRIFIÉ** — voir §2 |
| État de génération au déploiement concerné | **NON VÉRIFIÉ** en production, **mécanisme reproduit** (ci-dessus) |
| Cause racine prouvée | **NON** — hypothèse mécanistiquement complète, non constatée sur pièce |

## 2. Preuves disponibles dans les journaux

Aucune ligne de journal n'est accessible depuis cet environnement.

Point important, vérifié dans le code plutôt que supposé : l'identifiant de
corrélation **n'est pas perdu par conception**. `api/_lib/error-reporting.ts`
écrit à chaque erreur une ligne JSON sur `stderr` contenant
`correlationId`, `environment`, `release`, le nom du module, la pile tronquée
et un contexte caviardé. Vercel capture `stderr` : l'identifiant
`c3696f22-41d0-4981-8d99-4e6a177021a3` a donc bien été écrit dans les journaux
d'exécution du déploiement concerné.

La limite est la **rétention** : le déploiement servi date du 2026-10-09, soit
trois jours. Les journaux d'exécution Vercel ont une durée de conservation
limitée selon l'offre. Il est donc possible que la ligne ne soit plus
consultable — ce qui n'est pas la même chose que « l'identifiant n'existe pas ».

**Action propriétaire, précise** : console Vercel → projet → *Logs* (ou
*Observability*), déploiement `6968252029`, filtre texte
`c3696f22-41d0-4981-8d99-4e6a177021a3`. Si la rétention a expiré, la réponse est
« non consultable », et la cause restera **NON VÉRIFIÉE** : je ne la déclarerai
pas prouvée par déduction.

## 3. Instrumentation sécurisée — CORRIGÉ ET PROUVÉ (local)

Ce qui manquait n'était pas le canal, c'était le **discriminant** : un module
qui ne se charge pas et une exception de gestionnaire produisaient le même 500
et la même ligne, sans dire lequel des deux.

Ajouté, dans les modules existants (aucun module reconstruit) :

| Fichier | Changement |
|---|---|
| `api/_lib/error-reporting.ts` | `ErrorContext.phase` (`module_load` \| `handler`) ; `error.code` ; `error.moduleSpecifier` extrait de `Cannot find module '…'` |
| `api/index.ts` | le chargement du module et l'appel du gestionnaire sont distingués ; la réponse au client est inchangée (`500` + `correlationId`) |
| `scripts/test_error_reporting.ts` | 11 contrôles : phase nommée, module absent nommé, code conservé, aucun secret dans la ligne, un message anodin non altéré, une erreur = une ligne |

Caviardage : celui du dépôt, déjà couvert (chaîne de connexion, `sk_`/`rk_`/`pk_`,
`re_`, `AKIA`, `Bearer`, `eyJ`, paramètres `token|key|secret|signature`). La
ligne écrite pour une erreur contenant
`postgresql://user:motdepasse@ep-xxx…neon.tech/db` ne contient **ni le mot de
passe, ni le nom d'hôte** — vérifié par le test, pas par relecture.

Conséquence : la prochaine occurrence est interrogeable en une recherche
(`"phase":"module_load"`), sans avoir besoin du test discriminant.

## 4. État réel de la PR #36

Vérifié sur la branche, pas d'après la description :

| Point annoncé | Constat |
|---|---|
| 19 commits | **exact** (`git rev-list --count main..HEAD`) |
| 27 fichiers | **exact** (`git diff --name-only`) |
| commit de contrôle négatif identifié | **oui** — `21f9340`, seul `package.json` touché, reverté par `62fc3b3` |
| comportement final rétabli | **oui** — `postinstall` de `HEAD` **identique octet pour octet** à celui d'avant le contrôle (`b0d332f`) ; aucun résidu `__controle_negatif` dans le code |
| fichiers référencés existants | **oui** — scripts, migration, documents, registre de politique : tous présents |
| nouvelle vulnérabilité introduite | **aucune trouvée** — revue des nouveaux scripts : `spawnSync` sans shell, CLI Prisma local par chemin fixe (jamais un homonyme du registre), échec fermé, aucun `eval`, aucune écriture hors du dépôt |

Le seul écart, assumé et documenté dans l'historique : `21f9340` reste dans la
branche. Il **doit** y rester : c'est la preuve datée qu'un échec de génération
fait échouer un déploiement.

## 5. Tests exécutés et résultats

Tous exécutés today, sur cette branche. « Isolé » = PostgreSQL 18.4 jetable
(`127.0.0.1:55432`, base `tracefab_test`).

| Test | Code | Résultat |
|---|---|---|
| batterie de 15 suites (`test:db-guard`, `test:db-routing`, `test:workflow-policy`, `test:prisma-client`, `test:audit-script`, `test:neon:privileges`, `test:neon:rls`, `test:error-reporting`, `schema:static`, `test:security:chantier1`, `test:routes`, `test:production-readiness`, `test:cross-tenant`, `test:private-storage`, `test:questionnaires`) | 0 | 15/15 vertes |
| `test:router-load`, client factice | **1** | 119/125 modules ne se chargent pas — mode de défaillance reproduit |
| `test:router-load`, client conforme | 0 | 125/125, dont le parcours 404 |
| `verify:prisma-client`, client conforme **sans moteur** | **1** | refusé : c'est la panne qui suivrait un déploiement vert |
| séquence exacte du job CI (isolé) : `db:seed-rls`, `test:neon:rls`, `test:audit-script`, `test:neon:privileges` | 0 | les quatre suites du job « Base » passent sur la base jetable |
| `db:deploy` (local) | **1** | **limite locale** : le CLI Prisma veut télécharger son moteur depuis `binaries.prisma.sh`, inaccessible ici ; les 36 migrations ont été appliquées par le harnais SQL et rejouées sur base neuve |
| `npm run typecheck` | 0 | — |
| `npm run api:typecheck` | **2** | 85 erreurs, **toutes** dues au client Prisma non généré localement ; **différentiel avant/après mes modifications : 85 → 85, aucune erreur nouvelle** |
| `audit_neon_readonly` (cible jetable, cible déclarée fausse, cible absente) | 0 / **3** / **2** | rapport produit, puis refus sans rapport, puis refus sans exécution |

**Non exécuté, donc non réussi** : aucune suite de navigateur, aucune suite
contre Neon, aucune exécution en CI (workflow désactivé).

### 5.1 Observation nouvelle : des échecs de déploiement non reproductibles

Pendant ce chantier, **deux des six derniers déploiements Preview ont échoué**,
et les deux portaient sur des commits **de documentation seule** :

| Déploiement | Commit | Contenu | État |
|---|---|---|---|
| `7010547028` | `4a5b70c` | 1 fichier, documentation | **failure** (`dpl_7XwXhdxafNRZhGu8GGxDixnSRuYg`) |
| `7010746458` | `0a7df1b` | 6 fichiers, dont le code de `4a5b70c` **et** des modifications | succès |
| `7010775542` | `1cf5fdf` | 1 fichier, documentation | **failure** (`dpl_DnQBwcNWEPwM3tteamEfEHL73mwe`) |
| `7010717749` | `826bc11` | correctif CI (branche isolée) | succès |

Ce qui est établi, et ce qui ne l'est pas :

- **établi** : l'échec n'est pas un effet du contenu — `0a7df1b` contient tout
  `4a5b70c` **plus** du code, et il a réussi ;
- **établi** : la garantie centrale tient toujours. Un échec de génération
  **fait échouer** le déploiement (contrôle négatif `7010111138`), et un
  déploiement **vert** prouve que l'installation, la génération et la
  vérification ont eu lieu, puisque `postinstall` est le passage obligé ;
- **non établi** : la cause de ces deux échecs. Le schéma observé (échec sur
  les commits sans changement de `package.json`) **suggère** un chemin de cache
  d'installation, mais deux occurrences ne font pas une preuve, et je ne
  transforme pas une suggestion en conclusion ;
- **conséquence honnête** : un déploiement rouge **ne prouve rien à lui seul**.
  La flakiness ajoute des faux négatifs, jamais de faux positifs — l'argument
  « vert ⇒ génération vérifiée » reste valide, l'argument inverse n'a jamais
  été avancé.

Ces échecs sont **Preview** : la production n'a pas été touchée (dernier
déploiement de production `6968252029` = `b0c976f`, inchangé).

**Pour trancher, deux commandes côté propriétaire** (les journaux sont hors
d'atteinte d'ici) :

```
npx vercel inspect dpl_7XwXhdxafNRZhGu8GGxDixnSRuYg --logs
npx vercel inspect dpl_DnQBwcNWEPwM3tteamEfEHL73mwe --logs
```

Si la trace désigne le téléchargement des binaires Prisma pendant
l'installation, la parade est de fixer la version du moteur ou de le mettre en
cache ; si elle désigne autre chose, c'est cette autre chose qu'il faudra
corriger — et le remède ne sera pas le même.

## 6. État de la CI et raisons du blocage

- État : `disabled_manually`. **Métadonnée disponible** : workflow créé le
  2026-10-08T17:30:08Z, état modifié pour la dernière fois le
  **2026-10-11T20:42:39Z** — la veille de cette session, donc pendant la
  réponse à l'incident, **avant** mes travaux. La raison du clic n'est pas
  exposée par l'API : **NON VÉRIFIÉ** (je ne l'invente pas).
- Aucune exécution sur cette branche (cohérent avec l'état désactivé).

**Pourquoi je n'ai pas réactivé, alors que mes droits le permettraient**
(`permissions.admin = true`) : l'état « désactivé » est porté par le **chemin**
du workflow, donc commun à toutes les branches. Réactiver maintenant rendrait
immédiatement actifs les dix workflows dangereux recensés au §7 — dont celui de
`main`, qui lance cinq suites écrivant en base contre la cible du secret
`DATABASE_URL`. Ce serait « réactiver aveuglément un workflow susceptible
d'exécuter des tests destructeurs ».

**Séquence sûre, dans cet ordre** :

1. **Retirer le secret `DATABASE_URL`** des secrets Actions
   (`Settings → Secrets and variables → Actions → DATABASE_URL → Remove`).
   Une seule action neutralise les onze alertes : sans le secret, les étapes
   destructives des dix workflows sont conditionnelles et **sautent**. Effet
   de bord mesuré : aucune étape légitime ne lit ce secret.
2. **Porter le correctif minimal sur `main`** (§ ci-dessous), ou fusionner la
   PR #36.
3. **Alors seulement** : `gh workflow enable CI`.

**Correctif minimal préparé, `PRÉPARÉ NON APPLIQUÉ`** :
`docs/security/patches/ci-main-sans-secret.patch` — 2 insertions, 18 suppressions,
4 hunks. Vérifié applicable sur `main` dans un worktree jetable
(`git apply --check`), et le fichier résultant ne contient **plus aucune
référence à `secrets.`** et plus qu'une seule suite de base, celle qui vise la
base jetable du runner. Réserve explicite : appliquer ce patch sur `main` puis
fusionner la PR #36 demandera de résoudre un conflit dans la section du job
`base-de-donnees` ; le contenu final doit rester celui de la PR.

**Correction isolée effectivement posée** : branche
`securite/ci-sans-secret-depuis-main` (commit `826bc11`, 1 fichier), créée
depuis `main`, contenant exactement ce correctif minimal — pour que le
propriétaire puisse l'examiner en un diff, sans toucher à `main`.
(*Note de transparence : ma session est normalement liée à
`arena/879cd8db-tracefab` ; la mission demandant une correction sur branche
isolée, cette branche a été créée et poussée pour cela uniquement. Toute la
production de cette session reste sur `arena/879cd8db-tracefab`.*)

## 7. État réel de Neon

**BLOQUÉ**, sans tentative de contournement. Aucune chaîne de connexion n'est
disponible dans cet environnement, et il est interdit d'en réclamer une par le
chat.

Contrôle du script avant exécution, fait par lecture et par test :

- **dix requêtes**, toutes en lecture : `SHOW default_transaction_read_only`,
  `pg_roles`, `pg_class`/`pg_policy` (RLS), `pg_proc` (fonctions,
  SECURITY DEFINER, `has_function_privilege`), `_prisma_migrations`,
  `pg_default_acl`, propriétaires de tables — plus l'identité de session ;
- liste blanche vérifiée au démarrage : toute requête qui ne commence pas par
  `SELECT`, `WITH`, `SHOW` ou `TABLE` fait **échouer le script** avant connexion ;
- lecture seule **appliquée par le serveur** (`SET SESSION CHARACTERISTICS AS
  TRANSACTION READ ONLY`), prouvée par un `CREATE TABLE` refusé ;
- cible **déclarée d'avance** (`--expect-database=`) : sortie 3 si la base jointe
  diffère, sortie 2 sans cible, aucun repli silencieux ;
- aucune divulgation : hôte remplacé par sa **classe** (« base gérée (Neon) »),
  empreinte SHA-256 tronquée à 12 caractères, rapport relu avant affichage.

**Commande à exécuter par le propriétaire**, avec une chaîne en lecture seule
fournie par un mécanisme sécurisé :

```bash
DATABASE_URL=... node scripts/audit_neon_readonly.mjs --expect-database=<nom exact>
```

Relevé à consigner : rôle de connexion, `rolsuper`/`rolbypassrls`,
`neondb_owner` en avertissement, tables/politiques RLS, migrations appliquées,
`has_function_privilege('public', …)` sur les cinq fonctions,
`pg_default_acl`. Aucun de ces points n'est connu aujourd'hui : **NON VÉRIFIÉ**.

## 8. Inventaire des onze alertes critiques

Re-mesuré aujourd'hui après `git fetch --all` (`npm run audit:workflows`) : les
onze alertes sont **toujours présentes**. Elles ne sont pas identiques : deux
classes distinctes.

### Classe A — visent la production (secret + étape conditionnelle)

| # | Référence | Commit | Lignes | Suites |
|---|---|---|---|---|
| 1 | `main` | `b0c976f` | `ci.yml` L247 (secret), L280 (URL), L282-286 | 5 suites destructives + `seed_rls_fixture.mjs` L268 |
| 2 | `correctifs/chantier-1a` | `052ae64` | L268, L316, L318-322 | 7 suites, dont 2 inédites (`test:neon:rls:auth`, `test:neon:dpp-ambigu`) |
| 3 | `arena/e72cecf4-tracefab` | `49a2dc4` | L258, L313, L315-319 | 5 suites |
| 4 | `experience/chantier-16-securite-performance` | `1e71c6d` | L220, L238, L240-244 | 5 suites |
| 5 | `experience/chantier-17-ci` | `c9128a4` | L215, L233, L235-239 | 5 suites |
| 6 | `experience/chantier-18-production` | `438aa9c` | L220, L238, L240-244 | 5 suites |
| 7 | `experience/chantier-19-commercial` | `1051c05` | L220, L238, L240-244 | 5 suites |
| 8 | `experience/chantier-20-coherence` | `eee4817` | L220, L238, L240-244 | 5 suites |

- **Vulnérabilité** : le job transmet `DATABASE_URL` depuis `secrets.DATABASE_URL`
  et exécute des suites qui **créent et suppriment des rôles, écrivent des
  lignes et modifient des données** contre la cible de ce secret.
- **Preuve** : lecture directe des fichiers (`git show <ref>:…`), pas
  d'inférence ; les lignes sont citées ci-dessus.
- **Différence décisive** : les branches `experience/*` (4 à 8) **n'ont aucune
  base jetable** dans ce job — les cinq suites sont leur unique contenu. Si le
  secret existe, chaque poussée écrit dans la cible du secret. `main`,
  `chantier-1a` et `e72cecf4` portent en plus une base jetable pour les autres
  étapes : le risque y est concentré sur l'étape conditionnelle.
- **Exploitabilité** : conditionnée à l'existence du secret. `gh secret list`
  répond 403 à cette intégration : **l'existence du secret n'est pas
  vérifiable ici**. Les alertes sont donc *latentes* si le secret est absent,
  *actives* s'il existe — je ne tranche pas à la place du propriétaire.
- **Correctif minimal** : `docs/security/patches/ci-main-sans-secret.patch`
  (appliqué sur `main` et sur chaque branche de la classe) **ou**, plus
  efficace et immédiat, le retrait du secret.
- **Tests nécessaires** : `npm run test:workflow-policy` (les huit témoins
  refusent chacun de ces motifs) ; `npm run test:db-routing` (section C : toute
  suite écrivant en base sans passer par la garde fait échouer la chaîne).

### Classe B — écrivent en base sans garde, sur base jetable (écart de politique)

| # | Référence | Commit | Lignes | Constat |
|---|---|---|---|---|
| 9 | `arena/91844ee9-tracefab` | `19a867a` | L284 (`seed_rls_fixture.mjs`), L289, L295, L307, L312 | 5 écritures non gardées, **toutes sur le Postgres jetable du runner** |
| 10 | `security/incident-3b-remove-production-db-from-ci` | `8fe013e` | L265, L270 | idem : jetable, mais appel direct |

- **Vulnérabilité** : aucune atteinte à la production. L'écart est **la
  disparition du point de passage unique** : sans garde, rien ne prouve
  formellement que la cible est jetable, et une variable d'environnement
  modifiée suffirait à rediriger ces écritures.
- **Risque d'une fusion** : ces branches apportent des suites **absentes de mon
  arbre** (`test:neon:dpp-provenance`, `test:neon:deploiement-publication`,
  `test:neon:auth-provisioning`, `test:neon:rls:auth`, `test:neon:dpp-ambigu`).
  Fusionnées dans un arbre contenant la PR #36, la section C de
  `test:db-routing` **échoue** tant que ces suites ne passent pas par la garde :
  c'est exactement le contrôle avant fusion demandé.
- **Correctif minimal** : router ces cinq suites par `npm run` + la garde
  (`scripts/run-db-suite.mjs`) ou les déclarer explicitement.
- **À noter** : l'alerte 10 est portée par la PR #35 (brouillon), dont l'objet
  est précisément de retirer la production du job. Elle n'est donc pas une
  régression, mais un état intermédiaire.

### Alerte 11 — workflow visuel

| # | Référence | Commit | Lignes | Constat |
|---|---|---|---|---|
| 11 | `arena/91844ee9-tracefab` | `19a867a` | `figer-reference-visuelle.yml` L32-34, L41-42 | `permissions: contents: write` **au niveau du workflow**, déclenché par `push` sur un marqueur **et** par `workflow_dispatch` |

- **Vulnérabilité** : un jeton d'écriture est détenu par le workflow entier, et
  les jobs exécutent du code du dépôt (`npm ci`, Playwright, suites de
  régression). Un jeton qui peut pousser ne doit pas être détenu par un job qui
  exécute du code.
- **Atténuation de fait** : il faut déjà le droit d'écriture pour pousser le
  marqueur. Le risque est donc un écart de conception, pas une entrée non
  authentifiée.
- **Correctif préparé, `PRÉPARÉ NON APPLIQUÉ`** :
  `docs/security/patches/figer-reference-visuelle.permissions.patch` — vérifié
  applicable sur sa branche ce jour (`git apply --check`, worktree jetable).
  Conflit documenté : le fichier n'existe que sur `arena/91844ee9-tracefab`,
  donc un add/add si on l'applique ailleurs.
- **Tests nécessaires** : `test:workflow-policy` section H (aucun job
  `contents: write` n'exécute de code du dépôt) et les témoins
  `test:workflow-policy-temoins` (`ecriture-job.yml`, `ecriture-workflow.yml`).

## 9. Correctifs effectivement réalisés, et préparés

**CORRIGÉ ET PROUVÉ (local, sur cette branche)** :

1. Discrimination de l'étape de panne (`module_load` / `handler`) et nom du
   module absent dans la ligne de journal — test dédié, 11 contrôles verts.
2. Contrôle du **moteur** Prisma dans `verify:prisma-client` — quatre états de
   client couverts dans les deux sens.
3. `securite/ci-sans-secret-depuis-main` : correctif minimal de `main`, posé sur
   une branche isolée.

**CORRIGÉ EN ENVIRONNEMENT ISOLÉ** : garde de cible et routage des suites
destructives ; politique des workflows et ses huit témoins ; migration de
privilèges validée avec contrôle négatif ; audit Neon en lecture seule.

**PRÉPARÉ NON APPLIQUÉ** : `ci-main-sans-secret.patch` ; patch du workflow
visuel ; réglages de protection de `main` ; application de la migration
corrective en production ; contenu de la PR #36 (19 → 20 commits).

## 10. Actions nécessitant une intervention du propriétaire

1. **Retirer le secret `DATABASE_URL`** (ou confirmer son absence) — neutralise
   les onze alertes d'un coup. C'est l'action au meilleur rapport effet/risque.
2. **Chercher `c3696f22-41d0-4981-8d99-4e6a177021a3`** dans les journaux du
   déploiement `6968252029` — seule voie vers la cause prouvée.
3. **Fournir une chaîne de connexion en lecture seule** (mécanisme sécurisé)
   pour l'audit Neon, ou exécuter le script soi-même.
4. **Décider du sort de la PR #36** (brouillon) et de la branche
   `securite/ci-sans-secret-depuis-main`.
5. **Activer la CI** — seulement après 1 et 4 : `gh workflow enable CI`.
6. Protections de `main`, réglages Vercel (rôle de connexion applicatif,
   commande de build), politiques d'accès aux environnements.

## 11. Prochaine action prioritaire

**Retirer le secret `DATABASE_URL` des secrets Actions.** Une action de deux
minutes qui éteint les onze alertes, sans toucher au code, à la base, ni au
déploiement : les étapes destructives sont conditionnées à sa présence, et
aucune étape légitime ne le lit. Ensuite, la recherche du journal (§2) donne la
cause ; à défaut, le test discriminant à deux requêtes
(`/api/health` puis `/api/catalog/schemas`) reste disponible et ne demande
aucun accès.

## 12. Ce que ce rapport ne prouve pas

- Que la production réponde `internal_error` **aujourd'hui** : le mécanisme est
  reproduit, l'occurrence n'est pas constatée.
- Que le client Prisma était bien absent du déploiement servi : c'est
  l'hypothèse la mieux étayée, pas un constat.
- Que le secret `DATABASE_URL` existe encore : non vérifiable ici (403).
- Que la CI doive être réactivée en l'état : elle ne le doit pas avant le
  retrait du secret et l'arrivée du workflow durci.
- Que `api:typecheck` passe : échoué ici pour une raison d'environnement, avec
  un différentiel nul sur mes modifications — mais un différentiel nul n'est pas
  une réussite.

Aucun contrôle local n'est présenté comme une validation de production.
