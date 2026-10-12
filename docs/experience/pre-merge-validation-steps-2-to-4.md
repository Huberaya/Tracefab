# Validation pré-fusion de la PR #36 — étapes 2 à 4

**Date :** 2026-10-12
**Branche de travail :** `arena/879cd8db-tracefab`
**Commit examiné :** `44d49121` (tête de la PR #36 à l'heure de la rédaction)
**Autorisation appliquée :** niveau A (investigation, lecture seule, reproduction locale
non destructive sur cibles jetables) et niveau B (préparation documentaire, exécution
locale sur bases jetables). Aucun merge, aucun déploiement, aucune migration Neon,
aucun changement de secret, de variable ou de configuration de production.

---

## 0. Repères, et ce que ce document est

| Repère | Valeur |
|---|---|
| `main` | `b0c976f` |
| Tête de la PR #36 au début de ce contrôle | `16e453a` |
| Tête de la PR #36 à la rédaction | `44d49121` |
| Workflows enregistrés côté GitHub | 2 : `CI` (`disabled_manually`), `Figer la reference visuelle` (`active`) |
| Dernière exécution GitHub Actions du dépôt | 2026-10-10T10:18:56Z (`CI`, succès) |
| Exécutions créées après 2026-10-11T20:42:39Z | **0** (mesuré) |

La tête de la PR a bougé pendant le contrôle : l'auteur a poussé six commits
(`56d953c`, `ed0c9ce`, `3408967`, `7db70c1`, `e0e175b`, `44d49121`, 2026-10-12
13:02→13:15 +02:00) touchant `api/_routes/integrations*.ts`,
`api/_routes/documents/[documentId]/verify-ai.ts` et `scripts/prisma-generate.mjs`.
Ces commits ne touchent **ni** les trois routes métier de l'étape 1, **ni** la
migration de l'étape 2, **ni** `ci.yml` — les analyses ci-dessous restent valables,
et les mesures de refus des routes ont été **reprises à `44d49121`**.

Ce document rapporte trois contrôles (A, B, C). Chacun porte : statut, commit,
preuve, résultat, blocage, risque restant, critère de clôture. Aucun contrôle n'est
marqué « réussi » sans mesure reproductible ; aucun résultat n'est extrapolé ;
aucune session, aucun jeton et aucun accès n'ont été fabriqués pour obtenir un
résultat positif.

---

## 1. Contrôle A — routes métier `/api/organizations`, `/api/products`, `/api/suppliers`

**Statut : BLOQUÉ — aucune session de test autorisée n'existe. Seuls des refus ont
pu être mesurés ; aucun fonctionnement nominal n'a été observé.**

**Commit :** `44d49121` (worktree de travail détaché `/tmp/wt-pr36`, client Prisma
factice local, **aucune base jointe**).

**Commandes exécutées et résultats réels**

| Commande | Résultat mesuré |
|---|---|
| `npx tsx /tmp/harness_routes.mjs sans-secret` (`CLERK_SECRET_KEY` absent) | `/api/organizations` → **500** `internal_server_error` ; `/api/products` → **503** `clerk_not_configured` ; `/api/suppliers` → **503** `clerk_not_configured`. Journal : `GET /api/organizations failed Error: missing_clerk_secret_key` |
| `CLERK_SECRET_KEY="sk_locale_sonde_non_secrete" npx tsx /tmp/harness_routes.mjs secret-sans-jeton` | **401** `{"error":"unauthorized"}` sur les **trois** routes — refus par défaut, mesuré, aucune session fabriquée |
| `CLERK_SECRET_KEY=… TF_JETON=<jeton factice> npx tsx /tmp/sonde-jeton.mjs` (jeton à 3 parties, signature aléatoire locale) | **500** `internal_server_error` ×3, motif journalisé `TypeError: fetch failed` |
| `curl http://127.0.0.1:3000/api/{organizations,products,suppliers,me}` sur `node scripts/dev_static_server.mjs` | **HTTP 501** sur les quatre ; seule la route à fixture `/api/dpp/3760123456789` répond **200** |

**Résultat.** Le refus en l'absence d'en-tête `Authorization` est net et cohérent
sur les trois routes : **401**, sans exception levée, sans ligne de journal. En
revanche le sort d'un jeton est **indéterminé** : le `500` observé avec un jeton à
signature fausse provient d'un échec réseau (`TypeError: fetch failed` — pas de
route sortante vers Clerk depuis cet environnement), **et non d'un verdict de
signature**. Ce point ne doit pas être lu comme « le jeton a été rejeté ».

