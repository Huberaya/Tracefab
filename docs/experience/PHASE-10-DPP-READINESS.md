# PHASE 10 — DPP Readiness

Vue `dpp` de la Brand Console · couche 07 de l'ossature conceptuelle.

---

## 1. Ce que la vue rendait déjà

Le score global **88 %**, un profil actif (`TEXTILE_READINESS_MVP V1.0`), et
une décomposition en quatre piliers normatifs :

| Pilier | Score |
|---|---|
| 🏷️ Identification & caractéristiques | 100 % |
| 🧵 Composition matière | 100 % |
| ☍ Traçabilité chaîne d'approvisionnement | 75 % |
| 🛡️ Qualité & preuves | 67 % |

Chaque exigence porte son état ligne par ligne : `✓ Compliant` ou
`✗ Missing`. En bas, « Remaining requirements to complete (2) », avec le code
d'exigence, le caractère bloquant ou recommandé, et la phrase qui compte :

> *Readiness is an operational indicator, not a certification.*

Cette qualification est vérifiée automatiquement par la batterie, dans les
deux sens : la vue doit contenir le mot « indicateur » **et** ne contenir
aucune revendication de conformité. Les deux contrôles passent.

## 2. Le défaut : une liste d'écarts sans issue

Le cahier des charges demande, pour cette vue, « ✓ items and ⚠ gaps + **What
is missing? action list** », et pose le principe **Overview → Explore →
Inspect → Act**.

La vue s'arrêtait à *Inspect*. J'ai mesuré la section des exigences
restantes : **0 élément cliquable, 0 curseur `pointer`**. Un responsable
conformité lisait « Raw material origin (tier 4) — BLOCKING », puis devait
deviner seul dans quel écran aller le corriger.

C'est exactement le reproche traité en phase 8 côté Quality Center, où chaque
anomalie a reçu le bouton qui la règle. La vue DPP était restée en arrière.

## 3. La correction

Chaque exigence manquante porte désormais le bouton qui mène à l'écran de
résolution. La table est indexée sur le **préfixe** du code d'exigence, pas
sur le code entier, pour couvrir aussi celles que le backend ajoutera :

```js
const DP_FIX_TARGETS = {
  supply_chain: { view: 'supplyChain', labelKey: 'supplyChain' },
  traceability: { view: 'supplyChain', labelKey: 'supplyChain' },
  quality:      { view: 'quality',     labelKey: 'quality' },
  composition:  { view: 'materials',   labelKey: 'materials' },
  product:      { view: 'products',    labelKey: 'products' },
};
```

Sans correspondance, **aucun bouton n'est rendu**. C'est délibéré : la phase 8
a déjà payé le prix de seize boutons qui ne faisaient rien. Un bouton qui ne
mène nulle part est pire que pas de bouton.

Quand la cible accepte un produit, la navigation conserve le produit courant
(`loadSupplyChain(productId)`, `loadQuality(productId)`) : on arrive sur la
traçabilité **du bon produit**, pas sur une vue vierge.

Nouvelle clé `console.dpResolveIn` sur les 7 langues, composée avec les
libellés de vue existants selon la convention maison — pas d'interpolation :

- `Resolve in Traceability` · `Corriger dans Traçabilité`
- `Beheben in Rückverfolgbarkeit` · `Resolver em Rastreabilidade`

## 4. Résultats des contrôles

Batterie `npm run test:phases`, volet phase 10 — **11/11** :

```
✓ Vue DPP Readiness atteignable              oui
✓ Vue DPP non squelettique                   1723 car.
✓ Score de preparation affiche               oui
✓ Items conformes (✓) presents               12 marques
✓ Ecarts (✗) presents                        2 marques
✓ JAMAIS presente comme certification        aucune
✓ Qualifie d indicateur de preparation       oui
✓ Liste d actions cliquables                 5 controles
✓ Chaque ecart mene a sa correction          2 boutons / 2 ecarts
✓ Aucun debordement horizontal               0px
✓ Aucune erreur JS                           0 erreur(s)
```

Le contrôle « chaque écart mène à sa correction » n'est pas un seuil : il
exige **autant de boutons que d'écarts**. Une exigence sans issue fait
échouer la batterie.

Vérifié aussi à la main : clic sur le premier bouton → bascule effective vers
`supplyChain`, et libellés corrects en français comme en anglais.

## 5. Verdict

**Phase 10 conforme après correction.** La décomposition du score était déjà
exemplaire et la précaution juridique bien tenue ; ce qui manquait était le
dernier pas du principe directeur — *Act*. Il est posé, et verrouillé par un
test qui compte les boutons.
