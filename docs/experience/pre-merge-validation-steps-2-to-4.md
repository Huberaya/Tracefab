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

---

# Levée des blocages — mise à jour du 2026-10-12 (soir)

**Commit examiné :** `ba5f159` (tête de la PR #36 avant cette mise à jour ; les
sections 0 à 5 ci-dessus sont conservées telles quelles, elles rapportent l'état
antérieur et restent la trace des mesures de l'époque).

Statuts employés : `RÉUSSI` (mesuré, preuve reproductible) · `ÉCHEC` (mesuré, et
le résultat est un défaut) · `BLOQUÉ` (prérequis ou accès manquant) ·
`NON EXÉCUTÉ` (aucune mesure, donc aucun verdict).

---

## 6. Contrôle A — routes métier : dispositif d'épreuve et mesures

### 6.1 Le mécanisme retenu, et pourquoi c'est le plus sûr

**Instance Clerk de TEST** (clé `sk_test_…`), jamais l'instance de production.
Les identités sont créées dans cette instance par l'API dorsale
(`clerk.users.createUser`), les jetons sont de **vrais jetons de session**
(`clerk.sessions.createSession` puis `clerk.sessions.getToken`) : ils traversent
le vrai `verifyToken` du code applicatif. Aucune doublure d'authentification
n'est posée dans le code applicatif, et aucune ne serait atteignable en
production : le dispositif vit dans un harnais, hors des chemins de requête.

Ce mécanisme est préférable à une injection d'identité parce qu'il éprouve la
chaîne réelle (signature, `sub`, `clerk.users.getUser`, `prisma.user.upsert`) au
lieu de la contourner. Il est préférable à l'instance de production parce
qu'aucune donnée réelle n'est touchée et qu'aucun secret de production n'est
exposé à un harnais.

### 6.2 Ce qui a été livré

| Élément | Fichier | Rôle |
|---|---|---|
| Harnais d'épreuve | `scripts/test_routes_tenant_isolation.mjs` (nouveau) | gardes, identités de test, cas A1–A4, bilan |
| Commande dédiée | `package.json` → `verify:routes:isolation` | **hors** du préfixe `test:` : la boucle de CI ne l'attrape pas, donc pas de rouge ni de faux vert en attendant l'instance de test |
| Fixture | réutilise `npm run db:seed-rls` (Maison Alpha / Maison Beta) | deux locataires porteurs de données, avec l'adhésion `viewer` croisée ajoutée par le harnais pour le cas A3 |

### 6.3 Les quatre cas définis, et l'attendu tiré du code

| Cas | Requête | Attendu | Source de l'attendu |
|---|---|---|---|
| A1 accès autorisé | jeton alpha → `GET /api/organizations` | 200, ses organisations, **pas** celles de Beta | `api/_routes/organizations.ts` L20-36 |
| A2 absence d'authentification | sans en-tête → les trois routes | 401 `unauthorized` | `api/_lib/auth.ts` L16-21, L54-56 |
| A3 permissions insuffisantes | jeton alpha (`viewer` de Beta) → `POST /api/products` sur Beta | 403 `brand_product_role_required` | `api/_routes/products.ts` L88-95 ; `tracefab_create_product` (`20260923160000` L122-126) ; mapping `api/_lib/sql-errors.ts` L32 |
| A4 isolation entre deux organisations | jetons alpha et beta → `GET /api/products`, `?organizationId=<Beta>` avec jeton alpha, `GET /api/suppliers` | aucune organisation en commun ; liste **vide** sur la cible croisée, jamais une fuite | `api/_routes/products.ts` L57-59 ; `api/_routes/suppliers.ts` L21-56 |

### 6.4 Mesures réelles obtenues

| Mesure | Commande | Résultat | Statut |
|---|---|---|---|
| Refus par défaut du harnais, 7 configurations | voir §6.5 | codes 3, 2, 2, 3, 3, 3, 3 | `RÉUSSI` |
| Refus sans jeton sur les trois routes | `/tmp/harness_routes.mjs` (arbre `44d49121`) | 401 ×3 | `RÉUSSI` (déjà au §1) |
| Isolation RLS **avant** migration | `npm run test:neon:rls` sur base jetable recréée (35/36 migrations) | 14 contrôles `ok`, 0 échec, 47 tables sous RLS | `RÉUSSI` |
| Isolation RLS **après** migration | idem, base 36/36 | **sortie identique**, 14 `ok`, 0 échec | `RÉUSSI` |
| Cas A1, A3, A4 (fonctionnement nominal) | `npm run verify:routes:isolation` | **aucune mesure** : le harnais s'arrête avant | `NON EXÉCUTÉ` |

### 6.5 Matrice de refus du harnais (mesurée, sortie réelle)

| Configuration | Sortie | Message |
|---|---|---|
| aucun drapeau | 3 | « REFUS — ce harnais ne s execute pas par accident » |
| drapeau, aucune base | 2 | « NON EXECUTE — DATABASE_URL absent(s) » |
| drapeau + base jetable locale, clé absente | 2 | « NON EXECUTE — CLERK_SECRET_KEY absente » |
| clé au préfixe de production (chaîne factice) | 3 | « REFUS — ne porte pas le prefixe d une instance de test » |
| cible = hôte managé (Neon) | 3 | « REFUS — hote de base managee — jamais jetable, quelle que soit la declaration » |
| contexte `VERCEL_ENV=production` | 3 | « REFUS — contexte de deploiement de production » |
| tout fourni sauf un client Prisma réel | 3 | « REFUS — le client Prisma lit la base « inconnue » alors que la cible declaree est « tracefab_apres » » |

Cette dernière ligne est volontaire : la vérification préalable exige que le
client lise **la base déclarée** et qu'il y trouve la fixture. Une doublure de
client — qui rend des résultats vides — franchissait une simple sonde
`SELECT 1` et le harnais se serait mis à mesurer sa propre doublure. Le défaut a
été trouvé puis corrigé **pendant** ce chantier ; il est consigné ici parce
qu'il change ce que le harnais est autorisé à affirmer.

### 6.6 Ce qui manque, et qui peut le fournir

| Prérequis | Qui | Comment |
|---|---|---|
| Instance **Clerk de test** + clé `sk_test_…` | propriétaire | l'instance se crée dans le tableau de bord Clerk ; la clé se fournit par un mécanisme sécurisé — **jamais** dans ce rapport, un ticket ou un commit |
| Client Prisma réellement généré | propriétaire (poste avec réseau) ou CI | `npm ci` puis `npm run db:generate` ; ici la tentative échoue pour une raison mesurée : `request to https://binaries.prisma.sh/…/libquery_engine.so.node.sha256 failed` (réseau sortant fermé) |

**Risque résiduel.** Le fonctionnement nominal et l'isolation **des routes**
restent non vérifiés. Ce qui est vérifié est l'invariant dont elles dépendent
(RLS exécutée par un rôle sans `BYPASSRLS`) et le refus par défaut.

**Critère de clôture.** `npm run verify:routes:isolation` avec une clé de test et
un client Prisma généré, sortie 0, sur les quatre cas A1–A4.

---

## 7. Contrôle B — migration : diagnostic de production prêt, mesures locales faites

### 7.1 Livrable : la lecture seule qui tranche les hypothèses

`docs/security/diagnostic-pre-migration-close-public-execute-gap.sql` — **une
seule instruction `SELECT`**, aucune écriture. Il relève : le rôle exécuteur et
sa qualité de superutilisateur (section 1) ; pour chacune des six fonctions, son
propriétaire, `SECURITY DEFINER`, l'`EXECUTE` de `PUBLIC` et celui de
`tracefab_app`, les porteurs explicites (section 2) ; les privilèges par défaut
enregistrés pour les fonctions (section 3) ; les rôles porteurs d'un `EXECUTE`
et les rôles de connexion (section 4) ; les politiques qui appellent ces
fonctions (section 5) ; et le critère de la migration — le nombre de fonctions
encore ouvertes à `PUBLIC` (section 6).

**Comment comparer aux hypothèses du rapport :** H1 (le rôle qui jouera la
migration est le propriétaire des six) se lit en comparant la section 1 à la
section 2 ; H2 (aucun rôle non-propriétaire ne dépend de l'`EXECUTE` de
`PUBLIC`) se lit en section 4 ; H3 (les privilèges par défaut portent bien la
forme globale) se lit en section 3. **La section 6 doit valoir 0 après
application.** Si H1 est fausse — fonctions créées par un autre rôle que celui
qui joue la migration — l'auto-contrôle de la migration mesure un autre rôle que
celui des objets : vert, faille ouverte. C'est le risque 1 du §2.4.

### 7.2 Le diagnostic exécuté sur deux bases jetables locales (vérification de l'outil)

| Base | `PUBLIC` peut exécuter | Critère section 6 | Statut |
|---|---|---|---|
| `tracefab_avant` (35/36, migration cible non appliquée) | **true** sur les six | **6** | `RÉUSSI` — l'outil détecte la faille |
| `tracefab_apres` (36/36) | **false** sur les six | **0** | `RÉUSSI` — l'outil confirme la fermeture |

Lecture complémentaire : après migration, `tracefab_app` **garde** `EXECUTE` sur
les six ; deux lignes de privilèges par défaut coexistent pour le même rôle
(`{postgres=X/postgres}` global, de la migration, et `{tracefab_app=X/postgres}`
dans le schéma `public`, de la fixture) — et la mesure qui compte :

| Sonde | `tracefab_avant` | `tracefab_apres` |
|---|---|---|
| fonction neuve créée dans `public` → `PUBLIC` peut exécuter | true | **false** |
| idem → `tracefab_app` peut exécuter | true | true |

La coexistence des deux lignes de défauts **ne rouvre donc pas** la faille : le
retrait global l'emporte sur la liste du schéma, qui ne fait qu'ajouter
`tracefab_app`. C'était l'une des craintes raisonnables ; elle est mesurée, pas
supposée.

**Note d'instrument.** Sur la machine d'atelier, le diagnostic a listé un rôle
`app_role` porteur d'un `EXECUTE` : c'est un rôle créé par **mes propres sondes
antérieures** (`.cache/harness/probe_adp2.mjs`), pas un rôle de production. Il
est signalé ici pour que la lecture d'une future exécution ne prête pas à
confusion.

### 7.3 Preuves encore manquantes

| Preuve | Qui peut la fournir | Critère |
|---|---|---|
| Sortie du diagnostic **en production/préproduction** | propriétaire (accès base) | section 6 = 0 après application ; section 2 : propriétaire = rôle exécuteur ; section 4 : aucun rôle inattendu |
| Application de la migration | propriétaire, **opération de niveau D** | autorisation spécifique, relevé avant, application, relevé après |

**Risque résiduel.** Tant que le diagnostic n'a pas tourné en production, H1 et
H2 restent des hypothèses. Une application aveugle pourrait laisser la faille
ouverte tout en affichant un auto-contrôle vert.

**Ce qui n'est PAS un risque, et qui est établi :** la migration n'est appliquée
par **aucune** chaîne automatique. `prisma migrate deploy` n'existe que dans
`package.json` (`db:deploy`, appelé par la CI sur base jetable), et
`scripts/prisma-generate.mjs` — le seul chemin obligatoire au déploiement Vercel
— ne le lance pas. **Fusionner la PR n'applique donc pas la migration.**

---

## 8. Contrôle C — CI GitHub : inventaire, corrections, décisions

### 8.1 Diff exact `main` → tête de PR, fichier par fichier

`git diff main ba5f159 -- .github/workflows/ci.yml` : **1 fichier, 63
insertions, 29 suppressions**. Ce qui disparaît :

| Ligne retirée | Ce qu'elle permettait |
|---|---|
| `TF_SECRET_PRODUCTION: ${{ secrets.DATABASE_URL }}` | injecter le secret de production dans le job `base-de-donnees` |
| `- name: Scenarios croises contre la base de production` + `if: ${{ env.TF_SECRET_PRODUCTION != '' }}` | exécuter cinq suites destructives sur cette base |
| `DATABASE_URL: ${{ secrets.DATABASE_URL }}` (étape) | la cible réelle de ces suites |

Ce qui apparaît : une étape « Garde de cible des suites destructives », des
actions tierces épinglées par SHA, et un étage base de données sans aucune
lecture de secret.

### 8.2 Toutes les commandes pouvant écrire dans une base (inventaire mesuré)

| Commande | Écrit ? | Derrière la garde ? |
|---|---|---|
| `test:neon:security`, `:product`, `:supplier`, `:supplier:advanced`, `:quality`, `:collection`, `:bulk`, `:wallet`, `:storage`, `:privileges` | oui (rôles, privilèges, lignes) | **oui** |
| `db:seed-rls` | oui (rôle + deux locataires) | **oui** |
| `pilot:seed` | **oui** (un locataire complet) | **non → corrigé** (§8.3) |
| `test:neon:rls` | non (lecture seule, mesuré) | **non → corrigé** (§8.3) |
| `test:audit-script` | non (session en lecture seule, prouvé) | **non → corrigé** (§8.3) |
| `test:pilot` (`--dry-run`) | non, et sort 0 sans base | sans objet |
| `db:migrations:check`, `verify:prisma-client`, `test:prisma-client`, `postinstall` | non | sans objet |
| `diagnose:prod` | non (journaux Vercel) | sans objet |
| `db:deploy` | **oui** (migrations) | non — c'est l'opération de niveau D elle-même |

### 8.3 Corrections appliquées sur la branche, et leurs mesures

| Correction | Fichier | Mesure |
|---|---|---|
| Toutes les variables de connexion **présentes** sont vérifiées (`DATABASE_URL` **et** `TF_RLS_APP_URL`), pas seulement la première | `scripts/run-db-suite.mjs` | une suite avec `TF_RLS_APP_URL` visant un hôte managé est **refusée avant connexion** (sortie 3) ; une suite qui ne fournit qu'une variable reste acceptée |
| `test:neon:rls` passe par la garde | `package.json` | cible locale jetable : **14 `ok`, 0 échec** (aucune régression) |
| `pilot:seed` passe par la garde | `package.json` | cible managée **avec la dérogation complète** (`TRACEFAB_ALLOW_NONLOCAL_TEST_DB=true` + hôte + base déclarés) : **REFUS**, sortie 3 |
| La suite d'audit refuse une cible non autorisée avant de se connecter | `scripts/test_audit_neon_readonly.mjs` | avec base jetable : **sortie 0**, 17 contrôles `ok`, 0 échec (dont la preuve d'écriture refusée « read-only transaction ») ; sans base : sortie 2, inchangée |

