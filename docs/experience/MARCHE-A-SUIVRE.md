# Marche à suivre

État au 7 octobre 2026. Ce document ne liste que ce que **vous** avez à faire.
Tout le reste, je l'enchaîne dès que vous avez tranché.

---

## La situation en une phrase

Deux branches ont refait le même produit en parallèle, **sans se connaître**.
Elles ne se recouvrent pas : chacune a construit ce que l'autre n'a pas.

| Fichier | `main` | **notre branche** | **branche parallèle** |
|---|---:|---:|---:|
| `index.html` (landing) | 2 211 | **640** | 2 941 |
| `brand-console/` (vue Risk) | 4 302 | **4 544** | 4 302 |
| `dpp/` | 1 312 | **1 253** | 1 312 |
| `quality-center/` | 49 | 73 | **1 617** |
| `evidence/` | — | — | **1 360** |
| `supplier-portal/` | 1 272 | 1 256 | **2 377** |

Lecture : **nous** portons la landing, le design system, la couche i18n, la vue
Risk et le DPP. **Eux** portent l'Evidence Center, le Quality Center et
l'approfondissement du portail. Le cahier des charges exige les deux.

**Le seul vrai conflit est la landing** : deux réécritures incompatibles, sur
deux design systems différents (`tracefab-core+site.css` chez nous,
`tracefab-ds.css` chez eux — notre fichier n'existe même pas sur leur branche).
Il faudra en choisir une. Les autres apports sont en grande partie des
**fichiers neufs**, donc intégrables sans conflit.

---

## Étape 1 · Fusionner la PR #1

<https://github.com/Huberaya/Tracefab/pull/1>

Bouton **Merge pull request** → choisir **Create a merge commit** (pas
*Squash* : les 31 commits portent chacun la mesure et le raisonnement qui
justifient le changement ; les écraser perd cette traçabilité, qui est
précisément ce qu'un dépôt d'audit doit conserver).

**Pourquoi en premier.** C'est la seule des deux branches dont la matrice est
verte et mesurée (39 tests, 3 personas, build et typecheck). Elle apporte le
design system et la couche i18n sur lesquels tout le reste devra s'appuyer.
Elle est `mergeable: clean`, zéro conflit avec `main`.

**Ce que ça ne casse pas.** Aucune fonctionnalité existante n'est retirée. Les
modifications d'`api/index.ts` sont des ajouts. L'unique test en échec,
`test:supplychain:chantier3`, **échoue déjà sur `main` aujourd'hui** : la
fusion ne dégrade rien.

---

## Étape 2 · Me dire quoi faire de la branche parallèle

`arena/e72cecf4-tracefab` — 6 commits, ~11 000 lignes.

**Ma recommandation : garder ses trois apports, écarter sa landing.**

| Ce qu'elle apporte | Recommandation | Conflit ? |
|---|---|---|
| `evidence/index.html` — Evidence Center, **exigence du cahier des charges que nous n'avons pas du tout** | **à reprendre** | aucun, fichier neuf |
| `api/_routes/documents.ts` + 3 routes déclarées | **à reprendre** | aucun, fichier neuf |
| `quality-center/` — workflow CAP, 49 → 1 617 lignes | **à reprendre** | faible, notre version est un squelette |
| `supplier-portal/` — 23/23 routes, 8 actions | **à réconcilier à la main** | réel, nous y avons fait le premier écran mobile |
| Réécriture de la landing + `tracefab-ds.css` | **à écarter** | total, et notre landing est la version mesurée |

Le travail de portage est à ma charge : leurs pages sont stylées sur leur
design system, il faut les reposer sur le nôtre. Dites simplement **oui** à
cette recommandation, ou corrigez-la.

---

## Étape 3 · Vos quatre arbitrages

Aucun développement, seulement des décisions. Vous pouvez répondre en quatre
mots.

**3.1 · `test:supplychain:chantier3`** — il exige le littéral
`'Tier 4 · Matières'`, vocabulaire d'avant la refonte. Il échoue déjà sur
`main`.
➜ *Ma recommandation : adapter le libellé du test au nouveau vocabulaire.* Le
test protège une exigence réelle — la profondeur de chaîne doit rester lisible
— c'est seulement son libellé qui a vieilli.

**3.2 · Échelle du jeu de démonstration** — 1 fournisseur et 2 produits semés,
contre 1 248 produits / 86 fournisseurs affichés en vue d'ensemble. Un
responsable conformité qui passe d'un écran à l'autre voit l'écart.
➜ *Ma recommandation : dériver les KPI des données réellement chargées.* Plus
honnête et moins coûteux à maintenir, mais cela s'écarte des chiffres
littéraux de votre cahier des charges — d'où l'arbitrage.

**3.3 · Badge du DPP public** — il affiche `EU ESPR / DPP Compliant`, ce qui
contredit votre propre règle : la préparation n'est pas une certification.
➜ *Ma recommandation : le remplacer par une formulation de préparation.* C'est
le seul point de la liste qui porte un risque juridique.

**3.4 · Arbre `locales/`** — 84 Ko, aucun consommateur à l'exécution, toujours
déployé par `vercel.json`, et verrouillé par un test qui n'est pas de moi.
➜ *Ma recommandation : le retirer et repointer les trois assertions sur
`assets/i18n/`.*

---

## Étape 4 · Ce que j'enchaîne ensuite, sans vous

Dès les étapes 1 à 3 faites, et dans cet ordre :

1. déclarer `tsx` en devDependency (8 scripts en dépendent, build non
   reproductible sans lui) ;
2. porter l'Evidence Center et le Quality Center sur notre design system ;
3. réconcilier le portail fournisseur ;
4. externaliser la copie métier en dur — 268 marqueurs dans la console, 187
   dans le portail, 9 dans le DPP ;
5. rattraper les phases 9 à 12 avec la batterie convenue ;
6. unifier les deux polices d'affichage, corriger les 27 cibles tactiles sous
   40 px.

---

## Ce que vous n'avez pas à faire

- **Rien à installer, rien à exécuter.** Les tests, mesures et captures sont de
  mon côté.
- **Pas besoin de régénérer le jeton** : il porte désormais
  `Pull requests: write`, je peux agir sur les PR.
- **Ne fusionnez pas la branche parallèle** avant l'étape 2 : dans l'état, elle
  écraserait la landing mesurée.
