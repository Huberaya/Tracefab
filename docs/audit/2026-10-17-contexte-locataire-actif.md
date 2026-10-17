# Audit général — Brand Console & DPP Production
## Contexte de locataire actif et défauts associés

**Date :** 17 octobre 2026
**Base auditée :** `main` @ `d0ba6b2` (merge de la PR #55), PR #51 / #53 / #54 / #55 fusionnées, 45 migrations dans le dépôt
**Périmètre :** Brand Console, parcours DPP, surfaces privées multi-locataires
**Scénario de reproduction préservé :** utilisateur Clerk Production administrateur de `Ginger` et de `Tracefab Recette Production` ; produit brouillon `RECETTE-DPP-20261017` appartenant uniquement au tenant de recette ; depuis Ginger, ce produit apparaissait.

---

## 1. Cause racine

Le concept de **locataire actif n'existait pas côté serveur**. Deux idiomes de bornage coexistaient, et tous deux bornent l'**utilisateur**, pas le **locataire** :

| Idiome | Emplacement | Ce qu'il borne réellement |
|---|---|---|
| `activeBrandOrganizationIds(tx, user.id)` puis `{ in: organizationIds }` | `api/_lib/products.ts` | L'union de toutes les organisations du compte |
| `tracefab_can_access_org(org)` | SQL, migration `20260923130000` | « Cet utilisateur est-il membre ? » — vrai pour Ginger *et* pour la recette |

`api/_routes/products.ts` tombait sur `{ in: organizationIds }` dès que `organizationId` était absent — et la console appelait `/api/products` **sans** ce paramètre (`assets/js/brand-console.1.js`, fonction `sync()`).

**Pourquoi aucun test ne l'a vu :** avec un compte mono-organisation, un bornage utilisateur et un bornage tenant sont indiscernables. Le défaut n'était observable qu'avec un compte multi-organisations — c'est-à-dire uniquement en Production.

---

## 2. Classement des défauts

### P0 — déterministes, corrigés

| # | Défaut | Nature | Preuve |
|---|---|---|---|
| P0-1 | `/api/products` listait les produits de **toutes** les organisations du compte | code | `api/_routes/products.ts`, filtre `{ in: organizationIds }` |
| P0-2 | La console chargeait les listes **sans nommer le locataire** | code | `assets/js/brand-console.1.js:1106`, `api('/api/products')` sans paramètre |
| P0-3 | `activeOrganizationId` résolu **après** le chargement : le sélecteur ne pouvait pas cadrer la première lecture | code | `assets/js/brand-console.1.js:1133` |
| P0-4 | Au changement d'organisation, **aucun état n'était vidé** : flash de données du tenant précédent | code | `assets/js/brand-console.1.js:4494`, `change → sync()` sans reset |
| P0-5 | 12 autres routes retombaient sur toutes les organisations (détails, exports, agrégats) | code | voir matrice §3 |

### P1 — déterministes, corrigés

| # | Défaut | Nature | Preuve |
|---|---|---|---|
| P1-1 | `test_cross_tenant.mjs` vérifiait la **présence** des maillons d'isolation, jamais l'**étendue** du filtre | code (couverture) | la route fautive portait les deux maillons |
| P1-2 | `dpp/portfolio.ts` n'avait **aucun `try/catch`** et `isUnauthorized(auth)` était du **code mort** (`requireClerkUser` *lève*, il ne retourne pas) → aucun 401 produit par la route | code | `api/_routes/dpp/portfolio.ts` |
| P1-3 | `TRACEFAB_PUBLIC_BASE_URL` retombait sur `https://tracefab.com` codé en dur → QR encodant une origine qui n'est pas celle du déploiement | **configuration** | `api/_routes/resolve/[publicId]/qr.ts` |
| P1-4 | `resolve/[publicId]` : identifiant `retired` → **302** en HTML mais **410** en JSON ; deux contrats pour le même état, retrait resté navigable depuis un QR imprimé | code | `api/_routes/resolve/[publicId].ts` |
| P1-5 | Export CSV catalogue et export d'audit fusionnaient **toutes** les organisations — sortie de données hors tenant | code | `catalog/products/export.ts`, `catalog/audit-export.ts` |
| P1-6 | Enregistrement d'un certificat de transaction possible entre deux organisations tierces du compte | code | `mass-balance/certificates.ts` POST |
| P1-7 | Création de produit / de demande de données : le `brandOrganizationId` du corps n'était pas confronté au tenant affiché | code | `products.ts` POST, `data-requests.ts` POST |

### P2 — déterministes, corrigés

| # | Défaut | Nature |
|---|---|---|
| P2-1 | Le locataire actif n'était pas persisté : un rechargement basculait silencieusement sur la première organisation | code |
| P2-2 | Aucun état d'erreur explicite quand le compte n'a aucune organisation de marque | code |

### Hypothèses vérifiées puis **écartées** (aucun défaut)

Trois pistes ont été ouvertes puis fermées sur preuve, pour ne pas « corriger » ce qui n'était pas cassé :

- **Le retrait ne serait pas appliqué publiquement.** Faux. `tracefab_set_dpp_publication('withdraw')` met `public_slug = NULL` (migration `20261016130000`), et `tracefab_product_is_public` exige `public_slug IS NOT NULL` **et** un `dpp_records` publié et relu (migration `20261010120000`). La politique publique de `dpp_resolvable_identifiers` s'appuie sur cette fonction : après retrait, `/api/resolve/:publicId` rend bien 404.
- **`res.status(200).send(svg)` planterait sur une `VercelResponse`.** Faux. `status()` et `send()` sont déclarés dans `api/_lib/vercel-types.ts` et fournis par l'adaptateur Node de Vercel ; le motif est utilisé de façon cohérente sur 10 routes.
- **Un commentaire `//` dans les routes compactées.** Le défaut était **réel**, mais introduit par le correctif lui-même : inséré devant la nouvelle branche `retired` de `resolve/[publicId].ts`, il mettait en commentaire la branche `retired` *et* la branche de redirection HTML. TypeScript ne disait rien. Corrigé, et une garde permanente a été ajoutée (`test:minified-comments`) après vérification par mutation.

---

## 3. Matrice capacité → UI → route → contrôle tenant → défaut

Routes concernées par le repli multi-organisations. « Avant » = état de `main` @ `d0ba6b2`.

| Capacité | UI | Route | Table / fonction | Contrôle **avant** | Contrôle **après** | Test |
|---|---|---|---|---|---|---|
| Liste produits | `sync()` | `GET /api/products` | `tracefab_products` | `{ in: toutesOrgs }` | locataire obligatoire | `test:active-tenant`, `test:cross-tenant` |
| Fiche produit | `openProduct` | `GET/PATCH /api/products/:id` | `tracefab_products` | `{ in: toutesOrgs }` | locataire obligatoire | `test:product-edit:api` |
| Identifiants | fiche | `…/identifiers` | `product_identifiers` | `{ in: toutesOrgs }` | locataire obligatoire | `test:cross-tenant` |
| Composition | fiche | `…/materials` | `product_materials` | `{ in: toutesOrgs }` | locataire obligatoire | `test:cross-tenant` |
| Révision | fiche | `…/revision` | `tracefab_products` | `{ in: toutesOrgs }` **+ écriture avant contrôle** | locataire résolu **avant** toute mutation | `test:cross-tenant` |
| Préparation DPP | vue DPP | `GET /api/dpp/portfolio` | `dpp_records` ⋈ `tracefab_products` | `{ in: toutesOrgs }`, **sans `try/catch`** | locataire obligatoire + enveloppe d'erreur | `test:cross-tenant` |
| Surface DPP | vue DPP | `…/dpp`, `…/dpp/*` (13 routes) | via `accessibleProduct` | `tracefab_can_access_org` seul | `+ tracefab_in_active_tenant` | `test:neon:active-tenant` |
| Export catalogue | bouton export | `GET /api/catalog/products/export` | `tracefab_products` | `{ in: toutesOrgs }` | locataire obligatoire | `test:p1-catalog` |
| Export d'audit | bouton export | `GET /api/catalog/audit-export` | produits + points + journal | `{ in: toutesOrgs }` | locataire + rôle | `test:cross-tenant` |
| Statut job d'import | import | `…/import-jobs/:jobId` | `tracefab_catalog_import_jobs` | `ANY(toutesOrgs)` | locataire obligatoire | `test:p1-catalog` |
| Demandes de données | liste | `GET /api/data-requests` | `data_requests` | `{ in: toutesOrgs }` | locataire obligatoire | `test:supplier-advanced` |
| Relance fournisseur | liste | `POST …/remind` | `tracefab_notification_outbox` | `{ in: toutesOrgs }` | locataire résolu **avant** l'enqueue | `test:brand-console` |
| Matières | vue matières | `GET/POST /api/materials` | `materials` | `{ in: toutesOrgs }` | tenant **ou** partage explicite | `test:cross-tenant` |
| Fiche matière | détail | `GET/PATCH /api/materials/:id` | `materials` | `ANY(toutesOrgs)` | tenant **ou** partage explicite | `test:cross-tenant` |
| Certificats TC | vue bilan massique | `GET/POST /api/mass-balance/certificates` | `transaction_certificates` | `{ in: toutesOrgs }` | locataire obligatoire ; POST exige le tenant comme partie | `test:cross-tenant` |
| Plans d'action | vue qualité | `GET /api/quality/caps` | `quality_corrective_action_plans` | `{ in: toutesOrgs }` | locataire obligatoire | `test:cross-tenant` |
| Synthèse qualité | vue qualité | `GET /api/quality/overview` | `data_quality_issues`, `data_quality_scores` | `tracefab_can_access_org` | `tracefab_in_active_tenant` | `test:p1-quality` |
| Exploitation | vue ops | `GET /api/operations/overview` | `tracefab_notification_outbox` | `ANY(toutesOrgs)` | locataire + rôle owner/admin | `test:p1-quality` |
| Résolution publique | QR | `GET /api/resolve/:publicId` | `dpp_resolvable_identifiers` | `retired` → 302 en HTML / 410 en JSON | 410 dans les deux branches, `no-store` | `test:dpp:identity` |
| QR | étiquette | `GET /api/resolve/:publicId/qr` | — | repli `https://tracefab.com` | `503 public_base_url_not_configured` | `test:dpp:identity` |

**Routes volontairement non modifiées** : `/api/me`, `/api/organizations`, `/api/config` — elles servent précisément à déterminer le locataire actif et ne portent aucune donnée de tenant. Le client les exclut explicitement de l'en-tête (`TENANT_FREE_PATHS`).

---

## 4. Classes de bugs recherchées systématiquement

| Classe | Résultat |
|---|---|
| Retour HTTP absent | **Trouvé** — `dpp/portfolio.ts` sans `try/catch`, `isUnauthorized(auth)` mort (P1-2). Corrigé. |
| Contrats UI/API divergents | **Trouvé** — `retired` : 302 HTML vs 410 JSON (P1-4). Corrigé. |
| Champs bloquants non éditables | **Non reproduit** — corrigé par la PR #55 (`validateProductPatch`, `test:product-edit:api` couvre 12 champs, partiel, `null`, clés interdites). |
| Données de démo hors mode explicite | **Non reproduit** — `state.demo` exige `?demo=1` littéral ; `boot()` ne retombe jamais sur la démo en cas d'échec d'authentification ; `test:donnees-demo` et `test:demo-declaree` couvrent (exécutés en CI contre serveur). |
| État client conservé au changement de tenant | **Trouvé** — P0-4. Corrigé par `resetTenantState()` appelé *avant* le rechargement. |
| Routes renvoyant toutes les organisations | **Trouvé** — 19 routes. Toutes corrigées (§3). |
| Agrégats non filtrés | **Trouvé** — `dpp/portfolio`, `quality/overview`, `operations/overview`. Corrigés. |
| Placeholders de production | **Trouvé** — `https://tracefab.com` (P1-3). Corrigé + variable passée en **bloquante**. |
| Erreurs masquées | **Trouvé** — P1-2 ; `catch { return null }` unique en `clerk-proxy.ts:128`, justifié et local. |
| Boutons non câblés | **Non reproduit** sur le périmètre audité ; `data-tf-act` / `data-action` sont liés dans `bind()`. |

---

## 5. Corrections apportées

### Serveur — contexte de locataire actif

- **`api/_lib/tenant.ts`** (nouveau) : `requestedTenantId` (en-tête `X-Tracefab-Organization-Id` → query → corps), `resolveActiveTenant`, `requireActiveTenant`, `tenantFilter`, `TenantError`. Fail-closed : absent → `400 organization_id_required`, malformé → `400 invalid_organization_id`, non-adhérent → `404 organization_not_found`. Le 404 plutôt que le 403 est délibéré : un 403 révélerait que l'organisation existe.
- **`api/_lib/context.ts`** : `withTracefabUserContext` arme `tracefab.active_organization_id` — toujours écrit, y compris vide, pour qu'une connexion rendue au pool n'hérite jamais du locataire précédent. `withTracefabRequestContext` lit la requête : l'oubli d'armement devient impossible à écrire.
- **Migration `20261017120000_active_tenant_context`** : `tracefab_active_organization_id()`, `tracefab_in_active_tenant(uuid)`, `tracefab_require_active_tenant()`. Repli `NULL`, jamais « les autres organisations ». Aucune politique ajoutée ni modifiée. Fonctions fermées à `PUBLIC`, ouvertes à `tracefab_app` (invariant de `test_neon_privileges.mjs`).
- **`accessibleProduct`** : ajoute `AND tracefab_in_active_tenant(brand_organization_id)`. C'est le point où RLS et bornage tenant se cumulent : la RLS prouve l'adhésion, le GUC prouve que c'est le tenant nommé.

### Client

- `api()` porte `X-Tracefab-Organization-Id` sur **chaque** appel privé.
- `sync()` en deux phases : identité/adhésions d'abord (seules routes sans tenant), résolution du locataire, **puis** données du tenant.
- `resetTenantState()` appelé **avant** le rechargement : aucun flash, y compris réseau lent.
- Locataire persisté (`tracefab_active_organization_id`) et revalidé contre les adhésions réelles ; `tenantError` affiché explicitement si le compte n'a aucune organisation de marque — jamais remplacé par la démo.
- Clés i18n `cnNoActiveTenantTitle` / `cnNoActiveTenantBody` ajoutées dans les 7 locales complètes (`tr`/`zh` sont partielles avec repli EN, par conception).

### Configuration

- `TRACEFAB_PUBLIC_BASE_URL` : repli supprimé, `503 public_base_url_not_configured`, variable ajoutée à `.env.example` et à la liste `required` de `scripts/audit_production_env.mjs`, documentation passée de « fonctionnelle » à « bloquante ».

---

## 6. Tests ajoutés

| Test | Commande | Ce qu'il prouve | Exécutable ici |
|---|---|---|---|
| Contexte de locataire actif | `npm run test:active-tenant` | 13 contrôles sur le vrai module : précédence, 400/404 fail-closed, filtre à **un** élément, rôles, absence de requête métier avant résolution | **oui — 13/13 verts** |
| Garde des commentaires compactés | `npm run test:minified-comments` | Aucun `//` n'avale de code exécutable dans les 134 routes | **oui — vert** |
| Multi-locataires navigateur | `npm run test:multi-tenant:browser` | Un utilisateur, deux organisations : en-tête sur chaque appel, A ne voit que A, B ne voit que B, **aucun flash** pendant le basculement (vérifié à mi-requête), persistance, 390 px sans débordement, jamais de démo | non — Playwright absent du bac à sable |
| Contexte actif en base | `npm run test:neon:active-tenant` | GUC armé/borné, `tracefab_in_active_tenant` fausse sans armement, `accessibleProduct` rend le produit de recette sous la recette et **rien** sous Ginger, GUC non persistant entre transactions, privilèges | non — PostgreSQL absent du bac à sable |
| Isolation renforcée | `npm run test:cross-tenant` | Refuse désormais le repli multi-organisations, forme Prisma **et** forme SQL `ANY(...)` | **oui — vert** |

**Branchement CI** — les deux tests non exécutables ici sont réellement appelés par un workflow : `test:neon:active-tenant` dans l'étage `Base — isolation RLS exécutée`, `test:multi-tenant:browser` dans l'étage `Parcours — navigateur réel`. Ils étaient initialement déclarés dans `package.json` sans qu'aucune étape ne les appelle : un test non branché est un test qui n'existe pas. Les deux étages sont **verts** sur le SHA final.

**Vérification par mutation** — `test:active-tenant` a été éprouvé dans les deux sens :

| Mutation injectée dans `api/_lib/tenant.ts` | Résultat |
|---|---|
| Repli permissif (`return {…}` au lieu de lever) | **détectée** — sortie 1 |
| Filtre élargi à un second UUID | **détectée** — sortie 1 |
| Validation UUID désactivée | **détectée** — sortie 1 |
| Code restauré | sortie 0 |

`test:minified-comments` a été éprouvé de la même façon : réintroduction du `//` devant la branche `retired` → détectée (sortie 1) ; code réel → sortie 0.

---

## 7. Vérifications exécutées

| Vérification | Résultat |
|---|---|
| 67 scripts `test:*` exécutables sans base ni navigateur | **67 verts** |
| 27 scripts rouges en local | **cause environnementale, pas le code** : aucun binaire chromium (`browserType.launch: Executable doesn't exist at ~/.cache/ms-playwright/…`) et client Prisma non généré (`@prisma/client does not provide an export named 'PrismaClient'`). **Ces rouges locaux ne prouvent rien** — voir l'avertissement ci-dessous |
| `tsc` sur `api/` | **0 erreur nouvelle** ; 89 erreurs contre 91 à la baseline, toutes dues au client Prisma non généré |
| `tsc --noEmit` sur `src/` | **vert** |
| `test:i18n` | **vert** — 2 178 clés, parité stricte fr/de/it/es/nl/pt |
| `test:assets` | **vert** après `npm run assets:version` |
| `test:chantiers` | **vert** après mise à jour du compte de migrations (45 → 46) |

### Régressions introduites puis corrigées

Quatre tests ont cassé à cause des modifications. Aucun n'a été désactivé ; tous ont été rendus **plus stricts** :

| Test | Assertion d'origine | Problème | Correction |
|---|---|---|---|
| `test_brand_console.mjs` | exigeait `activeOrganizationIds` dans la route de relance | exigeait la présence du **défaut** | exige `requireActiveTenant` **et** refuse `activeOrganizationIds` |
| `test_p1_catalog_import_export.mjs` | exigeait `activeBrandOrganizationIds` dans l'export | idem | exige `requireActiveTenant`, refuse le repli |
| `test_p1_quality.mjs` | exigeait `tracefab_can_access_org` | idem | exige `tracefab_in_active_tenant` + partage explicite conservé |
| `test_supplier_advanced.mjs` | exigeait `requestedOrganizationId(req)` (optionnel) | idem | exige `requireActiveTenant` (obligatoire) |

### ⚠️ Avertissement méthodologique : la comparaison `git stash` est aveugle aux suites navigateur

Une première version de ce rapport affirmait que les scripts rouges en local étaient « tous préexistants, vérifié en comparant à `main` via `git stash` ». **Cette affirmation était fausse pour les suites navigateur, et elle a failli laisser passer deux régressions réelles.**

La méthode compare deux exécutions **dans le même environnement privé de chromium**. Une suite navigateur y échoue pour la même raison des deux côtés : la comparaison rend « rouge à la baseline » et conclut à tort à un défaut préexistant. Or `main` est `success` en CI (run `39062695293`, `d0ba6b2`) : ces suites y passent. **Une suite rouge en local faute de navigateur ne peut être classée préexistante que par la CI, jamais par `git stash`.**

C'est l'étage `Verification` de la CI qui a révélé les deux régressions suivantes, toutes deux introduites par le découpage de `sync()` en deux phases :

| Suite (CI) | Assertion | Cause | Correction |
|---|---|---|---|
| `test:brand-console:empty:304` | « une panne API ne rend pas la console », `1 !== 0` | Sur `main` les neuf appels étaient dans **un seul** `Promise.all` : `state.user` n'était affecté qu'après résolution, donc un 500 laissait la garde `configError && !state.user` déclencher l'écran bloquant. En deux phases l'identité est connue avant les données : la console rendait une vue **partiellement vide**, lisible comme une vérité à moitié fausse | la garde ne dépend plus de `!state.user` ; le message distingue authentification en cause (aucune identité) et données du locataire indisponibles (identité connue), via deux clés i18n ajoutées aux sept locales |
| `test:brand-console:schema-bindings:457` | `Cannot read properties of null (reading 'product')` | `saveProduct()` enchaîne `selectedProductDetail = await api(PATCH)` puis `await sync()` ; `resetTenantState()` y était appelé **inconditionnellement** et remettait `selectedProductDetail` à `null` — la fiche que l'utilisateur venait de modifier disparaissait | purge bornée au **changement** de locataire via `state.loadedOrganizationId` : un rechargement du même locataire ne détruit rien, un basculement vide tout avant le rechargement (garantie inchangée, vérifiée par `test:multi-tenant:browser`) |

Deux leçons en découlent, appliquées dans ce dépôt :

- **un test qui échoue doit pouvoir dire pourquoi** — le journal d'un job GitHub est hébergé hors de l'API, donc les suites en échec publient désormais la fin de leur journal en annotation de check-run, et les deux nouveaux tests émettent des `::error::` ;
- **la CI est la seule autorité** pour toute suite nécessitant un navigateur, une base ou un client Prisma généré.

### Défaut découvert par la base : prédicat d'autorisation à trois valeurs

L'étape « Contexte de locataire actif en base » a échoué avec « sans locataire armé, `tracefab_in_active_tenant()` a rendu vrai ». Le message du test était trompeur : la valeur réellement rendue était **`NULL`**, pas `vrai`.

`p_organization_id IS NOT NULL AND p_organization_id = tracefab_active_organization_id()` est une expression à trois valeurs : organisation fournie et aucun locataire armé donne `uuid = NULL` soit `NULL`, donc `vrai AND NULL` = `NULL`. `RETURNS BOOLEAN` ne contraint pas à non-NULL.

Un prédicat d'autorisation à trois valeurs reste sûr dans un `WHERE` (`NULL` n'est pas vrai), mais il trompe `= false`, `IS FALSE`, `NOT x`, un `CASE WHEN`, un `RAISE IF` plpgsql et toute assertion. Le commentaire de la migration promettait déjà « elle est fausse » : l'implémentation ne le tenait pas. Corrigé à la source par `COALESCE(…, false)`.

