# Chantier 3 — la vue Risk de la console

_7 octobre 2026. Branche `merge/experience`._

## Pourquoi

Le cahier des charges fixe la navigation du tableau de bord :

> Overview, Products, Suppliers, Materials, Supply Chain, Data Collection,
> Evidence, Certifications, Quality, **Risk**, DPP, Reports, Settings

La console en livrait 16 entrées — mais pas celle-là. C'était le dernier P0
du relevé, et la seule exigence explicite du cahier des charges encore non
servie.

## Ce qui a été construit

La vue s'insère entre **Qualité** et **DPP**, à la place prévue par le cahier
des charges.

### Un principe : ne rien inventer

C'est la contrainte structurante. La vue n'importe aucune notation externe et
ne simule aucun chiffre : **chaque signal est dérivé des enregistrements déjà
chargés** dans la console — fournisseurs, produits, matières, demandes de
données.

| Dimension | Dérivée de |
|---|---|
| Concentration fournisseurs | part du pays le plus représenté dans la base |
| Exposition géographique | fournisseurs sans pays déclaré |
| Lacunes de données | produits sous le seuil de complétude (70 %) ou non validés |
| Retards de collecte | demandes échues, ou sous 50 % d'avancement |
| Origine non déclarée | matières sans pays d'origine |

Deux conséquences assumées :

- **une dimension sans enregistrement vaut zéro et l'affiche** (« aucun
  enregistrement ») au lieu d'afficher un score rassurant tiré de rien ;
- **seules les dimensions réellement alimentées entrent dans l'indice.**
  Moyenner un zéro issu d'une absence de données ferait baisser le score pour
  la mauvaise raison — on dirait « peu de risque » là où on ne sait rien.

Un encart « Comment ce score est calculé » expose cette mécanique dans la vue
elle-même, pas seulement dans cette documentation.

### Le registre des risques

Gravité (Critique / Fort / Moyen / Faible), catégorie, objet, signal, et —
conformément au principe retenu pour le Quality Center — **chaque ligne mène à
la vue où elle se corrige** : produit, fournisseur, matière ou demande.

### Jamais une certification

Votre règle constante s'applique ici de façon directe, puisqu'un « score de
risque » est précisément le genre d'indicateur qu'un lecteur pressé prend pour
une note officielle. Deux garde-fous :

- le chapô l'écarte explicitement : « indicateur opérationnel destiné à
  prioriser le travail — ni une certification, ni un résultat d'audit, ni une
  évaluation juridique » ;
- un badge **« Indicateur, pas une certification »** est posé dans l'en-tête.

Le test automatisé vérifie la présence des deux.

## Un second défaut corrigé au passage

En câblant la vue, j'ai constaté que **`intelligence` était déclarée dans la
navigation mais absente du dispatch** : cliquer sur « TRACEFAB Intelligence »
ne menait pas à `intelligenceView()`, mais retombait sur la branche par
défaut, `requestDetailView()`. La vue existait, complète, et n'était pas
atteignable.

Une ligne de dispatch a été ajoutée. Et pour que ce type d'oubli ne puisse
pas revenir, le test énumère désormais **toutes** les entrées de navigation et
exige que chacune ait sa branche.

## Un défaut de lecture corrigé avant livraison

La première version nommait deux barres « Fiabilité des données » et
« Traçabilité de l'origine ». Or ces barres mesurent l'**exposition** :
100 % signifie « totalement exposé ». Le libellé disait donc exactement
l'inverse de la valeur affichée — « Fiabilité des données : 100 % » se lisait
comme une excellente nouvelle alors qu'il signalait que tous les produits
portaient un signal. Renommées **« Lacunes de données »** et **« Origine non
déclarée »**, dans les sept langues.

## i18n

55 clés `console.risk*` × 7 langues, générées par
`scripts/build_risk_i18n.mjs` (idempotent, option `--check`). Aucune copie
métier en dur : le test isole le corps de `riskView()` et échoue si une phrase
y apparaît littéralement.

Le générateur a d'abord été écrit avec une regex d'idempotence construite par
interpolation ; une erreur d'échappement a cassé `en.js` à la deuxième
exécution. Il utilise désormais une recherche littérale des marqueurs — la
leçon est consignée dans le script lui-même.

## Vérifications

| Contrôle | Résultat |
|---|---|
| `test:chantier3-risk` (nouveau, câblé dans `build`) | 19 assertions, toutes vertes |
| Matrice de tests | **33 / 34** — seul `test:supplychain:chantier3` échoue, à l'identique sur `origin/main` |
| `typecheck`, `api:typecheck`, `schema:static` | OK |
| Navigateur, 6 langues | titre, entrée de nav et fil d'Ariane traduits |
| Erreurs console / page | aucune |
| Registre non vide en démo | 2 lignes, 2 actions cliquables qui mènent bien ailleurs |
| Responsive 390 × 844 | débordement horizontal 0 px, KPI en grille 2 × 2 |

Captures : `.visual/risk/{risk-en,risk-fr,risk-mobile}.png`.

## Reste à faire sur cette vue

- La vue lit `state`, alimenté par les API existantes. **Aucune route n'a été
  ajoutée** : il n'y a pas d'API `risk`, et en inventer une sortait du cadre
  du chantier. Si vous voulez des signaux que la console ne charge pas
  aujourd'hui (certificats expirants, scores PEF, `fraud_risk_score` du bilan
  massique — tous présents en base), c'est un chantier serveur à part entière.
- Les valeurs brutes de statut (`needs review`) s'affichent telles quelles,
  non traduites : ce sont des données, pas de la copie. À arbitrer avec le
  chantier 7.
