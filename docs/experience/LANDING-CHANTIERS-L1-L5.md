# Landing — chantiers L1 à L5

Branche `merge/experience` · commits `3b84bc0`, `d176660`, `7da777f`, `98e1321` · poussés sur `origin`.

---

## Le verdict d'audit, d'abord

La landing **n'avait pas besoin d'être sauvée**. Elle avait besoin d'être finie.

J'ai mesuré avant de toucher quoi que ce soit, et une bonne partie de mes premières
hypothèses était fausse. La page implémente déjà l'essentiel du cahier des charges :
le libellé de héros, le titre en trois phrases avec « Prove it. » en émeraude, le
graphe de nœuds, les KPI, la matrice FIBRE → DPP croisée avec SUPPLIER / COUNTRY /
CERTIFICATE / QUALITY / STATUS, le dossier Atelier Milano, les sept couches, le
bandeau de promesse, le pied de page, la mention de données de démonstration.

**L'interactivité est réelle et je m'étais trompé en la croyant absente.** Un premier
sondage cherchait les bascules de dimension par leur nom de classe (`[class*=dim]`)
et n'a rien trouvé : elles existent, ce sont de simples `<button>`. Vérifié ensuite
par comportement : 65 éléments cliquables, survol d'un nœud du héros → une fiche
apparaît, clic sur une étape → le dossier change, 4 animations CSS + 10 animations
SVG natives. J'ai failli « ajouter » une fonctionnalité déjà livrée.

La vue mobile de la section WOW est elle aussi bien pensée : la matrice à 9 colonnes
devient des cartes verticales empilées. Elle répond déjà à la demande du brief.

Les trois chantiers ci-dessous corrigent donc des **défauts de finition mesurables**,
pas une conception ratée.

---

## L1 — Poser un plancher typographique de 11 px

**Le problème.** 218 nœuds de texte sous 11 px. 7,5 px pour la signature de marque,
8 et 8,5 px pour la quasi-totalité des libellés techniques, 10 px pour les cellules
de la matrice. Le brief demande de « petits labels techniques » ; il ne demande pas
des labels illisibles. En mono gris sur fond sombre, avec un interlettrage de 0,2 em
qui disjoint les lettres, 8,5 px n'est plus lu — c'est une texture.

**La cause n'était pas une valeur isolée.** Une micro-échelle en px brut s'était
installée *sous* le barème de tokens, lequel s'arrêtait déjà à 10 px. Les deux sont
corrigés : `--tf-size-3xs` 10 → 11 px, `--tf-size-2xs` 11 → 12 px, et les 14
déclarations en px brut de `tracefab-site.css` passent toutes par le token.

| | avant | après |
|---|---:|---:|
| Nœuds sous 11 px (1440 / 834 / 390) | 218 | **0** |
| Plus petite taille rendue | 7,5 px | **11 px** |
| Hauteur de page desktop | 6 098 px | 6 179 px (+1,3 %) |

Le risque identifié avant d'éditer — le bond de +29 % sur les libellés combiné à un
interlettrage de 0,2 em qui ferait déborder la colonne collante de la matrice — ne
s'est pas matérialisé. Quelques cellules passent sur deux lignes, et y gagnent.

La raison du plancher est écrite dans la feuille de style, pas seulement dans un test.

---

## L2 — Faire des 7 couches une vraie colonne vertébrale

**Le problème est une contradiction entre le texte et la mise en page.** La section
affirme « Each layer answers one question, and hands its answer to the next » et
rendait un tableau de sept rangées identiques. La phrase promet une chaîne, la mise
en page montre une liste. Or le brief demande précisément que ces sept couches soient
la colonne vertébrale visuelle du produit.

**Le rail rend la phrase littérale.** Une ligne continue traverse les sept rangées,
un nœud en losange marque chaque couche, et un relais nomme ce qu'elle transmet à la
suivante :

```
◆ 01 Supply Chain    Who makes what?            ↓ NETWORK
◆ 02 Product Data    What is the product?       ↓ PRODUCT
◆ 03 Evidence        Can we prove it?           ↓ PROOF
◆ 04 Data Quality    Can we trust it?           ↓ TRUST LEVEL
◆ 05 Traceability    Where did it come from?    ↓ CHAIN
◆ 06 Intelligence    What does the data say?    ↓ SIGNALS
◆ 07 DPP             What can we publish?       ◆ PASSPORT
```

