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
>
> Révision du 27/10 (seconde passe) : deux blocages de la première passe sont
> tombés. Un client Prisma **typé** a été généré hors ligne (§7.1), et les
> **58 migrations du dépôt ont été réellement appliquées** dans un PostgreSQL
> compilé en WebAssembly avant d'y jouer la barrière qualité (§7.2). Ces deux
> preuves portent sur le dépôt, **pas** sur l'environnement de recette :
> la distinction est maintenue dans chaque ligne du registre.

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
| **L5** | Le dossier peut être « prêt » sans contrôle qualité réel | D7 | Migration `20261027100000_dpp_quality_gate_requires_assessment` : `quality.no_open_issues` exige désormais **une évaluation persistée** (`data_quality_scores`) **et** l'absence d'anomalie ouverte. Le reste de la fonction est reproduit à l'identique ; privilèges reposés ; aucune table/policy touchée. | 1. `test_dpp_quality_gate_truthful.mjs` → **7 vérifications PASS** (dernière définition, absence de `OR`, 13 exigences, REVOKE, aucun DDL, intention documentée) — comptage re-vérifié le 27/10, le journal annonçait déjà 7 : il est exact. 2. `test_dpp_migration_chain_pglite.mjs` → la migration est **appliquée** dans un PostgreSQL réel, sur le **schéma complet du dépôt** (58/58), et la barrière y est **rejouée avant/après** (§7.2). | **TERMINÉE ET VÉRIFIÉE** (sémantique prouvée en exécution) — **application sur la base de recette : BLOQUÉE** faute d'accès (D8) |
| — | Migrations confirmées en base | D8 | — | Les 58 migrations s'appliquent dans l'ordre sur un PostgreSQL vierge (WASM) ; aucune ne suppose un état absent du dépôt, hormis les rôles provisionnés hors Prisma. | **TERMINÉE ET VÉRIFIÉE** pour le dépôt (chaîne complète jouée) — **BLOQUÉE** pour la base de recette, qui n'est pas accessible ici |
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
| V13 | Rejouer les treize barrières contre une base réelle | TERMINÉE ET VÉRIFIÉE (moteur PostgreSQL réel) / BLOQUÉE (base de recette) | `test_dpp_migration_chain_pglite.mjs` : les 13 branches sont éprouvées une par une sur le schéma complet ; les 4 statuts d'anomalie et la fraîcheur de `data_quality_scores` sont distingués. La base de recette, elle, reste inaccessible |
| V14 | Valider le parcours dans un vrai navigateur (captures) | BLOQUÉE | binaires Chromium absents et CDN bloqué ; le parcours est exécuté en DOM (jsdom), pas en navigateur |
| V15 | Corriger D7 (barrière qualitativement vraie) | TERMINÉE ET VÉRIFIÉE | migration écrite, PASS statique, **et** exécution avant/après : le produit non évalué franchissait la barrière avant, la franchit plus après |
| V16 | Réconcilier la documentation (D9, D10) | NON COMMENCÉE | hors périmètre immédiat |
| V17 | Exécuter réellement l'interface (DOM) au lieu de la lire | TERMINÉE ET VÉRIFIÉE | `scripts/test_brand_console_dpp_journey.mjs` : 38/38 |
| V18 | Brancher le parcours dans la chaîne `npm test` | TERMINÉE ET VÉRIFIÉE | `test:brand-console:dpp-journey` et `test:dpp:quality-gate` ajoutés à `scripts.test` |
| V19 | Rendre les compteurs de la vue Documents factuels | TERMINÉE ET VÉRIFIÉE | compteurs d'état/expiration ; plus aucune catégorie inexistante |
| V20 | Vérifier le type des routes modifiées (`api:typecheck`) | TERMINÉE ET VÉRIFIÉE — réserve : types seulement | Client Prisma typé généré hors ligne (`db:generate:offline`, §7.1) ; `npm run api:typecheck` → **exit 0**. Réserve explicite : ce client n'a **aucun moteur de requête**, il prouve la compilation TypeScript contre le schéma, **pas** l'exécution d'une requête. `scripts/verify_prisma_client.mjs` le déclare d'ailleurs non conforme pour le runtime |
| V21 | Rendre la génération Prisma reproductible sans `binaries.prisma.sh` | TERMINÉE ET VÉRIFIÉE | `scripts/generate_prisma_client_offline.mjs` : DMMF WASM + générateur officiel via RPC, `noEngine` + `binaryPathsOverride`. Le script **échoue** si le repli `PrismaClient: any` est écrit (contrôle sur `tracefab_products`) |
| V22 | Appliquer et éprouver la migration en exécution | TERMINÉE ET VÉRIFIÉE | `scripts/test_dpp_migration_chain_pglite.mjs` : 58/58 migrations, puis avant/après sur la barrière ; branché dans `npm test` sous `test:dpp:migrations` |
| V23 | Réaligner `package-lock.json` (devDependencies ajoutées) | TERMINÉE ET VÉRIFIÉE | `npm install --package-lock-only --ignore-scripts` ; `npm ci --dry-run` résout sans erreur ; `@prisma/internals` 6.19.3 et `@electric-sql/pglite` 0.5.12 présents au lock |

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
les douze autres branches à l'identique.

