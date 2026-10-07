# Chantiers restants

État au 7 octobre 2026 · branche `merge/experience` · 11 commits d'avance sur
`main` · arbre propre.

Relevé depuis le dépôt, pas de mémoire. Les deux correctifs P0 de l'audit
Market Readiness sont appliqués et ne figurent plus ici.

---

## Synthèse

| # | Chantier | Catégorie | Priorité | Effort |
|---|---|---|---|---|
| 1 | Arbitrer `test:supplychain:chantier3` | Dette | P1 | décision |
| 2 | Déclarer `tsx` en devDependency | Dette | P1 | 1 ligne |
| 3 | Vue **Risk** absente de la console | Cahier des charges | **P0** | vue complète |
| 4 | `dpp` et `certifications` en état vide | Persona | P1 | données démo |
| 5 | Portail mobile sans action au 1ᵉʳ écran | Persona | P1 | mise en page |
| 6 | Catalogues i18n concurrents | Architecture | **P0** | **Partiel — 4 pages sur 7** |
| 7 | Copie métier en dur dans les 3 SPA | Cahier des charges | P1 | ~754 chaînes |
| 8 | Pousser le commit et ouvrir la PR | Livraison | P1 | manuel |
| 9 | Phases 9 à 12 sans validation formelle | Process | P2 | revue |
| 10 | Sort de l'arbre `locales/` | Décision | P2 | 1 décision |

Les points 3 et 6 sont requalifiés en P0 : le premier est une exigence
explicite du cahier des charges, le second est un défaut d'architecture qui
rendra tout travail i18n ultérieur plus coûteux.

---

## 1. Arbitrer `test:supplychain:chantier3` · P1

Seul échec produit de la matrice (31 tests sur 33 passent). Il exige le
littéral `'Tier 4 · Matières'` puis Tier 3/2/1/0 dans la console.

Vérifié : **il échoue à l'identique sur `origin/main`**, même assertion
`Brand console must display Tier 4 stage`. Pré-existant, non introduit par la
refonte.

Trois issues possibles, à votre main :

- adapter le test au nouveau vocabulaire de la refonte ;
- réintroduire la nomenclature Tier 4…0 dans la vue Supply Chain ;
- marquer le test comme obsolète et le retirer de la matrice.

Je recommande la première : le test protège une exigence réelle (la
profondeur de chaîne doit rester lisible), c'est son libellé qui a vieilli.

## 2. Déclarer `tsx` en devDependency · P1

`tsx` est **absent de `package.json`** alors que **8 scripts** en dépendent :
`test:bulk:chantier8`, `test:neon:bulk:chantier8`, `test:wallet:chantier9`,
`test:neon:wallet:chantier9`, `test:storage:chantier10`,
`test:neon:storage:chantier10`, `test:p2:readiness`, `db:migrations:check`.

`npx` le télécharge à l'exécution. Conséquences : build non reproductible,
tests impossibles hors ligne, version non épinglée, et en CI un
téléchargement réseau à chaque exécution. Plus sérieux que le P2 initialement
estimé, d'où le reclassement.

## 3. Vue Risk absente de la console · P0

Le cahier des charges impose la navigation : Overview, Products, Suppliers,
Materials, Supply Chain, Data Collection, Evidence, Certifications, Quality,
**Risk**, DPP, Reports, Settings.

La console compte 16 vues, **Risk n'en fait pas partie** (1 seule occurrence
du mot dans tout le fichier). C'est le principal écart du persona
Responsable Conformité, bloqué à 3/5.

## 4. Deux vues clés atterrissent en état vide · P1

| Vue | Contenu à l'arrivée |
|---|---|
| `supplyChain` | 2 391 car. · 10 blocs |
| `quality` | 2 253 car. · 3 blocs |
| `documents` | 1 791 car. · 6 blocs |
| **`dpp`** | **532 car. · 1 bloc** — « Sélectionnez un produit… » |
| **`certifications`** | **683 car. · 3 blocs** — état vide |

L'état vide est un comportement légitime en production. Mais en démonstration,
atterrir dessus prive le visiteur de la démonstration de profondeur, et ce
sont précisément les deux vues qui portent la promesse réglementaire.

## 5. Portail fournisseur mobile sans action au premier écran · P1

En 390 × 844, les **12 éléments cliquables au-dessus de la ligne de
flottaison sont tous dans la navigation** : aucune action de contenu. Le
persona Fournisseur doit « savoir immédiatement quoi faire » — sur mobile il
ne voit que des onglets. Sur desktop le critère passe (progression
« 72 % complété » visible sans défilement).

## 6. Trois systèmes i18n concurrents · P0 · **fait**

> **Partiellement consolidé — 4 des 7 pages livrées.** Le détail est dans
> `docs/experience/CONSOLIDATION-I18N.md`. Résumé : les dictionnaires inline
> de la console et du portail ont été fusionnés dans `assets/i18n/`, servi
> par le runtime existant `tf-i18n.js`. Deux défauts visibles par
> l'utilisateur sont corrigés au passage : la langue était perdue entre la
> vitrine et l'application (deux clés de stockage), et le portail repliait
> en français les clés absentes en turc, portugais et chinois.
>
> **Ce qui reste**, et que mon relevé initial avait manqué — il ne couvrait
> que 4 pages alors que le dépôt en livre 7 :
>
> | Page | État | Liée depuis |
> |---|---|---|
> | `index.html` | catalogue partagé | — |
> | `product-intelligence/` | catalogue partagé | nav |
> | `brand-console/` | catalogue partagé | nav |
> | `supplier-portal/` | catalogue partagé | nav |
> | `dpp/` | **dictionnaire inline `dppLangs`, 7 langues** | nav |
> | `quality-center/` | **aucune i18n, copie française en dur** | **3 pages** |
> | `passport/`, `operations/` | aucune i18n | 0 page (orphelines) |
>
> `quality-center/` est le constat le plus gênant : elle est atteignable
> depuis trois pages, entièrement en français codé en dur, et ne possède
> aucun mécanisme de traduction — un utilisateur allemand ou italien y
> tombe sur une page française sans recours.
>
> Reste aussi l'arbre `locales/` — voir le point 10.

