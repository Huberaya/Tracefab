# PHASE 5 — Dashboard mission control, Overview & Product Intelligence

**Date :** 7 octobre 2026
**Périmètre :** `/brand-console/` (restylage en place) + nouvelle surface `/product-intelligence/`
**Statut :** terminé, l'ensemble des contrôles passe. **En attente de votre validation avant la PHASE 6.**

---

## 1. Ce qui a été livré

### 1.1 La console devient un centre de contrôle

La Brand Console existante a été **restylée en place**, sans jamais recréer de route parallèle
ni toucher à sa logique applicative. Le script SPA embarqué n'a été modifié que là où c'était
strictement nécessaire (voir §4).

| Avant | Après |
|---|---|
| 17 621 octets de CSS inline | **0** — deux `<link>` vers le design system v3 |
| Nav à plat, 15 entrées, 3 libellés français en dur | 16 entrées **groupées par domaine**, 100 % i18n |
| `risk` absent | **Surface Risque complète** (registre + 4 indicateurs) |
| Sélecteur de langue **non fonctionnel** | Corrigé — 6 locales opérationnelles |

La nav suit désormais les trois groupes du brief : *Main console* (Overview, Products,
Suppliers, Materials, Supply chain) · *Collection & compliance* (Data requests, Questionnaires,
Documents, Certifications, Quality, **Risk**, Mass balance, Integrations, DPP) ·
*Governance* (Reports, Settings).

### 1.2 Overview — les chiffres du brief, étiquetés comme démonstration

L'écran Overview a été réécrit (2 402 → 5 363 octets) autour de trois bandeaux :

- **SCALE** — 1 248 produits · 86 fournisseurs · 214 sites · 18 pays
- **TRUST & READINESS** (bandeau sombre) — 92,4 % qualité · 84 % couverture de preuves ·
  78 % vérifié · 91 % traçable · **88 % maturité DPP**
- **ATTENTION** — 17 données manquantes · 8 certificats expirants · 5 fournisseurs à revoir ·
  12 produits incomplets. Chaque ligne est cliquable et mène à l'écran qui la résout.

> **Mode démo vs mode connecté.** En démo, les chiffres du brief sont affichés tels quels,
> précédés d'une pastille « Demonstration data ». En mode connecté (`?demo=0`), tout est
> recalculé depuis l'état réel ; **quand une valeur n'est pas disponible, l'interface affiche
> `—` au lieu d'inventer un nombre.**

### 1.3 Product Intelligence — une nouvelle surface

`/product-intelligence/` présente **Organic Cotton T-Shirt / AW26-0248** sous onze angles.

- **Bandeau de signaux** : 94 % qualité · 88 % preuves · 91 % traçabilité · 88 % maturité DPP
- **11 onglets** : Overview · Composition · Materials · Supply chain · Manufacturing ·
  Suppliers · Evidence · Certifications · Quality · DPP · History
  (navigables au clavier, l'onglet actif est reflété dans l'URL)
- **Timeline produit** : 8 événements datés, chacun porteur de son niveau de preuve
- **Lignage cliquable** : Fibre → Filateur → Fil → Tissu → Teinturerie → Fabricant →
  Produit fini → DPP. Chaque maillon ouvre l'organisation qui le porte, son pays et son
  niveau de preuve.

**Le principe directeur de la page :** *« Every value below carries a level of proof. »*
Aucune valeur n'est affichée sans son niveau de preuve (Missing / Review / Declared /
Documented / Verified / Certified).

### 1.4 Maturité DPP — jamais présentée comme une certification

L'onglet DPP décompose les 88 % en **7 éléments prêts** (✓) et **2 manques** (⚠ analyse des
eaux usées de la teinturerie, informations de réparation), sous la mention explicite :

> *« A readiness indicator, never a legal certification. »*

---

## 2. Résultats des contrôles

| Contrôle | Résultat |
|---|---|
| `npm test` (~24 suites) | **exit 0** |
| `npm run typecheck` | ✅ |
| `npm run api:typecheck` | ✅ |
| `npm run schema:static` | ✅ 22 tables, 61 politiques RLS |
| `npm run test:brand-console` | ✅ contrat préservé |
| `verify_locales` desktop | **6/6** |
| `verify_locales` mobile 390×844 | **6/6** |
| Régression visuelle vs référence PHASE 4 | **aucune** |

### Capture comparative (desktop)

| Route | CSS inline | h1 | Débordement | Erreurs JS |
|---|---|---|---|---|
| `/` | 33 700 → **0** | 1 | non | 2 → **0** |
| `/brand-console/` | 17 621 → **0** | 1 | non | 4 → **2** ¹ |
| `/product-intelligence/` | — → **0** | 1 | non | — → **0** |
| `/supplier-portal/` | 12 370 (inchangé) | 1 | non | 4 → 2 ¹ |
| `/dpp/` | 13 862 (inchangé) | 1 | non | 2 → 0 |
| `/quality-center/` | 4 828 (inchangé) | 1 | non | 4 → 2 ¹ |
| `/operations/` | 2 477 (inchangé) | 1 | non | 4 → 2 ¹ |

¹ Les 2 erreurs restantes sont un **artefact du banc de test** : le serveur de preview statique
répond `501` sur `/api/*`. Elles n'existent pas en production.

### Mobile (390 × 844)

| Route | Débordement | Cibles < 44 px | Erreurs JS |
|---|---|---|---|
| `/product-intelligence/` | 0 | **0** | 0 |
| `/brand-console/` | 0 | **0** | 0 |

