# Levée des cinq verrous — journal d'exécution

Mission : dossier DPP textile réel (T-shirt), TraceFab Brand Console.
Date : 27 octobre 2026. Dépôt : `bf55f2ae6534cde84d072d9b975520216c7b6d4e`
(branche de travail `arena/c27ddaa4-tracefab`).

Voie retenue : **C** — corriger les verrous dans le code, sans toucher à la
production, sans base réelle, sans publication publique.

> Règle de preuve appliquée à ce journal : une ligne n'est « TERMINÉE ET
> VÉRIFIÉE » que si un contrôle **exécuté** la démontre. Écrire du code, ou
> écrire un test, ne suffit pas. Tout ce qui n'a pas pu être exécuté ici est
> marqué EN COURS ou BLOQUÉE, même si le code est en place.

---

## 1. Pourquoi la préparation est possible et le passeport public ne l'était pas

Ce n'est pas un seul blocage, mais **trois mécanismes distincts** qu'il faut
séparer, sinon on corrige le mauvais.

### 1.1 La préparation est une mesure, la publication est un acte

Le dossier DPP est évalué par treize exigences
(`prisma/migrations/20261021170000_dpp_readiness_truthful_gates/migration.sql`).
Tant qu'une exigence bloquante n'est pas satisfaite, l'état reste
`in_progress` / `review_required` / `data_ready` : on peut **préparer, saisir,
recalculer, corriger** autant qu'on veut. La préparation est réversible et
privée : rien n'en sort.

La publication est autre chose : `tracefab_set_dpp_publication(...)` +
`tracefab_mark_dpp_ready_to_publish(...)` écrivent un état lisible par le
monde entier, horodaté et attribué (`reviewed_at`, `reviewed_by`). C'est un
**acte**, pas une mesure. Il est donc normal — et souhaitable — que la
préparation soit atteignable bien avant lui.

### 1.2 Deux actes, pas un, et aucun des deux n'avait d'écran

Le passeport public exige deux franchissements successifs :

| Acte | Ce qu'il produit | Route | Interface avant ce chantier |
|---|---|---|---|
| Identité résolvable | un `public_id` (modèle / variante / lot / unité) → QR | `POST /api/products/:id/dpp/identities` | **aucune** |
| Publication | `readiness_status = published` + `public_slug` → URL `/dpp/?gtin=<slug>` | `POST /api/products/:id/dpp/publication` | **aucune** |

La console n'appelait que `POST …/dpp` (calcul) et `POST …/dpp/publish-review`
(revue). Le parcours marque s'arrêtait donc mécaniquement à « Validé & prêt à
publier » : **le dernier pas existait côté API et n'avait pas de bouton**. C'est
le défaut D2 du rapport de phase A, et c'est la réponse principale à la
question posée : ce n'était pas une barrière de données, c'était un écran
manquant.

### 1.3 Trois verrous de données en amont empêchaient d'atteindre « prêt »

Même avec l'écran de publication, trois défauts empêchaient d'arriver à l'état
`ready_to_publish` par le parcours nominal :

- **D1** : aucun produit ne sortait de `draft` (la barrière `product.not_draft`
  est bloquante) — la modale de création ne produit que des brouillons ;
- **D3/D4/D5** : les exigences `traceability.documented` et
  `evidence.product_data` ne pouvaient pas être satisfaites depuis l'interface
  (aucun champ document, formulaire de nœud en conflit avec la validation) ;
- **D6** : le registre documentaire et le téléversement étaient inertes, donc
  aucune preuve ne pouvait être déposée par la marque.

### 1.4 Ce qui reste réellement hors d'atteinte ici

- **Aucune base de recette n'est accessible depuis cet environnement** : les
  treize barrières n'ont pas été rejouées contre PostgreSQL. D8 (migrations 53,
  55, 56, 57 non déclarées appliquées) reste ouvert : l'écran réel de
  l'utilisateur peut diverger du code corrigé.
