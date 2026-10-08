# Élagage de `tracefab-console.css`

Dernière des deux dettes annoncées à la fin de la PR #23. La feuille pesait
49 909 o pour 379 règles. Elle en fait 29 395 pour 185. Le rendu n'a pas bougé
d'un pixel, et la vérification de cette phrase occupe l'essentiel de ce
rapport.

---

## 1. Ce que la feuille était vraiment

Le nom disait « console ». Le chargement disait autre chose :

```
grep -l tracefab-console.css **/*.html
  → product-intelligence/index.html
```

**Un seul consommateur.** Le Brand Console, dont le fichier porte le nom,
ne la charge pas : il a son propre `<style>` en ligne plus
`tracefab-spa-responsive.css`. Une première analyse menée contre
`brand-console/index.html` avait donc produit des chiffres qui ne voulaient
rien dire. Le nom d'un fichier n'est pas son consommateur ; la liste des
consommateurs s'établit avec `grep -l`, avant toute mesure.

Pour `product-intelligence/`, une page de 7 707 o, cela faisait
**49 909 o de CSS** livrés à chaque visiteur.

---

## 2. Pourquoi le texte ne suffit pas

Chercher `.ma-classe` dans le HTML pour décider si une règle est morte casse
sur trois cas au moins :

- les sélecteurs composés — `.pi-tab.active` n'apparaît jamais tel quel dans
  le markup ;
- les classes construites en JS — `'status-' + value` ;
- les attributs — `[data-level="verified"]`.

L'élagueur (`scripts/prune_console_css.mjs`) teste donc chaque sélecteur
contre le **DOM vivant**, par `document.querySelector`, dans un navigateur
réel. Il conserve d'office `:root`, `html`, `body`, `*`, `@keyframes`,
`@font-face`, descend dans les `@media` et supprime les enveloppes vidées.

---

## 3. Les deux angles morts, et ce qu'ils auraient coûté

Un DOM ne prouve l'inutilité d'une règle que s'il expose tout ce que la page
sait produire. Deux fois, ce n'était pas le cas.

### 3.1 La page a onze onglets, pas un

Premier passage : **75 sélecteurs vivants, −57 %**. Chiffre flatteur, et faux.
`assets/js/tf-product.js` (22 ko) construit onze panneaux — overview,
composition, materials, supplyChain, manufacturing, suppliers, evidence,
certifications, quality, dpp, history — et n'en monte qu'un à la fois. Les
règles des dix autres n'avaient aucun élément à rencontrer.

L'erreur s'est signalée en lisant le JS : il émettait `.dpp-hero`,
`.mc-alert`, `.pi-comp`, `.check-icon`, que la feuille élaguée ne contenait
plus. L'élagueur parcourt désormais les onze onglets, aux deux largeurs.

**116 sélecteurs vivants au lieu de 75 : 41 règles sauvées du couperet.**

### 3.2 Les fixtures ne jouent pas toute l'échelle

Second passage : `[data-level="missing"]` disparaissait. Légitime au regard du
DOM — aucun événement de démonstration n'est à l'état `missing` — et faux au
regard du produit : `missing` est un niveau de l'échelle de confiance, qu'un
autre jeu de données affichera.

Une valeur d'attribut absente du DOM n'est pas une valeur morte ; c'est une
valeur non jouée aujourd'hui. L'élagueur applique maintenant une **règle de
famille** : dès qu'une variante d'un attribut de données est vivante, toute la
famille est conservée. Les sept sélecteurs `[data-level]` / `[data-sev]`
d'origine sont intacts.

---

## 4. Un défaut trouvé en chemin

La vérification a mis au jour un bug **antérieur à l'élagage**. Le JS émet
cinq niveaux de confiance ; la feuille d'origine n'en stylait que trois :

| Niveau | Occurrences en fixtures | Pastille d'origine |
|---|---|---|
| `verified` | 14 | émeraude |
| `certified` | 13 | émeraude |
| `review` | 9 | ambre |
| `documented` | **9** | **blanche — aucune règle** |
| `declared` | **1** | **blanche — aucune règle** |