Ce que cela démontre, exactement : **même si un secret existe et qu'on le
branche à la main**, une cible de base managée est refusée — le refus est
antérieur à toute lecture d'opt-in. Le refus ne dépend pas de la bonne volonté
de l'auteur d'une poussée.

### 8.4 Un défaut mesuré, introduit par cette PR : le rouge certain de l'étage `verification`

`test:audit-script` est **absent de `main`** et apporté par cette PR. La boucle
de l'étage `verification` (qui n'a **pas** de base de données) sélectionne toutes
les clés `test:*` sauf `neon`, `staging`, `p2`, `regression` — donc celle-ci —
et cette suite **sort en 2 quand aucune cible n'est fournie** (« un test qui ne
tourne pas ne vaut pas un test qui passe »). Mesuré : `npm run test:audit-script`
sans `DATABASE_URL` → **code 2**. La boucle marque `ECHEC` dès qu'une suite sort
non-zéro : **si la CI était réactivée, l'étage `verification` serait rouge**, et
ce rouge serait imputable à cette PR. Le même contrôle, exécuté là où une base
existe, passe (sortie 0, mesuré).

La correction est **préparée, non appliquée** (elle touche la définition de la
CI, donc une décision du propriétaire) :

`docs/security/patches/ci.yml.garde-de-cible-et-moindre-privilege.patch`
— applicable (`git apply --check` : ok), YAML résultant valide, trois
modifications :