- **La publication publique n'a pas été déclenchée** — elle ne doit pas l'être
  sans autorisation explicite, et elle suppose un dossier réellement complet.
- **Aucun test navigateur n'a pu être exécuté** (Playwright indisponible) : le
  code d'interface est syntaxiquement validé et couvert par des contrats
  statiques, pas par une exécution réelle.

---

## 2. Les cinq verrous : état après travaux

Numérotation L1 → L5 = les cinq verrous opérationnels ; les identifiants D1–D10
renvoient au tableau du rapport de phase A.

> **Ce qui a changé depuis la première rédaction de ce journal.** Quatre
> verrous étaient marqués « EN COURS » faute de pouvoir *exécuter* l'interface.
> Un DOM de test (jsdom, devDependency épinglée) permet désormais de faire
> tourner le JavaScript réel de la console, d'émettre de vrais clics et de vrais
> `submit`, et d'inspecter les requêtes produites : `scripts/test_brand_console_dpp_journey.mjs`
> exécute 38 vérifications. Ces verrous sont donc passés de « code écrit » à
> « comportement constaté » — au niveau DOM, **pas** au niveau navigateur réel
> ni base réelle, ce qui est dit ligne par ligne.

| # | Verrou | Défaut source | Correction apportée | Preuve exécutée | Statut |
|---|---|---|---|---|---|
| **L1** | Un produit ne peut pas quitter le brouillon | D1 | `PATCH /api/products/:id` accepte `status:'active'` : `draft→active`, rôles owner/admin/manager, audit `product.activated`, 409 sur doublon et sur transition interdite. Bouton « Activer le produit » + confirmation explicite. | `test_product_edit_api.ts` → PASS (activation, 409 non idempotent, archivage depuis `active`, refus depuis `archived`, `published` → 400) ; `test_brand_console_dpp_journey.mjs` → PATCH `{"status":"active"}` constaté, statut affiché mis à jour, confirmation demandée ; `tsc --noEmit` exit 0. | **TERMINÉE ET VÉRIFIÉE** (API + DOM) |
| **L2** | Le passeport public n'a pas d'écran | D2 | Panneau « Identité résolvable » (création `public_id`, QR) et panneau « Publication du passeport » (slug, publier / suspendre / retirer), affichés **seulement** dans l'état attendu, avec confirmation. | Parcours DOM : `POST …/dpp/identities` `{publicId, granularity, qualifier}` ; QR exposé ; publication **indisponible avant la revue**, puis `POST …/dpp/publication` `{action:'publish', publicSlug}` ; slug conservé pour le lien. 4 vérifications. | **TERMINÉE ET VÉRIFIÉE** (DOM) — aucune publication réelle déclenchée |
| **L3** | Le graphe de traçabilité refuse les nœuds matière/organisation | D3 | Le formulaire n'envoie plus qu'**une** référence, celle du type choisi ; `processCode` n'est plus `required` ; message clair si la référence manque. | Parcours DOM : nœud `material` → `materialId` seul, `processCode` et `organizationId` à `null`, `sourceDocumentId` transmis. 4 vérifications. | **TERMINÉE ET VÉRIFIÉE** (DOM) |
| **L4** | Aucune preuve documentaire rattachable | D4 / D5 / D6 | `GET /api/documents` (route nouvelle, bornée au locataire) ; chargement du registre dans la console ; modale de dépôt (intent → PUT direct → scan obligatoire) ; sélecteur de document dans les formulaires nœud et data point ; data point envoyé avec `sourceDocumentId` ; compteurs de la vue Documents rendus factuels. | Parcours DOM : `POST /api/documents/upload-intent` avec métadonnées complètes, PUT vers le stockage **sans jeton Clerk**, `POST …/scan`, data point avec `sourceDocumentId` ; seuls les documents `available` sont proposés. 9 vérifications. `test_route_registry.mjs` → 138 routes, intégrité OK. | **TERMINÉE ET VÉRIFIÉE** (API + DOM) — sous réserve que le stockage privé soit configuré (voir §6) |
| **L4-limite** | Document sur un **lien** de chaîne | D4 | **Non corrigé, et non corrigeable sans décision** : `api/_routes/products/[productId]/supply-chain/links.ts` n'accepte aucun `sourceDocumentId` (ni la table `supply_chain_links`). Ajouter le champ côté UI produirait un champ silencieusement ignoré. | `grep sourceDocumentId` sur `links.ts` : aucun résultat | NON APPLICABLE — JUSTIFICATION FOURNIE (l'API ne porte pas la donnée) |
| **L5** | Le dossier peut être « prêt » sans contrôle qualité réel | D7 | Migration `20261027100000_dpp_quality_gate_requires_assessment` : `quality.no_open_issues` exige désormais **une évaluation persistée** (`data_quality_scores`) **et** l'absence d'anomalie ouverte. Le reste de la fonction est reproduit à l'identique ; privilèges reposés ; aucune table/policy touchée. | `test_dpp_quality_gate_truthful.mjs` → 7 vérifications PASS (dernière définition, absence de `OR`, 13 exigences, REVOKE, aucun DDL, intention documentée). **La migration n'est pas appliquée** : aucun accès base. | **CORRIGÉE ET VÉRIFIÉE STATIQUEMENT** — effet en base BLOQUÉ (D8) |
| — | Migrations non confirmées en base | D8 | — | Aucun accès base ici | BLOQUÉE (accès à une base de recette requis) |
| — | Manquants dérivés de clés codées en dur | D9 | — | `api/_lib/dpp.ts:64-78` | NON COMMENCÉE |
| — | Documentation obsolète | D10 | — | `README.md:164` | NON COMMENCÉE |

