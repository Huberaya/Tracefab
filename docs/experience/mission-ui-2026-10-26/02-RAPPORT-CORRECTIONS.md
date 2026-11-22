# TRACEFAB — Mission UI/UX — Rapport de corrections et de vérification

**Date : 2026-10-26 (UTC)**
**Branche : `arena/63303a21-tracefab`**
**SHA de départ : `4eac0205a9f7c1f9481be6c830e4fc47eefe2908`**
**Commit de code : `e78e2e03831245b33a1e2ec4c06abefa76e73f51`**
**HEAD final de la branche : communiqué dans la réponse de livraison (ce rapport appartient au commit de documentation qui suit).**

---

## 1. Principes appliqués

- Corrections **frontend uniquement** : aucun changement de schéma, de migration, de rôle PostgreSQL, de politique RLS, de variable d'environnement sensible, de workflow de sécurité ou de donnée de production.
- Aucun `push`, aucune fusion, aucune création de PR, aucune modification de `main`.
- Aucun test n'a été affaibli pour passer. Une seule assertion statique a été **réécrite** pour suivre un changement d'architecture justifié (préchargement Clerk conditionnel, §2.6).
- Aucune intégration réelle n'a été remplacée par un mock pour « faire passer » un test. Les deux scénarios de panne API injectent volontairement une erreur afin de vérifier la **gestion d'erreur** ; ils sont explicitement étiquetés comme tels.
- Petits lots cohérents (A : responsive, B : vérité/i18n, C :fiabilité du parcours démo), chacun suivi d'une passe de tests.

---

## 2. Corrections, causes racines et fichiers

### Lot A — Responsive mesuré (P0)

**Cause racine.** `.topbar` avait `height: 64px` en mobile alors que `.top-actions` (passée en `flex-wrap` par `tracefab-spa-responsive.css`) mesurait 140 px. Le bloc d'actions débordait donc de son parent et recouvrait la navigation et le haut du contenu. Trois grilles à colonnes figées (`1fr` sans `minmax(0,1fr)`) imposaient en plus leur largeur minimale de contenu à la page entière.

**Fichiers.**

| Fichier | Modification |
| --- | --- |
| `brand-console/index.html` | Ajout d'un bloc `@media` documenté en fin de `<style>` : `.topbar` en `height:auto`/`min-height`, `flex-wrap`, crumb masqué en mobile (comme le portail fournisseur), `.top-actions` pleine largeur, `.mc-domains-grid` et `.tc-echelons-grid` en `minmax(0,1fr)`/`auto-fit`, bascule 1 colonne sous 560 px. Ajout de `.eq-score-strip--four` (4 colonnes) avec repli 2 / 1 colonnes. |
| `assets/js/brand-console.1.js` | La grille des preuves documentaires quitte le `style="grid-template-columns:repeat(4,1fr)"` inline (spécificité imbattable) pour `class="eq-score-strip eq-score-strip--four"`. |

**Mesure avant / après (viewport 390 px).**

| Vue | `scrollWidth` avant | `scrollWidth` après |
| --- | --- | --- |
| Overview | 423 | **390** |
| Traçabilité | 674 | **390** |
| Documents | 474 | **390** |
| Products / DPP / Quality | 390 | 390 |

`.top-actions` : hauteur 140 px, `y=156..296` hors de `.topbar` `y=195..259` → hauteur 42 px, `y=205..247` dans `.topbar` `y=195..258`. À 768 / 820 / 1024 px : aucune action hors de la barre, aucun débordement.

**Captures :** `captures/avant-mobile-390.png` et `captures/apres-mobile-390.png` (données de démonstration uniquement).

### Lot B — Vérité des informations et i18n (P0/P1/P2)

**B1. Fausse création de questionnaire (P0).** `api/_routes/questionnaires.ts` n'expose que `GET` : le catalogue est versionné côté serveur. Le formulaire `questionnaire-builder-form` faisait pourtant `state.questionnaires.unshift(...)` puis annonçait « Protocole … créé et disponible pour toutes les marques », en français, même en mode connecté. La donnée disparaissait au rechargement et le bouton « Lancer une collecte » pouvait ensuite envoyer une clé inconnue à `/api/data-requests`.

