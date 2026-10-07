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
