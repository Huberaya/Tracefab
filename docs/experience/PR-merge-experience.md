# Réintégration de la couche expérience sur `main`

Réapplique le travail des phases 1–8 (design system, i18n, landing, product
intelligence) par-dessus la ligne phases 9–12 développée en parallèle, sans
rien perdre des deux côtés.

**7 commits** · 41 fichiers · base `origin/main` (`4ddf5f5`)

---

## Ce que la PR corrige sur `main`

### 1. `main` ne buildait plus

`npm run build` enchaîne `typecheck && api:typecheck`. Le second échouait
avec 8 erreurs TypeScript dans `api/_lib/wallet/apple-pass-generator.ts` :

```
TS2305  Module 'node:zlib' has no exported member 'crc32'
TS2345/TS2322  Buffer → Uint8Array<ArrayBufferLike>   (lignes 150, 166, 189, 197, 211×3)
```

Constaté sur un `git worktree` de `origin/main` **pur**, donc antérieur à
cette branche. La cause n'est pas le code : `@types/node@20.11.0` est trop
ancien pour TypeScript 5.9.3 et ignore `crc32`, qui existe pourtant bien à
l'exécution (vérifié sur Node v20.20.2).

Corrigé en relevant `@types/node` à `^20.19.43`. **Aucune ligne de
`apple-pass-generator.ts` modifiée.**

### 2. Le sélecteur de langue de la Brand Console était inopérant

Le script de la console est encapsulé dans une IIFE : `setBrandLang`,
`render` et `state` n'étaient donc pas globaux, alors que des attributs
`onchange=` / `onclick=` du HTML les référencent. Chaque changement de
langue levait `setBrandLang is not defined`.

Les trois sont désormais exposés explicitement.

### 3. Débordement horizontal sur mobile et tablette

| Route | Viewport | Avant | Après |
|---|---|---|---|
| brand-console | 390 | 722 px | **390 px** |
| brand-console | 768 | 1000 px | **768 px** |
| supplier-portal | 390 | 527 px | **390 px** |
| supplier-portal | 768 | 805 px | **768 px** |

Causes isolées au navigateur : `min-width:auto` bloquant le rétrécissement
des enfants flex/grid, `.top-actions` sans retour à la ligne, `.table-wrap`
poussant la page entière, `.sp-actions-grid` à 4 colonnes fixes (508 px)
dans un conteneur de 354 px.

Correctif de 3,8 ko **entièrement sous `@media (max-width: 860px)`** :
desktop strictement inchangé.

---

## Ce que la PR apporte

- Design system v3 : `tracefab-core` / `-site` / `-console` / `-portal`
- Architecture i18n native, **7 locales** (EN/FR/DE/IT/ES/NL/PT), 549 clés
  alignées, aucune copie métier dans les composants
- Landing refondue en parcours visuel : 7 couches, noyau de données animé,
  chaîne interactive 9 étapes × 7 dimensions
- Page Product Intelligence avec 11 onglets et lignage produit
- Outillage : `verify_locales.mjs`, `visual_capture.mjs`, serveur statique
- Couche infra réappliquée aux deux SPA : suppression d'`auto-translate.js`,
  `statusLabel()` localisé, dates `BCP47`, 31 faux `alert()` remplacés par
  un message de démonstration honnête

---

## Contrôles

| Contrôle | Résultat |
|---|---|
| `typecheck` | OK |
| `api:typecheck` | OK — **était cassé sur `main`** |
| `schema:static` | OK — 22 tables / 61 policies |
| `verify_locales` desktop | **7/7** |
| `verify_locales` mobile | **7/7** |
| Scripts `test:*` (hors Neon/staging) | tous OK sauf les 2 ci-dessous |

### Échecs restants — antérieurs, vérifiés un par un contre `origin/main`

- **`test:supplychain:chantier3`** — attend le littéral `'Tier 4 · Matières'`
  (puis Tier 3/2/1/0). La réécriture phases 9–12 a supprimé ces libellés de
  la console. Soit le test est périmé, soit les étapes du pipeline ont été
  perdues : **à trancher par l'auteur du chantier 3.** Rien n'a été modifié
  d'un côté ni de l'autre, pour ne pas masquer une éventuelle régression
  réelle.
- **`test:p2`** — antérieur.
- 8 scripts `test:neon:*` — nécessitent une base Neon active.

---

## Point ouvert, hors périmètre de cette PR

Le sélecteur de la Brand Console affiche « English » alors que le contenu
reste en français : les vues phases 9–12 ont la copie métier écrite en dur.

| Fichier | Appels i18n | Chaînes françaises en dur |
|---|---|---|
| `brand-console/index.html` | 20 `bt()` | ~115 |
| `supplier-portal/index.html` | 18 `t()` | ~73 |

Soit ~85 % de la copie hors i18n. Une phase d'extraction dédiée est prévue.
