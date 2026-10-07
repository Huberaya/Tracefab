# Chantiers — état vérifié

État au 7 octobre 2026 · branche `merge/experience` · **29 commits d'avance sur
`origin/main`** · arbre propre · HEAD `502d57f`.

Relevé en exécutant le dépôt, pas en relisant les en-têtes des rapports. Chaque
ligne « fait » ci-dessous a un test de garde qui passe à l'instant du relevé ;
chaque ligne « ouvert » a été vérifiée par une commande, pas supposée.

> **La réponse courte : non, tout n'est pas fait.** Neuf chantiers sont livrés,
> neuf restent ouverts. Et surtout : **rien n'est fusionné.** Les 29 commits
> vivent sur une branche, le dépôt ne porte **aucune pull request**, tous états
> confondus. Qui regarde `main` ne voit rien de ce travail.

---

## 1. Livrés — 9

Vérifiés par exécution : `npm run test:<nom>` passe pour chacun.

| # | Chantier | Garde-fou | État |
|---|---|---|---|
| 3 | Vue **Risk** absente de la console (P0, exigence du cahier des charges) | `test:chantier3-risk` | **OK** |
| 4 | `dpp` et `certifications` atterrissaient en état vide | `test:chantier4-demo` | **OK** |
| 5 | Portail fournisseur sans action au premier écran mobile | `test:chantier5-portail` | **OK** |
| 6 | Catalogues i18n concurrents (P0) — **6 pages sur 7** | `test:i18n` | **OK** |
| L1 | Lisibilité : 218 textes sous 11 px → 0 | `test:landing-lisibilite` | **OK** |
| L2 | Colonne vertébrale des 7 couches + bug mobile préexistant | `test:landing-spine` | **OK** |
| L3 | Densité mobile : page 11 141 → 9 473 px | `test:landing-lisibilite` (l. 94, 100) | **OK** |
| L4 | Repérage : rail de progression + sommaire du tiroir | `test:landing-reperage` | **OK** |
| L5 | Performance : axe variable, animations en veille | `test:landing-performance` | **OK** |

Le chantier 5, dont vous m'avez joint le rapport, est bien **fait** : son test
de 40 assertions passe, et les trois personas qu'il débloquait passent
(CEO 6/6 · Conformité 4/4 · Fournisseur 4/4).

**Matrice complète à l'instant : 39 OK / 1 échec.** `build` et `typecheck`
verts.

---

## 2. Ouverts — 9

### Ce qui bloque la livraison

**A. La PR n'est pas ouverte.** *P1 · un clic · le plus conséquent.*

Vérifié par l'API GitHub : le dépôt porte **0 pull request**, états ouverts et
fermés confondus. Les 29 commits sont poussés sur `origin/merge/experience` et
n'ont aucun chemin vers `main`.

Le jeton fourni est *fine-grained* avec `Pull requests: Read` — il lit les PR,
il ne peut pas en créer. C'est pourquoi ce point n'a jamais pu être fait de mon
côté.

- <https://github.com/Huberaya/Tracefab/pull/new/merge/experience>
- corps prêt à coller : `docs/experience/PR-merge-experience.md`

### Ce qui demande une décision de votre part — 4

**B. Arbitrer `test:supplychain:chantier3`.** *P1 · décision, pas de code.*
Seul échec de la matrice. Il exige le littéral `'Tier 4 · Matières'`. **Il
échoue à l'identique sur `origin/main`** : préexistant, non introduit par la
refonte. Trois issues — adapter le libellé au nouveau vocabulaire
(recommandé), réintroduire la nomenclature Tier 4…0, ou retirer le test.