Dix événements de frise affichaient donc une pastille blanche, muette, dans
une page dont le propos est précisément de rendre le niveau de preuve
lisible d'un coup d'œil. Les deux règles manquantes ont été ajoutées sur les
jetons existants (`--tf-trust-documented` `#2f6f94`, `--tf-trust-declared`
`#7a8782`). L'échelle est complète :

```
missing     #c0492f      documented  #2f6f94
review      #b47e18      verified    #0fb97c
declared    #7a8782      certified   #0fb97c
```

---

## 5. La preuve que le rendu n'a pas bougé

Une empreinte de rendu a été relevée avant et après : **onze onglets × deux
largeurs = 22 vues, 4 260 nœuds**, vingt-cinq propriétés calculées par nœud
(boîte, typographie, couleur, grille, espacement) plus les dimensions
observées.

```
noeuds differents : 0 / 4260
proprietes touchees : {}
```

Comparaison pixel des captures pleine page :

| Vue | Pixels différents | Nature |
|---|---|---|
| desktop 1280 | 69 / 1 851 k (0,004 %) | pastille `documented` corrigée |
| history 1280 | 142 / 1 847 k (0,008 %) | pastilles de l'échelle |
| mobile 390 | 2 177 / 867 k (0,251 %) | 29 px de pastille, le reste anticrénelage |

Le détail des transitions mobiles le confirme : une seule est une vraie
différence de couleur, `#ffffff → #2f6f94` sur 29 px — la pastille réparée.
Les autres sont des écarts de ±3/255 sur des gris de texte, c'est-à-dire du
bruit de rastérisation.

Les différences visibles sont donc **exactement la correction du § 4**, et
rien d'autre.

> Note de méthode : la première campagne de captures était sans valeur. Pour
> l'état « après », le script recopiait la feuille sur elle-même, alors que la
> boucle venait d'y écrire l'état « avant » — les deux captures montraient le
> même fichier et partageaient leur SHA256. Deux images identiques ne prouvent
> rien tant qu'on n'a pas prouvé qu'elles montrent deux choses différentes. Le
> script lit désormais deux sources explicites et vérifie la copie.

---

## 6. Résultat

| | Avant | Après |
|---|---|---|
| Poids | 49 909 o | **29 395 o** (−41 %) |
| Règles | 379 | **185** |
| Sélecteurs déclarés | 291 | 122 vivants |
| Niveaux de confiance stylés | 3 / 5 | **6 / 6** |

---

## 7. La garde

`npm run test:console-css` — `scripts/test_console_css.mjs` :

1. les onze onglets sont exposés, et rendent à 390 et 1 280 px sans
   débordement ni panneau vide ;
2. **chaque niveau lu dans `tf-product.js`** est forcé sur un `.pi-event` et
   doit produire une pastille non blanche — le test découvre les niveaux à la
   source, il ne les connaît pas d'avance, donc un sixième niveau ajouté
   demain sera contrôlé sans qu'on touche au test ;
3. la frise réellement rendue ne contient aucune pastille non stylée ;
4. zéro erreur JS, zéro ressource manquante.

**Contrôle négatif.** Règle `documented` retirée → le test échoue sur les deux
assertions attendues et sort en 1. Règle remise → vert.

---

## 8. Ce que cet élagage apprend

Un passage de code mort est une opération de suppression : la question n'est
jamais « cette règle sert-elle ? » mais « ai-je montré au mesureur tout ce que
la page sait faire ? ». Ici la réponse a été non deux fois — dix onglets
cachés, puis une échelle de valeurs que les données de démonstration ne
parcourent pas. Dans les deux cas le résultat intermédiaire était plus
flatteur que le bon : −57 % avant correction, −41 % après. **Un chiffre de
nettoyage qui s'améliore est plus souvent un angle mort qu'un progrès.**
