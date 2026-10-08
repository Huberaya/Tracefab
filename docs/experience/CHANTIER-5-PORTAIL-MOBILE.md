# Chantier 5 — Le portail fournisseur n'offrait aucune action sur mobile

**Statut : fait.** Priorité P1. Branche `merge/experience`.

> **Les trois personas passent désormais.** CEO 6/6 · Conformité 4/4 ·
> Fournisseur 4/4. C'est le test d'acceptation final du cahier des charges.

---

## 1. Le défaut

En 390 × 844, les **14 éléments cliquables au-dessus de la ligne de flottaison
étaient tous de la navigation**. Zéro action de contenu. Le cahier des charges
demande qu'un fournisseur « sache immédiatement quoi faire » ; il voyait des
onglets, deux listes déroulantes de réglage et une accroche publicitaire.

Budget vertical mesuré, écran de 844 px :

| Élément | Hauteur |
|---|---:|
| Bandeau de démonstration | 43 px |
| Marque + navigation | 121 px |
| Barre supérieure (fil d'Ariane, langue, organisation) | 110 px |
| Accroche | 265 px |
| **Premier élément actionnable** | **y = 579 px** |

Le panneau de progression — la seule chose qui réponde à « que dois-je
faire ? » — commençait à 579 px et son contenu utile tombait hors écran.

### Un second défaut, caché sous le premier

Le panneau lui-même n'était pas fiable. Il affichait :

```
✓ Fiche Entreprise (100%)   ✓ Sites de Production GPS (100%)
✓ Certificats GOTS & OEKO-TEX (100%)   ⏳ 1 Rapport d'essais RSL à renouveler
```

à côté d'un total de **72 %**, sous une phrase annonçant « Complétez les
**3 étapes** recommandées » alors qu'une seule était montrée. Trois « 100 % »
écrits en dur, un total de 72 %, trois étapes annoncées, une affichée : quatre
chiffres, aucun ne dérivait des données.

**Remonter un panneau incohérent au-dessus de la ligne de flottaison l'aurait
aggravé.** C'est la première chose que le fournisseur aurait lue. Il fallait
donc le rendre vrai avant de le rendre visible.

---

## 2. Ce qui a été fait

### 2.1 Le panneau dérive des données

`state.quality.score` portait déjà les dimensions calculées — elles n'étaient
simplement pas lues :

```js
score: { completeness: '72', freshness: '80',
         documentationCoverage: '25', consistency: '90',
         missingFields: [...] }
```

Le panneau les lit, les trie, et **désigne le point faible** au lieu de le
choisir à l'écriture :

```js
const faible = dims.slice().sort((a, b) => a.valeur - b.valeur)[0];
```

Avec le jeu de démonstration : **couverture documentaire, 25 %**. Les trois
autres dimensions sont au-dessus du seuil et portent une pastille verte. Le
seuil est nommé une fois (`SP_SEUIL = 70`) au lieu d'être réparti dans la
mise en forme.

Les quatre pastilles sont devenues de **vrais boutons** menant chacun à la vue
qui corrige sa dimension — complétude → profil, fraîcheur → points de données,
documentation → coffre-fort, cohérence → qualité.

### 2.2 Une action dominante

Sous la barre, un bouton pleine largeur pointe vers le point faible calculé :

> **Corriger maintenant · Couverture documentaire**

L'audit des personas vérifie qu'il domine visuellement le reste de l'écran
(≥ 1,25× la deuxième action). Il passe sur desktop comme sur mobile.

### 2.3 Dégraisser le chrome

| Élément | Avant | Après | Comment |
|---|---:|---:|---|
| Barre supérieure | 110 px | **51 px** | fil d'Ariane masqué (il répète l'onglet actif, déjà visible dans la nav) ; langue et organisation sur une seule ligne |
| Accroche | 265 px | **148 px** | titre réduit, paragraphe explicatif masqué sur mobile |
| **Panneau actionnable** | y = 579 | **y = 395** | |
| **Bouton d'action** | hors écran | **y = 653, entièrement visible** | |

Le paragraphe de l'accroche n'est pas supprimé, seulement masqué en dessous de
760 px : la promesse tient dans le titre, et l'explication coûtait 150 px
au-dessus de la ligne. Sur grand écran elle reste utile, et reste affichée.

### 2.4 Un piège de cascade

Le bloc responsive avait d'abord été posé à côté de la `@media` existante, en
tête de feuille — donc **avant** les règles `.sp-*`. À spécificité égale, la
règle la plus tardive l'emporte : `padding` et `font-size` étaient écrasés par
les règles de base, et seuls les `display: none` passaient. L'accroche restait
à 265 px.

Le bloc est désormais en **fin de feuille**, après les règles qu'il surcharge.
Le test verrouille cet ordre :

```js
ok(page.indexOf('Chantier 5 — en 390x844') > page.lastIndexOf('.sp-progress-pct span'),
  'le bloc responsive est place apres les regles .sp-* qu\'il surcharge');
```

**Une media query ne gagne pas parce qu'elle est une media query.** Elle ne
porte aucune spécificité supplémentaire : seul son rang dans la feuille compte.

---

## 3. Trois défauts trouvés en chemin

### 3.1 Le portail forçait le français

```js
lang: localStorage.getItem('tracefab_lang') || 'fr'
```

