# Chantier i18n des SPA — sortir la copie en dur

Dernière mise à jour : 7 octobre 2026. État de `main` : `ca07b1b`.

## Pourquoi ce chantier

Le cahier des charges impose une architecture i18n native, phase 1 en
EN/FR/DE/IT/ES/NL, et **aucune copie métier codée en dur dans les composants**.
La landing respecte cette règle (191 attributs `data-i18n`). Les trois SPA, non :
elles affichaient du français écrit en dur alors que leur langue par défaut est
l'anglais.

Le défaut était donc visible, pas théorique. Mesure au navigateur sur
`/brand-console/?lang=en` avant tout travail : **35 chaînes françaises** sur
l'écran d'accueil, dont le titre de page « Centre de Pilotage Opérationnel ».

## Inventaire mesuré

Comptage des nœuds texte et attributs visibles contenant du français :

| Surface | Occurrences | Chaînes uniques |
|---|---:|---:|
| `brand-console/index.html` | 435 | 410 |
| `supplier-portal/index.html` | 184 | 170 |
| `dpp/index.html` | 73 | 72 |
| `quality-center/index.html` | 0 | 0 |
| **Total** | **692** | **652** |

`quality-center/` est à zéro parce que c'est une ébauche de 73 lignes, pas
parce qu'elle est traduite.

## Deux règles de tri

Toute chaîne n'a pas vocation à devenir une clé.

1. **Interface** → clé dans le catalogue, 7 langues. Libellés, titres, boutons,
   en-têtes de colonne, messages d'état.
2. **Données de démonstration** → réécrites en anglais, sans clé. Elles
   représentent le contenu d'un client, pas l'interface ; les exemples du
   cahier des charges sont anglais (« Organic Cotton T-Shirt / AW26-0248 »,
   « Atelier Milano »). Les traduire en sept langues n'aurait aucun sens.

## Contrat technique

Le résolveur retombe déjà sur l'anglais quand une locale manque une clé :

```js
var active = bundle(current);
if (active && active[key] != null) return active[key];
var base = bundle(DEFAULT);          // socle EN
if (base && base[key] != null) return base[key];
return fallback != null ? fallback : '';
```

La dégradation est donc propre — jamais de clé brute à l'écran. Mais
`test_i18n_consolidation.mjs` exige la **parité stricte** : chaque locale doit
posséder toutes les clés de EN. D'où le découpage en tranches **complètes** :
une tranche livre ses clés dans les 7 catalogues à la fois, jamais à moitié.

Résolution côté console : `bt(key)` → `console.<key>` puis `shared.<key>`.
Le patron de nommage suit celui de la vue Risk, déjà traduite : préfixe de vue
puis rôle (`riskEyebrow`, `ovEyebrow`, `reportsViewLabel`).

## Avancement

### Fait — tranche 1 et 2 (`60d675a`, fusionné en `ca07b1b`)

48 clés × 7 langues.

- 30 clés pour la vue Overview
- 16 libellés de page de `viewLabel()` — le `h1` de chaque vue, dont seul
  `risk` passait déjà par `bt()`
- `signOut` et `dueDate`
- 3 titres de démonstration réécrits en anglais

Résultat mesuré sur `/brand-console/?lang=en` : **35 → 0**. Les `h1` résolvent
en anglais, allemand et néerlandais ; le français reste français ; 0 clé brute,
0 erreur console.

### Fait — tranche 3

57 clés × 7 langues + 6 chaînes de démonstration passées en anglais.
Vues Products, Suppliers, Materials et les deux vues de détail
(`productDetailView`, `supplierDetailView`). 72 remplacements : sept chaînes
apparaissaient dans plusieurs vues (« Statut » ×3, « Fournisseur » ×3) et sont
sorties partout d'un coup.

Mesuré sur les quatre vues, en anglais, allemand et espagnol : **0 chaîne
française résiduelle, 0 erreur JavaScript**.

### Fait — tranche 4a

84 clés × 7 langues + 17 chaînes de démonstration passées en anglais.
Couvre `requestsView`, `requestDetailView` et `questionnairesBuilderView` —
le parcours Data Collection du cahier des charges, avec ses états
Missing / Requested / Submitted / Under Review / Accepted / Rejected.

Mesuré sur les **six** vues désormais traitées, en anglais, allemand et
néerlandais : **0 chaîne française résiduelle, 0 erreur JavaScript**.

La vue Supply Chain est reportée en tranche 4b : 149 chaînes dont une forte
majorité de données de démonstration (noms d'usines, numéros de lot,
tonnages par échelon), qui relèvent de la réécriture en anglais et non du
catalogue.

### Fait — tranche 4b

64 clés × 7 langues + 35 chaînes de démonstration passées en anglais, pour
107 remplacements. Couvre `supplyChainView` et `supplyChainConsoleView`.

C'est la tranche où le tri interface / démonstration compte le plus : sur
147 chaînes, 83 étaient du contenu — tonnages par échelon, rendements,
étapes industrielles nommées. Les noms propres d'usines et de lieux
(Fiação Norte, Malhas do Ave, São Martinho, **Filature de Haute-Vienne**,
Tinturaria Braga) sont **volontairement conservés** : ce sont des raisons
sociales, pas de l'interface. Traduire « Filature de Haute-Vienne » serait
une faute.

Mesuré sur les **sept** vues traitées, en anglais, allemand et français :
0 chaîne française résiduelle hors noms propres, 0 erreur JavaScript.

Précaution ajoutée ici : toutes les substitutions visent le nœud texte
complet `>texte<`, jamais une sous-chaîne — sans quoi « Teinture » aurait
abîmé « 04. Teinture & Lavage Bio ».