**Blocage (mesuré, non contourné).**

1. `CLERK_SECRET_KEY` n'est pas disponible et ne doit pas l'être ici : ce serait un
   secret de production.
2. Le dépôt ne contient **aucun** mécanisme de session de développement ou de test
   (aucun jeton de fixture, aucune branche d'authentification de test, aucune
   doublure de `requireClerkUser` dans les routes métier).
3. Les routes ne sont pas servies localement : le serveur de prévisualisation
   répond **501** sur `/api/*` sauf sur l'unique fixture présente.
4. Une session réelle exigerait le locataire Clerk de production, un utilisateur de
   test et une base portant des données — hors autorisation.

**Risque restant.** Le **fonctionnement nominal** des trois routes (statut 200,
forme de la charge utile, filtrage par locataire) est **non vérifié**. Une
régression d'isolation multi-locataire sur ces routes ne serait pas détectée par ce
contrôle. Le seul point établi est le refus par défaut.

**Critère de clôture.** Fournir un des deux moyens suivants, puis rejouer :
(a) un jeu d'identifiants de **test** (instance Clerk de test, utilisateur de test)
injecté par un mécanisme sécurisé — jamais collé dans un rapport ni dans un
ticket ; ou (b) une cible locale autorisée avec base de fixtures. Le rejeu doit
couvrir, pour chacune des trois routes : le cas nominal, le cas sans jeton (401), et
le cas **croisé** où un utilisateur du locataire A demande une ressource du
locataire B (attendu : refus ou 404, jamais de fuite).

---

## 2. Contrôle B — migration `20261012120000_close_public_execute_gap`

**Statut : ANALYSÉ INTÉGRALEMENT ET ÉPROUVÉ SUR BASE JETABLE — non appliqué à la
production, aucune exécution Neon.**

**Commit :** `44d49121` — blob de la migration `9e73c903833d`, 218 lignes,
4 blocs anonymes `DO`. Le fichier n'existe pas sur `main` : il est apporté par la PR.

### 2.1 Ce que fait la migration, bloc par bloc

| Bloc | Effet |
|---|---|
| `$adp$` | `ALTER DEFAULT PRIVILEGES FOR ROLE current_user REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` — **forme globale, sans `IN SCHEMA`**. Porte sur les objets **futurs** créés par le **rôle qui joue la migration** (propriétaire). C'est la vraie fermeture de la faille : la forme `IN SCHEMA public` utilisée par la migration antérieure `20261007100000` n'a aucun effet. |
| `$revoke$` | 6 signatures retirées à `PUBLIC`, chacune gardée par `to_regprocedure(...) IS NOT NULL` : `tracefab_material_visible_via_product(uuid)`, `tracefab_product_is_public(uuid)`, `tracefab_material_is_public(uuid)`, `tracefab_supplier_site_is_public(uuid)`, `tracefab_public_brand(uuid)`, `tracefab_public_context()`. La première portait le seul `GRANT … TO PUBLIC` explicite (migration `20261009120000`, ligne 75). |
| `$grants$` | 6 `GRANT EXECUTE … TO tracefab_app`, conditionnés par `IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app')` — rôle absent d'une base vierge, présent si le rôle d'infrastructure existe. |
| `$auto_controle$` | Crée une fonction témoin `tracefab__autocontrole_defaut_execute()`, mesure `has_function_privilege('public', …, 'EXECUTE')`, la supprime, et **lève `insufficient_privilege` (SQLSTATE 42501) si `PUBLIC` peut encore l'exécuter** ; sinon `RAISE NOTICE`. |

Aucune instruction ne touche une politique, une table ou une donnée.

### 2.2 Effets mesurés sur une base locale jetable

Chaîne complète rejouée dans une base locale jetable (PostgreSQL d'atelier,
`127.0.0.1:55432`, base recréée avant la mesure), jamais sur Neon :

* **36/36 migrations appliquées sans erreur** ; les trois dernières (dont la cible)
  sont **rejouables**.
* Les **six** fonctions : `PUBLIC` **ne peut plus** les exécuter — mesuré par
  `has_function_privilege('public', …)` après application.
* Le rôle applicatif `tracefab_app` **conserve** `EXECUTE` sur les **six**.
* Une fonction créée **après** la migration par le rôle de la migration est fermée à
  `PUBLIC` : les privilèges par défaut sont bien enregistrés (`pg_default_acl` :
  1 entrée pour le rôle migrateur, `{rôle=X/rôle}`, 0 pour `tracefab_app`).