Correction :

- Bouton **désactivé hors démonstration**, avec `title` explicite (`qbCreateUnavailable`), et garde-fou dans l'action `p09`.
- En démonstration : bandeau « Demonstration only — this draft stays in this browser tab. It is never saved or shared. », toast « Local draft created in demo mode — not saved and not shared. », badge « Draft » sur la carte, bouton « Lancer une collecte » désactivé pour ce brouillon.
- Aucun `POST` n'est émis ; les libellés de champs passent par le catalogue i18n.
- « Edit the protocol » (bouton inerte) est désactivé avec une explication.

**B2. Préchargement Clerk inconditionnel (P1).** La balise statique `<link rel="preload" href="https://cdn.jsdelivr.net/...">` partait sur **toutes** les visites, y compris `?demo=1` où Clerk n'est jamais utilisé. Quand le CDN est inaccessible, cela produit une erreur console et faisait échouer 10 des 20 parcours E2E.

Correction : nouveau `assets/js/tf-clerk-preload.js`, chargé de façon synchrone dans le `<head>`, qui crée le lien **uniquement hors démo**. Le démarrage du préchargement reste antérieur à `/api/config`. L'assertion statique de `scripts/test_brand_console.mjs` a été réécrite pour vérifier (1) la déclaration du script, (2) la présence du `rel='preload'` et de l'URL du SDK, (3) le garde-fou `demo=1`. **Le comportement protégé est conservé, pas supprimé.**

**B3. Chaînes françaises incrustées (P1).** 15 nouvelles clés `console.*` ajoutées **aux 7 locales à parité stricte** (`en.js`, `fr`, `de`, `it`, `es`, `nl`, `pt`) ; `tr`/`zh` restent en parité partielle `shared+portal` et bénéficient du repli anglais, conformément à `test:i18n`. Chaînes remplacées : écran de connexion (« Espace marque », « Se connecter »), toasts de création produit/demande, sauvegarde produit, import catalogue, export audit, déclaration de donnée, aide ISO-2, « Principal », « Interne », libellés et aides du brouillon de questionnaire.

**B4. Titre de Product Intelligence (P2).** Ajout de `tf-skip-meta.js` avant `tf-i18n.js` : le titre propre de la page n'est plus écrasé par `meta.title` de la landing après un changement de langue.

**B5. Action inerte (P2).** Le bouton « Verify » de la table des preuves est désactivé avec `journeyFeatureUnavailable`, au lieu d'un `data-demo-action` qui affichait un toast d'indisponibilité.

**B6. Empreintes d'assets.** `npm run assets:version` a été rejoué après chaque lot. La modification de `assets/i18n/en.js` a propagé son empreinte aux 9 pages HTML qui le référencent — changement obligatoire (sinon `immutable` servirait l'ancien catalogue pendant un an). `test:assets` : **77 références exactes**.

### Lot C — Fiabilité du parcours démo (P0/P1)

**C1. « Prepare DPP » n'ouvrait pas le produit (P0).** `dppView()` choisit sa vue sur `state.dppScope`, pas sur `state.selectedDppProduct`. `loadDpp()` ne positionnait jamais `dppScope='product'` : depuis une fiche produit, l'utilisateur tombait sur le portefeuille (vide s'il n'avait pas été chargé) alors que le profil du produit avait bien été calculé. Correction : `state.dppScope = 'product'` dans `loadDpp()`.

**C2. Liens profonds non hydratés en démo (P1).** `sync()` retournait immédiatement dans sa branche démo, avant le bloc d'hydratation de `?view=…&productId=…`. Résultats observés : `Product not found`, portefeuille DPP vide, qualité/traçabilité non chargées. Correction : hydratation explicite (`productDetail`, `quality`, `supplyChain`, `dpp`, `dpp+productId`) avec `state.routeHydrated = true`.