### Reste à faire

| Tranche | Cible | Chaînes |
|---|---|---:|
| 5 | Brand Console — Documents, Certifications, Quality, DPP, Reports, Settings | ~130 |
| 6 | Supplier Portal | ~170 |
| 7 | DPP public | ~72 |

## Effet de bord découvert

`test_chantier5_console.mjs` était **rouge sur `main`** et n'était appelé par
**aucun script npm** : il ne gardait rien. Deux de ses ancres visaient des
libellés anglais disparus lors de la refonte (« Supply Chain Visualization »,
« Full Custody Mapping »).

Elles sont repointées sur l'implémentation elle-même — `function
supplyChainView`, `/lineage/i` — qui ne peut pas devenir obsolète sans que la
fonctionnalité disparaisse. Le test est désormais chaîné dans `build`.
La matrice passe de 40 à **41**.

Son assertion sur « Rapports & Audits » acceptait le français ou l'anglais ; le
libellé étant passé au catalogue, elle vérifie maintenant l'appel `bt()` **et**
la valeur anglaise dans `en.js`. Contrôle négatif effectué : clé cassée → test
rouge, code de sortie 1.

## Le piège de la tranche 3 : où atterrit `${bt('clé')}`

Le remplacement de `>texte<` par `>${bt('clé')}<` suppose que le nœud texte
vit dans un *template literal*. Quand il vit dans une chaîne en apostrophes
simples, l'apostrophe de la clé **referme la chaîne** et le fichier ne compile
plus. La console a un cas de ce type.

Une pré-étape générique par expression régulière a été écrite, puis
**abandonnée** : une regex ne peut pas distinguer une apostrophe qui ouvre un
littéral d'une qui le ferme. Elle a transformé `'in_progress'` en
`` 'in_progress` `` et `.join('')` en `` .join(`') ``, en silence.

La parade retenue tient en deux points :

1. une liste **explicite et vérifiée à la main** des littéraux à convertir en
   backticks avant remplacement ;
2. une **validation syntaxique du bloc `<script>` avant toute écriture** — le
   script extrait le bloc, le passe à `node --check`, et n'écrit rien s'il ne
   compile pas. C'est cette garde qui a nommé les clés fautives au lieu de
   laisser une console blanche.

Corollaire noté au passage : `repr()` en Python affiche `\'` pour une simple
apostrophe. Deux diagnostics ont été perdus à croire à des antislashs
parasites qui n'existaient pas. Vérifier les octets, pas la représentation.

## Précaution de méthode

Chaque tranche est appliquée par un script qui **assure chaque remplacement** et
n'écrit aucun fichier si une seule chaîne attendue est introuvable. La tranche 1
s'est arrêtée ainsi sur `Score de complétude` : le `<` littéral de
`Score de complétude < 80%` avait tronqué la capture initiale. Sans cette
garde, la chaîne serait restée en français sans que rien ne le signale.

## Fait — tranche 5a (Centre de Preuves + Centre de Qualité)

Vues couvertes : `documentsConsoleView`, `certificationsConsoleView`, `qualityView`.

- **57 clés d'interface × 7 langues** (préfixes `ev*` pour l'Evidence Center,
  `qc*` pour le Quality Center) et **19 chaînes de démonstration** réécrites en
  anglais. 81 remplacements. Catalogue : 1 038 → **1 089 clés**.
- La ligne du cahier des charges « Can you trust your data? » est désormais
  portée par la clé `qcTrustQuestion`, et le jeu de filtres
  CRITICAL / WARNING / REVIEW / RESOLVED par `qcCritical` … `qcResolved`.

### Noms propres préservés (règle 3 de la triade de tri)

Non traduits, dans aucune langue : CITEVE Portugal, Control Union
Certifications, EcoDye Aquitaine, Filature de Haute-Vienne, Intertek Ethical
Services, OEKO-TEX, Portugal Textile Mill, SGS Textile Testing Services,
SMETA Audit, TC GOTS, ZDHC Test. Idem pour les identifiants de règle en
SCREAMING_SNAKE (`CERTIFICATE_EXPIRATION_GATE`, `POLYGON_FACILITY_REGISTRY`,
`ZDHC_EFFLUENT_TEST_REPORT`), qui sont des clés techniques et non de la copie.

### Deux pièges rencontrés

1. **Apostrophes échappées.** Deux libellés de démonstration du questionnaire
   (`Rapport d\'essais laboratoire RSL`, `Rapport complet d\'audit social`)
   étaient invisibles à une recherche sur le texte nu : la source contient
   `d\'essais`. Toute recherche de français résiduel doit couvrir la forme
   échappée.
2. **Nœud de texte interpolé.** `Preuves documentaires actives & scellées
   (${docs.length})` ne pouvait pas être remplacé par le motif `>FR<` habituel,
   le nœud se terminant par une interpolation. Remplacement ciblé sur le
   fragment littéral seul.

### Vérifications

7 → **10 vues sur 17** propres. Sonde Playwright sur 10 vues × en/de/nl :
**0 résidu, 0 erreur JS**. Matrice **41/41**, build et `tsc --noEmit` verts,
personas **6/6 · 4/4 · 4/4**.

### Anomalie relevée, non corrigée ici

`certificationsConsoleView` affiche le texte littéral `certJours(c)` : un appel
de fonction rendu tel quel, vraisemblablement une interpolation `${…}`
manquante. Ce n'est pas une question de traduction ; laissé en l'état pour un
correctif dédié.

### Reste à faire