### Constat d'origine

C'est le constat qui requalifie le chantier : **l'i18n n'est pas à faire,
elle est faite trois fois, de trois manières incompatibles.**

| Système | Contenu | Consommateur réel |
|---|---|---|
| `assets/i18n/` | 549 clés × 7 locales, 0 écart | `index.html`, `product-intelligence/` |
| `locales/<lang>/translation.json` | 7 langues, ~9 Ko chacune | **aucune page** — seulement `test_p1_i18n.mjs`, et déployé par `vercel.json` |
| Dictionnaires inline | `brandTranslations`, `translations`, 1 anonyme — 7 langues chacun | les 3 SPA, chacune la sienne |

Deux anomalies à traiter :

- l'arbre `locales/` est **du poids mort livré en production** : aucune page
  ne le charge, mais `vercel.json` le déploie et un test en verrouille le
  contenu. Soit on le branche, soit on le retire — en l'état il donne une
  fausse impression de couverture ;
- chaque SPA embarque son propre dictionnaire, donc une clé commune se
  traduit et se corrige à trois endroits.

Cible : une source unique, les SPA consommant `assets/i18n/`.

## 7. Copie métier en dur dans les SPA · P1

| Fichier | Chaînes UI distinctes dans le JS | `data-i18n` |
|---|---|---|
| `brand-console/index.html` | ~379 (231 Ko de script) | 0 |
| `supplier-portal/index.html` | ~304 (122 Ko) | 0 |
| `dpp/index.html` | ~71 (9 Ko) | 0 |
| `index.html` (landing) | — | 178 |

Seule la landing respecte la règle « aucune copie métier en dur dans les
composants ». Point d'attention supplémentaire : la console contient
**246 marqueurs lexicaux français** contre 551 anglais, et le portail 133
contre 358. Or la décision retenue était un **source en anglais** avec la
couche i18n par-dessus. Le flux parallèle fusionné a introduit de la copie
française en dur, et des tests verrouillent désormais des chaînes françaises
(par exemple « Partages actifs »). À arbitrer avec le point 6.

## 8. Pousser et ouvrir la PR · P1

**1 commit à pousser** (`df11a5d` → `42acf07`). La PR n'est pas ouverte : le
jeton fourni n'avait pas le périmètre `Pull requests` (403).

    bash /home/user/push_and_pr.sh <fichier-token>

puis, si le 403 persiste :
https://github.com/Huberaya/Tracefab/pull/new/merge/experience

À noter : `.git/config` est exclu des snapshots de l'espace de travail.
L'identité git et l'URL du remote ont dû être restaurées ce tour-ci, et le
seront probablement à nouveau.

## 10. Sort de l'arbre `locales/` · P2 · décision

Seul fragment i18n restant. 7 langues, ~65 Ko, aucun consommateur à
l'exécution : c'est le dictionnaire de l'**ancienne** landing, antérieure à
la refonte — ses sections (`mockup`, `signature`, `problem`) n'existent plus.

Je ne l'ai pas supprimé parce que `scripts/test_p1_i18n.mjs`, qui n'est pas
de moi, en verrouille le contenu et vérifie trois accroches de
positionnement. Le supprimer casserait ce test ; le garder laisse du poids
mort déployé par `vercel.json`. C'est un arbitrage qui vous revient :

- **le retirer** : supprimer `locales/`, l'entrée de `vercel.json`, et
  repointer les trois assertions de `test_p1_i18n.mjs` sur `assets/i18n/` ;
- **le garder** : au minimum le sortir de `vercel.json` pour cesser de le
  livrer.

## 9. Phases 9 à 12 sans validation formelle · P2

Rapports présents : phases 1, 4, 5, 6, 7, 8. **Absents : 9 (Traçabilité),
10 (DPP), 11 (DPP public), 12 (i18n).**

Leur contenu existe dans l'application, mais il provient du flux parallèle
fusionné en option A, pas de mon cycle phase → test → validation. Ces quatre
phases n'ont donc jamais reçu la batterie convenue : build, TypeScript,
tests, responsive, régression, accessibilité, performance, vérification des
routes et de l'API.

---

## Ordre d'exécution proposé

1. **Point 6** (consolidation i18n) avant le point 7 : extraire les chaînes
   vers trois dictionnaires concurrents serait du travail à refaire.
2. **Point 3** (vue Risk) : plus gros écart au cahier des charges, et il
   débloque le persona Conformité.
3. **Points 4 et 5** : peu coûteux, ils ferment les deux personas restants.
4. **Point 2** (`tsx`) : une ligne, fiabilise toute la matrice de tests.
5. **Point 1** : décision de votre part, pas de développement.
6. **Point 9** : revue de rattrapage une fois le reste stabilisé.
