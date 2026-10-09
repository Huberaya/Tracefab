# Experience TRACEFAB — refonte de la landing, vue Risk, portail mobile, consolidation i18n

`merge/experience` → `main` · **30 commits** · 79 fichiers · +24 917 / −2 762 ·
fusionnable sans conflit.

Cette branche transforme l'expérience sans toucher au socle. **Aucune
fonctionnalité existante n'est supprimée ni remplacée** : Brand Console,
portail fournisseur, onboarding, produits et révisions, matières, demandes de
données, points de données structurés, documents, certifications, stockage des
preuves, Quality Center, traçabilité, préparation DPP, notifications, API,
multi-tenant, Clerk, Neon/Prisma, RLS et flux d'audit sont intacts. Les
modifications de `api/index.ts` sont des **ajouts** : câblage de 10 routes
orphelines et durcissement RLS.

---

## Ce que la branche livre

Neuf chantiers, chacun protégé par un test de garde chaîné dans `npm run build`.

| Chantier | Ce qu'il corrige | Test |
|---|---|---|
| **Vue Risk** | Dernière exigence P0 du cahier des charges absente de la console. Chaque signal dérive des enregistrements chargés ; une dimension sans donnée vaut zéro et l'affiche. Le score est explicitement écarté de toute valeur de certification. | `test:chantier3-risk` |
| **Démo DPP / Certifications** | Les deux vues qui portent la promesse réglementaire atterrissaient en état vide. Échéances relatives à `Date.now()`, donc jamais périmées. | `test:chantier4-demo` |
| **Portail mobile** | En 390 px, les 14 éléments cliquables du premier écran étaient tous de la navigation : **0 action de contenu → 5**. Le panneau de progression dérive désormais des données au lieu d'afficher trois « 100 % » écrits en dur à côté d'un total de 72 %. | `test:chantier5-portail` |
| **Consolidation i18n** | Quatre systèmes de traduction concurrents, dont un moteur qui repeignait le DOM à chaque mutation depuis un glossaire à source française. Six pages sur sept sur un catalogue unique. | `test:i18n` |
| **L1 · Lisibilité** | **218 nœuds de texte sous 11 px → 0.** Plancher typographique posé dans les jetons. | `test:landing-lisibilite` |
| **L2 · Colonne vertébrale** | Les 7 couches deviennent une vraie progression. Corrige au passage un bug mobile préexistant : `grid-column` posé sur un petit-fils, donc inerte — un mot par ligne. Description 64 → 254 px. | `test:landing-spine` |
| **L3 · Densité mobile** | Page mobile **11 141 → 9 473 px (−15 %)**. | `test:landing-lisibilite` |
| **L4 · Repérage** | Rail de progression monotone et sommaire du tiroir. Corrige **14 références `var(--tf-…)` pointant vers des jetons inexistants**, dont 12 préexistantes, qui échouaient silencieusement. | `test:landing-reperage` |
| **L5 · Performance** | Le design system dessine 8 graisses ; la page n'en demandait que 5, en instances statiques qui ne s'interpolent pas — **8 graisses écrasées sur 3 rendus**. Axe variable. 15 animations CSS et 10 SMIL tournaient en permanence hors champ. | `test:landing-performance` |

---

## Résultats mesurés

| | avant | après |
|---|---:|---:|
| Textes sous 11 px (landing) | 218 | **0** |
| Hauteur de page mobile | 11 141 px | **9 473 px** |
| Jetons CSS non résolus | 14 | **0** |
| Octets de police transférés | 90 040 | **44 872** |
| Requêtes de police | 5 | **2** |
| Animations actives hors champ | 15 | **0** |
| Actions de contenu, 1ᵉʳ écran mobile du portail | 0 | **5** |

**Test d'acceptation du cahier des charges — les trois personas passent :**
CEO/Fondateur **6/6** · Responsable conformité **4/4** · Fournisseur **4/4**.

---

## Vérifications

- **Matrice : 39 OK / 1 échec.** `npm run build` et `npm run typecheck` verts.
- Responsive vérifié à 320, 390, 834 et 1440 : **0 débordement horizontal**,
  **0 erreur console**.
- Chaque test de garde a été vérifié *capable d'échouer* : la régression est
  réintroduite, le test la signale, puis l'état correct est restauré.

### L'échec restant, en toute transparence

`test:supplychain:chantier3` échoue. **Il échoue à l'identique sur `main`** —
il n'est pas introduit par cette branche. Il exige le littéral
`'Tier 4 · Matières'`, vocabulaire antérieur à la refonte. Trois issues
possibles : adapter le libellé (recommandé), réintroduire la nomenclature
Tier 4…0, ou retirer le test. **C'est un arbitrage, pas un correctif.**

---

## Ce qui reste ouvert après cette fusion

Listé pour que rien ne soit découvert après coup. Détail dans
`docs/experience/CHANTIERS-RESTANTS.md`.

1. **Copie métier en dur dans les SPA** — 268 marqueurs français dans la
   console, 187 dans le portail, 9 dans le DPP. Seule la landing respecte la
   règle « aucune copie en dur dans les composants ».
2. **`tsx` non déclaré** en devDependency alors que 8 scripts en dépendent.
3. **Phases 9 à 12** sans validation formelle (contenu présent, cycle
   phase → test → validation jamais appliqué).
4. **Échelle du jeu de démonstration** : 1 fournisseur et 2 produits semés
   contre 1 248 produits / 86 fournisseurs affichés en vue d'ensemble.
5. **Badge du DPP public** affichant `EU ESPR / DPP Compliant`, ce qui
   contredit la règle « la préparation n'est pas une certification ».
6. **Arbre `locales/`** : 84 Ko sans consommateur à l'exécution, toujours
   déployé par `vercel.json`.
7. **`passport/` et `operations/`** sans i18n — pages orphelines, 0 lien
   entrant.
8. **Deux polices d'affichage** dans le même produit : Inter Tight sur la
   landing, Plus Jakarta Sans sur quatre pages dont le DPP public.
9. **27 cibles tactiles sous 40 px** sur desktop.

---

## Avertissement de branche

La branche `arena/e72cecf4-tracefab` part du même commit que celle-ci et porte
6 commits distincts (~11 000 lignes) touchant `index.html`,
`supplier-portal/index.html`, `quality-center/index.html`, `api/index.ts`,
`package.json` et `vercel.json`. **Huit fichiers sont modifiés des deux côtés**
et une fusion à blanc remonte 7 conflits. Fusionner cette PR rendra
l'intégration de l'autre branche manuelle. Décision à prendre avant de
poursuivre sur l'une ou l'autre.

---

## Documentation

Tous les rapports sont en français, dans `docs/experience/` :
`LANDING-CHANTIERS-L1-L5.md`, `CHANTIER-3-VUE-RISK.md`,
`CHANTIER-4-DEMO-DPP-CERTIFICATIONS.md`, `CHANTIER-5-PORTAIL-MOBILE.md`,
`CONSOLIDATION-I18N.md`, `TEST-ACCEPTATION-PERSONAS.md`,
`CHANTIERS-RESTANTS.md`.