5b queue console (~94 chaînes : dpp 34, intelligence 17, reports 12,
integrations 10, massBalance 8, settings 8, shell 5) · 5c `modal()` (128) ·
tranche 6 portail fournisseur (~170) · tranche 7 DPP public (~72).

## Fait — tranche 5b (queue console)

Vues couvertes : `dppView`, `reportsConsoleView`, `settingsConsoleView`,
`intelligenceView`, `massBalanceConsoleView`, `integrationsView`, `shell`,
plus deux panneaux partagés découverts en route (`complianceContractPanel`,
`capContractPanel`) et le reliquat de tranches antérieures.

- **132 clés d'interface × 7 langues** (préfixes `dp*`, `rp*`, `st*`, `ia*`,
  `mb*`, `ig*`, `sh*`, plus des compléments `ov*`, `mt*`, `sc*`, `qc*`) et
  **18 chaînes de démonstration** anglicisées. 161 remplacements.
  Catalogue : 1 089 → **1 221 clés** (539 sous `console`).
- La ligne du cahier des charges « Aucune donnée inventée · réponses justifiées
  par des preuves » est portée par `iaNoInvented`, et l'avertissement « la
  préparation est un indicateur opérationnel, pas une certification » par
  `dpGapsIntro`.

### Correctif de fond : les fixtures suivaient la langue de démarrage

`demoData()` et `demoDpp()` ne sont **pas** rejoués au changement de langue
(le gestionnaire `tf:languagechange` appelle seulement `render()`). Y écrire un
`bt()` aurait figé les libellés dans la langue du chargement initial.

Les fixtures portent désormais une **clé** et non un texte — `nameKey`,
`descKey`, `labelKey` — résolue au rendu par `renderPillarCard()` et par la
liste des écarts. Les champs `name` / `description` / `label` restent prioritaires
quand ils viennent de l'API, donc le comportement en mode connecté est inchangé.
Vérifié en conditions réelles : bascule fr → en sur la vue DPP, les quatre
piliers *et* leurs items basculent.

### Anomalies trouvées, non corrigées ici

- **`dppConsoleView` est du code mort** : définie ligne 2519, jamais appelée.
  Le routeur utilise `dppView`. Elle porte ~34 chaînes françaises qui n'ont
  donc pas été traduites — les traduire aurait été du travail pur perte.
  À supprimer dans une passe de nettoyage dédiée.
- `certJours(c)` dans `certificationsConsoleView` (déjà signalé en 5a).

### Quatre pièges rencontrés

1. **Les noms de fonctions se devinent mal.** `reportsView`, `settingsView`,
   `massBalanceView` n'existent pas ; ce sont des `*ConsoleView`. Lister les
   définitions réelles avant d'extraire.
2. **L'échappement JSON de la sortie d'outil se cumule à celui de `repr()`.**
   Un `\"` affiché peut être un `"` nu dans le fichier. Vérifier sur les octets.
3. **Un backtick est interdit dans un fragment déjà inclus dans un template
   literal** : il fermerait le template. La conversion se fait par concaténation
   (`'<div>' + bt('cle') + '</div>'`), pas par passage en template.
4. **Le détecteur par accents est aveugle au français sans accent.**
   `Conforme`, `Manquant`, `Score Global DPP`, `Bloquant` sont passés au travers
   de trois sondes successives.

### Vérifications

10 → **17 vues sur 17** propres. Sonde stricte (tout caractère accentué est
suspect) en anglais sur les 17 vues : **2 résidus, tous deux des noms propres**
(`İzmir, Türkiye`, `Filature du Sud-Ouest`), **0 erreur JS**. En français,
1 522 chaînes accentuées et **0 clé brute affichée**. Matrice **41/41**, build et
`tsc --noEmit` verts, personas **6/6 · 4/4 · 4/4**.

### Cinq tests repointés

`test_pef_chantier3`, `test_green_claims_chantier4`,
`test_plm_erp_gs1_chantier2`, `test_mass_balance_chantier7` verrouillaient la
copie française en dur ; `test_chantier4_demo` comptait un champ `label:`
renommé en `labelKey:`. Chaque assertion vise maintenant la clé **et** vérifie
que la valeur française est toujours au catalogue — une garantie plus forte
qu'avant. Contrôle négatif effectué : vider la clé fait bien rougir le test.

### Reste à faire

5c `modal()` (128 chaînes, la plus grosse fonction du fichier) · tranche 6
portail fournisseur (~170) · tranche 7 DPP public (~72).

## Fait — tranche 5c (modal) — chantier SPA console terminé

`modal()` et ses 12 branches : `new-product`, `supplier-import`,
`catalog-import`, `invite-supplier`, `new-questionnaire`, `new-request`,
`new-chain-node`, `new-chain-link`, `create-cap`, `review-cap`, `cap-message`,
`waive-issue`. Plus les quatre helpers d'aperçu d'import
(`supplierImportPreview`, `catalogImportPreview`, `previewSupplierImport`,
`previewCatalogImport`) et les deux générateurs de démonstration associés.

- **123 clés d'interface × 7 langues** (préfixe `md*`) et **3 chaînes de
  démonstration** anglicisées. 149 remplacements.
  Catalogue : 1 221 → **1 344 clés** (662 sous `console`).
- Les libellés de procédés textiles conservent leur terme anglais entre
  parenthèses dans toutes les langues — `Filature (Spinning)`,
  `Teinture (Dyeing)`, `Ennoblissement (Finishing)` — parce que la valeur
  entre parenthèses est l'identifiant métier, pas de la copie.
  Même logique pour les types de relation : `Étape suivante (next_step)`.

### Le périmètre annoncé était faux, dans les deux sens