**Périmètre de la réécriture, vérifié et non supposé** : `git ls-tree -r origin/main -- prisma/migrations/20261017120000_active_tenant_context` ne rend rien et `origin/main` compte 45 dossiers de migrations. La 46<sup>e</sup> n'existe que sur cette branche, n'a jamais été fusionnée ni appliquée : elle a été corrigée **en place**, aucune migration déjà appliquée n'a été réécrite. Ses `BEGIN;`/`COMMIT;` explicites ont été retirés au passage — c'était la seule migration du dépôt à les porter (45/45 ne les ont pas) et un `COMMIT` prématuré sort du cadre de la transaction de Prisma, empêchant son rollback en cas d'échec partiel.

Preuves associées, exécutées contre PostgreSQL 17 jetable :

- 3 contextes × 12 compositions (contexte absent, locataire armé sur B, locataire armé sur A avec ressource chez B) : chaque valeur, son `IS NULL`, et sa composition `vrai AND x`, `faux OR x`, `NOT x` ; UUID absent évalué séparément ;
- assertion explicite qu'**aucun des 36 booléens** n'est `NULL` ;
- **mutation négative** : le corps d'origine (sans `COALESCE`) est réinstallé dans une transaction annulée aussitôt, et le test vérifie qu'il rend bien `NULL`, puis que le rollback restaure la version corrigée. L'entrée de la mutation est un UUID **non nul** : avec un UUID `NULL`, `NULL IS NOT NULL` vaut faux et `faux AND NULL` vaut faux, le défaut ne se manifesterait pas.

