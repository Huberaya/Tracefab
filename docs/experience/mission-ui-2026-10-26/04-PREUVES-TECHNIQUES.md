# TRACEFAB — Preuves techniques de la mission UI/UX

**Date : 2026-10-26 (UTC)**
**Branche : `arena/63303a21-tracefab`**
**SHA initial (main / origin/main / HEAD de départ) : `4eac0205a9f7c1f9481be6c830e4fc47eefe2908`**
**Commit de code : `e78e2e03831245b33a1e2ec4c06abefa76e73f51`**
**HEAD final : communiqué dans la réponse de livraison (ce fichier fait partie du commit de documentation qui suit le commit de code).**
**PR : aucune créée (aucune autorisation). Push : aucun. Fusion : aucune.**

---

## 1. Environnement et reproductibilité

| Élément | Valeur |
| --- | --- |
| Node / npm / Python | v22.22.3 / 10.9.8 / 3.11.2 |
| Installation | `npm ci --ignore-scripts` (le `postinstall` Prisma échoue faute d'accès à `binaries.prisma.sh`) |
| Serveur d'aperçu | `node scripts/dev_static_server.mjs --port 3000`, bind `0.0.0.0`, réécritures lues depuis `vercel.json` |
| Navigateur de test | Chromium épinglé `@sparticuz/chromium` + bibliothèques natives `al2023.tar.br` extraites hors dépôt dans `/tmp` et exposées par `LD_LIBRARY_PATH` |
| Variables sensibles | `DATABASE_URL`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `RESEND_API_KEY`, `PRIVATE_STORAGE_BUCKET`, `VERCEL_TOKEN` : **toutes absentes** |
| Comportement `/api/*` dans l'aperçu | `501 api_not_available_in_static_preview` (ex. `GET /api/me`) |
| Commande de référence | `LD_LIBRARY_PATH=/tmp/al2023/lib npm run test:mission-ui` et `LD_LIBRARY_PATH=/tmp/al2023/lib npm run test:journeys` |

Aucune valeur d'environnement, aucun jeton, aucun cookie et aucune donnée personnelle n'a été copié dans ce rapport ou dans les captures.

---

## 2. Captures avant / après

| Fichier | Contenu | Données visibles |
| --- | --- | --- |
| `captures/avant-mobile-390.png` | Brand Console, vue Quality, viewport 390×844, **avant** correction | Bandeau « Demo mode », organisation « Atelier Demo », sélecteur de langue. On voit la barre d'actions chevaucher la navigation et le contenu. |
| `captures/apres-mobile-390.png` | Même vue, même viewport, **après** correction | Barre d'actions alignée sous la nav, aucun chevauchement, aucun débordement. |

Les deux images ne contiennent que des données de démonstration déjà publiées dans le dépôt ; aucune donnée client, aucun token, aucun en-tête sensible.

**Mesures associées (390 px) :** `scrollWidth` Overview 423 → 390 ; Traçabilité 674 → 390 ; Documents 474 → 390 ; `.top-actions` hauteur 140 → 42 px ; `.topbar` `y=195..259` avec actions `y=156..296` → `y=195..258` avec actions `y=205..247`.

---

## 3. Matrice de vérification finale — 74 commandes

Toutes exécutées avec le navigateur disponible. **74 PASS / 0 FAIL** (74 codes de sortie 0). Journal brut de la passe non commité (`/tmp/tf-checks-final.txt`).

| Groupe | Commandes (nombre) | Résultat |
| --- | --- | --- |
| Socle TypeScript / schéma / assets | `typecheck`, `schema:static`, `test:assets` (77 références), `test:routes`, `test:minified-comments` (5) | PASS |
| i18n / copie / CSS / design | `test:i18n` (2 398 clés EN, parité 7 locales), `test:copy`, `test:console-css`, `test:systeme-design` (4) | PASS |
| Accessibilité, touch, listes, démo, surfaces | `test:accessibilite`, `test:touch`, `test:pagination`, `test:catalogue`, `test:coherence`, `test:donnees-demo`, `test:surfaces` (7) | PASS |
| Chantiers 3→5, landing | `test:chantier3-risk`, `test:chantier4-demo`, `test:chantier5-portail`, `test:chantier5-console`, `test:landing-lisibilite`, `test:landing-spine`, `test:landing-reperage`, `test:landing-performance` (8) | PASS |
| Base / routes / workflow / erreurs | `test:db-guard`, `test:db-guard-driver`, `test:db-routing`, `test:workflow-policy`, `test:workflow-policy-temoins`, `test:error-reporting` (6) | PASS |
| Console marque statique / parcours | `test:brand-console`, `test:brand-console:schema-bindings`, `test:brand-console:empty`, `test:brand-journey`, `test:brand-journey-58`, `test:customer-journey:blockers`, `test:questionnaires`, `test:supplier-portal` (8) | PASS |
| Sécurité / contrats API | `test:clerk-proxy`, `test:sql-errors`, `test:security:chantier1`, `test:bridge:chantier2`, `test:supplychain:chantier3`, `test:supplychain:contract` (6) | PASS |
| DPP / contexte | `test:dpp:chantier4`, `test:dpp:lifecycle`, `test:dpp:evidence`, `test:dpp:quality`, `test:dpp:identity`, `test:dpp:demo-separation`, `test:context-integrity` (7) | PASS |
| Qualité, CAP, passeport, onboarding, masse, bulk, doc AI, PLM, PEF, claims | `test:quality-actions:chantier5`, `test:cap:chantier5`, `test:universal-passport:chantier6`, `test:onboarding:chantier6`, `test:mass-balance:chantier7`, `test:bulk:chantier8`, `test:docai:chantier1`, `test:plm-erp:chantier2`, `test:pef:chantier3`, `test:green-claims:chantier4` (10) | PASS |
| Locataire / limite / P1 | `test:active-tenant`, `test:rate-limit`, `test:p1-i18n`, `test:p1-quality` (4) | PASS |
| Navigateurs | `test:brand-console:browser`, `test:supplier-portal:browser`, `test:quality-center:browser`, `test:journeys` (**20/20**), `test:multi-tenant:browser`, `test:mission-ui` (**11/11**), `test:phases`, `test:dossier`, `test:demo-declaree` (9) | PASS |
| **Total** | **74** | **74 PASS / 0 FAIL** |

### 3.1 Évolution mesurable de deux suites

| Suite | Avant | Après |
| --- | --- | --- |
| `npm run test:journeys` (20 parcours E2E non mockés) | **10/20** — 10 échecs `erreur JS : Failed to load resource: net::ERR_CONNECTION_CLOSED` (préchargement Clerk) | **20/20** |
| `npm run test:mission-ui` | n'existait pas | **11/11** |

### 3.2 Contrôles bloqués (environnement, pas régression)

| Commande | Résultat | Cause |
| --- | --- | --- |
| `npm ci` (postinstall) | **BLOQUÉ** | `binaries.prisma.sh/.../schema-engine.gz.sha256` non joignable |
| `npm run db:generate` / `npm run build` | **BLOQUÉ** | idem, échec dès la 1re étape (`build` = chaîne de validation) |
| `npm run api:typecheck` | **BLOQUÉ** | `@prisma/client` non généré → `TS2305` sur `Prisma`, `data_type`, `data_value_status`, `membership_role`, … |
| `npm test` | **BLOQUÉ** | même cause à la 2e étape |
| `npm run verify:prisma-client` | **BLOQUÉ** | refuse le client factice non généré (comportement attendu) |
| `test:router-load`, `test:product-edit:api`, `test:wallet:chantier9`, `test:storage:chantier10` | **BLOQUÉ** | importent `@prisma/client` non généré |
| Parcours réels avec API/base/Clerk | **BLOQUÉ** | `/api/*` → 501 dans l'aperçu ; aucune variable d'environnement ni environnement staging |
| Isolation RLS en production | **NON EXÉCUTÉ** | nécessite une base PostgreSQL de staging |
| Dépôt / validation de documents, aperçu brouillon | **NON EXÉCUTÉ** | fonctionnalités non exposées (voir `03-PROPOSITION-PRODUIT.md`) |

Toutes les étapes de `npm run build` situées **après** `db:generate` ont été exécutées individuellement dans la matrice : elles passent, à l'exception de `api:typecheck` et `test:router-load` qui dépendent du client Prisma.

### 3.3 Audit d'accessibilité indépendant

`axe-core` (WCAG 2.0 / 2.1, niveaux A et AA) injecté dans un vrai Chromium :

| Page | Règles passées | Violations |
| --- | --- | --- |
| Console Overview 1440 | 18 | 0 |
| Console Products 1440 | 24 | 0 |
| Console fiche produit 1440 | 20 | 0 |
| Console DPP produit 1440 | 16 | 0 |
| Console Overview 390 | 19 | 0 |
| Supplier Portal 1440 | 11 | 0 |
| Landing 1440 | 24 | 0 |

### 3.4 Performance (aperçu statique, 1440×900)

| Mesure | Valeur |
| --- | --- |
| Chargement `networkidle` | ~631 ms |
| First Contentful Paint | ~160 ms |
| Ressources | 12 |
| Volume transféré (sans compression) | ~555 Ko |
| Nœuds DOM Overview | 291 |
| Re-rendu recherche produit (1 248 produits) | ~17 ms |

---

## 4. Fichiers modifiés (commit de code `e78e2e0…`)

**Code frontend :** `assets/js/brand-console.1.js`, `assets/js/tf-clerk-preload.js` (nouveau), `brand-console/index.html`, `product-intelligence/index.html`, `assets/i18n/en.js`, `assets/i18n/{fr,de,it,es,nl,pt}.json`.

**Empreintes d'assets propagées :** `index.html`, `brand-console/index.html`, `dpp/index.html`, `passport/index.html`, `product-intelligence/index.html`, `quality-center/index.html`, `operations/index.html`, `invitations/accept/index.html`, `supplier-portal/index.html`.

**Tests / configuration :** `scripts/test_mission_ui_ux.mjs` (nouveau), `scripts/test_brand_console.mjs`, `package.json`.

**Documentation :** ce dossier `docs/experience/mission-ui-2026-10-26/` (4 rapports + 2 captures), créé sans écraser de document existant.

**Non modifié :** `main`, schéma Prisma, migrations, rôles/RLS, variables d'environnement, `vercel.json`, workflows GitHub, intégrations Clerk/Neon/stockage, données de production, secrets.

---

## 5. Liens

- Branche : `arena/63303a21-tracefab` (locale, non poussée).
- PR : **aucune** — création non autorisée.
- Comparaison locale : `git diff 4eac0205a9f7c1f9481be6c830e4fc47eefe2908..HEAD`.
- Rapports : `01-RAPPORT-DIAGNOSTIC.md`, `02-RAPPORT-CORRECTIONS.md`, `03-PROPOSITION-PRODUIT.md`, `04-PREUVES-TECHNIQUES.md` (ce fichier).