La colonne de gauche se lit seule, en cinq secondes : c'est l'histoire du produit.

La ligne se remplit en vert au défilement, couche après couche, de façon cumulative.
L'animation dit quelque chose — la chaîne de preuve s'accumule — conformément à la
règle « chaque animation doit expliquer ». En mouvement réduit, tout est allumé
d'emblée, sans transition.

La question de chaque couche, cœur du concept, passe de 11 à 13 px et cesse d'être
une mention en gris pâle.

### Deux défauts préexistants trouvés en chemin

**1. Les sept descriptions se repliaient dans une colonne de 64 px sur mobile.**
La règle `.tf-layer__desc { grid-column: 2 }` visait un petit-enfant de la grille.
`grid-column` n'a aucun effet sur un élément qui n'est pas enfant direct du
conteneur : la règle visait le bon endroit et touchait le mauvais élément, donc elle
ne faisait rien du tout. Résultat : chaque description s'affichait un mot par ligne.

J'ai vérifié que ce défaut m'était antérieur en servant le commit précédent sur un
second port et en comparant les deux rendus — plutôt que de le supposer.

**2. La signature de marque faisait exploser l'en-tête mobile.**
`DATA × TEXTILE × TRUST` demande 212 px. Sous 560 px l'en-tête ne les a pas : elle se
repliait sur trois lignes et portait la barre collante de 79 à 114 px, sur un écran
qui n'en fait que 844. Elle sort de l'affichage sous 560 px en restant dans le
document pour les technologies d'assistance.

| | avant | après |
|---|---:|---:|
| `#platform` mobile | 4 727 px | **3 093 px** (−35 %) |
| Page mobile | 11 384 px | 9 750 px |
| Page tablette | 10 087 px | 7 933 px (−21 %) |
| En-tête collant à 390 px | 114 px | **74 px** |

Relais traduits en EN, FR, DE, IT, ES, NL, PT. `tr` et `zh` sont des catalogues
partiels sans clés de landing : ils tombent en repli anglais, comme le reste de la
page — je ne leur ai pas ajouté de clés orphelines.

---

## L3 — Rendre la page tenable sur téléphone

**Aucun contenu retiré.** Ce sont des défauts de mise en page, pas du volume en trop.

**Le titre du héros se brisait en cinq fragments.** Le plancher du clamp `d0` vaut
49 px, plus large qu'un téléphone : les deux phrases longues se cassaient chacune en
deux et « Know your product. » se lisait « Know your / product. ». Le héros reçoit
son propre plancher sous 640 px, calé sur la largeur réelle, avec des coupures
équilibrées. Vérifié de 320 à 1 440 px : 4 lignes sur téléphone au lieu de 5, 3 lignes
dès 640 px, desktop inchangé à 111 px.

Le centrage du héros n'a **pas** été touché : c'est un parti pris validé en phase 4.

**Le pied de page prenait plus d'un écran entier.** Ses quatre blocs s'empilaient en
une colonne : 1 122 px sur mobile contre 409 sur desktop, pour des liens secondaires.
Le bloc de marque garde la pleine largeur, les trois colonnes de liens se rangent par
deux. 1 122 → 929 px.