Le défaut a été **reproduit puis corrigé en exécution** (§7.2) : avant la
migration, un produit sans aucune évaluation renvoie `true` ; après, `false`,
puis `true` dès qu'une évaluation sans anomalie est persistée. Les quatre
statuts d'anomalie ont été éprouvés séparément : `open` et `acknowledged`
ferment la barrière, `resolved` l'ouvre, et **`waived` l'ouvre aussi** — un
acquiescement de renoncement ne vaut pas preuve ; c'est un comportement à
assumer explicitement, pas un détail. `quality.no_blocking_issues` suit la
**dernière** évaluation, pas la première.

Elle n'est **pas** appliquée sur la base de recette : cela suppose un accès qui
n'existe pas ici, et une autorisation explicite sur l'environnement visé.

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
| `npm run api:typecheck` | **exit 0** — après génération hors ligne du client Prisma (§7.1). Réserve : types seulement, pas de moteur de requête |
| `npm run db:generate:offline` | OK — `node_modules/.prisma/client/index.d.ts`, 7 878 Ko, modèle sonde `tracefab_products` présent 2 463 fois |
| `node scripts/test_dpp_migration_chain_pglite.mjs` | **PASS — 58/58 migrations appliquées**, puis **13 vérifications** avant/après sur la barrière qualité |
| `npm ci --ignore-scripts --dry-run` | OK — le lock résout `@prisma/internals` 6.19.3 et `@electric-sql/pglite` 0.5.12 |
| `node scripts/verify_prisma_client.mjs` | **ÉCHEC attendu et non contourné** : « aucun moteur de requêtes » — le client typé ne peut pas exécuter de requête |
| `node scripts/test_hardcoded_copy.mjs` | **non exécutable** : binaires Chromium absents, CDN bloqué |
| `node scripts/test_brand_console_empty_tenant.mjs` | **non exécutable** : idem |
| suites `test:neon:*` (base réelle) | **non exécutables** : aucune base |

Limite explicite après la seconde passe : `api:typecheck` **passe**, mais contre
un client sans moteur de requête. Les routes modifiées sont donc **type-checkées**
et **pas** exécutées : aucune requête Prisma n'a été jouée ici, et aucune ne peut
l'être dans cet environnement.

### 5.1 Deux régressions trouvées par la CI, invisibles ici

La CI de la PR a rejeté deux suites, et aucune des deux ne venait du code
applicatif : toutes deux étaient la **conséquence directe** des corrections.

