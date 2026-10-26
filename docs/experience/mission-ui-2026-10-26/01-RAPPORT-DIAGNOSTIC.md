# TRACEFAB — Mission UI/UX & qualité frontend — Rapport de diagnostic

**Date : 2026-10-26 (UTC)**  
**Branche : `arena/63303a21-tracefab`**  
**SHA de départ (main / origin/main / HEAD) : `4eac0205a9f7c1f9481be6c830e4fc47eefe2908`**  
**Arbre de départ : propre (aucune modification non commitée)**  
**Méthode : Inspecter → reproduire → mesurer → prioriser → corriger → tester → vérifier → documenter**

Ce rapport décrit l'état **avant** corrections. Les corrections et leurs preuves sont dans `02-RAPPORT-CORRECTIONS.md`, les propositions produit dans `03-PROPOSITION-PRODUIT.md`.

---

## 1. Phase A — état du dépôt, travaux en cours, règles

### 1.1 Références et état Git

| Élément | Valeur vérifiée |
| --- | --- |
| Dépôt | `Huberaya/Tracefab` (clone local `/home/user/Tracefab`) |
| Branche active | `arena/63303a21-tracefab` |
| `main`, `origin/main`, `HEAD` au départ | `4eac0205a9f7c1f9481be6c830e4fc47eefe2908` |
| Dernier commit | `4eac020 Merge pull request #97 from Huberaya/arena/fd550680-tracefab` |
| Arbre de travail | propre |
| Fichiers suivis | 769 |

### 1.2 PR ouvertes / récemment fusionnées touchant l'UI, les dépendances ou les API

| PR | État | Branche | Fichiers touchés (extrait) | Risque pour cette mission |
| --- | --- | --- | --- | --- |
| #99 `feat: complete archived product lifecycle` | ouverte (MAJ 2026-10-26 14:51 UTC) | `arena/c40c3ee5-tracefab` | `assets/js/brand-console.1.js`, i18n | **Chevauchement direct** avec nos modifications |
| #98 `Add archived products workspace and restoration` | ouverte (MAJ 2026-10-26 14:26 UTC) | `feature/archived-products-workspace` | `assets/js/brand-console.1.js`, i18n | **Chevauchement direct** |
| #97 `fix: use provisioned user UUID for product archival` | fusionnée 2026-10-26 13:51 UTC | — | archivage produit | déjà intégrée au SHA de départ |
| #95, #81, #79, #74, #72 | fusionnées récemment | — | UI / API divers | déjà intégrées |

**Décision :** aucune fusion, aucun push, aucune PR créée. Les modifications restent isolées sur la branche de session. **Risque identifié :** l'ajout de clés i18n et l'empreinte `?v=` de `assets/i18n/en.js` touchent 9 fichiers HTML que les PR #98/#99 modifient aussi ; un conflit de fusion devra être résolu au moment de l'intégration. Ce n'est pas un blocage pour cette mission.

### 1.3 Instructions et architecture relevées