1. exclure `test:audit-script` de la boucle sans base (il tourne déjà dans
   l'étage base de données, avec la base jetable) ;
2. ajouter `permissions: contents: read` au workflow ;
3. corriger le compte annoncé dans l'en-tête (« 63 scripts » alors que la boucle
   en sélectionne 75 : 65 sur `main`, 75 ici).

### 8.5 Jetons `GITHUB_TOKEN` et workflow à écriture

* `ci.yml` — ni sur `main` ni sur la branche — ne déclare de bloc
  `permissions:`. Le jeton hérite donc du réglage du dépôt. Le correctif
  (`contents: read`) est dans le patch ci-dessus.
* `Figer la reference visuelle` est **`active`** et porte
  `permissions: contents: write` **au niveau du workflow** : tous ses jobs
  héritent du droit d'écriture, y compris ceux qui installent des dépendances et
  exécutent le code du dépôt. La version durcie préparée
  (`docs/security/patches/figer-reference-visuelle.durci.yml`) passe le workflow
  à `contents: read`, réserve `contents: write` au seul job qui pousse, et reste
  un YAML valide (vérifié). Le patch correspondant
  (`figer-reference-visuelle.permissions.patch`) **s'applique** sur la branche
  qui porte le fichier (`arena/91844ee9-tracefab`), vérifié par
  `git apply --check`.