**Un verrou trouvé en levant les autres.** Le parcours DOM a révélé un défaut
que la lecture du code ne montrait pas : le gestionnaire global
`[data-product-id]` s'attachait aussi aux **boutons d'action** portant cet
attribut. Cliquer « Activer le produit » exécutait donc l'activation *puis*
rouvrait la fiche, ce qui réaffichait le statut d'avant l'écriture. Corrigé
(`if (el.dataset.action) return;`) et verrouillé par le test : le parcours
vérifie désormais que le statut affiché suit la réponse.

---

## 3. Registre d'avancement (numéroté, statuts contrôlés)

| N° | Étape | Statut | Preuve / motif |
|---|---|---|---|
| V1 | Constater le blocage `draft` (D1) | TERMINÉE ET VÉRIFIÉE | lecture `[productId].ts` + barrière `…170000:57` |
| V2 | Ouvrir `draft→active` avec rôles, audit, conflits | TERMINÉE ET VÉRIFIÉE | `test_product_edit_api.ts` PASS ; `tsc` exit 0 |
| V3 | Adapter les contrats statiques au nouveau cycle de vie | TERMINÉE ET VÉRIFIÉE | `test_customer_journey_release_blockers.mjs` PASS après mise à jour de deux assertions devenues fausses |
| V4 | Exposer le bouton d'activation | TERMINÉE ET VÉRIFIÉE | parcours DOM : PATCH attendu, statut mis à jour, confirmation |
| V5 | Lire le registre documentaire (`GET /api/documents`) | TERMINÉE ET VÉRIFIÉE | `test_route_registry.mjs` PASS ; parcours DOM : registre chargé et rendu |
| V6 | Enregistrer la route dans le routeur | TERMINÉE ET VÉRIFIÉE | `test_route_registry.mjs` : 138 routes, intégrité OK |
| V7 | Téléverser un document depuis la console | TERMINÉE ET VÉRIFIÉE | parcours DOM : intent + PUT + scan, aucun jeton envoyé au stockage tiers |
| V8 | Rattacher une preuve à un nœud de chaîne | TERMINÉE ET VÉRIFIÉE | parcours DOM : `sourceDocumentId` transmis, une seule référence |
| V9 | Rattacher une preuve à un data point | TERMINÉE ET VÉRIFIÉE | parcours DOM : `sourceDocumentId` transmis ; seuls les documents `available` proposés |
| V10 | Corriger le formulaire de nœud (une seule référence) | TERMINÉE ET VÉRIFIÉE | parcours DOM : `{materialId: <m>, processCode: null, organizationId: null}` |
| V11 | Publier un passeport depuis la console | TERMINÉE ET VÉRIFIÉE | parcours DOM : publication impossible avant revue, puis requête conforme ; **aucune publication réelle** |
| V12 | Vérifier la parité i18n et la fraîcheur des assets | TERMINÉE ET VÉRIFIÉE | `test_i18n_consolidation.mjs` OK (2467 clés, 7 locales) ; 0 clé `bt()` non résolue ; `test_assets` PASS |
| V13 | Rejouer les treize barrières contre une base réelle | BLOQUÉE | aucune base de recette accessible ; D8 non levé |
| V14 | Valider le parcours dans un vrai navigateur (captures) | BLOQUÉE | binaires Chromium absents et CDN bloqué ; le parcours est exécuté en DOM (jsdom), pas en navigateur |
| V15 | Corriger D7 (barrière qualitativement vraie) | TERMINÉE ET VÉRIFIÉE (statique) / BLOQUÉE (effet en base) | migration écrite + `test_dpp_quality_gate_truthful.mjs` PASS ; application impossible ici |
| V16 | Réconcilier la documentation (D9, D10) | NON COMMENCÉE | hors périmètre immédiat |
| V17 | Exécuter réellement l'interface (DOM) au lieu de la lire | TERMINÉE ET VÉRIFIÉE | `scripts/test_brand_console_dpp_journey.mjs` : 38/38 |
| V18 | Brancher le parcours dans la chaîne `npm test` | TERMINÉE ET VÉRIFIÉE | `test:brand-console:dpp-journey` et `test:dpp:quality-gate` ajoutés à `scripts.test` |
| V19 | Rendre les compteurs de la vue Documents factuels | TERMINÉE ET VÉRIFIÉE | compteurs d'état/expiration ; plus aucune catégorie inexistante |
| V20 | Vérifier le type des routes modifiées (`api:typecheck`) | BLOQUÉE | `prisma generate` échoue (TLS vers `binaries.prisma.sh`) : le client Prisma n'existe pas ici |