L'estimation de 128 chaînes venait d'un motif d'extraction trop lâche. Le
premier passage n'en trouvait que 68 — parce que mon détecteur reposait sur les
accents et les mots-outils français. Un second balayage, sans filtre
linguistique, a révélé **57 chaînes de plus** : `Nom`, `Pays`, `Titre`,
`Annuler`, `Verdict`, `Approuver`, `Instructions`, toute la liste des procédés
textiles. Le total réel est 123.

### Vérification : les modales ne s'affichent pas toutes seules

Une sonde qui se contente de charger les vues ne voit **aucune** modale. La
console expose `window.state` et `window.render` : la sonde force
`state.modal = '<branche>'` puis rappelle `render()`, pour les 12 branches, et
simule en plus les deux états d'aperçu d'import (avec erreurs, puis sans) afin
d'atteindre les branches conditionnelles `À corriger` / `Aucune erreur`.

### Vérifications

17 vues + 12 modales, sonde stricte en anglais : **2 résidus, tous deux des
noms propres** (`İzmir, Türkiye`, `Filature du Sud-Ouest`), **0 erreur JS**.
En français, 33 chaînes accentuées dans les modales et **0 clé brute affichée**.
Matrice **41/41**, build et `tsc --noEmit` verts, personas **6/6 · 4/4 · 4/4**.

`test_collection_bridge_chantier2` verrouillait `Produit associé` en dur :
repointé sur `bt('mdLinkedProduct')` avec vérification que la copie française
reste au catalogue, et contrôle négatif effectué.

### État du chantier SPA console

**Terminé.** 17 vues sur 17 et les 12 modales sont exemptes de copie codée en
dur. Restent les deux chantiers hors console : tranche 6 portail fournisseur
(~170 chaînes) et tranche 7 DPP public (~72).

### Dette signalée, non traitée

- `dppConsoleView` : code mort, ~34 chaînes françaises, jamais appelée.
- `certJours(c)` : interpolation manquante dans `certificationsConsoleView`.

Les deux méritent une passe de nettoyage dédiée, sans rapport avec l'i18n.

## Fait — tranche 6a (portail fournisseur, premier bloc)

Périmètre : chargement/erreur, page d'authentification, création d'entreprise,
tableau de bord d'accueil, profil, sites, certificats. Les vues matières,
données structurées, équipe, coffre de preuves, partage/passeport, TC &
bilan massique, CAP, qualité et détail de demande restent pour la 6b.

**129 clés × 9 langues** dans la racine `portal` (préfixe `sp*`, distinct du
`sp*` de la racine `console`) : 107 au premier passage, 21 à la finition,
plus `spOpenRequests`. La racine `portal` passe de 38 à 167 clés.
**5 chaînes de démonstration** réécrites en anglais.

### Deux bugs réels trouvés et corrigés

1. **La navigation du tableau de bord était morte.** L'application vit dans une
   IIFE, mais six attributs `onclick="state.view='…';render()"` s'évaluent dans
   la portée globale : chaque clic jetait `ReferenceError: state is not defined`.
   Les quatre tuiles d'action, le bouton du panneau de progression et les
   pastilles ne menaient nulle part. Corrigé par `window.goView = goView`, au
   même endroit et selon le même idiome que le `window.handleBomImportSubmit`
   déjà présent dans le fichier.
2. **La modale d'import BOM ne pouvait pas s'ouvrir.** `openBomModal()` était
   cité dans un `onclick` mais n'existait nulle part. Écrite
   (`state.modal = 'import-bom'; render();`) et exposée.

Le test `test_chantier5_portail_mobile.mjs` épinglait littéralement le motif
cassé ; il est repointé sur `goView` et reçoit une assertion supplémentaire
vérifiant que le gestionnaire est joignable depuis la portée globale.

### Les tests navigateur étaient rouges sur `main` et personne ne le voyait

La commande de matrice exclut `*:browser`. Vérification faite dans un worktree
isolé sur `origin/main` : `test:brand-console:browser` et
`test:quality-center:browser` étaient **déjà en échec avant cette tranche**,
cassés par les tranches 5a–5c. Ils épinglaient des libellés français devenus
anglais. Réparés ici :

- `brand-console`, `quality-center`, `supplier-portal` naviguent désormais avec
  `?demo=1&lang=fr`, ce qui conserve les assertions françaises **et** teste la
  locale FR de bout en bout ;
- deux assertions portaient sur des données de démonstration anglicisées
  (`Essentiel coton` → `Cotton Essential`, `Données produit — collection
  automne` → `Product data — autumn collection`) : repointées sur le libellé
  anglais, car une fixture sans clé est insensible à la locale.

**Désormais, exécuter la matrice sans `--include browser` ne suffit plus.**
La commande de vérification retire le filtre `browser` : 45 tests au lieu de 41.

### Vérifications

- 45 tests verts (41 matrice + 4 navigateur), `npm run build` OK, `tsc --noEmit` OK.
- Sonde Playwright, portail en anglais, 13 vues : **0 résiduel français sur les
  vues 6a**, 0 `pageerror`. Les 65 résiduels restants sont tous dans le
  périmètre 6b.
- Les quatre tuiles d'accueil mènent bien à `profile`, `sites`,
  `certifications`, `documents`.
- Contrôle FR : `Vue d'ensemble` / `Demandes ouvertes` rendus. Contrôle TR :
  `Genel bakış` / `Açık talepler`.
- Personas CEO 6/6, Conformité 4/4, Fournisseur 4/4.

### Pièges rencontrés

