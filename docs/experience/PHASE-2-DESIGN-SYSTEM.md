# PHASE 2 — Système de design

Identité propriétaire **TRACEFAB — DATA × TEXTILE × TRUST**.

---

## 0. Pourquoi ce rapport arrive après les autres

Les phases 1 et 4 à 12 ont leur rapport ; les phases 2 et 3 n'en ont jamais
eu. Le travail avait été fait et validé en passant, mais rien ne le
consignait. Ce document reconstitue l'état réel du système tel qu'il est
livré aujourd'hui, mesuré sur le dépôt, pas tel qu'il était prévu.

## 1. Ce que le système contient

| Feuille | Poids | Règles | Rôle |
|---|---|---|---|
| `tracefab-core.css` | 24 473 o | 121 | jetons, échelles, primitives |
| `tracefab-site.css` | 42 708 o | 272 | landing et pages publiques |
| `tracefab-console.css` | 51 206 o | 379 | Brand Console |
| `tracefab-portal.css` | 13 245 o | 74 | Supplier Portal |
| `tracefab-spa-responsive.css` | 3 784 o | 7 | adaptations SPA |
| `tracefab-touch.css` | 3 331 o | 10 | plancher de cible tactile |

**122 jetons** et **70 classes utilitaires**.

## 2. Les décisions structurantes

### Palette

Base **Deep Forest / Charcoal / Off White**, accent **émeraude** parcimonieux.

```
forest    950 #040b08  900 #071410  850 #091b15 … 500 #1d5339
charcoal  950 #0a0c0b  900 #121514 … 300 #98a19c
bone       50 #fbfaf8  100 #f5f4f0  200 #ecebe5 … 400 #c7c5ba
emerald       #0fb97c  bri #2ee39b  deep #07875a  ink #05543a
```

La contrainte posée au départ — « doit fonctionner presque en monochrome » —
est ce qui a servi d'arbitre à chaque fois qu'une couleur décorative s'est
invitée. Elle a tranché deux fois en pratique : le passeport fournisseur et
le DPP public portaient chacun une palette parallèle, retirées depuis.

### Échelle de confiance

Six niveaux, parce que la confiance n'est pas binaire dans un dossier
d'audit :

```
missing #c0492f · review #b47e18 · declared #7a8782
documented #2f6f94 · verified #0fb97c · certified #07875a
```

C'est cette échelle, et non une palette d'humeur, qui colore les statuts
partout dans le produit. Un statut qui prend une couleur hors de cette
échelle est un défaut.

### Typographie

**Inter Tight** (affichage et texte) + **JetBrains Mono** (libellés
techniques, codes, identifiants).

Échelle de corps : `3xs 11 · 2xs 12 · xs 13 · sm 15 · md 16 · lg 18 · xl 21 ·
2xl 26 px`. Affichages `d0` à `d3` en `clamp()`, numériques `n0` à `n2`.

Le registre est **éditorial, pas gras** : les affichages tournent à 540-620 de
graisse, là où un SaaS générique poserait 800. C'est ce qui donne le ton
« architectural et précis » demandé plutôt que « application web moderne ».

### Rayons et espace

Rayons serrés — `xs 2 · sm 4 · md 6 · lg 10 · xl 14 px`. Rien d'arrondi au
point d'être doux. Échelle d'espace `s1 4px` à `s12 160px`, gouttière
`clamp(20px, 4vw, 56px)`, largeur maximale 1 480 px.

## 3. Ce que le système a coûté à faire respecter

Un système de design n'existe que s'il est contraignant. Trois pages
l'avaient contourné, et chacune a demandé une reprise :

- **`passport/`** — Plus Jakarta Sans, fond bleu nuit, accent bleu, rayons
  18 px, quatre indicateurs en quatre couleurs décoratives. Aligné
  (tranche 12).
- **`dpp/`** — Plus Jakarta Sans et graisses 750/800/850, hors de la plage
  chargée par le reste du produit. Aligné (tranche 13).
- **`tracefab-ds.css`** — feuille orpheline de 5 ko déclarant une troisième
  famille (`Inter`, jamais chargée) et **référencée par aucune page**.
  Supprimée.

La leçon est simple : une feuille qui n'est chargée nulle part ne se fait pas
remarquer, et une page qui charge sa propre police non plus. Seul un audit
transversal les révèle.

## 4. Accessibilité : le plancher de cible tactile

Ajouté en tranche 13 après un audit qui a relevé **33 types de contrôles sous
40 px** : navigation à 39 px, sélecteurs de langue à 30 px, pastilles de
filtre à 23 px, boutons-liens à 14 px.

`tracefab-touch.css` pose le plancher à 40 px de hauteur, en excluant
explicitement les liens au fil du texte que WCAG 2.5.8 exempte. Le résultat
est verrouillé par `npm run test:touch` — 9 pages × 3 largeurs — avec contrôle
négatif prouvé.

## 5. Vérification

```
Cibles tactiles : OK — 9 pages x 3 largeurs, plancher 40px tenu.
```

Barrière complète : 45 tests + `test:phases` + `test:touch` + `build` +
`tsc --noEmit` + `e2e_audit.py` 4/4 + personas 6/6 · 4/4 · 4/4.

## 6. Reste à faire

Le système est cohérent sur les neuf pages. Il reste que
`tracefab-console.css` (51 ko, 379 règles) est la feuille la plus lourde du
dépôt et mériterait un passage de consolidation — plusieurs de ses règles
dupliquent probablement des primitives de `core`. Ce n'est pas un défaut
visible, c'est de la dette.