**Une hypothèse d'audit invalidée.** J'avais noté 108, 144 et 86 px de « vide en fin
de section ». Mesure refaite : ce sont les paddings de section, c'est-à-dire le parti
pris éditorial assumé du brief (« beaucoup d'espace »). Je les ai conservés.

---

## État mesuré après les trois chantiers

| | desktop 1440 | tablette 834 | mobile 390 | petit 320 |
|---|---:|---:|---:|---:|
| Hauteur de page | 6 179 px | 7 888 px | **9 473 px** | 10 712 px |
| Débordement horizontal | 0 | 0 | 0 | 0 |
| Texte sous 11 px | 0 | 0 | 0 | 0 |
| Cibles tactiles < 40 px | 27 | 1 | 3 | 3 |
| Contenu resté invisible | 0 | 1 | 1 | 1 |

Page mobile : **11 141 → 9 473 px, soit −15 %**, entièrement par correction de
défauts.

Les 27 cibles sous 40 px en desktop sont des liens de navigation et de pied de page à
la souris ; sur tactile il en reste 3. C'est un point à arbitrer, pas un défaut
bloquant.

---

## Tests et non-régression

Deux tests ajoutés et chaînés dans `build` :

- `npm run test:landing-lisibilite` — 15 assertions : le plancher de 11 px, le barème
  de tokens, les deux crans distincts, la raison écrite dans le CSS, et les trois
  réglages mobiles.
- `npm run test:landing-spine` — 32 assertions : les 4 éléments de grille sont bien
  des **enfants directs** de chaque couche, le relais et sa clé i18n, un seul nœud
  terminal, le franchissement des gouttières par le rail, le mouvement réduit en JS
  et en CSS, les 7 relais traduits dans les 6 locales, et le mot du relais conservé
  hors écran sur mobile.

J'ai vérifié que ce second test **échoue bien** en réintroduisant le défaut de grille
d'origine : un garde-fou qui ne peut pas échouer ne garde rien. Trois assertions
tombent, puis repassent au vert une fois le CSS restauré.

**Matrice complète : 37 tests verts / 1 échec.** L'unique échec,
`test:supplychain:chantier3`, est **identique sur `origin/main`** : il attend la
chaîne littérale `'Tier 4 · Matières'` dans la console de marque. Il est antérieur à
ces travaux et reste à arbitrer.

`npm run build` et `npm run typecheck` verts. **Les trois personas passent :
CEO 6/6 · Conformité 4/4 · Fournisseur 4/4.**

---

## L4 — Dire où l'on est

**Le surlignage du menu ne pouvait pas le dire.** L'ordre du menu est fixé par le
cahier des charges — Why / Platform / Supply Chain / Product Intelligence / DPP /
Resources — et il ne suit pas l'ordre de la page, qui est hero → supply-chain →
platform → why. Mesuré au défilement, l'élément actif **bondissait en arrière** :
position 3 → 2 → 4 → 5 → 1 → 6. Et sur téléphone le menu dort dans un tiroir fermé.

Je n'ai touché ni à l'ordre du menu (il est dans le brief) ni à l'ordre des sections
(le brief impose que la section WOW suive immédiatement le héros). Le conflit est
structurel : j'ai donc ajouté un repère qui, lui, **avance toujours**.

**Un rail de progression** collé au bas de l'en-tête, avec des encoches aux vraies
frontières de section. Il n'apparaît qu'une fois la page quittée du haut. Une seule
propriété composée (`scaleX`), un seul calcul par frame, encoches replacées au
redimensionnement.

**Le tiroir mobile devient une vraie table des matières.** Il numérotait
« Why TRACEFAB = 01 » alors que la page affiche « 01 — THE CONNECTED FOUNDATION » sur
Supply Chain : deux « 01 » différents. Il suit maintenant l'ordre de la page, porte
les numéros que la page affiche elle-même, laisse sans numéro ce qui n'est pas un
chapitre, et marque les deux liens internes à Platform comme subordonnés. **Parce
qu'il suit l'ordre de la page, le repère n'y recule jamais.**

### Trois défauts préexistants trouvés en chemin

**1. La navigation mobile était typographiée comme une note de bas de page.** Le
sélecteur `.tf-drawer__link span` visait le numéro mais frappait les deux enfants :
le libellé, déclaré à 17 px / poids 500, retombait à 11 px de mono gris.

**2. Quatorze références `var(--tf-…)` visaient des tokens inexistants**, sans valeur
de repli, dans les trois feuilles du design system. Un `var()` introuvable rend la
déclaration invalide et la propriété retombe en héritage : **l'échec est totalement
silencieux** — ni erreur console, ni règle barrée dans l'inspecteur.

| token appelé | réalité | conséquence |
|---|---|---|
| `--tf-emerald-bright` ×5 | s'appelle `--tf-emerald-bri` | le lien actif du tiroir calculait `rgb(10,12,11)` : du noir sur du noir |
| `--tf-size-2xl` ×3 | défini nulle part | trois titres console/portail retombaient à la taille héritée |
| `--tf-surface-light-hover` ×6 | défini nulle part | six survols console et portail ne faisaient rien du tout |

Les deux tokens manquants sont définis, les cinq références renommées. Console et
portail vérifiés après coup : aucune régression.

**3. Le tiroir à 0,97 d'opacité** laissait transparaître la section claire qui défile
derrière. Il devient opaque.

### Une alerte que j'ai eu tort de croire

J'ai cru voir une bande délavée derrière les deux sous-entrées du tiroir. J'ai
échantillonné les pixels : uniformément `(4, 11, 8)`, le fond du tiroir. **La bande
n'existait pas** — artefact de rendu. Mesurer avant de corriger m'a évité de
« réparer » une couleur parfaitement correcte.

---

## État mesuré après L4

| | desktop 1440 | tablette 834 | mobile 390 | petit 320 |
|---|---:|---:|---:|---:|
| Hauteur de page | 6 179 px | 7 888 px | 9 473 px | 10 712 px |
| Débordement horizontal | 0 | 0 | 0 | 0 |
| Texte sous 11 px | 0 | 0 | 0 | 0 |
| Rail en bas de page | 100 % | 100 % | 100 % | 100 % |
| Encoches de chapitre | 3 | 3 | 3 | 3 |

**39 tests verts / 1 échec** (`test:supplychain:chantier3`, identique sur
`origin/main`). `build` et `typecheck` verts. **CEO 6/6 · Conformité 4/4 ·
Fournisseur 4/4.**

Troisième garde-fou : `npm run test:landing-reperage`, 23 assertions, chaîné dans
`build`. Vérifié qu'il échoue en réintroduisant le token mort et la fausse
numérotation.

---

## Ce que je fais ensuite

- **L5 — performance.** Polices, chargement différé, poids des SVG, suppression du
  mort (`locales/` pèse 84 Ko et n'est plus lu).

Deux points attendent toujours votre arbitrage, hors landing : le badge
`EU ESPR / DPP Compliant` du DPP public, qui affirme une conformité là où le reste du
produit parle de *readiness* ; et le jeu de démonstration de la console (1 fournisseur,
2 produits) qui contredit les 86 / 1 248 affichés en Overview.

---

## L5 — Performance

Deux défauts, mesurés avant d'être corrigés.

### Le premier : la typographie ne rendait pas ce qu'elle écrivait

Le design system dessine huit graisses — 400, 480, 500, 520, 540, 560, 600, 620 — réparties sur vingt-six déclarations. La page n'en demandait que cinq, et en instances statiques : 300, 400, 500, 600, 700.

Une instance statique ne s'interpole pas. Demander 520 quand le navigateur n'a que 500 et 600 en magasin ne produit pas un 520 : il prend le plus proche. J'ai mesuré la largeur rendue de « Know your supply chain » à 64 px, graisse par graisse.

| graisse demandée | 400 | 480 | 500 | 520 | 540 | 560 | 600 | 620 | 700 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **avant** (5 statiques) | 653 | **670** | **670** | **689** | **689** | **689** | **689** | **700** | 700 |
| **après** (axe 400..700) | 653 | 665 | 670 | 672 | 675 | 678 | 689 | 690 | 700 |

Huit graisses dessinées s'écrasaient sur trois rendus. Seize déclarations sur vingt-six étaient décoratives : elles existaient dans le CSS, elles ne changeaient rien à l'écran. Aucune erreur nulle part — c'est le genre de dégradation qui ne se voit que si on la mesure.

Le passage à l'axe variable `wght@400..700` répare les neuf valeurs, et pèse moins lourd au passage, parce qu'un axe variable tient dans un seul fichier là où chaque instance statique en demandait un :

| | avant | après |
|---|---:|---:|
| fichiers latin Inter Tight | 4 | **1** |
| octets latin | 90 040 | **44 872** (−50 %) |
| CSS de police | 12 390 | **2 506** (−80 %) |
| requêtes de police | 5 | **2** |
| **total transféré** | | **−55 052 octets** |

La graisse 300 était demandée et n'est utilisée nulle part sur cette page : un fichier téléchargé pour rien.

Je n'ai pas pour autant resserré la borne haute à 620, bien que rien ne rende au-dessus. J'ai vérifié : Google sert **exactement le même woff2** pour `400..620` et pour `400..700` — 44 872 octets dans les deux cas. Les bornes d'un axe variable ne coûtent rien, contrairement aux instances statiques. Resserrer n'aurait rien gagné et aurait écrêté tout usage futur de `<b>` ou `<strong>`, qui valent 700 par défaut. Mon propre test de garde affirmait le contraire ; la mesure l'a contredit, j'ai corrigé le test.

### Le second : les animations tournaient hors champ

Quinze animations CSS infinies et dix animations SMIL tournaient en permanence, y compris à cinq mille pixels du champ de vision. Elles se mettent maintenant en veille quand leur bloc sort de l'écran, et reprennent au retour.

| | haut de page | bas de page | retour en haut |
|---|---:|---:|---:|
| animations CSS actives | 14 | **0** | 14 |
| en veille | 1 | **15** | 1 |
| SVG SMIL | actif | **suspendu** | actif |

Identique à 1 440 et à 390. La marge de réveil est de 300 px : une section se rallume avant d'entrer, jamais une apparition figée.

Deux pièges méritent d'être notés, parce qu'ils sont invisibles au premier essai. D'abord, `animation-play-state` **perd contre la propriété raccourcie `animation`** à égalité de spécificité : le raccourci remet `running`. La classe de veille est donc doublée — `.tf-offscreen.tf-offscreen` — pour peser (0,2,0). Ensuite, j'avais d'abord visé les `<section>` : le ticker, 48 s en boucle et le plus gros consommateur de la page, n'est pas dans une section mais enfant direct de `<main>`. Il a continué de tourner pendant que je croyais l'avoir arrêté. L'observateur porte maintenant sur tous les enfants directs de `<main>`.

### Ce que je n'ai pas touché, et pourquoi

Trois choses qui ressemblaient à du travail de performance et n'en sont pas.

Les scripts sont déjà en fin de `<body>` et `tf-landing.js` est déjà différé. Ajouter `defer` aux deux autres n'apporterait presque rien et introduirait un risque réel sur l'ordre d'amorçage.

`locales/` pèse 84 Ko morts. Mais ce dossier n'est servi à aucun navigateur : c'est du poids de dépôt, pas du poids de page. Gain de performance nul. Il reste sur la liste d'arbitrage, pas sur celle-ci.

Les paddings de section sont le parti pris éditorial validé en PHASE 4. Ce n'est pas du gras.

### Découvert en chemin, non corrigé

Le produit embarque **deux polices d'affichage différentes** : Inter Tight sur la landing, Plus Jakarta Sans sur quatre pages dont le DPP public. Trois requêtes Google Fonts distinctes, aucun partage de cache entre les pages. C'est un écart au design system déclaré, qui dépasse le cadre de ce chantier : je l'ai mis sur la liste d'arbitrage plutôt que d'unifier unilatéralement une identité typographique.

### Vérification

| | 320 | 390 | 1440 |
|---|---:|---:|---:|
| hauteur de page | 10 671 | 9 473 | 6 144 |
| débordement horizontal | 0 | 0 | 0 |
| texte sous 11 px | 0 | 0 | 0 |
| animations actives en bas | **0** | **0** | **0** |
| erreurs console | 0 | 0 | 0 |

`document.fonts` ne rapporte plus qu'une face variable `Inter Tight : 400 700` au lieu de quatre faces statiques.

**39 tests verts / 1 échec** — `test:supplychain:chantier3`, identique sur `origin/main`, toujours en attente d'arbitrage. `build` et `typecheck` verts. Personas **CEO 6/6 · Conformité 4/4 · Fournisseur 4/4**.

Le garde-fou `scripts/test_landing_performance.mjs` (19 assertions) est chaîné dans `build`. J'ai vérifié qu'il sait échouer : en remettant les instances statiques et en re-restreignant l'observateur aux sections, il signale les deux régressions.

**Commit `f340dc6`**, poussé.