* Aucune activation, désactivation ni modification de workflow n'a été faite ici.

### 8.6 Décisions du propriétaire, et ce qui n'a pas été fait

| Décision | Pourquoi elle n'appartient pas à l'exécution automatique |
|---|---|
| Appliquer le patch `ci.yml` (boucle + `permissions`) | change ce que la CI exécutera et ce que son jeton peut faire |
| Réactiver `CI` | niveau C ; et la démonstration « ne peut pas toucher la production » doit alors être refaite sur le fichier de `main` (§3.2) |
| Désactiver ou durcir `Figer la reference visuelle` | workflow de l'auteur, toujours `active`, à écriture |
| Trancher l'existence du secret `DATABASE_URL` | le dépôt se contredit (§4) ; l'API refuse (403) |

Aucun workflow activé, désactivé ou modifié ; aucun secret, paramètre GitHub ni
protection de branche touché ; la CI reste `disabled_manually`.

---

## 9. Statut de chaque point, preuve à l'appui

| # | Point | Statut | Preuve |
|---|---|---|---|
| 1 | Refus par défaut des trois routes (401 sans jeton) | `RÉUSSI` | §1 et §6.5 (re-mesuré à `44d49121`) |
| 2 | Fonctionnement nominal des trois routes (A1, A3, A4) | `NON EXÉCUTÉ` | harnais livré, arrêt motivé avant mesure (§6.5) |
| 3 | Isolation RLS des deux locataires, avant migration | `RÉUSSI` | 14 `ok`, 0 échec (base jetable 35/36) |
| 4 | Isolation RLS après migration (non-régression) | `RÉUSSI` | sortie identique (base jetable 36/36) |
| 5 | Diagnostic de production (propriétaire des six fonctions, rôle migrateur, `EXECUTE`, défauts) | `RÉUSSI` pour l'outil, `BLOQUÉ` pour la production | §7.1-7.2 / §7.3 |
| 6 | Fermeture de la faille sur les fonctions futures | `RÉUSSI` | sonde : `false` après migration, malgré la fixture (§7.2) |
| 7 | Application de la migration en production | `NON EXÉCUTÉ` | niveau D, autorisation absente (§2.4) |
| 8 | Chaîne automatique de déploiement : n'applique aucune migration | `RÉUSSI` | `prisma-generate.mjs` ne lance pas `migrate deploy` (§7.3) |
| 9 | Inventaire des commandes écrivant en base | `RÉUSSI` | §8.2 |
| 10 | Garde de cible étendue aux variables de connexion présentes | `RÉUSSI` | §8.3 (refus mesuré sur `TF_RLS_APP_URL`) |
| 11 | Cible managée refusée même avec dérogation complète | `RÉUSSI` | §8.3, sortie 3 |
| 12 | Rouge certain de l'étage `verification` si la CI est réactivée | `ÉCHEC` (état de la PR) | §8.4, code 2 mesuré ; patch préparé |
| 13 | Moindre privilège du jeton (`permissions`) | `BLOQUÉ` (décision) | §8.5, patch prêt |
| 14 | Workflow `active` à `contents: write` | `BLOQUÉ` (décision) | §8.5, patch prêt et vérifié |