**C. Échelle du jeu de démonstration.** *P2 · proposé trois fois, sans réponse.*
`demoData()` sème 1 fournisseur, 2 produits, 1 matière. La vue d'ensemble
affiche 1 248 produits / 86 fournisseurs / 214 sites / 18 pays. Un responsable
conformité qui passe de l'une à l'autre lit 86 d'un côté et 1 de l'autre.
Étoffer le jeu, ou dériver les KPI des données chargées — la seconde est plus
honnête, mais s'écarte des valeurs littérales du cahier des charges.

**D. Sort de l'arbre `locales/`.** *P2.* 84 Ko, zéro consommateur à l'exécution,
mais déployé par `vercel.json` et verrouillé par `test_p1_i18n.mjs`. Poids mort
livré en production. Aucun impact sur la performance des pages — c'est de
l'hygiène de dépôt.

**E. Le badge du DPP public.** *Signalé deux fois, sans réponse.* Il affiche
`EU ESPR / DPP Compliant`, ce qui contredit votre propre règle : la préparation
n'est pas une certification. Les 76 lignes orphelines après `</html>` dans
`dpp/index.html` (onglet Réparabilité / Recyclabilité / Économie circulaire)
attendent le même arbitrage — préexistantes sur `origin/main`.

### Ce qui demande du travail — 4

**F. Copie métier en dur dans les SPA.** *P1 · le plus gros poste restant.*
Mesuré à l'instant :

| Fichier | Appels au résolveur i18n | Marqueurs français en dur |
|---|---:|---:|
| `brand-console/index.html` | 71 | **268** |
| `supplier-portal/index.html` | 28 | **187** |
| `dpp/index.html` | 1 | **9** |

Le cahier des charges demande « aucune copie métier en dur dans les
composants ». Seule la landing respecte la règle (178 `data-i18n`). Les
chantiers 3 à 6 ont externalisé les écrans qu'ils touchaient ; le reste tient.

**G. `tsx` non déclaré.** *P1 · une ligne.* Vérifié absent de `package.json`
alors que **8 scripts** en dépendent. `npx` le télécharge à l'exécution : build
non reproductible, tests impossibles hors ligne, version non épinglée.

**H. Phases 9 à 12 sans validation formelle.** *P2.* Rapports présents : 1, 4,
5, 6, 7, 8. Absents : **9 (Traçabilité), 10 (DPP), 11 (DPP public),
12 (i18n)** — vérifié. Leur contenu existe dans l'application mais provient du
flux parallèle fusionné, pas du cycle phase → test → validation que vous aviez
fixé. Ces quatre phases n'ont jamais reçu la batterie convenue.

**I. Deux pages orphelines sans i18n.** *P2.* `passport/` et `operations/` :
0 référence i18n, 0 lien entrant. Leur migration n'a de sens qu'une fois tranché
leur sort — supprimer ou rebrancher.

---

## 3. Relevés en chemin, non traités — 2

Trouvés pendant L5, hors de son périmètre, volontairement non corrigés.

**J. Deux polices d'affichage dans le même produit.** Inter Tight sur la
landing, **Plus Jakarta Sans** sur quatre pages dont le DPP public. Trois
requêtes Google Fonts distinctes, aucun partage de cache entre les pages. C'est
un écart au design system déclaré ; unifier une identité typographique est une
décision de marque, pas un correctif de performance.

**K. 27 cibles tactiles sous 40 px** sur desktop (3 sur tactile). Sous le seuil
d'accessibilité recommandé.

---

## 4. Ordre proposé

1. **A — ouvrir la PR.** Un clic. Tant qu'elle n'est pas ouverte, les neuf
   chantiers livrés n'existent pour personne d'autre que cette branche.
2. **G — `tsx`.** Une ligne, fiabilise toute la matrice.
3. **B, C, D, E — vos quatre arbitrages.** Aucun développement, ils débloquent
   la suite.
4. **F — externalisation des chaînes.** Le plus gros poste, à faire après B–E
   pour ne pas externaliser des chaînes qui vont changer.
5. **H — rattrapage des phases 9 à 12.**
6. **I, J, K** en dernier.
