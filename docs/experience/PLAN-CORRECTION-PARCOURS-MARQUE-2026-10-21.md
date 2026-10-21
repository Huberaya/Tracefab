# Plan de correction — parcours client marque

Date : 2026-10-21  
Branche : `arena/af3266d9-tracefab`

## Ordre de traitement

1. **Terminologie et allégations** : supprimer en premier les formulations pouvant être comprises comme une conformité, une authenticité ou une détection de fraude acquise.
2. **Cohérence inter-écrans** : alimenter la vue d’ensemble avec les lectures réelles Qualité, PEF et Supply Chain.
3. **États vides et prérequis** : ne plus confondre absence connue, échec de chargement et valeur non calculée ; bloquer les actions impossibles.
4. **Localisation et métadonnées** : rendre les états de confiance, sources, méthodes et dates visibles.
5. **UX opérationnelle et gouvernance** : expliciter les cycles d’autorisation, les contrôles humains et les limites des surfaces encore indisponibles.

## Familles, composants et vérifications

| Famille | Composants et fichiers principaux | Vérifications de non-régression |
|---|---|---|
| 1 — Terminologie | `assets/js/brand-console.1.js`, `assets/i18n/en.js`, `assets/i18n/{fr,de,es,it,nl,pt}.json` | Contrat statique anti-allégations ; captures Vue d’ensemble, Traçabilité, Documents, Certifications, Questionnaires, Qualité |
| 2 — Cohérence | agrégats et `loadOverviewInsights()` dans `brand-console.1.js`, lecture PEF `api/_routes/products/[productId]/pef.ts` | Comparer complétude, indice qualité, preuves, avertissements, PEF et étapes entre Vue d’ensemble / Qualité / Risque |
| 3 — États vides | Documents, Certifications, Demandes, Rapports, Intégrations, modales Qualité | Tenant de recette sans fournisseur/certificat/document ; absence connue affichée à 0, échec de source affiché non calculé |
| 4 — Prérequis | Questionnaires, Demandes, Traçabilité, Bilan massique, CAP | Boutons désactivés sans fournisseur/certificat ; aucune mutation réseau au clic ; tooltip explicatif |
| 5 — Français | catalogues i18n et traduction conditionnelle des anomalies | `test:i18n`, changement de langue navigateur, message `product_missing_evidence` en français |
| 6 — Métadonnées | Traçabilité, Certifications, Demandes, Bilan massique, Intégrations, Rapports, PEF | Captures avec ordre/échelon, cycle de confiance, soldes TC, cycle connecteur, provenance export, méthode PEF |
| 7 — UX visuelle | CSS intégré `brand-console/index.html`, Bilan massique, Intégrations, Rapports | États désactivés perceptibles, navigation clavier, contraste, aperçu obligatoire |
| 8 — Gouvernance | Paramètres, Qualité/PEF, actions d’anomalie | Identifiant masqué, liens lecture seule, journalisation annoncée, confirmation avant acquittement/dérogation, avertissement PEF |

## Règles de validation croisée

- **Complétude** : provient de `dataCompletion`; elle ne doit jamais être étiquetée qualité ou vérification.
- **Indice qualité** : moyenne des dimensions réellement calculées par l’API Qualité ; les dimensions absentes restent non calculées.
- **Couverture de preuves** : provient de `documentationCoverage`; `product_missing_evidence` ouvert impose une valeur connue de 0 % lorsque l’API la fournit.
- **PEF** : une lecture GET est sans effet de bord ; seule l’action explicite de calcul écrit une évaluation. Une évaluation affichée reste provisoire et non réglementaire.
- **Risque** : les dimensions sans enregistrement sont exclues ; la dimension de complétude structurée ne doit pas être interprétée comme couverture de preuves.
- **Supply Chain** : étapes déclarées, fournisseurs connectés et sites contrôlés sont trois compteurs distincts.

## Preuves attendues avant fusion

- tests statiques Brand Console et contrat des 58 corrections ;
- parité stricte des catalogues EN/FR/DE/ES/IT/NL/PT ;
- empreintes d’assets exactes ;
- tests PEF, mass-balance, intégrations, supply-chain et qualité ;
- parcours navigateur réel en CI ;
- recette Production après déploiement, sans création de preuve, certification, fournisseur ou validation fictive.