| Suite | Message | Cause réelle | Correction |
|---|---|---|---|
| Parcours navigateur — « un utilisateur, deux organisations » | `aucune route inattendue n'a ete appelee — /api/documents` | la console charge le registre documentaire au démarrage ; la fixture du test est **fail-closed** et refusait cette route | route déclarée dans les deux fixtures fail-closed (`documents: []`), au lieu de laisser la console atteindre un backend réel |
| Base — « cycle de vie DPP dynamique » | `dpp_publication_requirements_not_met` puis `permission denied for function tracefab_refresh_product_data_readiness` | la revue exige désormais une évaluation qualité persistée — c'est exactement L5 ; la fixture n'en créait aucune, et le recalcul de complétude n'est plus exécutable par le rôle runtime | l'épreuve **vérifie d'abord le refus**, puis calcule la complétude (en admin : c'est une fixture) et la qualité (avec le rôle applicatif, comme la console), puis publie |

C'est la démonstration la plus utile de ce journal : une barrière corrigée ne
se voit pas dans un test statique, elle se voit dans les suites qui
**publiaient sans avoir rien évalué**. La première version de ce journal
affirmait que L5 était corrigée ; la CI a montré ce que « corrigée » implique
ailleurs dans la chaîne.

Après correction, la CI de la PR #102 est **verte** sur les quatre contrôles
exécutables : `Socle — types, compilation, isolation`, `Base — isolation RLS
exécutée`, `Parcours — navigateur réel` (Chromium réel, GitHub Actions) et le
déploiement de prévisualisation Vercel. C'est la seule preuve de navigateur
réel disponible dans ce dossier : elle ne peut pas être produite depuis
l'environnement de travail (bibliothèques système absentes), mais elle existe
et porte sur cette branche.

---

## 6. Ce qu'il reste à faire, et par qui

**Ne peut pas être fait depuis cet environnement :**

1. **Appliquer la migration `20261027100000`** sur la base de recette
   (`prisma migrate deploy`), puis rejouer les treize barrières dessus. La
   migration est désormais prouvée en exécution sur un PostgreSQL vierge ; ce
   qui manque est l'état *de votre base*, pas la preuve que la migration
   fonctionne.
2. **Vérifier le parcours en navigateur réel** (captures) : Chromium n'est pas
   installable ici (CDN bloqué, bibliothèques système absentes).
3. ~~**Type-checker `api/`**~~ — fait (§7.1). Reste que le client généré n'a
   **pas de moteur de requête** : `prisma generate` complet et toute requête
   réelle demandent encore `binaries.prisma.sh`.
4. **Appliquer la migration sur la base de recette** : la chaîne est prouvée sur
   un PostgreSQL vierge, elle ne l'est pas sur *votre* base (état, rôles,
   extensions, `_prisma_migrations`). Commande cible : `prisma migrate deploy`,
   à lancer sur l'environnement de recette avec votre autorisation.

**Dépend d'une décision ou d'une autorisation :**

5. **Publication publique d'un passeport** : le bouton existe, la confirmation
   existe, mais publier reste un acte de la marque. Rien n'a été publié.
6. **Stockage privé** : le dépôt de document passe par une URL présignée. Si
   `PRIVATE_STORAGE_*` n'est pas configuré sur l'environnement, l'API répond
   `503 private_storage_not_configured` et la console affiche cette erreur —
   c'est un blocage d'environnement, pas de code.

**Dépend de données qui n'existent pas encore :**