---

## 4. Détail des corrections (ce qui a été écrit, et où)

### 4.1 Cycle de vie produit — `api/_routes/products/[productId].ts`

| Corps `PATCH` | Transition | Rôles | Résultat |
|---|---|---|---|
| `{status:'active'}` | draft→active | owner/admin/manager | 200 + audit `product.activated` |
| `{status:'active'}` si déjà active | — | — | 409 `product_already_active` |
| `{status:'active'}` depuis archived | — | — | 409 `product_not_activatable_from_current_status` |
| `{status:'archived'}` | draft **ou** active→archived | owner/admin | 200 + audit `product.archived` |
| `{status:'archived'}` depuis archived | — | — | 409 `product_not_archivable_from_current_status` |
| `{status:'draft'}` | archived→draft | owner/admin | 200 + audit `product.restored` |
| statut inconnu | — | — | 400 `invalid_product_status_change` |

Activer n'est ni une validation des données ni une publication : le libellé de
confirmation le dit, et l'audit porte `requires_dpp_readiness_review: true`.

### 4.2 Registre documentaire — `api/_routes/documents.ts` (nouvelle route)

`GET /api/documents` — 200 `{documents:[…]}` ; 401/404 via `isTenantError` ;
bornée à `owner_organization_id = tenant.organizationId`, `deleted_at: null`,
`take: 200`. **Asymétrie assumée** : les documents fournisseurs n'y figurent
pas ; ils arrivent par la collecte de données.