* **Expérience décisive — portée du correctif :** une fonction créée par un
  **autre** rôle **reste exécutable par `PUBLIC`**. La fermeture ne couvre donc que
  les objets créés par le rôle qui joue la migration. C'est la précondition à
  vérifier en production avant application (§2.4, risque 1).
* **Contrôle négatif :** en retirant le bloc de privilèges par défaut, la migration
  **échoue comme prévu** — `Migration sans effet : une fonction creee par postgres
  est encore executable par PUBLIC … code SQLSTATE = 42501`. L'auto-contrôle n'est
  donc pas décoratif : il détecte l'absence du correctif.

### 2.3 Effet sur RLS, et pourquoi ce n'est pas un affaiblissement

Les politiques publiques restent `TO PUBLIC` — c'est leur **portée d'application**,
pas un droit d'exécuter. Plusieurs de ces politiques **appellent** les six
fonctions (par exemple `materials_select_authorized` appelle
`tracefab_material_visible_via_product`) : une politique est évaluée avec les
privilèges du rôle **qui interroge**. Rendre `EXECUTE` à `tracefab_app` est donc
**nécessaire** (sans quoi la lecture des tables publiques échoue) **et suffisant**
(l'isolation complète passait avec ce seul droit). Aucune politique, aucun `USING`,
aucun `CHECK` n'est modifié. `RLS` n'est ni désactivée ni contournée.

### 2.4 Risques de non-régression, et ce qui les lève

| # | Risque | Preuve / critère |
|---|---|---|
| 1 | **Le rôle migrateur n'est pas le propriétaire des six fonctions.** L'auto-contrôle mesurerait alors un autre rôle que celui des objets : vert, faille ouverte. | Mesuré sur la base jetable : propriétaire = rôle de migration, donc contrôle valide **ici**. En production : relever `pg_get_userbyid(proowner)` des six fonctions **et** `pg_default_acl` du rôle migrateur ; les deux doivent désigner le même rôle. |
| 2 | **Un rôle non-propriétaire interroge les tables publiques sans `EXECUTE`.** La politique échouerait au lieu de filtrer. | Inventaire du dépôt : seuls `tracefab_app` (94 mentions) et `neondb_owner` (41) sont nommés. En production : relever les rôles existants et leurs `EXECUTE` sur les six fonctions avant application. |
| 3 | **Ordre de déploiement.** Un correctif applicatif qui appellerait ces fonctions avec un autre rôle que `tracefab_app` casserait après migration. | Appels directs recensés dans le code et dans les migrations : tous passés par `tracefab_app` ou par le propriétaire. Aucun troisième rôle nommé (le motif `tracefab_readonly` du dépôt est un **nom de table sonde** dans un test d'audit, pas un rôle). |
| 4 | **Retour arrière.** Rejouer l'inverse rouvre la faille. | Inverse exact : `GRANT EXECUTE ON FUNCTIONS TO PUBLIC` pour le rôle concerné (privilèges par défaut) puis les 6 `GRANT EXECUTE ON FUNCTION … TO PUBLIC` explicites. À n'utiliser que sur décision explicite, avec horodatage. |
| 5 | **Non-idempotence.** `db:deploy` rejoue la migration sur la base jetable de la CI. | Mesuré : rejouable (`BEGIN`/`ROLLBACK` sans erreur). |

**Blocage.** L'application à la production est une opération de **niveau D**
(migration difficilement réversible, privilèges en production) : elle exige une
autorisation spécifique, absente. Les relevés de production (rôles, propriétaires,
`pg_default_acl`) exigent un accès base que je n'ai pas.

**Critère de clôture.** Autorisation de niveau D + relevé préalable en production
(rôle migrateur, propriétaire des six fonctions, privilèges par défaut, rôles
porteurs d'un `EXECUTE`) + application, puis mesure **après** application par la
même sonde que celle utilisée ici.

---

## 3. Contrôle C — CI GitHub

**Statut : INSPECTÉ — le déclenchement n'est pas démontrable comme sûr aujourd'hui ;
aucun workflow n'a été activé, modifié ni désactivé.**

### 3.1 Ce qui existe réellement

| Workflow | Fichier présent sur | État API | Déclencheurs | `permissions:` | Actions tierces | Accès base |
|---|---|---|---|---|---|---|
| `CI` | `main` (et branches) | **`disabled_manually`** (modifié 2026-10-11T20:42:39Z) | `push: branches: ['**']`, `pull_request`, `workflow_dispatch` | **aucun bloc** (défaut du dépôt) | 9 `uses:` sur **tags flottants** (`@v4`) sur `main` ; 9 épinglés **par SHA** sur la branche | voir §3.2 |
| `Figer la reference visuelle` | `arena/91844ee9-tracefab` **seulement** (pas sur `main`) | `active` | `workflow_dispatch` + `push` | `contents: write` | épinglées par SHA | aucune |
| `vercel-log-search` (branche PR #36) | `arena/879cd8db-tracefab` | **non enregistré** | `push` (branche), `workflow_dispatch` | `permissions: {}` | épinglées par SHA | aucune |

### 3.2 L'accès à la production, ligne par ligne

`main:.github/workflows/ci.yml`, job `base-de-donnees` — **deux références de code**
au secret :

* **L247** `TF_SECRET_PRODUCTION: ${{ secrets.DATABASE_URL }}` (env du job) ;
* **L278** `if: ${{ env.TF_SECRET_PRODUCTION != '' }}` ;
* **L280** `DATABASE_URL: ${{ secrets.DATABASE_URL }}` sur l'étape
  **« Scenarios croises contre la base de production »**, qui lance
  `test:neon:security|supplier|product|quality|collection`.

Ces suites créent et suppriment des rôles, accordent et révoquent des privilèges et
écrivent des lignes (décrit dans `docs/security/PHASE-1-PIPELINE-GITHUB.md` §2).
Côté branche PR #36, la même L244 n'est **qu'un commentaire** : le fichier de la
branche ne contient **aucune** référence de code à un secret, et sa base de données
est le service jetable `postgres:17` sur `localhost:5432`.

**Nuance décisive sur le choix du fichier par événement.** Un `push` exécute le
workflow **du commit poussé** ; une `pull_request` exécute celui de la tête de PR ;
un `push` sur `main` exécute celui de **`main`**. Autrement dit : activer `CI`
aujourd'hui n'est **pas** démontrable comme incapable de toucher la production, car
les événements portés par `main` (poussée sur `main`, `workflow_dispatch` sur `main`)
utiliseraient le fichier de `main`, celui qui contient L247/L278/L280.

### 3.3 Pourquoi aucun run n'a été établi pour le commit examiné

* Mesure : `total_count = 0` pour les exécutions créées **après**
  2026-10-11T20:42:39Z ; la dernière exécution du dépôt est
  2026-10-10T10:18:56Z (`CI`, `arena/91844ee9-tracefab`, `19a867a1`, succès).
* Mesure : sur `44d49121` comme sur `16e453a`, il n'existe **qu'un** `check-run` —
  `Vercel Preview Comments` (application `vercel`) — et un statut `Vercel`
  « Deployment has completed ». **Aucun check GitHub Actions.**
* Conséquence mécanique : le seul workflow enregistré capable de réagir à une
  poussée sur la branche est `CI`, et `CI` est `disabled_manually` **depuis une date
  antérieure** aux poussées du 2026-10-12 (les miennes comme celles de l'auteur).
  Le silence n'est donc pas un défaut du dépôt : il vient de l'état du workflow.

### 3.4 Pourquoi `CI` est désactivé, et ce que l'on ne peut pas conclure

* L'état `disabled_manually` est **mesuré** (API `actions/workflows`), et consigné
  dans le dépôt (`docs/security/PHASE-1-PIPELINE-GITHUB.md` L22 ;
  `docs/incident/TRACEFAB-BILAN-RECUPERATION-2026-10-12.md` L24, L93, L95, L376).
* Le **motif** de la désactivation n'est consigné nulle part ; je ne l'attribue pas.
* L'API refuse les réglages d'Actions :
  `repos/Huberaya/Tracefab/actions/permissions` →
  `Resource not accessible by integration` (403). On ne peut donc pas distinguer
  « `CI` désactivé seul » de « Actions désactivées pour le dépôt ».
* Indice mesuré qui pointe vers une portée plus large que `CI` : le fichier de
  workflow poussé sur la branche le 2026-10-12 **n'a pas été enregistré** par
  GitHub, alors qu'un tel fichier poussé le 2026-10-09 l'a été et a produit un run
  (`Figer la reference visuelle`, 2026-10-09T22:30:45Z, succès). Retenu comme
  observation, pas comme conclusion : le réglage lui-même est illisible avec ce
  jeton. Un simple regard du propriétaire dans *Settings → Actions → General*
  tranche.

### 3.5 Exposition résiduelle à traiter

`Figer la reference visuelle` est **actif**, porte `contents: write`, et se
déclenche par `push` sur toute branche où `tests/regression/reference/.figer`
change. Il est absent de `main`. C'est une écriture de dépôt par un jeton de
workflow : à désactiver ou à reprendre après revue (le patch de durcissement est
préparé dans `docs/security/patches/figer-reference-visuelle.permissions.patch`).

**Blocage.** Aucune activation n'est possible tant que la démonstration
« ne peut pas toucher la production » n'est pas faite ; les réglages et les secrets
du dépôt sont illisibles (403) et la protection de `main` aussi.

**Critère de clôture.** La démonstration est **faite** pour le fichier de la branche
PR #36 (aucune référence de code à un secret, base jetable locale uniquement). Elle
reste à faire pour `main`. Deux chemins, aucun exécuté ici : (1) porter d'abord sur
`main` le fichier sans accès à la base de production (la PR #36 le contient), ou
(2) faire vérifier par le propriétaire que `secrets.DATABASE_URL` n'existe pas.
Ensuite seulement : activer `CI`, vérifier un run vert, et **vérifier que la
protection de `main` n'exige pas un check qui n'est jamais produit** — un check
obligatoire jamais émis bloque toute fusion (voir §5 du document
`PHASE-1-PIPELINE-GITHUB.md`).

---

## 4. Contrôles toujours bloqués, par cause

| Contrôle | Cause du blocage |
|---|---|
| Fonctionnement nominal et isolation des trois routes métier | Aucune session de test autorisée ; routes non servies localement (501) |
| Verdict de signature Clerk sur un jeton | Aucune route réseau sortante (`TypeError: fetch failed`) — verdict **indéterminé**, à ne pas lire comme un rejet |
| Réglages Actions du dépôt, protection de `main`, secrets du dépôt | API GitHub : `Resource not accessible by integration` (403) |
| Existence du secret `DATABASE_URL` | `gh secret list` 403. Le dépôt se contredit : `PHASE-1-PIPELINE-GITHUB.md` L24 le donne « présent » **en l'inférant d'un 403** (inférence non valide), tandis que `main:.github/workflows/ci.yml` L216-217 affirme « Le dépôt n'a jamais eu le moindre secret ». À trancher par le propriétaire |
| Relevé de production (rôles, propriétaires de fonctions, `pg_default_acl`) | Aucun accès base de production, aucune chaîne fournie — et n'en demander aucune en clair |
| Journaux de build Vercel (la chaîne `postinstall` a-t-elle réellement tourné ?) | Réseau et rétention ; le statut Vercel `success` du 2026-10-12T11:16:08Z sur `44d49121` en est un indice, pas une preuve |
| Migration appliquée en production | Opération de niveau D, autorisation spécifique absente |

---

## 5. Ce qui a été exécuté, et rien de plus

* `git worktree add --detach /tmp/wt-pr36` puis `git checkout --detach 44d49121` :
  arbre de travail **hors du dépôt**, doublure locale du client Prisma,
  **aucune base jointe**.
* Sondes de refus sur les trois routes (trois variantes), avec une clé Clerk
  **factice locale** (`sk_locale_sonde_non_secrete`) et un jeton **factice** à trois
  parties dont la signature est un tirage aléatoire local — aucun secret réel,
  aucune session fabriquée.
* `node scripts/dev_static_server.mjs` : relevé des codes HTTP des routes.
* Base **jetable locale** : chaîne complète (36/36), rejeu des trois dernières,
  mesure `has_function_privilege` pour `public` et `tracefab_app`,
  `pg_default_acl`, expérience « autre rôle », contrôle négatif de l'auto-contrôle.
* Lectures seules côté GitHub : `actions/workflows`, `actions/runs`, `branches`,
  `commits/<sha>/check-runs`, `commits/<sha>/status`, plus `git ls-remote`.

Aucune écriture n'a été faite sur GitHub hormis les commits de documentation de la
branche de travail ; aucun workflow n'a été activé, désactivé ou modifié ; aucun
secret, variable ou réglage de production n'a été touché ; aucune migration n'a été
appliquée ailleurs que sur une base jetable locale.