- `README.md` : 9 surfaces statiques, 125 routes API serverless, mode `?demo=1` explicite avec bandeau, modèle de sécurité (Clerk + en-tête de locataire + RLS), commandes de test/build, travail restant connu.
- `docs/DESIGN_SYSTEM.md`, `docs/experience/CHANTIERS-RESTANTS.md`, `docs/experience/*` (recettes), `docs/architecture/*`, `docs/audit/01-world-class-transformation-audit.md` : règles de design, recettes et historique d'audit.
- `.github/workflows/ci.yml` : CI en plusieurs étages (`socle`, `parcours`, …). `npm run build` n'est **pas** un simple bundler : c'est une chaîne de validation (génération Prisma, typechecks, schéma statique, i18n, assets, routes, contrôles landing/console, rapport d'erreurs).
- `tsconfig.json` ne couvre que `src/**/*.ts(x)` ; `npm run api:typecheck` analyse séparément `api/**/*.ts`.
- `vercel.json` : CSP et en-têtes de sécurité, cache immuable `/assets/js/*` et `/assets/design-system/*` avec empreinte `?v=`, routage `/api/*`, `/p/:gtin` → `/dpp/index.html?gtin=…`. Le README signale que `/passport/` repose sur le filesystem (implicite).
- `scripts/build_asset_versions.mjs` + `test:assets` : toute modification d'un asset impose de régénérer les empreintes, sinon un correctif resterait invisible un an.

### 1.4 Commandes et environnement de vérification

- Node v22.22.3, npm 10.9.8, Python 3.11.2. `node_modules` absent au départ.
- `npm ci` échoue au `postinstall` (`scripts/prisma-generate.mjs`) car `https://binaries.prisma.sh/...` n'est pas dans la liste d'hôtes sortants autorisés. Installation réalisée avec `npm ci --ignore-scripts` (aucune modification du dépôt).
- Chromium de test : binaire épinglé `@sparticuz/chromium` présent dans npm mais dépendances natives absentes (`libnspr4.so`, `libnss3.so`, `libnssutil3.so`). Elles ont été extraites du paquet npm `al2023.tar.br` (hors dépôt, dans `/tmp`) et exposées via `LD_LIBRARY_PATH`. Playwright a également été relié à ce binaire. **Aucun fichier de cette adaptation n'est commité.**
- Serveur de test : `node scripts/dev_static_server.mjs --port 3000`, lié à `0.0.0.0`, qui reproduit les réécritures de `vercel.json`. Il répond `501` à tout `/api/*` non pourvu de fixture.

---

## 2. Cartographie des écrans, routes et composants

### 2.1 Surfaces (9 pages HTML)

| Surface | URL | Bundle principal | API réelle (hors `?demo=1`) | Persistance | Statut fonctionnel |
| --- | --- | --- | --- | --- | --- |
| Landing | `/` | `tf-landing.js` (851 l), `index.0.js` | aucune (formulaire de démo non connecté, clairement annoncé) | i18n en localStorage | **REAL** (statique) / formulaire **DOCUMENTED** |
| Brand Console | `/brand-console/` | `brand-console.1.js` (~5 300 l) | ~80 références `api()`/`fetch()` : produits, fournisseurs, matériaux, demandes, qualité, DPP, réglages, imports, masse salariale… | API + `X-Tracefab-Organization-Id` | **REAL** côté frontend ; **BLOQUÉ** à vérifier contre l'API réelle dans ce bac |
| Supplier Portal | `/supplier-portal/` | `supplier-portal.1.js` (944 l) | ~31 références : profil, sites, certificats, documents, réponses, invitations, données | API + Clerk | **REAL** côté frontend ; vérification multi-locataire **NON PROUVÉE** ici |
| Quality Center | `/quality-center/` | `quality-center.1.js` (47 l) | `/api/quality/overview`, acknowledge, waive | API | **REAL** |
| Passeport public DPP | `/dpp/`, `/p/:gtin` | `dpp.2.js` (346 l) | `GET /api/dpp/:gtin` avec règles de provenance `sourced / unverified / not_filled / unavailable` | lecture scellée | **REAL** (fail-closed si identifiant absent) |
| Passeport fournisseur | `/passport/` | `passport.1.js` (360 l) | `GET /api/passport/:ref`, `POST .../request-access` | lecture | **REAL** (501 dans l'aperçu statique) |
| Product Intelligence | `/product-intelligence/` | `tf-product.js` (432 l), `product-intelligence.0.js` | **aucun `fetch`** | aucune | **MOCK** déclaré (bandeau « demonstration record ») |
| Operations | `/operations/` | `operations.1.js` (2 l minifiés) | `/api/operations/overview` | API | **REAL** |
| Acceptation d'invitation | `/invitations/accept/` | `invitations-accept.1.js` (61 l) | `/api/invitations/accept` + Clerk | API | **REAL** |

### 2.2 Brand Console — 17 vues routables

`overview`, `requests`, `questionnaires`, `products`, `quality`, `risk`, `intelligence`, `massBalance`, `integrations`, `suppliers`, `materials`, `supplyChain`, `documents`, `certifications`, `dpp`, `reports`, `settings` (+ `productDetail`, `supplierDetail`, `requestDetail` en vues de détail). Navigation par `data-view`, URL `?view=…&productId=…`.

| Vue | Source de vérité | Statut | Observation |
| --- | --- | --- | --- |
| Overview | agregats API + indicateurs dérivés | **REAL / PARTIAL** | les valeurs non calculées sont affichées « Not computed », bonne pratique |
| Products / productDetail | `/api/products`, `/materials`, `/identifiers`, `/data-points`, `/schema-bindings` | **REAL** | fiche riche ; composition, identifiants, points de données versionnés |
| Requests / questionnaires | `/api/data-requests`, `GET /api/questionnaires` | **REAL / PARTIAL** | catalogue versionné réel, **création de questionnaire MOCK** (voir A02) |
| Quality / risk | `/api/quality/products/:id`, issues, PEF, green claims | **REAL / PARTIAL** | PEF et claims en lecture non bloquante |
| Supply chain / massBalance | `/api/products/:id/supply-chain`, `/mass-balance` | **REAL** | création de nœuds/liens, graphe déclaré ≠ documenté |
| DPP | `/api/dpp/portfolio`, `/api/products/:id/dpp`, `/publish-review` | **REAL** | profil interne `textile_readiness_mvp`, 9 exigences, 4 piliers, disclaimer « pas une certification » |
| Documents / certifications | aucune route de liste des documents d'organisation ; certificats dérivés des TC | **MOCK / PARTIAL** | upload, téléchargement et vérification **désactivés** ; la table affiche « Not computed » hors démo |
| Intelligence | aucune route | **MOCK** | assistant et réponses illustratives |
| Integrations / reports | lecture de schémas + exports API | **DOCUMENTED / PARTIAL** | connecteurs décrits, non configurés |
| Settings | `/api/organization-settings` | **REAL** | seuil qualité + historique |

### 2.3 Rôles, accès, persistance, validation

- **Auth** : Clerk chargé depuis jsdelivr, configuration via `/api/config`, jeton `Bearer` en mémoire (cache 30 s), jamais dans `localStorage`. Le `localStorage` ne contient que la langue et l'identifiant d'organisation actif — **aucun secret, token ou donnée personnelle trouvé** dans les bundles frontend (recherche de motifs `sk_live_`, `ghp_`, clés AWS, `BEGIN PRIVATE KEY`, `Bearer …` : 0 occurrence).
- **Rôles** : le frontend annonce les rôles (owner/admin/manager/contributor) mais ne les applique pas finement aux boutons ; l'API applique les contrôles (ex. `brand_product_role_required`, `organization-settings`). **Une inspection frontend ne prouve pas l'isolation multi-organisations.** Les tests `test:multi-tenant:browser` et `test:active-tenant` couvrent ce point côté contrat.
- **Persistance** : réelle côté API (hors démo). Le mode `?demo=1` est **en mémoire** : un rechargement efface les créations locales. Ce n'est pas un défaut en soi, mais cela doit rester explicitement annoncé.
- **Validation** : nombreux champs natifs (`required`, `pattern`, `min/max`, `type=number/date`), allowlist explicite dans `saveProduct`, validation serveur des points de données. Les erreurs API sont remontées par `api()` (`message`/`error`/`request_failed_###`) et affichées en toast ou état dégradé.

### 2.4 Performance mesurée (aperçu statique, 1440×900, réseau local)

| Mesure | Valeur |
| --- | --- |
| `load` (networkidle) | ~631 ms |
| First Contentful Paint | ~160 ms |
| Ressources | 12 |
| Volume transféré (sans compression) | ~555 Ko |
| Nœuds DOM (Overview) | 291 |
| Re-render d'une recherche produit (1 248 produits) | ~17 ms |

Le bundle `brand-console.1.js` pèse ~341 Ko bruts. Pas de goulot d'étranglement interactif mesuré, mais l'absence de découpage reste un sujet P2.

---

## 3. Tableau des anomalies (avant correction)

Gravité : **P0** = parcours métier cassé / information trompeuse ; **P1** = dégradation majeure ; **P2** = finition.

| ID | Gravité | Zone / fichier | Reproduction | Impact | Preuve mesurée | Statut |
| --- | --- | --- | --- | --- | --- | --- |
| A01 | **P0** | `loadDpp()` — `assets/js/brand-console.1.js` | Depuis une fiche produit, cliquer « Prepare DPP » | Le portefeuille DPP (souvent vide) s'affiche à la place de la préparation du produit ; les exigences calculées restent invisibles | Avant : `view=dpp`, `dppScope='portfolio'`, h1 « DPP readiness (Digital Product Passport) », texte « Select a textile product… ». Après : h1 « Cotton Essential », `dppScope='product'` | **CORRIGÉ** |
| A02 | **P0** | `questionnaire-builder-form` — `assets/js/brand-console.1.js` ; `api/_routes/questionnaires.ts` | Ouvrir Form Studio, créer un protocole en mode connecté | Succès annoncé « créé et disponible pour toutes les marques » alors qu'aucune route d'écriture n'existe (`GET` seul) ; mutation locale perdue au rechargement ; champs en français dans toutes les langues | Route `questionnaires.ts` : `if (req.method !== 'GET') return methodNotAllowed(res, ['GET'])` | **CORRIGÉ** |
| A03 | **P0** | CSS responsive — `brand-console/index.html`, `assets/design-system/tracefab-spa-responsive.css` | Ouvrir la console à 390 px | `.topbar` figée à 64 px contient des actions de 140 px : chevauchement de la nav et du contenu ; débordement horizontal | `scrollWidth` = 423 px (Overview), 674 px (Traçabilité), 474 px (Documents) pour 390 px ; `.top-actions` y=156..296 hors `.topbar` y=195..259. Captures `captures/avant-mobile-390.png` | **CORRIGÉ** |
| A04 | **P1** | `sync()` branche démo — `brand-console.1.js` | Recharger `?demo=1&view=productDetail&productId=…` ou `&view=dpp` | « Product not found », portefeuille DPP vide, qualité/traçabilité non chargées ; aucun bouton pour charger le portefeuille | `state.routeHydrated` jamais positionné en démo ; `dppPortfolio=false`, `selectedProductDetail=null` | **CORRIGÉ** |
| A05 | **P1** | Fiche produit, données structurées — `brand-console.1.js` | Ouvrir une fiche produit en démo | « Loading » permanent, formulaire désactivé (0 définition), et clic « Add declared data point » appelait une route tenant-scopée avec un identifiant fictif | `productDataPoints=null` jamais résolu ; `productDataPointDefinitions={}` ; toast d'erreur API | **CORRIGÉ** |
| A06 | **P1** | `<link rel="preload">` Clerk — `brand-console/index.html` | Ouvrir n'importe quelle page `?demo=1` | Requête vers un CDN tiers inutile ; erreur console `net::ERR_CONNECTION_CLOSED` quand le CDN est indisponible ; suite E2E polluée | `test:journeys` = **10/20** parcours valides avant, **20/20** après | **CORRIGÉ** |
| A07 | **P1** | Libellés en dur — `brand-console.1.js` | Interface `lang=en`, écran de connexion, création produit, sauvegarde, import CSV, export audit, aide ISO-2, identifiants | Français inconditionnel au milieu d'une interface anglaise ; incohérence de traduction | Chaînes relevées : « Espace marque », « Se connecter », « Produit créé en mode démonstration. », « Données produit enregistrées. », « Import catalogue terminé : … », « Code pays ISO-2 (ex. FR) », « Principal », « Interne », « Signé par le directeur d'usine » | **CORRIGÉ** |
| A08 | **P2** | `documentsConsoleView()` — `brand-console.1.js` | Table des preuves, bouton « Verify » | Bouton d'apparence active mais sans action réelle (toast « indisponible ») | `data-demo-action="1"` sur chaque ligne | **CORRIGÉ** (désactivé avec explication) |
| A09 | **P2** | `product-intelligence/index.html` | Charger la page puis changer de langue | `tf-i18n.js` remplace le titre par `meta.title` de la landing : la page s'intitule « The intelligence layer… » | `TF_I18N_SKIP_META` absent alors que 5 autres SPA l'ont | **CORRIGÉ** |
| A10 | **P2** | Grilles figées — `brand-console/index.html`, `documentsConsoleView()` | 390 px | `.mc-domains-grid` (4 → 2 colonnes `1fr` sans `minmax(0,1fr)`), `.tc-echelons-grid` (7 colonnes), grille de preuves en style inline (4 colonnes) : débordements | Voir A03 | **CORRIGÉ** |
| A11 | **P1** | Dépôt / consultation / validation des preuves — `documentsConsoleView()` | Mode connecté | Pas de route de liste des documents d'une organisation ; upload/téléchargement/vérification désactivés ; le dépôt réel se fait dans le portail fournisseur | Boutons `disabled title="This capability is not available in this version."` ; `state.documents=null` hors démo | **DOCUMENTÉ — travail à part** (backend + stockage privé + antivirus + RLS) |
| A12 | **P1** | Prévisualisation du passeport — `productDetailView()` | Cliquer « Preview DPP · draft » | Ouvre l'URL publique `/dpp/?gtin=…`, qui exige un passeport publié ; aucun aperçu de brouillon non publié | Bouton désactivé si aucun GTIN ; `dpp.2.js` échoue fermé sans ID | **DOCUMENTÉ — proposition P0-3** |
| A13 | **P2** | `brand-console.1.js` (341 Ko), `render()` complet | Navigation | Chaque frappe de recherche reconstruit tout le DOM ; focus restauré artificiellement | ~17 ms mesuré : acceptable aujourd'hui, mais fragilité IME/accessibilité | **DOCUMENTÉ — P2** |
| A14 | **P2** | Drapeaux emoji des sélecteurs de langue | Chromium sans police emoji | Drapeaux rendus en carrés « tofu » dans l'en-tête | Capture `captures/apres-mobile-390.png` | **DOCUMENTÉ — P2** (environnement-dépendant) |
| A15 | — | PR #98 / #99 | Fusion future | Conflits probables sur `brand-console.1.js`, `assets/i18n/*`, empreintes HTML | Voir §1.2 | **DOCUMENTÉ** |

### 3.1 Ce qui n'a pas été trouvé

- Aucun secret, token, cookie ou donnée personnelle en clair dans les bundles frontend ni dans les clés `localStorage` utilisées.
- Aucun `console.log` de jeton ou de payload dans `assets/js/*`.
- Aucune erreur JavaScript sur les 9 surfaces en mode démo après correction (hors `501` attendu de `/api/passport/...` dans l'aperçu statique).
- Audit axe-core (WCAG 2.0/2.1 A + AA) sur 7 pages : **0 violation** (18 à 24 règles passées par page).

---

## 4. Parcours — ce qui marche, ce qui échoue, ce qui est bloqué

Légende : **PASS**, **FAIL**, **BLOQUÉ**, **NON EXÉCUTÉ**.

| Parcours | Avant | Après | Périmètre de la preuve |
| --- | --- | --- | --- |
| Connexion / retour (bootstrap Clerk, proxy, pas de repli démo) | PASS | PASS | `test:brand-console:browser`, `test:clerk-proxy`, `test:mission-ui` |
| Tableau de bord marque (17 vues) | PASS | PASS | `test:brand-console`, `test:journeys` J07 |
| Liste / détail produit | PASS | PASS | `test:journeys` J08, `test:mission-ui` |
| Création produit + composition + identifiant + points de données (démo) | PARTIAL (A05) | PASS | `test:mission-ui` — données de test `MISSION-TSHIRT-001`, `Mission T-shirt`, GTIN `3760123456789`, composition 85 % |
| Préparation DPP depuis la fiche produit | **FAIL** (A01) | **PASS** | `test:mission-ui` |
| Portefeuille DPP, écarts, disclaimer | PASS | PASS | `test:journeys` J11–J13 |
| Contrôles bloquants et publication | PASS | PASS | le bouton de validation n'apparaît que si `canMarkReadyToPublish` est vrai |
| Fournisseurs / étapes de fabrication | PASS | PASS | `test:journeys` J09, J16 |
| Demande de données / questionnaire | PASS | PASS | catalogue réel ; création personnalisée désormais refusée explicitement (A02) |
| Dépôt / consultation / validation de documents | **BLOQUÉ** | **BLOQUÉ** | pas d'API disponible dans l'aperçu statique ; fonctionnalité désactivée en console (A11) |
| Qualité / complétude | PASS | PASS | `test:quality-center:browser`, `test:journeys` J10 |
| Aperçu du passeport brouillon | **NON EXÉCUTÉ** | **NON EXÉCUTÉ** | nécessite un passeport publié ou une route de brouillon (A12) |
| Portail fournisseur (14 vues) | PASS | PASS | `test:supplier-portal:browser`, `test:journeys` J17 |
| Paramètres compte / organisation | **BLOQUÉ** (API) | **BLOQUÉ** (API) | le rendu et le formulaire existent ; la persistance réelle n'est pas vérifiable sans staging |
| Passeport public `/p/:gtin` | PASS | PASS | `test:journeys` J18–J20 (hydratation réelle simulée par fixtures) |
| Persistance après rechargement contre l'API réelle | **BLOQUÉ** | **BLOQUÉ** | `DATABASE_URL`, `CLERK_SECRET_KEY`, clés Clerk, bucket de stockage : **absents** ; `/api/me` → 501 dans l'aperçu statique. Aucun environnement staging accessible depuis ce bac |
| Isolation multi-organisations (sécurité) | **BLOQUÉ** | **BLOQUÉ** | les tests navigateur vérifient les en-têtes/états, pas la RLS PostgreSQL réelle |
| Champs obligatoires / format invalide | NON EXÉCUTÉ | PASS | `test:mission-ui` : `required`, `pattern` ISO-2 |
| Panne API / utilisateur non autorisé | NON EXÉCUTÉ | PASS | `test:mission-ui` : injection de pannes 500/401, erreur explicite, aucun repli démo, bouton « Réessayer » |
| Erreurs console en démo | **FAIL** (A06) | PASS | `test:mission-ui`, `test:journeys` 20/20 |
| Mobile 390 px / tablette 768–820 px | **FAIL** (A03) | PASS | `test:mission-ui`, captures avant/après |

**Données de test utilisées (exclusivement fictives, mode démo) :** organisation `Atelier Demo`, fournisseur `Nhãn Textile`, produit `MISSION-TSHIRT-001` / `Mission T-shirt`, GTIN `3760123456789`, matériau `Organic cotton` 85 %, protocole `MISSION TEST protocol`. Aucune donnée réelle de client n'a été utilisée ni exposée.

---

## 5. Exigences, préparation et éléments non confirmés

Le bac n'avait pas accès aux sources juridiques officielles ; **ce rapport ne formule aucune obligation légale nouvelle** et ne valide aucune conformité réglementaire.

| Catégorie | Ce qui est établi / observable | Ce qui reste à confirmer |
| --- | --- | --- |
| **Exigences légales établies** | Aucune nouvelle obligation n'est affirmée ici. Le dépôt présente l'ESPR / Digital Product Passport comme cadre cible et l'UI répète explicitement qu'il s'agit d'un **indicateur de préparation, pas d'une certification**. | Vérification juridique formelle des textes applicables, de leur calendrier et de leur transposition : à mener par l'équipe conformité, hors de cette mission. |
| **Préparation recommandée (interne TRACEFAB)** | Profil `textile_readiness_mvp` v1.0 : 9 exigences, 4 piliers (identification, composition, traçabilité, qualité), score de complétude, liste d'écarts bloquants vs recommandés, historique de versions, sources et statuts de confiance (`declared`, `documented`, `verified_by_reviewer`). | Pertinence du profil par rapport au référentiel cible ; calibration des seuils (80 % / 50 %). |
| **Éléments sectoriels non confirmés** | Le dépôt cite PEF/PEFCR, GOTS, GRS, OEKO-TEX, SMETA, ZDHC, ISO 17025, GS1 Digital Link, CIRPASS JSON-LD comme exemples de standards ou de formats. | Aucune vérification de leur caractère obligatoire, de leur version ou de leur applicabilité produit par produit n'a été faite. Ils ne doivent pas être présentés comme preuve de conformité. |
| **Exigences internes produit** | En-tête de locataire sur chaque appel privé, absence de repli vers la démo après échec d'auth, états « non calculé » plutôt que zéro, 7 langues à parité stricte, empreintes d'assets, séparation démo/réel, journalisation des décisions. | Généralisation de ces règles aux futurs écrans. |

---

## 6. Limites de ce diagnostic

- Les parcours « réels » ont été vérifiés **côté frontend** (états, transitions, gestion d'erreurs, contrats d'appel). L'aperçu statique renvoie `501` sur `/api/*` : aucune base, aucun Clerk, aucun stockage privé n'était joignable. **Un build vert ne prouve pas un parcours utilisateur fonctionnel en production.**
- Les tests de sécurité multi-locataires du dépôt contrôlent les en-têtes et les états navigateur ; ils ne prouvent pas l'isolation RLS effective d'une base PostgreSQL de production.
- Les captures ne contiennent que des données de démonstration publiques du dépôt. Aucune donnée sensible, cookie ou jeton n'a été enregistré.
- `npm run build`, `npm test`, `npm run api:typecheck`, `test:router-load` et quelques suites d'API restent **BLOQUÉS** dans ce bac (voir `02-RAPPORT-CORRECTIONS.md` §4). Ce n'est pas une régression du code : c'est l'absence du client Prisma généré, lui-même causée par l'hôte `binaries.prisma.sh` non autorisé.