- **Le détecteur d'accents a encore sous-compté de moitié.** `Certificats`,
  `Demandes ouvertes`, `Mon profil`, `Sites de production`, `Vue d'ensemble` ne
  portent aucune lettre accentuée. Seul le dump non filtré des chaînes rendues
  les a sortis.
- **Une matrice lue au `grep` ment.** Les tests écrivent « ECHEC », pas
  « fail » ; `test:i18n` était rouge et comptabilisé vert. Ne juger qu'au code
  de sortie.
- **`tr` et `zh` exigent la racine `portal`**, pas seulement `shared`. Toute
  clé portail part donc en **9 langues**, pas 7.
- **Une clé peut exister dans la mauvaise racine.** `spOpenRequests` vivait
  dans `console` ; le portail aurait affiché la clé brute. Vérifier la racine,
  pas seulement la présence.
- **`\"` dans une chaîne de remplacement Python s'écrit littéralement.** Six
  `onclick` ont reçu des contre-obliques parasites, inoffensives dans un
  littéral gabarit mais invisibles au test. Compter les `\"` avant/après.

## Fait — tranche 6b (portail fournisseur, second bloc)

Périmètre : matières, données structurées, équipe & accès, coffre de preuves,
partage/passeport, bilan massique & TC, CAP, Quality Center, détail de demande,
modale d'import BOM. **Le portail est terminé : 13/13 vues + la modale.**

**211 clés × 9 langues** (109 au bloc 1, 102 au bloc 2) : la racine `portal`
passe de 167 à **378 clés**. Sept chaînes de démonstration anglicisées.

### Ce que l'extraction a appris

Le dump du DOM ne suffisait pas. Trois filets successifs ont été nécessaires,
chacun rattrapant ce que le précédent laissait filer :

1. **DOM rendu** (212 chaînes) — rate tout ce qui vit dans une branche non
   affichée en mode démonstration.
2. **Nœuds et attributs de la source** (145 chaînes) — rate les littéraux JS.
3. **Littéraux JS cités** (67 chaînes, dont **42 inédites**) — c'est là que se
   cachaient les 26 `notify()` en dur, le ternaire
   `canManage ? 'Gestion autorisée' : 'Lecture seule'` et les valeurs de repli
   du type `'Ville non renseignée'`.

S'arrêter au premier filet aurait laissé près d'un tiers du portail en français.

### Trois pièges de remplacement

- **Le repli « texte nu » a frappé une chaîne JS dans un ternaire**, produisant
  `'${t('spMgmtAllowed')}'` — syntaxiquement mort. `node --check` a bloqué avant
  toute écriture. Les chaînes citées se remplacent entières
  (`'FR'` → `t('cle')`), jamais par injection de `${}`.
- **Les mots courts (`Nom`, `Date`, `Actif`, `Autre`) ont leur propre mode
  strict** : uniquement `>texte<` et `"texte"`, jamais le repli texte nu, qui
  frapperait un identifiant JS homonyme.
- **Un emoji ou un préfixe littéral doit rester hors de la clé** :
  `'✓ Conforme ESPR (100%)'` devient `'✓ ' + t('spEsprOk')`.

### Un résidu de la tranche 6a réparé

La 6a avait coupé « Aucune preuve privée » en `t('spNoEvidence') + ' privée'`,
ce qui affichait **« No evidence privée »** en anglais. La branche n'était pas
rendue en mode démonstration, donc la sonde DOM ne pouvait pas la voir : c'est
l'extraction en source qui l'a sortie. Remplacé par `spNoPrivateEvidence`.

### Format CSV de l'import BOM

Le format documenté est passé en anglais
(`Material; Percentage; Type; Country; Standard; LicenseNumber; SupplierBatch`).
Vérifié dans `api/_lib/bom-importer.ts` l.57-63 : `findColIndex` compare en
`includes` sur une liste d'alias qui contient déjà les termes anglais. Le
contrat serveur est donc intact.

### Quatre tests repointés

`test_quality_cap_chantier5.mjs`, `test_universal_passport_chantier6.mjs` et
`test_p1_bom_importer.mjs` épinglaient de la copie française du balisage.
Chacun reçoit les deux assertions habituelles — le balisage appelle `t('<clé>')`
**et** `fr.json portal.<clé>` conserve le libellé d'origine — validées par
contrôle négatif. Les deux premiers utilisent l'idiome `fs`/`path` synchrone du
fichier hôte, pas `readFile`.

### Vérifications

- 45 tests verts · `npm run build` OK · `tsc --noEmit` OK
- Sonde Playwright, portail en anglais, 13 vues + détail de demande + modale
  BOM : **307 chaînes rendues, 0 résiduel français**, 0 `pageerror`.
- Contrôles de locale : FR `Équipe fournisseur` / `Lecteur`, DE `Lieferantenteam`
  / `Leser`, ZH `供应商团队` / `查看者`.
- Personas CEO 6/6 · Conformité 4/4 · Fournisseur 4/4.

---

## Fait — tranche 7 : le DPP public

Dernière surface non internationalisée. Le passeport public passe de
**10 clés `dpp`, dont une seule réellement lue**, à **122 clés × 7 langues**,
et le balisage bascule en anglais source comme le reste du site.

### Ce qui a été corrigé avant de traduire

**Deux onglets morts.** 74 lignes de balisage (`#panel-circularity`,
`#panel-gs1`) étaient placées **après `</html>`**. Le navigateur les
rapatrie dans `<body>`, si bien qu'une sonde DOM les voyait présentes —
mais le script de commutation s'exécute pendant l'analyse du document et
recevait `null`, que le garde `if (panels[k])` avalait en silence. Cliquer
ces deux onglets ne faisait rien, sans la moindre erreur. Bloc déplacé
après `</section>` de `#panel-evidence` ; les 6 onglets répondent.

