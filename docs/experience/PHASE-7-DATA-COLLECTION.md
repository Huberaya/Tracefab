# PHASE 7 — Data Collection

**Date :** 7 octobre 2026
**Périmètre :** `/brand-console/` écran *Data collection* + alignement du portail fournisseur
**Statut :** terminé, l'ensemble des contrôles passe. **En attente de votre validation avant la PHASE 8.**

---

## 1. Ce qui a été livré

### 1.1 Le circuit de collecte, rendu visible

Le brief demandait la chaîne **Brand → Supplier → Product → Required Data → Evidence →
Review → Verified Data**. Elle est désormais la colonne vertébrale de l'écran : sept étapes
numérotées `01`…`07`, chacune portant son compte et son verbe, reliées par des chevrons.
La dernière étape — *Verified data* — est la seule teintée d'émeraude : c'est la sortie du
circuit.

| 01 Brand | 02 Supplier | 03 Product | 04 Required data | 05 Evidence | 06 Review | 07 Verified data |
|---|---|---|---|---|---|---|
| 1 | 86 | 1 248 | 14 208 | 9 847 | 12 | 1 186 |
| *asks* | *answers* | *in scope* | *data points* | *attached* | *awaiting* | *accepted* |

### 1.2 Les six états, et qui en est responsable

Le tableau d'états traduit la question « où en est chaque chose » :

| Missing | Requested | Submitted | Under review | Accepted | Rejected |
|---|---|---|---|---|---|
| **17** | **64** | **23** | **12** | **1 186** | **5** |
| Never asked for | Waiting on the supplier | Back from the supplier | On your desk | Verified and reusable | Sent back for correction |

Chaque état dit **à qui appartient la balle**. C'est le point du brief : *« every item carries
a state, and every state has an owner. »*

Chaque carte filtre la liste au clic, et un second clic rend le filtre. Plutôt que de créer
un mécanisme parallèle, le tableau **pilote le `#request-filter` existant** : la recherche,
le filtre et la liste restent une seule et même machinerie.

### 1.3 Le mapping, dérivé et non inventé

Les six états du brief ne sont pas un nouveau champ en base : ils sont **dérivés des statuts
que l'API produit déjà**. Une demande tombe dans un et un seul état.

| État du brief | Statuts API |
|---|---|
| Missing | `draft`, `not_started` |
| Requested | `sent`, `in_progress`, `open`, `invited` |
| Submitted | `submitted`, `data_ready` |
| Under review | `needs_review`, `review_required`, `acknowledged` |
| Accepted | `approved`, `verified_by_reviewer`, `completed`, `ready_to_publish`, `resolved`, `active` |
| Rejected | `changes_requested`, `cancelled`, `waived` |

> En démo, les chiffres du brief sont affichés (le **17 Missing** reprend volontairement
> le « 17 Missing Data » de l'Overview). En mode connecté, tout est compté sur les demandes
> réelles ; les grandeurs non disponibles affichent `—`.

---

## 2. Deux bugs i18n préexistants, sur le chemin direct de cette phase

### 2.1 Tous les statuts de la console étaient en français, dans les six langues

`labels{}` était une carte codée en dur. Quelle que soit la langue choisie, chaque pastille
de statut affichait *Brouillon*, *Envoyée*, *Soumise*… Remplacée par `statusLabel()` qui passe
par le catalogue : **22 statuts × 6 locales** côté console, **19 × 6** côté portail.

### 2.2 Les dates et les nombres étaient figés en `fr-FR`

`date()` et `moneyless()` forçaient `'fr-FR'` dans les deux applications. Un acheteur allemand
lisait `12 oct. 2026`. Corrigé par une résolution BCP-47 sur la langue active :

| | EN | FR | DE | IT | ES | NL |
|---|---|---|---|---|---|---|
| date | 12 Oct 2026 | 12 oct. 2026 | 12.10.2026 | 12 ott 2026 | 12 oct 2026 | 12 okt 2026 |
| statut | In progress | En cours | In Bearbeitung | In corso | En curso | Loopt |

Le portail fournisseur bénéficie des deux corrections : le fournisseur voit enfin ses
échéances et ses statuts dans sa langue.

---

## 3. Résultats des contrôles

| Contrôle | Résultat |
|---|---|
| `npm test` (~24 suites) | **exit 0** |
| `typecheck` · `api:typecheck` · `schema:static` | ✅ |
| `test:brand-console` · `test:supplier-portal` | ✅ contrats préservés |
| `verify_locales` desktop / mobile | **6/6** · **6/6** |
| Régression visuelle vs référence PHASE 4 | **aucune** |

### Responsive (390 × 844)

| Route | Débordement | Cibles < 44 px | Texte coupé | Erreurs JS |
|---|---|---|---|---|
| `/brand-console/` (Data collection) | 0 | 0 | 0 | 0 |
| `/supplier-portal/` | 0 | 0 | 0 | 0 |
| `/product-intelligence/` | 0 | 0 | 0 | 0 |

Le circuit passe de 7 colonnes à 4 (≤ 1180 px) puis 2 (≤ 640 px) ; le tableau d'états de 6 à
3 puis 2. Les chevrons disparaissent quand le flux n'est plus horizontal.

### Détail technique

Le chevron est dessiné en bordures sur le **bord gauche** de chaque étape, pas le bord droit :
les éléments d'une grille se peignent dans l'ordre du DOM, un pseudo-élément à droite aurait
été recouvert par le fond de l'étape suivante. C'est pour ça qu'il était invisible au premier
essai.

---

## 4. Dette i18n : le point honnête

Je donnais « 224 chaînes françaises en dur » en PHASE 5. Ce chiffre global était peu utile.
Voici la mesure par fonction, qui est la seule actionnable :

| Zone | Chaînes FR | Phase |
|---|---|---|
| `requestsView` · `productsView` · `overview` · `riskView` · `qualityView` · `certificationsConsoleView` · `reportsConsoleView` · `massBalanceConsoleView` · `integrationsView` · `questionnairesBuilderView` · `materialsConsoleView` | **0 ✓** | faites |
| `productDetailView` | 14 | PHASE 8 |
| `dppView` | 9 | PHASE 10 |
| `supplierDetailView` | 7 | PHASE 8 |
| `supplyChainView` · `requestDetailView` | 3 + 3 | PHASES 9 et 8 |
| `documentsConsoleView` · `settingsConsoleView` · `suppliersView` | 2 + 1 + 1 | PHASES 8 et 12 |
| **Jeu de données de démonstration** (`demoData`) | **30** | PHASE 12 |

Soit **40 chaînes de copie d'interface** réparties sur 8 vues, plus 30 chaînes de contenu
de démonstration. Le reste du total brut (221) est constitué de fragments non-UI que mon
détecteur capture par excès de prudence.

---

## 5. Suite proposée

**PHASE 8 — Evidence + Quality.** Les deux se tiennent : l'Evidence Center
(documents, certificats, rapports d'essai, déclarations, audits, factures, relevés de
production — chacun avec Source / Date / Émetteur / Produit / Fournisseur / Statut /
Vérification / Expiration) alimente directement le Quality Center et sa question
*« Can you trust your data? »*.

C'est aussi la phase qui absorbe le plus gros reliquat de copie française
(`productDetailView`, `supplierDetailView`, `requestDetailView`, `documentsConsoleView` —
26 chaînes sur 40).

**J'attends votre validation avant de démarrer.**