---

## 10. Décision de validation pré-fusion

**PR NON FUSIONNABLE en l'état**, sur la base des seules preuves disponibles :

1. **Deux des quatre cas d'épreuve des trois routes n'ont jamais été exécutés.**
   Le refus est prouvé ; le fonctionnement et l'isolation des routes ne le sont
   pas. Fusionner reviendrait à valider sur une analyse statique, ce que la
   consigne interdit explicitement.
2. **Un défaut mesuré est introduit par cette PR** : si la CI est réactivée,
   l'étage `verification` échoue sur `test:audit-script` (code 2 sans base,
   mesuré). Le correctif est prêt mais non appliqué — c'est une décision du
   propriétaire.
3. **La migration n'est pas applicable en l'état** : ses hypothèses H1 et H2 ne
   sont pas vérifiées en production, et le diagnostic qui les tranche n'a pas
   encore tourné là-bas. Fusionner ne l'applique pas (établi), mais laisser
   croire qu'elle est prête à l'être serait une affirmation sans preuve.
4. **Le durcissement du jeton du workflow n'est pas appliqué** : le correctif qui
   rend l'étage base de données définitivement aveugle à tout secret est prêt,
   à l'identique de ce qui est demandé depuis le début du chantier.

**Ce qui la rendrait fusionnable, dans cet ordre :**

