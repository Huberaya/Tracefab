# Fusion Option A — rapport

Branche `merge/experience`, partant de `origin/main` (`4ddf5f5`).
Objectif : réappliquer la couche expérience par-dessus la ligne phase 9–12
développée en parallèle, sans rien perdre des deux côtés.

---

## 1. Ce qui a été intégré

| Commit | Contenu |
|---|---|
| `4a2ba38` | 34 fichiers sans conflit : design system, couche i18n, landing, product-intelligence, outillage, docs, `.gitignore`, `vercel.json` |
| `0c090d9` | `@types/node` → `^20.19.43` : débloque `api:typecheck` |
| `75cbda7` | Couche i18n/infra réappliquée sur les deux SPA + 3 handlers inline réparés |
| `10ea859` | Correctif du débordement horizontal mobile des deux SPA |
| `c0b11b5` | Contrat du contrôleur de langue de la landing restauré |

---

## 2. `origin/main` ne compilait pas

Constat établi sur un `git worktree` de `origin/main` **pur**, pour écarter
tout doute sur l'origine du défaut.

```
npm run typecheck       exit 0
npm run api:typecheck   exit 2   ← 8 erreurs TS
```

Toutes dans `api/_lib/wallet/apple-pass-generator.ts` :
`TS2305 Module 'node:zlib' has no exported member 'crc32'`, plus des
`TS2345`/`TS2322` `Buffer` → `Uint8Array<ArrayBufferLike>`.

Cause réelle : `@types/node@20.11.0` est trop ancien pour TypeScript 5.9.3.
`crc32` **existe** à l'exécution (vérifié sur Node v20.20.2) ; seuls les
types l'ignoraient. `npm run build` enchaînant `typecheck && api:typecheck`,
la branche principale ne buildait plus.

Corrigé **sans toucher une ligne de leur code** : seul le paquet de types
a été relevé. Les deux `typecheck` repassent à 0.

---

## 3. Les SPA phase 9–12 portaient encore tous les défauts corrigés avant

Leur Brand Console et leur Supplier Portal ayant été réécrits en parallèle,
les correctifs de la branche expérience n'y étaient pas. `scripts/merge_apply_experience_layer.py`
les réapplique **sans toucher au contenu des vues** :

- suppression de `auto-translate.js` (traduction machine non maîtrisée)
- `labels{}` figé → `STATUS_KEYS` + `statusLabel()`, 30 clés × 6 locales
- `date()` / `moneyless()` passent par `BCP47` / `locale()` au lieu de `fr-FR` codé en dur
- 30 (console) + 1 (portail) `onclick="alert(…)"` → `data-demo-action` + message honnête de démonstration
- `#lang-switch` du portail réellement câblé

### Trois handlers inline cassés, découverts au navigateur

Le script de la console est encapsulé dans une IIFE : `setBrandLang`,
`render` et `state` n'étaient donc **pas globaux**, alors que des attributs
`onchange=` / `onclick=` du HTML les référençaient. Chaque changement de
langue levait `setBrandLang is not defined` — le sélecteur de langue de la
console était purement décoratif.

Les trois sont désormais exposés explicitement. Vérifié : nav, statuts et
dates se traduisent sur `en` / `fr` / `de` / `it`, **0 erreur JS**.

---

## 4. Débordement horizontal mobile — corrigé

Défaut antérieur, mesuré à l'identique sur `origin/main` pur.

| Route | Viewport | Avant | Après |
|---|---|---|---|
| brand-console | 390 | **722 px** | 390 px |
| brand-console | 768 | **1000 px** | 768 px |
| supplier-portal | 390 | **527 px** | 390 px |
| supplier-portal | 768 | **805 px** | 768 px |

Causes isolées au navigateur, pas devinées :

- `min-width:auto` empêchait les enfants flex/grid de rétrécir
- `.top-actions` ne passait pas à la ligne (406 px dans 390)
- `.table-wrap` laissait la table pousser la page entière
- `.sp-actions-grid` imposait 4 colonnes fixes = 508 px dans 354 px

Tout est enfermé dans `@media (max-width: 860px)` : **desktop strictement
inchangé** (débordements réels 1 et 5, identiques à `origin/main`).

### Pourquoi le design system n'est PAS injecté dans les SPA

Mesure faite avant de décider : **100 % des classes `.mc-`, `.dc-` et `.sp-`
utilisées dans leurs SPA sont déjà stylées par leur CSS inline** (0 classe
orpheline sur 21 + 11 + 19). Charger `tracefab-core/console/portal.css`
n'ajouterait que ~88 ko de doublons et des risques de conflit, pour aucun
gain visuel. Seule la couche corrective responsive (3,8 ko, mobile only)
a été ajoutée.

---

## 5. État des contrôles

| Contrôle | Résultat |
|---|---|
| `typecheck` | OK |
| `api:typecheck` | OK (était cassé sur `main`) |
| `schema:static` | OK — 22 tables / 61 policies |
| `test:brand-console` / `:browser` | OK |
| `test:supplier-portal` / `:browser` | OK |
| `test:quality-center:browser` | OK |
| `verify_locales` desktop | 6/6 |
| `verify_locales` mobile | 6/6 |
| 41 scripts `test:*` | OK |

### Échecs restants, tous antérieurs

Vérifiés un par un contre `origin/main` : **aucune régression introduite**.

- `test:supplychain:chantier3` — attend le littéral `'Tier 4 · Matières'`
  (puis Tier 3/2/1/0). Leur réécriture phase 9–12 a supprimé ces libellés
  de la console. Soit le test est périmé, soit les étapes du pipeline ont
  été perdues : **à trancher par l'auteur du chantier 3**, pas devinable.
- `test:p1:staging`, `test:p2:staging`, `test:p2` — antérieurs.
- 8 scripts `test:neon:*` — nécessitent une base Neon active.

---

## 6. Point ouvert : le français codé en dur dans leurs vues

Le sélecteur de la console affiche « English » alors que le contenu reste
en français (« Centre de Pilotage Opérationnel », « Fournisseurs Rang 1–4 »).
Ma couche traduit la navigation, les statuts et les dates ; **leurs vues
phase 9–12 ont la copie métier écrite en dur**.

| Fichier | Appels i18n | Chaînes françaises en dur |
|---|---|---|
| `brand-console/index.html` | 20 `bt()` | ~115 |
| `supplier-portal/index.html` | 18 `t()` | ~73 |

Soit ~85 % de la copie hors i18n, contre la règle « aucune copie métier
codée en dur ». C'est un chantier d'extraction à part entière (≈188 chaînes
× 6 locales), pas quelque chose à glisser dans un commit de fusion.

## 7. Point ouvert : le portugais de la landing

Leur landing servait 7 locales. La nouvelle en sert 6 — EN/FR/DE/IT/ES/NL,
exactement le périmètre « phase 1 » demandé. Le portugais est donc perdu
côté landing, ce qui fait échouer la dernière assertion de `test:p1-i18n`
(`hreflang="pt"`).

Restaurer le portugais représente 548 clés / ~12 600 caractères à traduire.
Décision produit, laissée ouverte.