Enregistrée dans `api/index.ts` avant `documents/upload-intent`.

### 4.3 Interface — `assets/js/brand-console.1.js`

- état `documents`, `documentsError`, `dppIdentities`, `dppIdentitiesError` ;
- `normalizeDocuments`, `attachableDocuments` (seuls les documents `available`
  sont rattachables : un document en analyse ne prouve rien),
  `documentOptions`, `loadDocuments`, `uploadDocument` (intent → PUT direct
  vers le stockage privé → scan obligatoire) ;
- modale `upload-document` (PDF/PNG/JPEG/TXT, type de document, expiration),
  bouton « Importer » actif, bandeau d'erreur + « Réessayer » ;
- panneaux `dppIdentityPanel` et `dppPublicationPanel` dans la vue DPP ;
- `activateProduct`, `createDppIdentity`, `publishDppPublic`,
  `changeDppPublication` ; toutes les actions destructives ou publiques sont
  confirmées ;
- formulaire de nœud : une seule référence envoyée, `processCode` non requis,
  avertissement « sans document, l'étape reste déclarée ».

### 4.4 Traductions

48 + 8 = 56 clés ajoutées en EN (référence) puis répliquées dans `fr, de, es,
it, nl, pt` — parité stricte vérifiée : **2467 clés par locale**. `mdClose`,
clé préexistante utilisée mais absente du dictionnaire, a été ajoutée au
passage. Aucune chaîne d'interface n'est écrite en dur.

### 4.5 Vue Documents — des compteurs qui ne mentent plus

Les quatre cartes du bandeau comptaient des catégories que le modèle ne porte
pas (`d.category` : « certificats de transfert », « rapports de laboratoire »,
« audits sociaux », « dossiers produit »). `normalizeDocuments` ne produit aucun
`category` : les quatre affichaient donc **0 en permanence**, y compris avec un
registre rempli. Elles comptent désormais ce que le registre sait réellement —
`available`, `uploaded`/`scanning`, expirés, `rejected` — et la colonne de
statut ne compare plus à `sealed`, valeur qui n'existe pas dans
`document_status`.

### 4.6 Barrière qualité — migration `20261027100000`

`quality.no_open_issues` se réduisait à `NOT EXISTS (… data_quality_issues …)`.
Un produit jamais évalué n'a aucune ligne d'anomalie : il franchissait la
barrière sans contrôle. La migration repose la fonction avec une condition
supplémentaire (`EXISTS (… data_quality_scores …)`), sans `OR`, en reproduisant
les douze autres branches à l'identique. **Elle n'est pas appliquée** : tant
qu'elle ne l'est pas, le comportement observé en base reste celui de
`20261021170000`.

### 4.7 Exécution de l'interface — `scripts/test_brand_console_dpp_journey.mjs`

Le JavaScript réel de la console est chargé dans un DOM jsdom, avec un `fetch`
intercepté et un utilisateur Clerk simulé ; les clics et les `submit` sont de
vrais événements. Le test vérifie **le corps exact** de chaque écriture
d'API, et refuse de se déclarer vert si jsdom manque (échec explicite plutôt
que saut silencieux). `jsdom` a été ajouté aux `devDependencies` pour que la
preuve soit reproductible en CI.

Ce que ce test ne prouve pas : que les routes acceptent ces corps (rôle de
`test_product_edit_api.ts` et des contrats SQL), ni que la base est migrée, ni
le rendu CSS réel.

---

## 5. Commandes exécutées et résultats exacts

