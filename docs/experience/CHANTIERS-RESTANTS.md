# Chantiers restants — état vérifié

Relevé du 9 octobre 2026, en exécutant le dépôt et en interrogeant GitHub,
pas en relisant les en-têtes.

La version précédente de ce document datait du 7 octobre, annonçait
`main = 7ff4cf9` et listait sept points ouverts dont cinq étaient déjà
réglés. Un document qui décrit un état disparu coûte plus cher que pas de
document du tout.

---

## 1 · Fusionné — `main` porte tout

**Les huit PR sont fusionnées.** Plus aucune PR ouverte.
**`main` = `f4d8a73`**, CI verte.

Fusion séquentielle le 9 octobre 2026, chaque PR ré-adressée vers `main`
après sa parente :

| Ordre | PR | Chantier | `main` après fusion |
|---|---|---|---|
| 1 | #26 | 15 — i18n complet | `22d3cda` |
| 2 | #27 | 13 — DPP Readiness actionnable | `5f3245a` |
| 3 | #28 | 14 — Passeport public dynamique | `306acb7` |
| 4 | #29 | 17 — Tests E2E & CI | `571b1cd` |
| 5 | #30 | 18 — Production Readiness | `a4ebf1c` |
| 6 | #31 | 19 — Commercial Readiness | `f4aa899` |
| 7 | #32 | 16 — Sécurité & Performance | `c9c00e0` |
| 8 | #33 | 20 — Cohérence | `f4d8a73` |

14 commits, 116 fichiers. La pile était strictement linéaire — vérifié
avant fusion avec `git merge-base --is-ancestor` sur les huit maillons.

**Contrôle décisif après fusion :** l'arborescence de `main` est identique,
octet pour octet, à celle du sommet de la pile
(`49a29f6dca5ff308021690cf6755db404930c974`). Rien n'a été perdu ni
réordonné par l'empilement.

Les huit branches `experience/*` n'ont pas été supprimées. Leurs commits
sont dans `main` ; les effacer est sans risque mais n'a pas été demandé.

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

Les suites de tests n'ont pas été rejouées localement pour établir ce
relevé : `node_modules` n'est pas conservé entre les sessions. Les constats
reposent sur l'inspection du dépôt, sur l'API GitHub et sur la CI.

Après fusion, **CI run #25 sur `main` (`f4d8a73`) : verte sur ses quatre
jobs.**

Une réserve sur cette phrase, qui vaut pour tous les rapports précédents :
le job « Base — isolation RLS executee » est vert **sans rien exécuter**.
Le secret `DATABASE_URL` n'existe pas dans le dépôt, donc ses étapes
d'installation, de génération Prisma et de scénarios croisés sont
*skipped*. Le job porte un nom qui affirme une exécution qui n'a jamais eu
lieu. Les 46 tables en ENABLE rapportées aux chantiers précédents ont bien
été mesurées, mais en local contre un PostgreSQL jetable — jamais en CI, et
jamais contre Neon. À corriger en même temps que les migrations.