**`scripts/e2e_audit.py` échouait déjà sur 3 fichiers sur 4** avant cette
tranche — séquelle des tranches 4 à 6, invisible car l'audit n'est câblé
dans aucun script npm. Marqueurs repointés sur des identifiants et des
clés plutôt que sur de la copie, donc indépendants de la langue : 4/4.

### Internationalisation

Les clés sont ajoutées dans la table `T` de `scripts/build_dpp_i18n.mjs`,
qui **possède** la portée `dpp` : il efface par expression régulière la
région `// --- DPP public ---` de `en.js` et réécrit la racine `dpp` de
chaque JSON. Éditer le catalogue à la main serait effacé au build suivant.

Trois cas ont demandé un traitement particulier :

- **Nœud texte voisin d'une icône.** `applyTo()` écrit `textContent` :
  poser `data-i18n` sur `.badge-eu` ou `#btn-view-raw` aurait supprimé leur
  `<svg>`. Le fragment traduisible est enveloppé dans un `<span>`.
- **Le badge appartient au JavaScript.** `renderDppLang` réécrit
  `.badge-eu` en `innerHTML` à chaque rendu : le `<span data-i18n>` qu'on y
  avait posé était détruit dès le chargement. Vérifié à la sonde
  (`spans data-i18n: 0`). Le balisage n'y garde qu'un texte anglais de
  peinture pré-JS.
- **Entité HTML dans le catalogue.** La source portait
  `Méthodologie Loi AGEC &amp; ESPR`. Stockée telle quelle, l'entité se
  serait affichée littéralement, puisque le catalogue contient du texte et
  non du balisage. Ramenée à `&`.

La charge utile JSON-LD CIRPASS, lisible par les douanes et les auditeurs
CSRD, est de la donnée de démonstration : passée en anglais sans clé.

### Deux défauts de fond trouvés en chemin

**Le garde-fou « préparation ≠ certification » était contourné.** Le test
`test_pef_chantier3.mjs` interdit `DPP Conforme|DPP Compliant|certifié ESPR`
dans `dpp/index.html` depuis le 7 octobre. Mais la copie vit désormais dans
le catalogue : la clé `badgeEu` rendait **« EU ESPR / DPP Compliant »** à
l'écran pendant que le fichier HTML, lui, passait le test. Le libellé est
reformulé sur les 7 langues (« EU ESPR / DPP format »), et l'assertion
balaie maintenant les 7 catalogues clé par clé, pas seulement le balisage.

**Le DPP public n'avait aucune `@media`.** C'est pourtant la page la plus
certainement consultée au téléphone : on l'atteint en scannant le QR cousu
sur l'étiquette. Les six onglets, en `flex:1`, ont `min-width:auto` par
défaut et ne peuvent pas se comprimer sous la largeur de leur libellé ; ils
poussaient le document hors cadre — **20 px en français déjà**, 29 px en
anglais, 133 px en allemand. La barre d'onglets défile désormais à la place
de la page, et l'en-tête passe sur deux rangées sous 520 px. Mesuré à 0 px
de débordement sur 360 / 390 / 768 / 1440 px × 7 langues.

### Leçon de méthode

La première passe cherchait le français par accents et mots-outils. Elle a
laissé passer tout ce qui n'en comporte pas — « Composition totale »,
« Substances Chimiques », « Valide 2027 » — soit **32 chaînes sur 112**,
révélées par une capture d'écran en allemand. Le filet correct est
l'inverse : énumérer chaque nœud texte visible et retenir ceux qu'**aucune
clé ne couvre**, puis trier à la main. Un détecteur de langue est un
raccourci ; l'inventaire de couverture est une preuve.

Corollaire déjà rencontré : une table de remplacement dédoublonnée ne
remplace que la **première** occurrence. `100% fibres naturelles
biodégradables.` apparaissait dans deux panneaux ; le second est resté
français jusqu'au contrôle de comptage.

### Vérifications

- 6 onglets testés au clic, `display` calculé — un panneau visible chacun.
- 162 nœuds texte distincts, **50 sans clé**, tous légitimes : noms propres
  (Fiação Norte Lda, Quinta de São Martinho), identifiants, emoji, nombres.
- 7 langues résolues sur le corps, le `<title>`, `meta[name=description]`,
  `og:description` et l'attribut `title` du badge. 0 `pageerror`.
- Tests repointés avec contrôle négatif prouvé : `test_pef_chantier3.mjs`
  (`impEcoScore`, `impMethod`, `badgeEu` sur 7 catalogues),
  `scripts/e2e_audit.py` (`dpp.metaTitle`, `dpp.cirIndex`).
- Barrière : **45/45**, `build` OK, `tsc --noEmit` OK, `e2e_audit.py` 4/4,
  personas 6/6 · 4/4 · 4/4.

### Reste à traiter

Hors périmètre de cette tranche, inchangé : `dppConsoleView` est du code
mort (~34 chaînes françaises) et mérite une suppression plutôt qu'une
traduction ; `certificationsConsoleView` affiche `certJours(c)` en
littéral ; les fixtures `Coton biologique` de la console restent françaises.

---

## Fait — tranche 8 : solde de la Brand Console

La console était réputée traduite depuis la tranche 5 : 662 clés, et les
sondes d'alors ne signalaient rien. Elle comptait pourtant encore **178
chaînes françaises hors `bt()`**. La racine `console` passe à **780 clés ×
7 langues**.

### Pourquoi la tranche 5 ne les avait pas vues