| Commande | Résultat |
|---|---|
| `node --check assets/js/brand-console.1.js` | OK (après chaque passe) |
| `node --check assets/i18n/en.js` | OK |
| `npx tsc --noEmit` | exit 0 |
| `npm run test:product-edit:api` | PASS ×2 lignes |
| `node scripts/test_brand_console_dpp_journey.mjs` | **PASS — 38/38 vérifications** |
| `node scripts/test_dpp_quality_gate_truthful.mjs` | **PASS — 7 vérifications** |
| `node scripts/test_route_registry.mjs` | PASS — 138 routes, intégrité OK |
| `node scripts/test_dpp_chantier4.mjs` | PASS |
| `node scripts/test_dpp_evidence_chain.mjs` | PASS |
| `node scripts/test_dynamic_dpp_lifecycle.mjs` | PASS |
| `node scripts/test_dpp_resolvable_identity.mjs` | PASS |
| `node scripts/test_brand_journey_58_defects.mjs` | PASS |
| `node scripts/test_brand_journey_truthfulness.mjs` | PASS |
| `node scripts/test_customer_journey_release_blockers.mjs` | PASS (après mise à jour de 2 assertions devenues fausses) |
| `node scripts/test_brand_console.mjs` | PASS |
| `node scripts/test_asset_versions.mjs` | PASS — 77 références à l'empreinte exacte |
| `node scripts/test_i18n_consolidation.mjs` | OK — 2467 clés, 7 locales |
| `node scripts/test_minified_comments.mjs` | PASS |
| suites `test:active-tenant`, `test:security:chantier1`, `test:error-reporting`, `test:sql-errors`, `test:bridge:chantier2`, `test:supplychain:*`, `test:context-integrity`, `test:quality-actions:chantier5`, `test:cap:chantier5`, `test:universal-passport:chantier6`, `test:onboarding:chantier6`, `test:mass-balance:chantier7`, `test:supplier-portal`, `test:questionnaires` | PASS |
| `python3 scripts/validate_schema.py` | PASS — 22 tables historiques, 61 policies |
| `npm run api:typecheck` | **ÉCHEC environnemental** : `@prisma/client` non généré (`prisma generate` → TLS `binaries.prisma.sh`) |
| `node scripts/test_hardcoded_copy.mjs` | **non exécutable** : binaires Chromium absents, CDN bloqué |
| `node scripts/test_brand_console_empty_tenant.mjs` | **non exécutable** : idem |
| suites `test:neon:*` (base réelle) | **non exécutables** : aucune base |

Limite explicite : `tsc --noEmit` porte sur le TypeScript du dépôt hors `api/`
(`api:typecheck` est le pendant API et il échoue faute de client Prisma généré).
Les routes modifiées n'ont donc **pas** été type-checkées ici.

---

## 6. Ce qu'il reste à faire, et par qui

**Ne peut pas être fait depuis cet environnement :**

1. **Appliquer la migration `20261027100000`** sur une base de recette, puis
   rejouer les treize barrières — sans quoi L5 reste sans effet observable et
   D8 ouvert.
2. **Vérifier le parcours en navigateur réel** (captures) : Chromium n'est pas
   installable ici (CDN bloqué, bibliothèques système absentes).
3. **Type-checker `api/`** : `prisma generate` échoue faute d'accès à
   `binaries.prisma.sh`.

**Dépend d'une décision ou d'une autorisation :**

4. **Publication publique d'un passeport** : le bouton existe, la confirmation
   existe, mais publier reste un acte de la marque. Rien n'a été publié.
5. **Stockage privé** : le dépôt de document passe par une URL présignée. Si
   `PRIVATE_STORAGE_*` n'est pas configuré sur l'environnement, l'API répond
   `503 private_storage_not_configured` et la console affiche cette erreur —
   c'est un blocage d'environnement, pas de code.

**Dépend de données qui n'existent pas encore :**

6. Les **données réelles du T-shirt** (composition et pourcentages, teintures,
   fabricants et sites, pays d'origine, certifications). Aucune ne peut être
   inventée ; ce sont elles, et non le code, qui font aujourd'hui défaut.