---

## 8. Limites et blocages externes

Déclarés, non simulés.

| Blocage | Conséquence | Ce qui reste à prouver en CI |
|---|---|---|
| `binaries.prisma.sh` hors liste blanche réseau | `prisma generate` impossible → client factice | `api:typecheck`, `test:router-load`, `test:product-edit:api`, `verify:prisma-client` |
| Aucun PostgreSQL dans le bac à sable | migrations et RLS non exécutées localement | `test:neon:active-tenant`, `test:neon:cross-tenant`, `test:neon:rls`, `db:migrations:check` |
| Aucun navigateur Playwright | parcours navigateur non exécuté localement | `test:multi-tenant:browser`, `test:brand-console:*`, `test:i18n` points 3-4 |
| Pas de compte Clerk Production ni de base écrivable | **un parcours réellement non mocké est impossible ici** | `test:multi-tenant:browser` utilise un serveur de fixture qui applique le contrat serveur réel ; l'étanchéité en base est prouvée par `test:neon:cross-tenant` |
| Aucun secret Production | déploiement non vérifiable depuis ce bac à sable | statut Production Ready à confirmer après fusion |

Ce qui n'a **pas** été fait, volontairement : aucune modification de Production, de Neon, de Clerk ou de Vercel ; aucune donnée de recette créée, modifiée ou supprimée ; aucun test supprimé ni désactivé ; aucune IA, blockchain, service payant ni dépendance externe ajoutée.