Les sondes précédentes cherchaient du français **dans le rendu**, avec un
détecteur par accents et mots-outils — la même faiblesse qu'en tranche 7.
Deux angles morts s'y ajoutaient :

- les **toasts** `notify()` ne s'affichent qu'après une action, donc jamais
  pendant un parcours de lecture ;
- l'**écran d'authentification** et l'écran de chargement ne s'affichent pas
  en mode démonstration.

Le filet employé ici est l'analyse statique de la source : neutraliser les
appels `bt('…')` (ce sont des identifiants, pas de la copie), puis lister
tout littéral et tout texte de gabarit restant. Ce filet ne dépend ni du
parcours, ni de l'état de l'application.

Un second filet, utile et bon marché, consiste à **comparer le rendu EN et
le rendu FR** : toute ligne identique dans les deux est soit un nom propre,
soit du texte non câblé. Il a sa propre lacune — une ligne *partiellement*
traduite diffère entre les deux et y échappe — ce qui confirme qu'aucun
filet unique ne suffit.

### Travail effectué

1. **`dppConsoleView` supprimée** (79 lignes). Aucune branche du routeur ne
   l'appelait — `state.view === 'dpp'` rend `dppView()`. Elle portait 34
   chaînes françaises qu'on aurait traduites pour rien.
2. **30 fixtures passées en anglais** (règle 2 : une donnée de démonstration
   n'est pas de la copie d'interface). Les noms propres restent intacts :
   Fiação Norte Lda, Nhãn Textile Confeção, Quinta de São Martinho, CITEVE,
   Control Union, Hohenstein.
3. **44 toasts câblés** sur `notify(bt('cnN*'))`. Ils ne suivaient pas tous
   la même forme — `notify('x')`, `notify('x', true)`,
   `notify(cond ? 'a' : 'b')`, affectation à `reviewerNote` — ce qui a imposé
   de remplacer le **littéral quoté** lui-même plutôt que l'appel.
4. **74 clés de chrome** : écrans d'authentification et de chargement,
   introductions de vue, états vides, groupes de formulaire, aides de
   saisie, fragments de phrase interpolés.
5. **4 libellés de fixture** `Rang 1..4` anglicisés ; ils échappaient au
   filet parce qu'ils encodaient le tiret en `\u2014`.

### Le piège qui a cassé la page

Deux chaînes visées vivaient dans des littéraux **simple-quotés**, pas dans
des gabarits. Y injecter `${esc(bt('clé'))}` produit du texte inerte *et*
referme la chaîne sur l'apostrophe de la clé : `SyntaxError`. Le garde
`node --check` sur le plus long `<script>` l'a arrêté net — mais après
écriture, car la vérification suivait l'enregistrement. Les deux chaînes ont
été converties en gabarits.

Variante du même piège dans le `<head>` : `content="${esc(bt('cnMetaDesc'))}"`
ne s'interpole pas, le `<head>` est du HTML statique. La `meta description`
utilise donc `data-i18n-attr="content:console.cnMetaDesc"`, comme le DPP.

### Une assertion qui passait pour la mauvaise raison

`test_supply_chain_chantier3.mjs` vérifiait que la console nomme l'étape
« Matières ». Le mot n'existait dans le fichier que par
« Matières & Traçabilité », un intitulé de groupe de formulaire sans rapport
avec la chaîne d'approvisionnement. Le test passait par coïncidence. Il
vérifie désormais la clé `bt('materials')` et la copie française au
catalogue — contrôle négatif prouvé.

### Vérifications

- **0 fuite de gabarit** dans le rendu des 17 vues (`${`, `bt(`, `esc(`,
  `undefined`, `[object Object]`).
- **0 ligne française dans le rendu anglais**, fragments interpolés inclus.
- 7 langues résolues, `meta description` comprise. 0 `pageerror`.
- 3 tests repointés, 2 avec contrôle négatif prouvé ;
  `test_brand_console_browser.mjs` suivait une fixture anglicisée.
- Barrière : **45/45**, `build` OK, `tsc --noEmit` OK, `e2e_audit.py` 4/4,
  personas 6/6 · 4/4 · 4/4.

### Reste à traiter

`quality-center/` est un gabarit de 73 lignes sans sélecteur de langue ;
`passport/` et `operations/` sont orphelins ; `tsx` manque en dépendance de
développement (8 scripts) ; les phases 9 à 12 n'ont pas de rapport dédié.

---

## Tranche 9 — `quality-center`, `operations`, `passport`, `tsx`

### Deux diagnostics du backlog étaient faux

La tranche 8 laissait trois constats. L'audit préalable en a invalidé deux.

« `quality-center/` est un gabarit de 73 lignes » : le fichier fait bien
73 lignes, mais **16 475 octets**. Le CSS et le JS y sont quasi minifiés sur
des lignes très longues. C'est une page complète, pas une ébauche. Pour
dimensionner ces coquilles, `wc -c`, jamais `wc -l`.

« `passport/` et `operations/` sont orphelins » : les deux sont servis par des
routes enregistrées dans `api/index.ts`
(`api/_routes/passport/[tokenOrSlug].ts`, `api/_routes/operations/overview.ts`)
et couverts par des tests. Les supprimer aurait cassé des points d'entrée
vivants. **Avant de déclarer une coquille HTML morte, chercher les références
entrantes dans `api/_routes/` et `scripts/`.**

La dette réelle n'était donc pas l'orphelinat mais l'i18n :

