# Chantier 11 — Supply Chain Graph & Map

Statut : livré sur la branche `arena/df246958-tracefab`.
Date : 2026-10-08.

## Objectif (roadmap)

« Graphe zoom/pan/filtres, sélection de nœuds → dossier
fournisseur/evidence/qualité, carte géographique des sites et flux. »
Dépendance : 05.

## Point de départ (audit)

- Le backend était réel : `tracefab_get_product_traceability` (fonction
  SQL avec garde membre), route
  `GET /api/products/:id/supply-chain` (graphe, étapes groupées, résumé
  calculé), CRUD nœuds/liens, génération de chaîne de base, routes
  `traceability/*` (audit-chain, lineage-graph, mass-balance).
- `supplier_sites` porte **latitude/longitude**, mais le graphe ne les
  exposait nulle part (les champs `site_name/site_city` du type lib
  n'étaient jamais remplis).
- La vue Supply Chain de la console était **100 % simulée** : badge
  « ISO 22095 CERTIFIED CHAIN OF CUSTODY · 98.4% MASS RECONCILIATION »,
  7 échelons codés en dur (İzmir, Ege Birlik, Haute-Vienne, Barcelos,
  EcoDye, Atelier Braga, Hub Lyon), KPIs fictifs (7/7 étapes scellées,
  polygones GPS 100 %, couverture preuves 98.4 %), table de
  réconciliation massique inventée (volumes, rendements, TC), résumé de
  repli inventé (14 nœuds / 13 liens / 98 %) et bouton d'export factice.
  Le graphe réel chargé par `loadSupplyChain` n'était jamais affiché.

## Ce qui a été fait

### API : sites géographiques du graphe

`GET /api/products/:id/supply-chain/map` — pour chaque nœud du graphe
référençant un site fournisseur : site (nom, pays, ville, latitude,
longitude). Même garde que la route graphe (organisations de marque
actives + produit de la marque). Aucun repli inventé : un nœud sans site
ou un site sans coordonnées est simplement absent. **Aucune migration.**

### Brand Console : graphe, dossier, carte, étapes

`supplyChainView()` réécrite sur les données réelles :

- **Résumé réel** : nœuds, liens, taux de documentation et étapes
  couvertes calculés par le serveur (+ badge « chaîne complète » quand le
  moteur l'indique) ; état vide avec guidance (générer une base ou
  ajouter des nœuds).
- **Graphe SVG interactif** : disposition en colonnes par étape
  (`tier4→tier0` + autres), arêtes suivant les liens réels, coloration
  par type de nœud (matière/procédé/site/organisation/produit), opacité
  réduite pour les nœuds `declared`. **Zoom** (molette + boutons),
  **déplacement** (pointer drag), **filtres** par type et « documentés
  uniquement », réinitialisation de la vue, légende. Transformations
  appliquées directement sur le viewport SVG (fluidité sans re-rendu).
- **Sélection de nœud → dossier** : libellé, type, étape, statut,
  procédé, site, organisation fournisseur résolue, preuves sources (nœud
  + liens), métadonnées ; actions réelles : ouvrir dans l'Evidence
  Center, ouvrir le fournisseur, ouvrir la vue qualité du produit.
- **Carte géographique** : projection équirectangulaire SVG des sites
  avec coordonnées, **flux tracés suivant la séquence de la chaîne**,
  cadrage automatique sur l'emprise des sites, compteurs honnêtes
  (sites localisés, flux tracés, nœuds référençant un site sans
  coordonnées). Aucun fond de carte externe : zéro dépendance réseau.
- **Table d'étapes réelles** depuis `sc.stages` (nœuds par étape).
- **Export JSON réel** de la chaîne (produit, graphe, étapes, résumé,
  sites) en remplacement du bouton d'export factice.
- Sélection de produit obligatoire (plus de repli sur un produit
  inventé) ; chargement graphe + carte en `Promise.allSettled` (carte
  non bloquante) ; démo avec deux sites à coordonnées publiques
  (Barcelos, Guimarães).

### Styles

`assets/design-system/tracefab-supplychain.css` (préfixe `.scg-`) :
graphe, filtres, dossier, carte ; `prefers-reduced-motion` et
adaptation mobile (< 720 px).

### i18n

Namespace `supplyGraph` : **47 clés × 7 langues**, source
`scripts/_chantier11_supply_graph_i18n.json`, générateur
`scripts/build_supply_graph_i18n.mjs` (additif, idempotent, ancré au
niveau racine). FR intégralement couvert ; aucun texte métier en dur.

### Contrat statique

`scripts/test_supply_graph_chantier11.mjs` (6 volets, ~80
vérifications) : endpoint carte + registre, absence de tout le contenu
simulé (12 motifs), graphe/filtres/zoom/dossier/carte/étapes/états
vides/export, câblage (allSettled, dispatcher, wheel/pointer, sélection
clavier), parité i18n, idempotence du générateur, non-régression (routes
supply-chain/traceability, formulaires nœud/lien, lentille ch07, CSS).
Branché dans `npm test` (`test:supplygraph:chantier11`).

## Non-régression

- Routes supply-chain (graphe, nœuds, liens, génération de base) et
  traceability intactes ; formulaires d'ajout de nœud/lien conservés ;
  lentille Supply Chain du détail produit (ch07) inchangée.
- Aucune migration.
- Contrats des chantiers 07–10 toujours verts ; registre de routes et
  consolidation i18n OK.

## Limitations connues (documentées)

1. La carte est une projection SVG sans fond cartographique (pas de
   tuiles externes) : elle situe les sites et leurs flux, pas les
   frontières.
2. La disposition du graphe est déterministe par colonnes d'étapes (pas
   de moteur physique) ; suffisant pour les chaînes multi-tiers, à
   revisiter si des graphes très denses apparaissent.
3. Les nœuds `site` sans `supplier_site_id` (ou site sans coordonnées)
   n'apparaissent pas sur la carte — un compteur le signale.
4. Les flux de la carte relient les sites **consécutifs dans la
   séquence des liens** ; les liens sans ordre explicite sont triés en
   dernier.

## Tests

- `npm run test:supplygraph:chantier11` : OK (stable sur double
  exécution).
- `scripts/test_route_registry.mjs`, `npm run test:i18n` : OK.
- Matrice `npm test` : voir rapport — seuls les échecs préexistants liés
  à l'absence de client Prisma généré en sandbox demeurent.

## Reste à faire (chantiers suivants)

- Fond de carte optionnel (tuiles) si une dépendance externe est
  acceptée.
- Dossier étendu : historique des vérifications liées au nœud.
- TRACEFAB Intelligence (chantier 12) : moteur de questions sur ces
  données réelles.
