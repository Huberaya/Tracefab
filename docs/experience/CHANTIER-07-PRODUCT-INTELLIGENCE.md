# Chantier 07 — Product Intelligence réelle

Statut : livré sur la branche `arena/df246958-tracefab`.
Date : 2026-10-08.

## Objectif (roadmap)

« Fiche produit 11 lentilles branchée sur l'API (composition, fournisseurs,
evidence, qualité, DPP readiness) ; actions produit (request data, view
lineage, export, history). »

## Point de départ

- La console possédait une fiche produit mêlant formulaires réels (fiche
  technique, BOM, identifiants) et contenu fabriqué : « indice qualité
  98.4 / 100 », pipeline de lignée codé en dur (« Ferme GOTS »,
  « Guimarães PT », « ZDHC Level 3 », « BOM 100 % », « Score A (PEF) »),
  BOM factice de repli, valeurs par défaut inventées (« Navy Deep »,
  « 185 g », tailles XS–XL).
- Une maquette statique (`product-intelligence/` + `assets/js/tf-product.js`)
  démontrait les 11 lentilles avec un enregistrement de démonstration.
- Les APIs produit existaient déjà : `GET /api/products/:id`,
  `/supply-chain` (graphe + étapes + résumé), `/dpp`,
  `/api/quality/products/:id`, `/schema-bindings`, `/revision`.

## Ce qui a été fait

### Fiche produit restructurée en 11 lentilles réelles

`productDetailView()` rend désormais une barre d'onglets (rôles ARIA
tablist/tab/tabpanel) avec onze lentilles, toutes alimentées par l'état
chargé — jamais de simulation :

| Lentille | Source réelle |
| --- | --- |
| Overview | produit (référence, catégorie, version, statut, complétude), identifiants, formulaires existants, schémas versionnés (`state.schemaBindings` + `state.schemaCatalog`) |
| Composition | parts réelles des matières attachées (`detail.materials`) : barre + tableau |
| Materials | BOM réel (édition des parts + ajout) et identifiants (édition + ajout) — fonctionnalités conservées |
| Supply chain | `GET /api/products/:id/supply-chain` : nœuds, liens, taux de documentation, étapes couvertes |
| Manufacturing | nœuds process/site du graphe de traçabilité |
| Suppliers | organisations (nœuds site) du graphe, dédupliquées |
| Evidence | panneau honnête : unification prévue au chantier Evidence Center, lien vers les documents |
| Certifications | certifications d'organisation (`state.certifications`), explicitement étiquetées comme telles |
| Quality | `GET /api/quality/products/:id` : composantes du score + anomalies ouvertes |
| DPP | `GET /api/products/:id/dpp` : complétude, exigences satisfaites, statut — vocabulaire « préparation » uniquement |
| History | événements horodatés réels : création produit, identifiants, matières, schémas |

Chaque lentille sans données affiche un état vide explicite ; les échecs
d'endpoint (Promise.allSettled) ne cassent pas la fiche.

### Chargement et actions

- `loadProductIntel(id)` : chargement parallèle tolérant (graphe, DPP,
  qualité) appelé par `openProduct` en modes réel et démo ; stocké dans
  `state.productIntel`.
- Actions produit réelles : demande de données (modale existante), graphe
  complet (`loadSupplyChain`), centre qualité (`loadQuality`), vue DPP
  complète (`loadDpp`), nouvelle révision (`reviseProduct`), **export JSON**
  du produit (fiche + identifiants + matières + schémas + intelligence,
  téléchargement réel via `downloadTextFile`), historique.
- Bascule d'onglets sans re-rendu : les formulaires restent liés.

### Nettoyage vérité

Supprimés de la fiche produit : l'indice qualité inventé, tout le pipeline
de lignée factice, le BOM de repli factice, les valeurs par défaut
inventées, le bouton « Passeport DPP Public » hors contexte produit.

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `assets/design-system/tracefab-intel.css` | Styles `.pil-*` (onglets, lentilles, nœuds, résumé, historique), mobile + reduced-motion. |
| `scripts/_chantier07_intel_i18n.json` | Source unique des 63 clés × 7 langues. |
| `scripts/build_intel_i18n.mjs` | Générateur additif/idempotent borné au namespace `intel`. |
| `scripts/test_intel_chantier7.mjs` | Test de contrat (7 volets). |
| `brand-console/index.html` | Fiche produit restructurée + loader + export + état. |
| `package.json` | Script `test:intel:chantier7` ajouté à la chaîne `npm test`. |

## Contrats vérifiés (test_intel_chantier7.mjs)

1. Structure 11 lentilles + CSS + bascule d'onglets.
2. Données réelles : les 3 endpoints appelés, chargement parallèle
   tolérant, états vides explicites, 8 faux éléments vérifiés absents.
3. Les 6 actions produit présentes + export JSON réel + historique dérivé.
4. Aucune fonctionnalité supprimée : les 6 formulaires conservés, handlers
   intacts (dont révision).
5. Evidence annoncée honnêtement ; DPP confiné au vocabulaire de
   préparation.
6. i18n : 63 clés × 7 langues paritaires ; TR/ZH exclues (repli EN).
7. Générateur idempotent, garde de consolidation respectée.

## Non-régression

- Matrice hors-ligne : **24/26 suites PASS**, dont `test:brand-console`.
  Les 2 échecs (`test:wallet:chantier9`, `test:storage:chantier10`)
  proviennent de l'impossibilité de générer le client Prisma dans la
  sandbox — identiques sur le commit de base.
- `npm run test:i18n` vert ; syntaxe des scripts inline vérifiée.
- Aucune route API, migration ou schéma modifiés.

## Limitations connues

- La lentille Evidence est volontairement un panneau « à venir » : l'API de
  preuves par produit relève du chantier 08 (Evidence Center).
- Les certifications affichées sont au niveau organisation ; les certificats
  par produit ne sont pas encore enregistrés séparément en base.
- La maquette statique `product-intelligence/` reste une page de
  démonstration autonome (bannière démo explicite) ; elle sert de référence
  de design mais n'est pas branchée sur les APIs privées.

## Prochaine étape suggérée

Chantier 08 de la roadmap : **Evidence Center** (surface unifiée upload /
preview / métadonnées / liaisons / statuts de vérification / versions) —
à confirmer avec l'utilisateur.
