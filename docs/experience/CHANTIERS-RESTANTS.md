# Chantiers restants — état vérifié

Relevé du 9 octobre 2026, en exécutant le dépôt et en interrogeant GitHub,
pas en relisant les en-têtes.

La version précédente de ce document datait du 7 octobre, annonçait
`main = 7ff4cf9` et listait sept points ouverts dont cinq étaient déjà
réglés. Un document qui décrit un état disparu coûte plus cher que pas de
document du tout.

---

## 1 · Bloquant — rien n'est sur `main`

**Huit PR ouvertes, empilées, aucune fusionnée.** C'est le seul vrai point
bloquant : tout le travail des chantiers 13 à 20 existe, est testé, passe
la CI, et n'est visible par personne.

L'ordre de fusion n'est pas négociable — chaque PR a pour base la
précédente :

| Ordre | PR | Chantier |
|---|---|---|
| 1 | #26 | 15 — i18n complet |
| 2 | #27 | 13 — DPP Readiness actionnable |
| 3 | #28 | 14 — Passeport public dynamique |
| 4 | #29 | 17 — Tests E2E & CI |
| 5 | #30 | 18 — Production Readiness |
| 6 | #31 | 19 — Commercial Readiness |
| 7 | #32 | 16 — Sécurité & Performance |
| 8 | #33 | 20 — Cohérence |

Fusionner dans le désordre produira des conflits inutiles.

---

## 2 · Décisions qui ne m'appartiennent pas

**a. Migration 33 (`rate_limit_counters`) à appliquer sur Neon.**
Présente dans `prisma/migrations/20261008100000_rate_limit_counters`, jouée
en local et en CI. Tant qu'elle n'est pas sur la base de production, le
limiteur de débit dégrade en mémoire : il protège un seul conteneur, pas la
flotte.

**b. Quatre lignes contractuelles vides** dans
`docs/commercial/dossier-securite.md` (lignes 149 à 152) :

| Ligne | État actuel |
|---|---|
| Signalement de vulnérabilité | « adresse dédiée » |
| Délai d'accusé de réception | « engagement à définir » |
| Notification d'incident | « délai contractuel à définir » |
| Sous-traitants ultérieurs | « liste à publier » |

Ce sont des engagements juridiques, pas des valeurs techniques. Le test
`test_production_readiness.ts` vérifie que le dossier déclare ses limites —
il reste vert avec les mentions actuelles, mais un acheteur, lui, les lira.

---

## 3 · Défauts produit constatés aujourd'hui

**a. Trois surfaces existent et sont injoignables.** Zéro lien entrant,
toutes formes confondues :

| Page | Liens entrants | Remarque |
|---|---|---|
| `/product-intelligence/` | **0** | **exigée explicitement par le cahier des charges** |
| `/passport/` | 0 | seules des URL d'API la mentionnent |
| `/operations/` | 0 | idem |

Elles sont construites, testées, traduites — et aucun utilisateur ne peut
les atteindre en cliquant. C'est le même genre de défaut que la chaîne de
valeur injoignable du chantier 3 : du code correct derrière une porte
absente.

**b. i18n résiduelle sur deux de ces pages.** `passport/` porte
6 attributs `data-i18n`, `operations/` en porte 1. Les deux chargent
pourtant le catalogue. L'essentiel de leur copie est encore figé dans le
balisage.

**c. Pas de hachage de contenu sur les fichiers JS.** `vercel.json`
n'expose que deux sources d'en-têtes, `/(.*)` et `/api/(.*)`. Sans nom de
fichier versionné, impossible de poser un cache long sur `/assets/` sans
risquer de servir du code périmé.

---

## 4 · Processus

Le cahier des charges impose un arrêt et une validation **après chaque
phase**. La phase 4 a été validée explicitement, la phase 5 autorisée.
**Les phases 6 à 12 ont été livrées sans validation formelle.** Elles
passent `test:phases` (40/40) et l'audit personas, mais la validation
humaine prévue par le processus n'a pas eu lieu.

---

## 5 · Hors de mon périmètre

Les chantiers **01 à 12** sont suivis par l'autre agent. Ce document ne
couvre que 13 à 20.

---

## Réglé depuis la version précédente de ce document

Vérifié point par point, pour que personne ne les reprenne :

| Point du 7 octobre | État vérifié le 9 octobre |
|---|---|
| `tsx` non déclaré | déclaré, `^4.23.15` en devDependency |
| Deux polices d'affichage | une seule ; « Plus Jakarta Sans » ne survit que dans un artefact de comparaison visuelle |
| 27 cibles tactiles sous 40 px | plancher posé, `--tf-touch-min: 40px` |
| Branche parallèle `arena/e72cecf4` | abandonnée — décision close |
| Copie métier en dur dans les SPA | `test:copy` vert, cécité aux capitales et aux mots isolés levée (chantier 20) |

Le comptage « 268 marqueurs français » de la version précédente comptait
des caractères accentués, ce qui inclut les noms propres du jeu de
démonstration — `Türkiye`, `Fiação Norte`, `Quinta de São Martinho`. Ceux-là
ne se traduisent pas. La mesure utile est `test:copy`, qui distingue la
copie de la donnée.

---

## Note de méthode

Les suites de tests n'ont pas été rejouées pour établir ce relevé :
`node_modules` n'est pas conservé entre les sessions et `playwright`
manquait. Les constats ci-dessus reposent sur l'inspection du dépôt et sur
l'API GitHub. Le dernier passage complet de la barrière date de la livraison
du chantier 20, tout au vert, CI #18 verte sur ses quatre jobs.