7. Les **données réelles du T-shirt** (composition et pourcentages, teintures,
   fabricants et sites, pays d'origine, certifications). Aucune ne peut être
   inventée ; ce sont elles, et non le code, qui font aujourd'hui défaut.

---

## 7. Deux blocages tombés, et ce que les preuves correspondantes valent

### 7.1 Un client Prisma typé, sans réseau vers `binaries.prisma.sh`

`prisma generate` télécharge un moteur de requête binaire. Ce CDN est
injoignable ici (`ECONNRESET` ; `api.github.com/.../prisma-engines/releases`
renvoie `[]`) : sans client, `api:typecheck` échouait et **aucune route de l'API
n'était type-checkée**.

La génération est pourtant possible sans ce binaire : le DMMF (la description
du schéma) est disponible en WASM dans `@prisma/internals`, et le générateur
officiel `@prisma/client/generator-build` sait produire les types à partir de
ce DMMF. `scripts/generate_prisma_client_offline.mjs` les branche par RPC, avec
`noEngine: true`, `skipDownload: true` et un `binaryPathsOverride` pointant vers
un chemin **inexistant** — sans cette dernière option, le générateur écrit un
**repli** `PrismaClient: any` qui compile et ne vérifie rien.

Le script refuse donc de se déclarer réussi si le modèle sonde
`tracefab_products` est absent de `index.d.ts`. Résultat : 7 878 Ko de types,
`tracefab_products` présent 2 463 fois, `npm run api:typecheck` → **exit 0**.

**Ce que cela prouve** : les routes modifiées compilent contre le schéma Prisma
réel ; une faute de nom de champ ou de type de retour est détectée.

**Ce que cela ne prouve pas** : le client n'embarque **aucun moteur de requête**.
`scripts/verify_prisma_client.mjs` le dit sans détour (« le client se
construirait, puis échouerait à la première requête »). Un `api:typecheck` vert
n'autorise donc **aucune** conclusion sur le fonctionnement de la base.

### 7.2 Les 58 migrations, appliquées, puis la barrière rejouée

Le second blocage était plus gênant : la migration corrective n'avait jamais
été **exécutée**, seulement lue. Un test qui lit du SQL prouve qu'on a écrit ce
qu'on voulait écrire ; il ne prouve pas que PostgreSQL en fait ce qu'on croit —
et le défaut corrigé est précisément un défaut de comportement.

`scripts/test_dpp_migration_chain_pglite.mjs` applique donc, dans l'ordre,
**les 58 migrations du dépôt** dans un PostgreSQL compilé en WebAssembly
(`@electric-sql/pglite`, devDependency, extensions `pgcrypto` et `uuid_ossp`),
après création du rôle runtime `tracefab_app` avec ses attributs attendus
(`LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`). Puis il rejoue la séquence :

| Étape | Résultat observé |
|---|---|
| 58/58 migrations, dans l'ordre | aucune erreur |
| Définition d'origine reposée : produit **jamais évalué** | `quality.no_open_issues` = **true** (le faux vert, reproduit) |
| Migration `20261027100000` réappliquée sur le schéma réel | OK |
| Même produit, sans évaluation | **false** |
| Une évaluation persistée, sans anomalie | **true** |
| Anomalie `open` | **false** |
| Anomalie `acknowledged` | **false** |
| Anomalie `waived` | **true** — renoncement assumé, signalé |
| Anomalie `resolved` | **true** |
| Barrières témoins (`product.reference`, `composition.complete`, `traceability.documented`, `evidence.product_data`, clé inexistante…) | chacune rend sa propre réponse, aucune n'est auto-satisfaite |
| `quality.no_blocking_issues` avec deux évaluations | suit la **dernière** |
| `has_function_privilege` pour `PUBLIC` et `tracefab_app` | **false** dans les deux cas |

**Ce que cela prouve** : la chaîne de migrations est cohérente, la migration
corrige bien le comportement sur le schéma réel, et la correction ne rend pas
les autres barrières complaisantes.

**Ce que cela ne prouve pas** : PGlite n'est ni Neon ni la base de recette. La
RLS n'y est pas éprouvée en conditions réelles (les rôles existent, les données
de production non), les extensions disponibles diffèrent, et
`_prisma_migrations` n'est pas géré. Le test ne remplace donc pas
`prisma migrate deploy` sur l'environnement visé : il établit que la migration
**mérite** d'y être appliquée, pas qu'elle y est appliquée.

### 7.3 Ce qui reste bloqué, et pourquoi ce n'est pas contournable

| Blocage | Motif | Contournement honnête |
|---|---|---|
| Appliquer la migration sur la base de recette | aucun accès base, aucune `DATABASE_URL` | aucun : il faut l'environnement et une autorisation |
| Exécuter une requête Prisma de bout en bout | moteur de requête introuvable hors ligne | aucun ici ; le type-check est le maximum atteignable |
| Navigateur réel (captures) | `libnspr4.so` absent, CDN bloqué | aucun installé ici ; le parcours reste prouvé en DOM (jsdom) |
