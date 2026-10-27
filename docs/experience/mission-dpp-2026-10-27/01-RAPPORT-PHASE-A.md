# Mission « Premier DPP textile » — Rapport d'avancement, Phase A

**Date :** 2026-10-27
**Branche de session :** `arena/c27ddaa4-tracefab`
**Révision examinée (SHA) :** `bf55f2ae6534cde84d072d9b975520216c7b6d4e`
**Commit :** `Merge pull request #100 from Huberaya/arena/63303a21-tracefab`
**Arbre de travail au départ :** propre
**Environnement cible (déclaré par l'utilisateur) :** Brand Console, organisation « Tracefab Recette Produc… »
**Régime :** lecture seule sur le dépôt distant, aucun déploiement, aucune migration, aucune publication, aucune écriture métier.

> Ce rapport décrit **ce que le code fait**. Il ne prouve pas **ce que la base de recette contient**, ni les migrations réellement appliquées. Cette distinction est maintenue partout ci-dessous.

---

## 1. Résumé exécutif

Le parcours DPP **existe réellement** : modèle de données, fonctions SQL de calcul, barrières de publication à 13 exigences, routes API, écran de préparation, page publique dynamique. Ce n'est plus le « DPP conceptuel, SQL seulement » décrit par l'audit du 6 octobre 2026, qui est **périmé sur ce point**.

Trois constats structurants ressortent de l'analyse :

1. **Un produit créé par « + Nouveau produit » ne peut jamais satisfaire la barrière `product.not_draft`.** La modale crée un produit `draft` (`api/_routes/products.ts:94` → `tracefab_create_product`), et **aucun chemin de code ne fait passer un produit de `draft` à `active`** : le PATCH produit n'autorise que `draft → archived` et `archived → draft`, et rejette toute autre valeur (`api/_routes/products/[productId].ts:81,97,123,142`). Le seul endroit du dépôt qui écrit `status: 'active'` est l'**import CSV en masse** (`api/_lib/bulk-operations/bulk-importer.ts:125`), branché sur `POST /api/catalog/products/import` et exposé par le bouton **« Importer CSV »** de la page Produits.
   → Conséquence : avec le parcours nominal (+ Nouveau produit), l'état « Validé & prêt à publier » est **inatteignable**, non par manque de données, mais par une impasse de statut.

2. **La publication explicite et l'identité résolvable existent côté API, pas côté interface.** `POST /api/products/:id/dpp/publication` (publier / suspendre / retirer, avec `publicSlug`) et `POST /api/products/:id/dpp/identities` (identifiant public `public_id`, granularité, QR) sont implémentés, testés statiquement, mais **aucun écran ne les appelle** : la console n'appelle que `POST .../dpp` (recalcul) et `POST .../dpp/publish-review` (revue). Le « DPP public » du parcours marque s'arrête donc à « prêt à publier ».

3. **Deux barrières documentaires ne sont pas atteignables depuis l'interface marque** :
   - `traceability.documented` exige que **chaque** nœud du graphe porte un `source_document_id` (migration `20261021170000…:72-82`), or le formulaire de nœud ne propose **aucun champ document** ;
   - `evidence.product_data` exige un data point produit **relié à un document disponible**, or le formulaire de data point de la console ne permet que la déclaration nue (« aucune preuve »), alors que l'API accepte `sourceDocumentId`.
   La voie réaliste pour ces deux points est la **collecte fournisseur** (portail fournisseur → réponse + document → revue marque → pont SQL vers `data_points`).

**Conclusion opérationnelle :** un dossier DPP réel peut être constitué jusqu'à « structure technique complète », mais **la chaîne jusqu'à la publication publique n'est pas franchissable aujourd'hui depuis la Brand Console seule**. Il manque une décision produit (statut produit) et quatre écrans (publication, identité, preuves de nœuds, preuves de data points).

**Conformité réglementaire :** aucun acte délégué DPP textile n'est en vigueur à ce jour ; l'adoption est attendue vers **Q4 2027** (calendrier indicatif de la Commission), pour une application qui ne peut être antérieure d'environ 18 mois. Les 13 barrières TraceFab sont un **profil interne de préparation technique**, ce que le code dit explicitement (`scope: internal_technical_readiness`, mention « Not certification, regulatory compliance or publication approval »). Voir §8 pour la qualification.

---

## 2. Phase A — État technique du dépôt

### 2.1 Socle

| Élément | Valeur vérifiée | Preuve |
|---|---|---|
| Révision | `bf55f2ae6534cde84d072d9b975520216c7b6d4e` | `git rev-parse HEAD` |
| Routes HTTP | 136 fichiers de route, tous enregistrés dans `api/index.ts` | `npm run test:routes` → OK |
| Migrations | 58 dossiers dans `prisma/migrations` (dont `migration_lock.toml`) | `ls prisma/migrations` |
| Dernière migration | `20261023120000_revoke_app_default_dml` | idem |
| Modèle DPP | `dpp_requirement_profiles`, `dpp_records`, `dpp_lifecycle_events`, `dpp_resolvable_identifiers`, `dpp_claims`, `dpp_claim_evidence` | `prisma/schema.prisma`, migrations |
| Calcul de préparation | `tracefab_compute_dpp_readiness(uuid, text, text)` | `prisma/migrations/20260923130000_tracefab_neon_initial/migration.sql:5776` |
| Barrières | `tracefab_dpp_requirement_met(text, uuid)` (13 exigences) | `…/20261021170000_dpp_readiness_truthful_gates/migration.sql:28` |
| Revue | `tracefab_mark_dpp_ready_to_publish(uuid)` — ré-évalue les 13 barrières sous verrou | idem:121-140 |
| Publication | `tracefab_set_dpp_publication(uuid, text, text)` | `…/20261016130000_dynamic_dpp_lifecycle/migration.sql:79` |
| Identité résolvable | `tracefab_create_dpp_identity`, `tracefab_replace_dpp_identity` | `…/20261016170000_dpp_resolvable_identity/migration.sql:22,30` |

### 2.2 Parcours réel, du produit au passeport public

| # | Étape | UI (Brand Console) | API | SQL / règle | Réversible ? |
|---|---|---|---|---|---|
| 1 | Créer la référence | Modale « + Nouveau produit » (`brand-console.1.js:3897`) | `POST /api/products` | `tracefab_create_product` → `status='draft'` | oui (archivage) |
| 2 | Renseigner la fiche technique | Formulaire « Fiche Technique » (`:2693-2705`) | `PATCH /api/products/:id` | validation ISO-2, longueurs | oui |
| 3 | Composition | Panneau BOM (`:2710-2731`) | `POST /api/products/:id/materials` | somme = 100 % exigée **au calcul**, pas à la saisie | oui (édition %) |
| 4 | Origine des matières | Modale « + Ajouter un matériau » (`:3898`) | `POST /api/materials` | `origin_country_code` ISO-2 | oui |
| 5 | Identifiants | Panneau Identifiants (`:2733-2737`) | `POST /api/products/:id/identifiers` | `gtin/ean/upc/internal` | partiel |
| 6 | Fournisseurs | Modale invitation (`:3901`) | `POST /api/organizations/:id/invitations` | acceptation par le fournisseur | non |
| 7 | Collecte + preuves | Demandes (`:4031+`), revue des réponses (`:4513`) | `POST /api/data-requests`, `…/items/from-template`, `POST /api/data-responses/:id/review` | pont SQL → `data_points` avec `source_document_id` (`20261006120000…:277-303`) | non |
| 8 | Graphe de traçabilité | Vue Supply Chain, modales nœud/lien (`:3905-3906`) | `POST /api/products/:id/supply-chain/nodes|links` | `tracefab_create_supply_chain_node` | via fonctions contrôlées |
| 9 | Qualité | Vue Qualité, acquittement/waiver (`:3910-3917`) | `POST /api/quality-issues/:id/waive` | génère `data_quality_issues` | non (append) |
| 10 | Calcul DPP | Bouton « Recalculer » (`:3624`) | `POST /api/products/:id/dpp` | `tracefab_compute_dpp_readiness` | oui (recalcul) |
| 11 | Revue « prêt à publier » | Bouton « ✓ Valider » si `canMarkReadyToPublish` (`:3646`) | `POST …/dpp/publish-review` | `tracefab_mark_dpp_ready_to_publish` (13 barrières réévaluées) | non |
| 12 | Identité résolvable + QR | **aucune** | `POST …/dpp/identities`, `GET /api/resolve/:publicId(+ /qr)` | `dpp_resolvable_identifiers` | remplacement tracé |
| 13 | Publication explicite | **aucune** | `POST …/dpp/publication` | `tracefab_set_dpp_publication` (`slug` + `published`) | suspend/withdraw |
| 14 | Passeport public | Page `/dpp/?id=…` ou `/p/:gtin` | `GET /api/dpp/:gtin` | exige `public_slug` **et** un `dpp_records` `published` relu (`api/_lib/wallet/dpp-data-resolver.ts:64`) | retrait |

### 2.3 Les 13 barrières : où se règle chacune

Source unique : `prisma/migrations/20261021170000_dpp_readiness_truthful_gates/migration.sql`.

| Barrière | Règle exacte | Où la satisfaire (UI) | Atteignable ? |
|---|---|---|---|
| `product.reference` | non vide | fiche / modale | oui |
| `product.name` | non vide | fiche / modale | oui |
| `product.description` | **≥ 30 caractères** | fiche technique | oui |
| `product.category` | non vide (texte libre) | fiche | oui |
| `product.country_of_manufacture` | **ISO-2** (2 lettres, liste ISO contrôlée à l'écriture) | fiche | oui |
| `product.required_attributes` | `color_name` + `size_range` + `weight_grams > 0` | fiche | oui |
| `composition.complete` | matériaux > 0, tous avec %, somme = 100 ± 0,01 | BOM | oui |
| `materials.origin_documented` | **chaque** matière liée a `origin_country_code` ISO-2 | Matières | oui (champ facultatif → à remplir) |
| `traceability.graph` | ≥ 1 lien de chaîne | Supply Chain | oui (si formule corrigée, cf. D3) |
| `traceability.documented` | chaque nœud du graphe a `source_document_id` **et** statut documenté/vérifié | **aucun champ document en UI** | non en l'état |
| `quality.no_open_issues` | aucune anomalie `open`/`acknowledged` | Qualité (waiver) | oui, mais passante par absence d'évaluation (cf. D7) |
| `evidence.product_data` | ≥ 1 data point produit avec document `available` | Data points marque = déclaratif seul | non en l'état ; oui via collecte fournisseur |
| `product.not_draft` | `status <> 'draft'` | **aucune transition UI** | **non via la modale** ; oui via import CSV |

Note d'architecture : le résumé renvoyé par `buildDppSummary` est **fail-closed** — une exigence absente du snapshot persisté n'est jamais considérée comme satisfaite (`api/_lib/dpp.ts:186-196`). C'est une bonne propriété, mais elle rend l'écran dépendant du profil réellement appliqué en base : un `dpp_records` calculé avec l'ancien profil s'affichera **13 exigences dont plusieurs non satisfaites**, sans que l'utilisateur puisse savoir si le problème est la donnée ou le profil.

### 2.4 Matrice fonctionnelle

Statuts : **A** réellement fonctionnel · **B** partiel (maillon manquant) · **C** démo seulement · **D** statique · **E** absent.

| Fonction | Statut | Preuve / limite |
|---|---|---|
| Création de produit (modale) | A | `api/_routes/products.ts`, validation `required`/longueurs, 409 doublon |
| Import CSV produits | A | crée les produits en **`active`** (`bulk-importer.ts:125`) |
| Édition fiche technique | A | `validateProductPatch`, ISO-2 contrôlée |
| Composition / BOM | A | somme contrôlée au calcul seulement |
| Catalogue matières + origine | A | `originCountryCode` **facultatif** à la création |
| Identifiants produit | A | `gtin/ean/upc/internal`, un seul principal |
| Data points marque | B | API accepte `sourceDocumentId` ; l'UI envoie uniquement une valeur déclarée (`brand-console.1.js:2723`) |
| Documents (marque) | E (UI) / A (API) | boutons « Téléverser » **désactivés** (`:2046`), route `POST /api/documents/upload-intent` opérationnelle |
| Documents (fournisseur) | A | `supplier-portal.1.js:658` |
| Demandes de données + revue | A | création, items depuis template, envoi, réponse, revue item par item |
| Pont collecte → `data_points` | A (SQL) | `20261006120000…:277-303` ; non vérifié en exécution réelle ici |
| Graphe de traçabilité | B | API + SQL présents ; formulaire incohérent (D3) ; pas de champ document (D4) |
| Calcul de préparation DPP | A | UI + API + SQL |
| Revue prêt à publier | A (technique) | UI + API ; barrière `not_draft` bloquante (D1) |
| Publication explicite | B | API + SQL, **aucune UI** (D2) |
| Identité résolvable + QR | B | API + SQL, **aucune UI** (D2) |
| Événements de cycle de vie | B | API + SQL append-only, **aucune UI** |
| Allégations DPP (`claims`) | B | API + SQL, **aucune UI** |
| Passeport public dynamique | A (sous réserve de publication) | `assets/js/dpp.2.js:325` appelle `/api/dpp/:gtin` ; neutralisation si indisponible |
| Wallets Apple/Google | B | routes présentes, dépendances de credentials non vérifiables ici |
| P2 readiness (intégrations) | A | `GET /api/internal/p2/readiness` |
| Tests E2E bout-en-bout avec base réelle | E dans cet environnement | aucune base de recette accessible ici |

### 2.5 Défauts constatés (avec preuve)

| ID | Sév. | Défaut | Emplacement | Impact mission |
|---|---|---|---|---|
| **D1** | **P0** | Aucune transition `draft → active` : la modale crée un brouillon définitif ; seul l'import CSV crée des produits actifs | `api/_routes/products/[productId].ts:81,97,123,142` ; `bulk-importer.ts:125` ; barrière `…170000:57` | « prêt à publier » inatteignable par le parcours nominal |
| **D2** | **P0** | Publication (`publication.ts`) et identité résolvable (`identities.ts`) sans interface ; la console n'appelle que `dpp` et `publish-review` | grep `assets/js/brand-console.1.js` : 1 seul appel DPP d'écriture | aucun DPP public créable depuis la console |
| **D3** | P1 | Formulaire de nœud toujours incompatible avec la validation serveur : `processCode` est **toujours** envoyé (select `required`, défaut `other`) en plus de `materialId`/`organizationId`, alors que l'API exige **exactement une** référence → `invalid_node_reference` | `brand-console.1.js:4595-4601` vs `api/_lib/supply-chain.ts:122-123` | nœuds matière/organisation impossibles à créer en UI |
| **D4** | P1 | Aucun champ `sourceDocumentId` dans les formulaires nœud/lien | `brand-console.1.js:3905-3906` | `traceability.documented` inatteignable en UI |
| **D5** | P1 | Data point marque sans rattachement documentaire | `brand-console.1.js:2723` | `evidence.product_data` inatteignable en UI |
| **D6** | P2 | Boutons Documents désactivés alors que l'API marque accepte le téléversement | `brand-console.1.js:2046` vs `api/_routes/documents/upload-intent.ts` | aucune preuve déposable par la marque en UI |
| **D7** | P2 | `quality.no_open_issues` est satisfaite par **absence** d'évaluation (`NOT EXISTS`) : ne pas calculer la qualité fait passer la barrière | `…170000:83-88` | barrière « verte » sans contrôle réel |
| **D8** | P2 | Les migrations 53, 55, 56, 57 ne sont **pas déclarées appliquées** sur une base distante ; l'historique de recette n'est pas vérifiable d'ici | `docs/experience/CHANTIERS-RESTANTS.md` | l'écran observé peut diverger du code examiné |
| **D9** | P3 | Le résumé DPP dérive les manquants des 13 clés codées en dur, pas du profil stocké ; une clé de profil hors liste serait invisible | `api/_lib/dpp.ts:64-78, 178-196` | lisibilité des écarts |
| **D10** | P3 | Documentation obsolète : le README affirme que `dpp/index.html` ne fait aucun `fetch` ; l'audit du 6 octobre décrit un DPP « SQL seul » | `README.md:164` ; `TRACEFAB_MARKET_READINESS_AUDIT.md` | risque de décision sur une base fausse |

### 2.6 Corroboration documentaire

Deux documents internes confirment indépendamment les points ci-dessus :

- `docs/experience/RECETTE-POST-FUSION-PARCOURS-MARQUE-2026-10-21.md:68` : un produit **« Brouillon »** affichait « Structure technique complète · revue requise » alors que `product.not_draft` fait partie des 13 barrières → soit snapshot obsolète, soit profil non appliqué. **C'est exactement D1/D8.**
- `docs/experience/CHANTIERS-RESTANTS.md` : la migration 56 (`dpp_readiness_truthful_gates`) « n'est pas déclarée appliquée à une base distante et ne doit pas l'être sans réconciliation et autorisation opérateur ».

### 2.7 Tests exécutés dans cet environnement

Environnement : Node v22.22.3, npm 10.9.8, Python 3.11.2. `npm ci --ignore-scripts` (174 paquets) car `binaries.prisma.sh` est hors du périmètre réseau autorisé ; **aucune modification du dépôt**.

| Commande | Résultat | Portée |
|---|---|---|
| `node scripts/test_dpp_chantier4.mjs` | ✅ | migration, routes, UI, algorithmes de piliers |
| `node scripts/test_dynamic_dpp_lifecycle.mjs` | ✅ 22 assertions | publication explicite, append-only, RLS |
| `node scripts/test_dpp_evidence_chain.mjs` | ✅ 18 assertions | chaîne de preuves, confidentialité |
| `node scripts/test_dpp_resolvable_identity.mjs` | ✅ 15 assertions | identité stable, remplacement, QR |
| `npx tsx scripts/test_dpp_quality_engine.ts` | ✅ | moteur qualité DPP (5 scénarios) |
| `node scripts/test_dpp_demo_separation.mjs` | ✅ | neutralisation des données de démo |
| `node scripts/test_brand_console.mjs` | ✅ | contrat de la console |
| `node scripts/test_brand_journey_truthfulness.mjs` / `…_58_defects.mjs` | ✅ | véracité du parcours marque |
| `node scripts/test_supply_chain_chantier3.mjs` / `…_contract.mjs` | ✅ | graphe, RLS, formulaires |
| `node scripts/test_universal_passport_chantier6.mjs` | ✅ | passeport public, routage |
| `node scripts/test_wallet_public_surface.mjs` | ✅ | surface wallet publique |
| `node scripts/test_route_registry.mjs` | ✅ 136 routes | intégrité du routeur |
| `node scripts/test_route_context_coverage.mjs` | ✅ | couverture du contexte RLS |
| `python3 scripts/validate_schema.py` | ✅ | schéma statique |
| `npx tsc --noEmit` | ✅ | `src/**` uniquement |
| `npx tsx scripts/test_route_auth_coverage.mjs` | ❌ **112 échecs** | **environnemental** : `@prisma/client` non généré (`prisma generate` → `binaries.prisma.sh` inaccessible). Aucune conclusion sur le code. |
| Tests navigateur Playwright (`test:mission-ui`, `test:brand-console:browser`, `test:dpp:timeline-browser`) | ⏸ non exécutés | binaires Chromium non installables ici |
| Suites `test:neon:*` (base réelle) | ⏸ non exécutés | aucune base autorisée/joignable ; hors périmètre |

**Ce que ces tests prouvent :** la cohérence statique entre SQL, API et interface, et les propriétés de sécurité déclarées. **Ce qu'ils ne prouvent pas :** qu'un parcours fonctionne sur la base de recette. Aucun test de bout en bout réel n'a été exécuté.

---

## 3. Phase B — Checklist opérationnelle ordonnée

Chaque étape indique : objectif, champs réellement présents, données à obtenir, justificatifs, contrôle, critère de réussite, preuve attendue.

### É1 — Créer la référence produit
- **Objectif :** disposer d'un produit identifié de façon unique dans la marque.
- **Champs :** `Référence` (obligatoire, ≤180, unique par marque), `Nom` (obligatoire, ≤240), `Catégorie` (≤180), `SKU` (≤120).
- **À obtenir :** référence interne réelle, nom commercial, SKU éventuel.
- **Justificatifs :** fiche article interne, facture, bon de commande, ou extrait PLM.
- **Contrôle :** aucun code d'exemple (`TF-ESS-001`, `Cotton Essential`, `SKU-001` sont des **placeholders** du code) ; unicité de la référence.
- **Critère :** produit visible dans la liste avec son statut.
- **Preuve :** capture de la liste produits avec la référence réelle.

### É2 — Fiche technique
- **Champs :** nom, référence, catégorie, couleur, description (**≥ 30 caractères**), pays de fabrication (**ISO-2**), poids (g), tailles.
- **À obtenir :** couleur commerciale, poids unitaire, grille de tailles, pays de confection.
- **Justificatifs :** fiche technique fournisseur, étiquette, fiche de colisage.
- **Contrôle :** validations serveur (ISO-2 réelle, longueurs) ; cohérence poids/tailles avec la réalité.
- **Critère :** 6 barrières d'identification satisfaites au prochain calcul.
- **Preuve :** capture de la fiche + recalcul DPP montrant les 6 exigences vertes.

### É3 — Composition et origine des matières
- **Champs :** matière (catalogue), rôle, pourcentage ; matière : nom, type, **pays d'origine ISO-2**.
- **À obtenir :** composition exacte et pourcentages, origine de **chaque** fibre.
- **Justificatifs :** étiquette de composition, fiche fournisseur, certificat matière (le cas échéant).
- **Contrôle :** somme à 100 % ; origine renseignée pour chaque matière liée.
- **Critère :** `composition.complete` + `materials.origin_documented` vertes.
- **Preuve :** capture BOM + recalcul.

### É4 — Identifiants
- **Champs :** type (`internal`, `gtin`, `ean`, `upc`), valeur, principal.
- **À obtenir :** GTIN réel si le produit est destiné à la vente (préfixe GS1 de l'entreprise).
- **Contrôle :** clé de contrôle GS1 pour GTIN/EAN ; ne jamais saisir un GTIN d'exemple.
- **Critère :** identifiant réel présent ; le bouton « Prévisualiser DPP » de la fiche s'active alors.
- **Preuve :** capture du panneau Identifiants.

### É5 — Connecter les fournisseurs
- **Champs :** e-mail professionnel, raison sociale, nom d'usage, pays, organisation marque.
- **À obtenir :** coordonnées des partenaires réels (filateur, tisseur/confectionneur, teinturier).
- **Contrôle :** l'invitation n'est pas une relation vérifiée ; le fournisseur doit accepter.
- **Critère :** au moins un fournisseur connecté (sinon les demandes de données restent désactivées).
- **Preuve :** capture « Fournisseurs » avec le fournisseur accepté.

### É6 — Collecte et preuves (voie réaliste pour 2 barrières)
- **Champs :** demande de données rattachée au produit, items du questionnaire, réponse fournisseur + **document source**, revue marque (`verified_by_reviewer`).
- **À obtenir :** réponses factuelles + pièces (facture, certificat, rapport, bon de livraison).
- **Contrôle :** ne pas accepter une réponse sans document quand la preuve est demandée ; vérifier l'expiration du document.
- **Critère :** au moins un data point produit `documented` avec document `available`.
- **Preuve :** capture du détail de demande approuvée + recalcul DPP.

### É7 — Graphe de traçabilité
- **Objectif :** matérialiser les étapes réelles (filature → tissage → teinture → confection).
- **Champs UI :** libellé, type, procédé, matière, organisation. **Manquants en UI :** document source, site fournisseur.
- **À obtenir :** la séquence réelle des acteurs et les documents de chaque étape.
- **Contrôle :** cohérence des liens (une référence sémantique par nœud).
- **Critère :** `traceability.graph` verte ; `traceability.documented` **non atteignable en UI** (D3, D4).
- **Preuve :** capture du graphe + statut des nœuds.

### É8 — Qualité
- **Contrôle :** calculer la qualité, lire les anomalies, les corriger ou les motiver par un waiver.
- **Piège à signaler :** ne pas calculer fait aussi passer la barrière (D7) ; ce n'est pas une preuve de qualité.
- **Critère :** `quality.no_open_issues` verte **avec** une évaluation réellement exécutée.

### É9 — Calcul de préparation DPP
- **Action :** « Recalculer » ; lire les 13 exigences et le score.
- **Critère :** score = 100 % et `canMarkReadyToPublish` = vrai.
- **Preuve :** capture de l'écran DPP (piliers + liste des manquants).

### É10 — Revue « prêt à publier »
- **Action :** bouton « ✓ Valider » → `publish-review`.
- **Blocage attendu :** D1 (`product.not_draft`) si le produit a été créé par la modale ; `dpp_publication_requirements_not_met` sinon.
- **Critère :** statut `ready_to_publish` avec `reviewed_at`.

### É11 — Identité résolvable
- **API :** `POST /api/products/:id/dpp/identities` (`public_id` ^[a-z0-9][a-z0-9-]{7,79}$, granularité `model|variant|batch|unit`).
- **UI :** inexistante (D2). **Décision requise** avant toute action.

### É12 — Publication explicite
- **API :** `POST /api/products/:id/dpp/publication` (`publish` + `publicSlug`, ou `suspend`/`withdraw`).
- **UI :** inexistante (D2). **Interdite sans autorisation explicite de l'utilisateur.**

### É13 — Vérification du passeport public
- **Action :** ouvrir `/api/dpp/:gtin` puis la page `/dpp/`.
- **Critère :** données réelles uniquement, aucune valeur de démonstration, historique public vide ou exact.

### É14 — Vérifier l'état réel de la base de recette
- **Objectif :** savoir quelles migrations sont appliquées (D8), donc quel profil de barrières est actif.
- **Moyens autorisés :** `npx prisma migrate status` en lecture seule, ou `GET /api/internal/p2/readiness`, ou capture d'écran d'un écran qui expose le profil.
- **Statut :** bloquée sans accès autorisé.

---

## 4. Registre d'avancement

| # | Étape | Statut | Preuve / motif |
|---|---|---|---|
| 0 | Accès dépôt, SHA, architecture | **TERMINÉE ET VÉRIFIÉE** | `bf55f2ae…`, tests statiques OK |
| 1 | Création de la référence produit | **EN COURS** | capture reçue ; valeurs réelles non confirmées (placeholders probables) |
| 2 | Fiche technique | NON COMMENCÉE | dépend de É1 |
| 3 | Composition + origines | NON COMMENCÉE | — |
| 4 | Identifiants | NON COMMENCÉE | — |
| 5 | Fournisseurs connectés | NON COMMENCÉE | — |
| 6 | Collecte + preuves | NON COMMENCÉE | dépend de É5 |
| 7 | Graphe de traçabilité | **BLOQUÉE** | D3 + D4 : UI incohérente / champ document absent |
| 8 | Qualité | NON COMMENCÉE | — |
| 9 | Calcul DPP | NON COMMENCÉE | dépend de É2–É8 |
| 10 | Revue prêt à publier | **BLOQUÉE** | D1 : `product.not_draft` non satisfiable via la modale |
| 11 | Identité résolvable | **BLOQUÉE** | D2 : aucune interface ; décision requise |
| 12 | Publication explicite | **BLOQUÉE** | D2 + dépend de É10 ; interdite sans autorisation |
| 13 | Vérification passeport public | NON COMMENCÉE | dépend de É12 |
| 14 | État des migrations en recette | **BLOQUÉE** | aucun accès base autorisé depuis cet environnement |
| — | Matrice des preuves / fiche de collecte | NON COMMENCÉE | annexe A ci-dessous, à remplir avec des données réelles |

---

## 5. Prochaines actions

**Immédiat, sans risque, par l'utilisateur :**
1. Confirmer la nature des 4 valeurs affichées dans la modale (placeholders ou valeurs réelles) et ne pas valider `TF-ESS-001` / `Cotton Essential` / `SKU-001`.
2. Fournir les données réelles de É1 (référence, nom), puis de É2.

**Décisions à prendre (ChatGPT + utilisateur), avant toute action supplémentaire :**
- **Décision 1 — statut produit.** Faut-il (a) corriger le produit pour permettre une transition explicite de publication, (b) créer les produits via l'import CSV (qui les rend `active`) en assumant l'écart de parcours, ou (c) retirer `product.not_draft` du profil ? Chaque option a un coût : (a) = développement, (b) = contournement d'UX à documenter, (c) = affaiblissement d'une barrière.
- **Décision 2 — dossier limité au privé ?** Accepte-t-on un dossier allant jusqu'à « structure technique complète » sans publication (aucune donnée publique), ce qui est déjà utile et sans risque.
- **Décision 3 — voie des preuves.** Accepte-t-on de connecter un fournisseur (É5) comme seule voie propre pour `evidence.product_data`, ou faut-il d'abord exposer le rattachement documentaire côté marque ?

**Autorisations nécessaires :** accès lecture seule à l'état des migrations de recette ; toute écriture API hors UI (identités, publication) ; tout téléversement de document.

---

## 6. Annexe A — Fiche de collecte (à remplir, **non un justificatif**)

> Modèle vierge. Il ne vaut preuve d'aucune donnée tant qu'il n'est pas rempli et adossé à un document.

| Champ TraceFab | Valeur | Source | Statut | Document lié |
|---|---|---|---|---|
| Référence | | | À obtenir | |
| Nom commercial | | | À obtenir | |
| Catégorie | | | À obtenir | |
| SKU / GTIN | | | À obtenir | |
| Description ≥ 30 car. | | | À obtenir | |
| Couleur | | | À obtenir | |
| Poids (g) | | | À obtenir | |
| Tailles | | | À obtenir | |
| Pays de confection (ISO-2) | | | À obtenir | |
| Matière 1 + % + origine | | | À obtenir | |
| Matière 2 + % + origine | | | À obtenir | |
| Étape filature (acteur, pays, doc) | | | À obtenir | |
| Étape tissage (acteur, pays, doc) | | | À obtenir | |
| Étape teinture (acteur, pays, doc) | | | À obtenir | |
| Étape confection (acteur, pays, doc) | | | À obtenir | |
| Certificats (standard, n°, émetteur, validité) | | | À obtenir | |

---

## 7. Annexe B — Bloc de transmission à ChatGPT

```
FAITS (dépôt, SHA bf55f2ae) :
- 13 barrières DPP = profil INTERNE de préparation technique (pas une conformité réglementaire), réévaluées au moment de la revue.
- Parcours UI : produit → fiche → BOM → identifiants → fournisseurs → collecte → graphe → qualité → calcul DPP → revue.
- Aucune UI pour : publication explicite (slug), identité résolvable (public_id), événements, claims.
- product.status : draft à la création ; seules transitions = draft→archived, archived→draft ;
  l'import CSV crée des produits 'active'. Donc la barrière product.not_draft est
  inatteignable via « + Nouveau produit » et atteignable via « Importer CSV ».
- traceability.documented exige un document par nœud : aucun champ document dans l'UI.
- evidence.product_data exige un data point marqué documented avec document : la collecte
  fournisseur (réponse + doc + revue marque) est la seule voie propre ; l'UI marque ne
  déclare que des valeurs nues.
- Le formulaire de nœud envoie toujours processCode + (matière|organisation) alors que l'API
  exige exactement une référence → invalid_node_reference.
- quality.no_open_issues est satisfaite par absence de calcul qualité (passante par défaut).

TESTS : 14 suites statiques exécutées et vertes (dont 4 spécifiquement DPP) ; api:typecheck et
couverture d'auth non exécutables ici (client Prisma non générable, réseau bloqué) ; aucune
suite base réelle ; aucun test navigateur.

CONSTATS D'INTERFACE : fournis par l'utilisateur, non rejoués par l'agent.

DÉCISIONS DEMANDÉES :
1) statut produit (corriger / importer en CSV / assouplir la barrière) ;
2) périmètre : dossier privé jusqu'à « prêt à publier » ou objectif public ;
3) voie des preuves : fournisseur connecté vs exposition du rattachement documentaire.

VALIDATIONS REQUISES : état des migrations en recette (lecture seule) ; toute écriture hors UI ;
téléversement de documents ; publication (interdite sans autorisation explicite).

RÉGLEMENTAIRE (à requalifier par ChatGPT) : pas d'acte délégué DPP textile en vigueur ;
adoption indicative Q4 2027, application ~18 mois plus tard ; les 13 barrières ne sont PAS
une liste légale.
```

---

## 8. Qualification réglementaire (à revalider)

- Le règlement (UE) 2024/1781 (ESPR) est en vigueur depuis le 18 juillet 2024 ; il crée le cadre du passeport numérique, sans fixer à lui seul les champs textiles.
- À la date de ce rapport, **aucun acte délégué fixant le contenu du DPP textile n'est en vigueur**. La Commission annonce une **adoption indicative au Q4 2027** pour le textile/habillement, suivie de spécifications techniques ; l'application ne peut normalement intervenir moins de 18 mois après l'entrée en vigueur d'un acte délégué (ESPR art. 4(4) et 72(6)).
- Conséquence : les 13 barrières TraceFab sont une **bonne pratique documentaire interne**, pas une obligation légale. Elles ne doivent pas être présentées à un client comme « le DPP obligatoire ».
- Points **déjà contraignants** pour un T-shirt, indépendamment du DPP : étiquetage de la composition (règlement (UE) 1007/2011) ; pour les grandes entreprises, interdiction de destruction des invendus textiles depuis le 19 juillet 2026 (ESPR art. 25 et actes associés).
- Le registre européen DPP a été établi par le règlement d'exécution (UE) 2026/1778 (en vigueur en août 2026) — cela ne rend pas le passeport textile obligatoire.
- **À vérifier au moment de l'usage** : périmètre exact, niveau d'identification (modèle / lot / article), droits d'accès et échéances définitives, qui dépendront de l'acte délégué textile et de ses actes d'exécution.
