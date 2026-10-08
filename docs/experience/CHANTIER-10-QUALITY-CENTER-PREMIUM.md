# Chantier 10 — Quality Center premium

Statut : livré sur la branche `arena/df246958-tracefab`.
Date : 2026-10-08.

## Objectif (roadmap)

« Score décomposé cliquable, drill-down par composante, « Resolve missing
data » partout, tendances. » Dépendance : 05.

## Point de départ (audit)

- Le moteur était réel : `tracefab_compute_product_quality` calcule quatre
  composantes (complétude, fraîcheur, couverture preuves, cohérence),
  remplit `missing_fields` / `blocking_issues` et **insère** un instantané
  dans `data_quality_scores` à chaque calcul (index `product_id,
  computed_at desc`) ; `GET/POST /api/quality/products/:id` expose score +
  anomalies ; acknowledge/waive/CAP fonctionnent.
- Le SPA `quality-center/` est réel (overview organisation, filtres,
  actions) — hors périmètre de réécriture.
- La vue Qualité de la Brand Console (`qualityView()`) était **100 %
  simulée** : « OVERALL GRADE: A (98.4%) » codé en dur, cinq piliers
  fictifs (96.8 / 92.0 / 88.5 / 94.2 / 88.0 %) dont une carte
  **« ESPR Conformity 88% »** (double violation : chiffre inventé et
  promesse de conformité), onglets de sévérité à compteurs fictifs
  (3/0/1/2/14) branchés sur une fonction `filterIssues` inexistante, trois
  anomalies fabriquées (RSL dye lot #089, GOTS CU-881294, polygone GPS de
  Barcelos). `state.quality` était chargé mais jamais affiché ; les
  renderers réels `scoreCard` / `issueCard` n'étaient appelés nulle part.

## Ce qui a été fait

### API : historique des scores (tendances)

`GET /api/quality/products/:id/history` — les 30 derniers instantanés de
`data_quality_scores` pour le produit (garde identique au score :
`accessibleProduct` / `tracefab_can_access_org`), retournés en ordre
chronologique croissant, sérialisation commune. **Aucune migration** :
l'historique existe déjà puisque chaque calcul insère une ligne.

### Brand Console : score décomposé, drill-down, tendances

`qualityView()` réécrite sur les données réelles uniquement :

- **Score décomposé cliquable** : les quatre composantes du moteur
  (valeurs réelles, barres de progression, métadonnées de calcul :
  date + version), plus un global explicitement étiqueté « moyenne
  dérivée ». État vide avec CTA de calcul.
- **Drill-down par composante** : un clic ouvre un panneau montrant les
  `missingFields` du score, les `blockingIssues`, et les anomalies liées
  (filtrage déterministe par composante : complétude → règles de
  complétude/profil ; fraîcheur → règles de péremption ; couverture
  preuves → règles de preuves/certificats ; cohérence → anomalies
  bloquantes).
- **« Resolve missing data » partout** : chaque champ manquant, chaque
  anomalie bloquante et chaque anomalie porte un bouton de résolution qui
  navigue vers la vue où la donnée peut réellement être corrigée
  (Evidence Center, certifications, demandes de données, fiche produit),
  selon un mappage déterministe du contenu de la règle.
- **Anomalies réelles** : rendues par le vrai `issueCard` (acquitter /
  déroger déjà câblés au dispatcher), avec filtres de sévérité à
  compteurs **calculés** depuis la liste réelle.
- **Tendances** : un panneau trace un instantané par barre (moyenne des
  quatre composantes, date, valeur) + delta depuis le premier instantané ;
  état vide explicite sous deux instantanés (« recalculez après
  correction pour construire la tendance ») — aucun lissage, aucune
  interpolation.
- Chargement : score + historique en `Promise.allSettled` (l'historique ne
  bloque pas la vue) ; le recalcul recharge l'historique ; le chemin démo
  fournit score, champs manquants, anomalies bloquantes et trois
  instantanés, et chaque recalcul de démonstration ajoute un instantané à
  la tendance (comme la fonction SQL en mode réel).

### i18n

Namespace `qualityPremium` : **35 clés × 7 langues**, source
`scripts/_chantier10_quality_premium_i18n.json`, générateur
`scripts/build_quality_premium_i18n.mjs` (additif, idempotent, ancré au
niveau racine). FR intégralement couvert ; aucun texte métier en dur.

### Contrat statique

`scripts/test_quality_chantier10.mjs` (6 volets, ~75 vérifications) :
endpoint historique + registre (spécificité avant la route produit),
absence de tout le contenu simulé de l'ancienne vue (13 motifs), présence
des composantes cliquables / drill-down / resolve / filtres réels /
tendances, câblage, parité i18n, idempotence du générateur,
non-régression (routes qualité, SPA Quality Center, acquitter/déroger).
Branché dans `npm test` (`test:quality:chantier10`).

## Non-régression

- Routes qualité intactes (overview, calculate-index, audit-pack,
  produits/fournisseurs, acknowledge/waive, CAP) ; SPA `quality-center/`
  inchangé ; recalcul réel et actions acquitter/déroger conservés.
- Aucune migration.
- Contrats des chantiers 07/08/09 toujours verts ; registre de routes et
  consolidation i18n OK.

## Limitations connues (documentées)

1. Les helpers `scoreCard` restent inutilisés (le panneau premium les
   remplace visuellement) ; ils demeurent dans le code, sans régression.
2. Le drill-down « fraîcheur » dépend des règles de péremption émises par
   le moteur ; si aucune règle de ce type n'est levée pour un produit, la
   section « anomalies liées » est vide — affiché comme tel.
3. La tendance montre la moyenne dérivée des quatre composantes ; le
   détail par composante est disponible dans l'historique API mais pas
   encore tracé composante par composante dans l'UI.
4. Le score global « moyenne dérivée » est un indicateur d'affichage, pas
   une valeur stockée par le moteur.

## Tests

- `npm run test:quality:chantier10` : OK (stable sur double exécution).
- `scripts/test_route_registry.mjs`, `npm run test:i18n` : OK.
- Matrice `npm test` : voir rapport — seuls les échecs préexistants liés
  à l'absence de client Prisma généré en sandbox demeurent.

## Reste à faire (chantiers suivants)

- Tracé de tendance par composante.
- Nettoyage des vues restantes encore partiellement simulées
  (Supply Chain — chantier 11, TRACEFAB Intelligence — chantier 12).