Le portail ignorait `?lang=` et retombait sur le français, alors que la langue
source du produit est l'anglais et que la règle du projet est explicite. Un
fournisseur allemand atterrissait en français. La langue suit désormais
`TF_I18N`, qui lit `?lang=` et la clé de stockage partagée, avec repli `en`.

### 3.2 Le jeu de démonstration se contredisait

`missingFields: ['active_site']` affichait « Manquant : un site de production
actif » — alors que `state.sites` contient un site marqué `isActive: true`. Le
champ manquant est devenu `rsl_test_report`, cohérent avec `state.documents`
qui ne contient qu'un certificat, et fidèle à l'intention de la pastille
d'origine.

### 3.3 L'audit des personas mesurait mal

Le persona Conformité échouait sur « vues clés avec contenu substantiel » :
la vue DPP était comptée à **1 bloc** malgré 1 900 caractères à l'écran. Le
sélecteur de l'audit était `tr, .card, .mc-tile, li` — écrit quand la vue DPP
était vide, il ne connaissait pas les blocs qu'elle rend une fois alimentée.

Compte réel dans la vue : **4 `.pillar-card` + 1 `.card` + 2 `.item` = 7 blocs.**
Le sélecteur en voyait 1.

J'ai corrigé l'instrument, pas la vue — et je le signale explicitement, parce
que modifier un test pour le faire passer mérite d'être justifié : ici la vue
rend bien sept blocs de contenu, et ne compter qu'une de leurs conventions de
nommage était une lacune de mesure.

---

## 4. i18n : une frontière assumée

État historique à la livraison : les 17 chaînes du premier écran étaient
produites par `scripts/build_portal_overview_i18n.mjs` en neuf catalogues.
**Mise à jour Chantier 15 (2026-10-08)** : ce générateur produit désormais
uniquement les sept langues complètes ; tr/zh ont été retirées du produit avec
leurs catalogues partiels. Le contrôle courant est `test:i18n` et
`test_i18n_chantier15.mjs`.

Le reste de `overview()` — les 4 cartes d'action, les 6 statistiques, les
demandes prioritaires, l'import BOM — **reste en dur, en français.** C'est le
point 7 du backlog.

Traduire la moitié d'un écran est généralement pire que ne rien traduire. Mais
**la ligne de flottaison mobile est une frontière nette et vérifiable**, et le
test l'exprime : aucune phrase en dur entre le début de l'accroche et la grille
des modules d'action. En anglais, le premier écran est désormais entièrement
anglais.

---

## 5. Résultat mesuré

| Contrôle | Avant | Après |
|---|---|---|
| Cliquables au-dessus de la ligne, 390×844 | 14 nav / **0 contenu** | 14 nav / **5 contenu** |
| Bouton d'action principal | absent | **visible en entier, y = 653** |
| Pourcentage de progression sans défilement | non | **oui** |
| Débordement horizontal (FR / EN / DE, mobile + desktop) | — | **0 px** |
| Erreurs console, 12 vues × 2 tailles | — | **aucune** |
| Les 12 vues du portail, contenu et débordement | — | **aucun problème** |

### Personas — test d'acceptation du cahier des charges

| Persona | Avant | Après |
|---|---|---|
| CEO / Fondateur | 6/6 | **6/6 validé** |
| Responsable conformité | 3/5 | **4/4 validé** |
| Fournisseur | 3/4 | **4/4 validé** |

### Matrice de tests

**35 OK / 1 échec.** L'unique échec reste `test:supplychain:chantier3`,
**identique sur `origin/main`**. `npm run build` et `typecheck` verts.

`npm run test:chantier5-portail` — **40 assertions**, chaîné dans `build`. Il
verrouille la dérivation du panneau, la disparition des quatre pastilles en
dur, la présence d'une action de contenu, l'ordre de cascade du bloc
responsive, la langue par défaut, la typographie du deux-points, la couverture
des 17 clés sur 9 langues, et l'absence de phrase en dur au-dessus de la ligne.

Captures : `.visual/portail/c5-{mobile-fr,mobile-en,desktop-fr}.png`
(`.visual/` est ignoré par git).

---

## 6. Détail typographique

L'accroche rendait « Weakest area : Evidence coverage » en anglais —
l'espace avant deux-points est une règle française. Un utilitaire applique
désormais l'espace insécable en français seulement :

```js
const sp2pts = () => (state.lang === 'fr' ? '\u00a0: ' : ': ');
```

---

## 7. Fichiers touchés

| Fichier | Nature |
|---|---|
| `supplier-portal/index.html` | `spDimensions()` / `spProgressPanel()` dérivés, accroche et bandeau catalogués, bloc responsive en fin de feuille, langue par défaut, champ manquant cohérent |
| `scripts/build_portal_overview_i18n.mjs` | **nouveau** — 17 clés × 9 langues |
| `scripts/test_chantier5_portail_mobile.mjs` | **nouveau** — 40 assertions |
| `scripts/persona_audit.mjs` | sélecteur de blocs complété (`.pillar-card`, `.item`) |
| `assets/i18n/en.js` + `{fr,de,it,es,nl,pt,tr,zh}.json` | 17 clés `sp*` |
| `package.json` | `test:chantier5-portail`, chaîné dans `build` |