Les routes `supplier-portal`, `dpp`, `quality-center` et `operations` conservent leur CSS inline
hérité et leurs défauts mobiles d'origine : elles relèvent des **PHASES 6, 8, 10 et 11**.
Elles n'ont **pas régressé**.

---

## 3. Trois corrections de bugs préexistants

La PHASE 5 a mis au jour trois défauts qui existaient déjà dans `HEAD` :

1. **Le sélecteur de langue de la console ne fonctionnait pas.** Le script SPA s'exécute dans
   une IIFE ; le `onchange="setBrandLang(this.value)"` inline du `<select>` ne pouvait donc
   jamais atteindre la fonction. Corrigé par un export explicite sur `window`.
   Les 6 locales sont désormais opérationnelles (vérifié : nav, fil d'Ariane, KPI, gravités).
2. **Le fil d'Ariane était figé.** `viewLabel()` était une table française codée en dur et
   incomplète. Réécrite pour utiliser les **mêmes clés que les boutons de nav** — un libellé
   ne peut donc plus diverger de son entrée de menu.
3. **Un clic sur une vue inconnue affichait le mauvais écran.** Le `render()` retombait sur
   `requestDetailView()`. C'est pourquoi `risk` a été livré avec sa vue, et pas seulement
   avec son bouton.

---

## 4. Ce qui a été touché, et ce qui ne l'a pas été

### Modifié
- `brand-console/index.html` — CSS inline remplacé par des `<link>` ; `overview()` réécrit ;
  `riskView()` ajouté ; `viewLabel()` i18n ; `setBrandLang` exporté ; **194 clés i18n ajoutées**
  sur les 6 locales de `brandTranslations`.
- `vercel.json`, `scripts/dev_static_server.mjs`, `scripts/visual_capture.mjs` — route
  `/product-intelligence`.
- `assets/i18n/en.js` (547 clés, dont 170 `pi.*`) et `assets/i18n/fr.json`.

### Créé
- `product-intelligence/index.html` (7,5 ko) · `assets/js/tf-product.js` (21,8 ko)
- `scripts/build_pi_locales.py`, `scripts/patch_console_risk.py` (patches rejouables)

### Intact
Backend, `api/index.ts`, Prisma, Clerk, RLS, migrations, `src/app/**`, Supplier Portal,
DPP, Quality Center, Operations, et **toute la logique applicative de la console** :
appels API, formulaires, workflow de relance, actions `data-action`.

---

## 5. Point d'attention : i18n de la nouvelle surface

Le namespace `pi.*` (170 clés) est **complet en EN et FR**. Pour DE/IT/ES/NL, le runtime
résout proprement vers l'anglais — l'interface reste cohérente, sans clé brute affichée.

C'est un choix assumé : la **PHASE 12 est la phase i18n**, et c'est là que ces quatre locales
seront rédigées. En revanche, **l'architecture est déjà respectée** : zéro copie métier dans
le markup, tout passe par le catalogue.

À l'inverse, les 194 clés ajoutées à la console (mission control + risque) sont **complètes
sur les 6 locales**, car elles vivent dans `brandTranslations` qui n'a pas de mécanisme de
repli vers l'anglais aussi propre.

### Dette i18n héritée — à traiter, chiffrée

Un audit du script de la console relève **224 chaînes françaises encore codées en dur** dans
les corps de vues, héritées de l'application d'origine. Ce ne sont pas des régressions :
elles existaient avant la PHASE 5. Les écrans que j'ai traités (shell, nav, fil d'Ariane,
Overview, Risque) en sont désormais **entièrement exempts**.

| Vue | Chaînes FR en dur | Phase de traitement |
|---|---|---|
| `dppView` | 9 | PHASE 10 |
| `supplyChainView` | 3 | PHASE 9 |
| `documentsConsoleView` | 2 | PHASE 8 |
| `settingsConsoleView` | 1 | PHASE 12 |
| Jeux de données de démonstration (noms d'étapes, libellés de certificats, commentaires d'audit) | ~209 | PHASE 12 |

Le gros du volume est constitué de **contenu de démonstration** (« Égrenage (Ginning) »,
« Rapport Hohenstein #21.HPT.94112 », « Fiação Norte Lda »…) plutôt que de copie d'interface.
Je propose de le traiter en une passe dédiée à la PHASE 12 plutôt que de le disperser.

---

## 6. Les trois personas

| Persona | Avant PHASE 5 | Après |
|---|---|---|
| **CEO / Fondateur** | ✅ (landing) | ✅ L'Overview donne l'échelle et la confiance en un écran |
| **Responsable conformité** | ✅ (landing) | ✅✅ Product Intelligence lui donne la profondeur : 11 angles, lignage, preuves datées, manques DPP nommés |
| **Fournisseur** | ⚠️ | ⚠️ **inchangé — c'est l'objet de la PHASE 6** |

---

## 7. Proposition pour la suite

**PHASE 6 — Supplier Portal.** C'est le dernier persona en souffrance, et la route
`/supplier-portal/` est aussi celle qui présente le plus de défauts mobiles résiduels
(débordement de 121 px, 17 cibles tactiles sous 44 px). Les deux se traitent ensemble.

Objectif du brief : *« Your data. Your profile. Reusable across your customers. »*
— avec une barre de complétion et un parcours où le fournisseur sait immédiatement quoi faire.

**J'attends votre validation avant de démarrer.**