**C3. Données structurées : chargement infini et appel fantôme (P1).** `openProduct()` mettait `productDataPoints = null` puis retournait sans rien charger en démo ; les définitions restaient vides (formulaire désactivé) ; `createProductDataPoint()` appelait une route tenant-scopée avec un identifiant fictif. Correction : `DEMO_DATA_POINT_DEFINITIONS` aligné sur `DATA_POINT_DEFINITIONS` de l'API, état `productDataPointsProductId`, garde-fous démo dans `openProduct`, `loadProductDataPoints` et `createProductDataPoint`, déclaration locale explicitement étiquetée « demo mode — not saved ».

---

## 3. Tests ajoutés / adaptés

| Fichier | Rôle |
| --- | --- |
| `scripts/test_mission_ui_ux.mjs` (**nouveau**, `npm run test:mission-ui`) | 11 contrôles navigateur réels : responsive 390/768/820, absence d'erreur console et de requête CDN en démo, liens profonds, données structurées, Form Studio, écran de connexion bilingue, parcours DPP complet, validations natives, pannes API / 401, titre Product Intelligence. |
| `package.json` | Ajout de `test:mission-ui` et intégration à `test:p1:browser`. |
| `scripts/test_brand_console.mjs` | Assertion du préchargement Clerk réécrite pour le nouveau mécanisme conditionnel (3 vérifications au lieu d'une). |

**Détail des 11 contrôles :** tous **PASS** (`11/11`, ~23 s). Le parcours DPP utilise des données fictives clairement identifiées : `MISSION-TSHIRT-001` / `Mission T-shirt`, GTIN `3760123456789`, `Organic cotton` 85 %. Il vérifie l'orchestration frontend uniquement.

**Recherches de régression effectuées :**

- `node --check` sur `brand-console.1.js` et `tf-clerk-preload.js` : OK.
- `npm run test:assets` : 77 références, empreintes exactes.
- `npm run test:i18n` : 2 398 clés EN, parité stricte FR/DE/IT/ES/NL/PT, parité partielle TR/ZH.
- `npm run test:brand-console` (contrats statiques), `test:brand-journey`, `test:brand-journey-58`, `test:customer-journey:blockers` : PASS.
- `npm run test:brand-console:browser` (bootstrap Clerk + proxy, pas de repli démo) : PASS.
- `npm run test:journeys` : **10/20 → 20/20** parcours valides.
- Matrice complète de 74 commandes (statique + navigateur + contrats API) : **74 PASS / 0 FAIL**.
- Audit axe-core WCAG 2.0/2.1 A+AA sur 7 pages (console desktop/mobile, portail, landing, fiche, DPP) : **0 violation**.

---

## 4. Résultats des contrôles — PASS / FAIL / BLOQUÉ / NON EXÉCUTÉ

### 4.1 Chaine complète

| Commande | Résultat | Précision |
| --- | --- | --- |
| `npm run typecheck` | **PASS** | `tsc --noEmit` sur `src/**/*.ts(x)` |
| `npm run schema:static` | **PASS** | — |
| `npm run test:assets`, `test:routes`, `test:i18n`, `test:copy`, `test:console-css`, `test:accessibilite`, `test:touch`, `test:pagination`, `test:catalogue`, `test:coherence`, `test:donnees-demo`, `test:surfaces`, `test:systeme-design`, `test:minified-comments` | **PASS** | 14 suites |
| Suites chantiers 1→10, landing, DPP, qualité, onboarding, masse, bulk, PEF, green claims, contexte, rate-limit, active-tenant, clerk-proxy, sql-errors | **PASS** | voir `04-PREUVES-TECHNIQUES.md` |
| Suites navigateur : `brand-console`, `supplier-portal`, `quality-center`, `journeys`, `multi-tenant`, `phases`, `mission-ui`, `dossier`, `demo-declaree` | **PASS** | Chromium épinglé + libs natives extraites du paquet npm |
| `npm run test:mission-ui` | **PASS (11/11)** | nouveau garde-fou |
| `npm run test:journeys` | **PASS (20/20)** | était 10/20 avant correction |
| `npm run build` | **BLOQUÉ** | échoue dès `db:generate` : `https://binaries.prisma.sh/...schema-engine.gz.sha256` non joignable (hôte non autorisé). Toutes les étapes suivantes de la chaîne ont été exécutées **individuellement** et passent, sauf celles qui dépendent du client Prisma. |
| `npm test` | **BLOQUÉ** | s'arrête à `api:typecheck` pour la même raison |
| `npm run api:typecheck` | **BLOQUÉ** | ~N erreurs `TS2305: Module '"@prisma/client"' has no exported member 'Prisma' / 'data_type' / …` : client non généré, pas une erreur de code applicatif |
| `npm run verify:prisma-client` | **BLOQUÉ** | refuse à juste titre le client factice non généré |
| `npm run test:router-load`, `test:product-edit:api`, `test:wallet:chantier9`, `test:storage:chantier10` | **BLOQUÉ** | importent `@prisma/client` non généré |
| Persistance réelle après rechargement contre l'API | **BLOQUÉ** | `DATABASE_URL`, `CLERK_SECRET_KEY`, clé publique Clerk, `RESEND_API_KEY`, bucket privé : absents ; `/api/me` → 501 dans l'aperçu statique. Aucun staging joignable |
| Isolation RLS multi-organisations en production | **NON EXÉCUTÉ** | nécessite une base réelle ; les tests navigateur ne prouvent que les en-têtes et les états |
| Dépôt / consultation / validation de documents | **NON EXÉCUTÉ** | fonctionnalité désactivée côté console, API de liste absente |
| Aperçu du passeport brouillon non publié | **NON EXÉCUTÉ** | pas de route de brouillon |

### 4.2 Ce qui est corrigé et prouvé, ce qui ne l'est pas

| Affirmation | Statut |
| --- | --- |
| Le débordement horizontal mobile de la console est supprimé sur 9 vues | **PROUVÉ** (mesures + captures + test) |
| La barre supérieure ne recouvre plus la navigation ni le contenu | **PROUVÉ** (géométrie DOM à 390/768/820/1024) |
| « Prepare DPP » affiche désormais la préparation du produit | **PROUVÉ** (test de parcours) |
| Les liens profonds démo survivent au rechargement | **PROUVÉ** (test de parité de vue) |
| La création de questionnaire ne prétend plus être enregistrée | **PROUVÉ** (test + absence de POST) |
| Le mode démo ne contacte plus le CDN Clerk et ne produit plus d'erreur console | **PROUVÉ** (20/20 parcours + test dédié) |
| Les libellés sont traduits dans 7 langues à parité stricte | **PROUVÉ** (`test:i18n`, écran de connexion EN/FR en navigateur) |
| L'accessibilité WCAG A/AA des pages testées est sans violation | **PROUVÉ** (axe-core, 7 pages) |
| Les parcours API réels (produits, DPP, documents) fonctionnent en production | **NON PROUVÉ** — nécessite staging + jeux de données réels |
| L'application est prête pour une commercialisation | **NON AFFIRMÉ** — les bloqueurs §5 restent ouverts |

---

## 5. Problèmes ouverts — chantiers séparés

1. **Backend / schéma :** écriture de modèles de questionnaire (POST/PATCH/GET versionnés, rôles, RLS, migration). Le frontend est prêt à les consommer ; aujourd'hui la création est honnêtement désactivée.
2. **Stockage privé :** liste, téléchargement, upload et validation des preuves dans la console marque (réutiliser `upload-intent` du portail, antivirus, signatures, RLS, journalisation). Actuellement désactivé.
3. **Passeport brouillon :** route de lecture non publiée avec marqueurs de confiance, pour que « Preview DPP · draft » montre autre chose qu'une URL publique exigeant publication.
4. **Différences de rôles explicites :** dériver les permissions de `/api/me` pour désactiver les actions interdites avant l'appel, plutôt que d'attendre un 403 en toast.
5. **Vérification en staging :** persistance après rechargement, erreurs réseau réelles, autorisations, performance avec compression, RLS multi-locataire.
6. **Conflits de fusion :** PR #98/#99 modifient `brand-console.1.js` et les catalogues i18n ; prévoir une résolution manuelle.
7. **P2 :** découpage du bundle `brand-console.1.js` (~341 Ko bruts), remplacement des drapeaux emoji, CI : ajouter `test:mission-ui` à l'étage `parcours` (non fait ici pour ne pas modifier les workflows).

Aucun de ces points n'a été contourné par un mock ou une modification de test.