1. appliquer `docs/security/patches/ci.yml.garde-de-cible-et-moindre-privilege.patch`
   (le rouge mesuré disparaît, le jeton passe en lecture seule) ;
2. fournir une instance Clerk **de test** et exécuter
   `npm run verify:routes:isolation` jusqu'à sortie 0 sur A1–A4, dans un
   environnement où `npm run db:generate` fonctionne ;
3. décider du sort de `Figer la reference visuelle` (durcissement ou
   désactivation) ;
4. et, séparément de la fusion, exécuter le diagnostic en production avant toute
   application de la migration.


---

## 11. Addendum — correction du rouge CI appliquée sur la branche (2026-10-12)

### Changement

Après la revue du rapport de chantier, le correctif ciblé de `.github/workflows/ci.yml`
a été appliqué directement sur `arena/879cd8db-tracefab` :

- le job `verification` exclut désormais `test:audit-script` de sa boucle
  `test:*` qui ne dispose pas de base de données ;
- `test:audit-script` reste exécuté dans le job de base de données, contre le
  PostgreSQL jetable, avec `DATABASE_URL` local au service du job ;
- le workflow déclare `permissions: contents: read` ;
- le titre de l'étage a été corrigé pour ne plus annoncer un nombre de scripts
  non garanti.

Fichier relu sur la branche après l'écriture :
`.github/workflows/ci.yml`, blob `2aa11779789e0aec4f6d86f8933ab65b64aff372`.

### Preuves et limites

| Contrôle | Statut | Preuve |
|---|---|---|
| Exclusion de `test:audit-script` de la boucle sans base | RÉUSSI — contrôle statique | Expression de sélection relue sur la branche |
| Maintien de `test:audit-script` dans le job PostgreSQL jetable | RÉUSSI — contrôle statique | Étape dédiée conservée dans le job base de données |
| Permissions du workflow CI limitées à `contents: read` | RÉUSSI — contrôle statique | Bloc `permissions` relu |
| Quatre checkouts CI sans identifiants persistants | RÉUSSI — contrôle statique | Quatre occurrences de `persist-credentials: false` |
| Réexécution du test `test:audit-script` sans base dans la boucle de vérification | NON EXÉCUTÉ après correction | CI désactivée ; aucun run n'a été lancé |
| Réexécution de l'ensemble des tests de politique de workflows | NON EXÉCUTÉ après correction | Aucun run GitHub Actions sur le HEAD courant |
| Vérification de la CI par un run GitHub Actions sur le HEAD courant | BLOQUÉ / NON EXÉCUTÉ | CI toujours désactivée manuellement |

### État du HEAD après la correction

Le commit de correction est `0b6f90ef94f46735f2d9b6e69f9da8bb5d3ef278`.
La PR #36 reste ouverte, en brouillon et non fusionnée. Aucun workflow n'a été
réactivé et aucune migration ni action de production n'a été effectuée.

**Décision inchangée : NON FUSIONNABLE.** Cette correction retire la régression
de sélection de tests identifiée par le rapport, mais ne prouve pas l'exécution
des tests nominaux A1/A3/A4, ne tranche pas les hypothèses de rôles en production
et ne remplace pas les contrôles d'exécution exigés avant fusion.