| page | octets | `<html lang>` | `tf-i18n` | sélecteur | `fr-FR` figé |
|---|---|---|---|---|---|
| `quality-center/` | 16 475 | `fr` | oui | **aucun** | 1 |
| `passport/` | 27 781 | `fr` | **non** | aucun | 1 |
| `operations/` | 7 820 | `fr` | **non** | aucun | 1 |

### `quality-center/` — une page qui lisait le catalogue sans pouvoir en changer

La page résolvait déjà `quality.*` (44 clés) et se re-rendait sur
`tf:languagechange`. Il lui manquait le moyen de déclencher ce changement :
elle héritait passivement d'un choix fait ailleurs. Un sélecteur a été ajouté
dans l'emplacement `.actions` de la barre supérieure, sur le modèle de
`#dpp-lang-select`. `<html lang>` passe à `en` et `num()` suit la locale
active au lieu de `toLocaleString('fr-FR')`.

Une ligne posant `documentElement.lang` à la main a été retirée : `tf-i18n`
le fait déjà dans `applyDocumentMeta()` à chaque `setLanguage`. Dupliquer
cette responsabilité n'apportait rien.

### `operations/` — un script mort depuis des mois

La page chargeait `<script src="/auto-translate.js">`. **Ce fichier n'existe
pas** : la requête renvoyait `HTTP 404` à chaque visite. Le réécriveur
historique avait été retiré du dépôt sans que la balise suive. Un
`grep -c 'auto-translate.js'` ne suffit pas à trancher — sur
`quality-center` le même compte valait 1, mais pour un simple commentaire de
suppression. Il faut `grep -n 'script src=.*auto-translate'`.

La balise morte a été remplacée par la vraie pile : `TF_I18N_SKIP_META`,
`/assets/i18n/en.js`, `/assets/js/tf-i18n.js`. Une racine **`ops`** de
28 clés couvre les 7 langues, la `meta description` comprise via
`data-i18n-attr`. Date d'exécution localisée, sélecteur dans la barre de
navigation.

### Un écouteur sur la mauvaise cible

Premier essai sur `operations/` : la `meta description` se traduisait, le
corps de page restait anglais. `tf-i18n` émet
`document.dispatchEvent(new CustomEvent('tf:languagechange', …))`, et un
`CustomEvent` ne remonte pas par défaut. Un `addEventListener` nu dans une
IIFE s'attache à `window` : il n'a jamais vu l'événement. Les autres pages
écrivent `document.addEventListener` — la nuance est invisible à la relecture.
**Écouter sur `document`, pas sur `window`.**

### `passport/` — 59 clés, de zéro

788 lignes sans aucune couverture : balisage statique, en-tête Open Graph,
quatre KPI, bannière secret d'affaires, trois cartes, barre collante et
modale de demande d'accès NDA. Une racine **`passport`** de 59 clés en
7 langues. Les données de démonstration (noms de sites, matières, résumé
d'entreprise, base légale) sont passées à l'anglais sans clé, selon la règle
de tri en vigueur ; `Nhãn Textile`, `GOTS`, `OEKO-TEX`, `CITEVE`, `Intertek`
et `Control Union` restent intacts.

Deux assertions de `test_universal_passport_chantier6.mjs` portaient sur la
copie française en dur. Repointées sur le couple clé + catalogue, **contrôle
négatif prouvé** : en sabotant `fr.json`, le test échoue bien.

### Un débordement mobile antérieur à la tranche

`quality-center` débordait de **346 px** à 390 px de large. Vérification faite
sur la version `HEAD` : le défaut préexistait, la tranche ne l'avait pas
introduit. Cause : `table{min-width:680px}` dans une piste de grille `1fr`,
dont le minimum implicite vaut `auto`. La carte s'élargissait à la table au
lieu de laisser `.table-wrap` défiler. Corrigé par
`grid-template-columns:minmax(0,1fr)` et `min-width:0` sur les enfants, en
couche responsive **en dernier** dans le `<style>`. Débord nul de 390 à
1280 px, table défilante en dessous de 900 px.

### `tsx` — une dépendance téléchargée à chaque exécution

`npx --no-install tsx --version` échouait : `tsx` n'était dans aucun
`package.json`. Les 8 scripts qui l'invoquent téléchargeaient donc une
version non épinglée depuis le registre **à chaque exécution** — lenteur,
dépendance réseau, et aucune garantie de reproductibilité. `tsx@^4.23.15`
ajouté en `devDependencies`. Les 5 scripts non-Neon s'exécutent désormais en
717 à 1 020 ms. Les 3 variantes `test:neon:*` échouent toujours faute de
connexion Neon, ce qui est attendu et inchangé.

### Vérifications

- **0 débordement horizontal** sur les 3 pages, de 390 à 1280 px.
- **0 fuite de gabarit** et **0 `pageerror`** sur les 3 pages, 7 langues.
- `/auto-translate.js` : plus aucune requête en échec.
- Catalogues portés à **21 racines** ; `ops` 28 clés et `passport` 59 clés
  complètes sur les 7 langues.
- 2 assertions repointées, contrôle négatif prouvé.
- Barrière : **45/45**, `build` OK, `tsc --noEmit` OK, `e2e_audit.py` 4/4,
  personas 6/6 · 4/4 · 4/4.

### Reste à traiter

`passport/` utilise encore une identité visuelle distincte du système de
design (Plus Jakarta Sans, accent bleu `#2563eb`) : la page est antérieure à
la refonte et n'a pas été restylée, car cela relève d'une décision de design
à valider. Les phases 9 à 12 n'ont toujours pas de rapport dédié. Restent
aussi deux polices d'affichage à arbitrer, 27 cibles tactiles sous 40 px et
10 clés `portal` non référencées.
