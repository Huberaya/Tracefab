# Chantiers — état vérifié

État au 7 octobre 2026 · **`main` = `7ff4cf9`** · tout est fusionné ·
0 commit en attente · **matrice 40/40, zéro échec**.

Relevé en exécutant le dépôt, pas en relisant les en-têtes.

---

## Fait

**PR #1 et PR #2 fusionnées.** Les 32 commits de l'expérience, puis les quatre
arbitrages. `main` porte l'intégralité du travail.

| Chantier | Garde-fou |
|---|---|
| Vue Risk (P0 du cahier des charges) | `test:chantier3-risk` |
| Démo DPP / Certifications | `test:chantier4-demo` |
| Portail mobile actionnable | `test:chantier5-portail` |
| Consolidation i18n, 6 pages sur 7 | `test:i18n` |
| L1 lisibilité · L2 colonne vertébrale · L3 densité · L4 repérage · L5 performance | 4 suites, 73 assertions |
| **Chaîne de valeur injoignable** — `generate-baseline-chain` et `new-chain-link` codées sans bouton | `test:supplychain:chantier3` |
| **DPP ne se déclare plus conforme** | `test:pef:chantier3` |
| **`locales/` supprimé**, test repointé sur `assets/i18n/` | `test:p1-i18n` |
| **KPI dérivés des données** | `test:chantier4-demo`, 9 assertions |

Personas : **CEO 6/6 · Conformité 4/4 · Fournisseur 4/4.**

---

## Ouvert

**1 · La branche parallèle, en attente de votre lecture.**
`arena/e72cecf4-tracefab`, tête `5d7feb8`, activement développée — elle a
ajouté « Chantier 9 : surface Traçabilité » pendant que nous travaillions.
Elle porte l'**Evidence Center** (1 360 lignes, exigence du cahier des charges
que nous n'avons pas), le **Quality Center** (49 → 1 617 lignes) et une route
API. Sa landing est une réécriture incompatible avec la nôtre.
Comparaison sur pièces : `COMPARAISON-LANDINGS.html` à la racine.

**2 · `tsx` non déclaré** en devDependency alors que 8 scripts en dépendent.

**3 · Copie métier en dur dans les SPA** — 268 marqueurs français dans la
console, 187 dans le portail, 9 dans le DPP.

**4 · Phases 9 à 12** sans validation formelle.

**5 · `passport/` et `operations/`** sans i18n — orphelines, 0 lien entrant.

**6 · Deux polices d'affichage** : Inter Tight sur la landing, Plus Jakarta
Sans sur quatre pages.

**7 · 27 cibles tactiles sous 40 px** sur desktop.
