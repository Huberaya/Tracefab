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

### Reste à faire

| Tranche | Cible | Chaînes |
|---|---|---:|
| 4b | Brand Console — Supply Chain (2 vues) | ~149 |
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