---

## 9. Checklist de recette Production

À exécuter après fusion, sans modifier les données de production.

1. **Migration** — `npx prisma migrate status` : 46 migrations, dont `20261017120000_active_tenant_context` appliquée, aucun drift.
2. **Variable** — `TRACEFAB_PUBLIC_BASE_URL` définie sur Vercel et égale à l'origine canonique réelle. `node scripts/audit_production_env.mjs --production` : zéro `FAIL`.
3. **Reproduction initiale** — compte administrateur de `Ginger` et de `Tracefab Recette Production`. Depuis **Ginger** : `RECETTE-DPP-20261017` absent de la liste, absent de l'agrégat DPP, absent de l'export CSV. Depuis la **recette** : présent.
4. **Basculement** — changer d'organisation et observer : la liste se vide **avant** de se recharger, aucune ligne de l'autre tenant n'apparaît, même brièvement. Répéter avec une connexion ralentie.
5. **Contrat serveur** — `curl` sans en-tête `X-Tracefab-Organization-Id` sur `/api/products` : `400 organization_id_required`. Avec un UUID d'une organisation non adhérée : `404 organization_not_found`.
6. **Détails vidés** — ouvrir une fiche produit, changer d'organisation : la fiche est vide, pas celle du tenant précédent.
7. **QR** — `GET /api/resolve/:publicId/qr` rend un SVG dont l'URL encodée pointe l'origine canonique. Variable retirée temporairement sur un environnement de pré-production : `503 public_base_url_not_configured`.
8. **Retrait** — retirer un produit publié : `/api/resolve/:publicId` rend `410` en JSON **et** en HTML, avec `Cache-Control: no-store`. L'historique privé reste consultable dans la console.
9. **Export** — télécharger l'export catalogue et l'export d'audit depuis chaque tenant : aucune ligne de l'autre tenant.
10. **Persistance** — recharger la page : le locataire actif est conservé.
