# PR #121 — Préparation à la fusion

**Aucune fusion effectuée.** Ce document prépare la décision ; il ne la prend pas.

## Pourquoi #121 ne peut pas être fusionnée en l'état

| Constat | Mesure |
| --- | --- |
| État | `OPEN`, **draft** |
| Mergeabilité GitHub | `CONFLICTING` (« dirty ») |
| Tête | `01c50a268fd7ff7050c9b59dddbff7e134bd84e9` |
| Base | `main` |
| Ancêtre commun avec `main` | **aucun** |
| Écart réel avec `main` | `main` est un **sur-ensemble strict** de l'arbre de #121 |

La branche `release/p107-runtime-production-20261110` n'a pas d'histoire commune
avec `main` : GitHub ne peut donc pas la fusionner, alors même que **son contenu
est déjà dans `main`**, à un fichier près (`livrables-finalisation/p105-rapport-final.md`,
un livrable de rapport).

Fusionner #121 en l'état reviendrait à tenter de réintégrer du contenu déjà
présent : soit un conflit total, soit un écrasement. Dans les deux cas sans
valeur et avec un risque réel.

## La voie sûre

Le contenu validé de P10.7 **est déjà sur la branche de session**
`arena/0f6eb7a9-tracefab`, au SHA `cdc7adc`, qui est un descendant direct de
`main` (`a24406d`).

Mesure faite : `git merge a24406d` sur `cdc7adc` rend **« Already up to date »**,
**zéro conflit**. Le candidat contient déjà tout `main`.

La fusion doit donc se faire **depuis la branche de session**, pas depuis la
branche de la PR #121 :

1. les quatre preuves de runtime C1–C4 obtenues (voir plus bas) ;
2. une PR ouverte depuis `arena/0f6eb7a9-tracefab` vers `main` ;
3. revue et fusion de **cette** PR ;
4. #121 fermée ensuite, **sans fusion**, en renvoyant à la PR de la branche de
   session — son contenu y est déjà intégralement.

## Ce qui manque avant d'ouvrir la PR de fusion

| Prérequis | État |
| --- | --- |
| Compatibilité avec `main` | **Acquis** — descendant direct, zéro conflit |
| Corrections P10.7 livrées | **Acquis** — 6 défauts corrigés, 10 commits |
| Non-régression P10.5/P10.6/P10.8 | **Acquis** — 20/20 suites, deux passes |
| C1 identité signée runtime | **Manquant** |
| C2 HMAC chargé dans le processus réel | **Manquant** |
| C3 anti-usurpation sur le déploiement | **Partiel** (local 21/21) |
| C4 identité PostgreSQL du runtime | **Manquant** |

Les quatre preuves manquantes exigent un déploiement Preview du SHA `cdc7adc`,
le secret de sonde et une branche autorisée. Voir la section « Blocages » du
rapport final.

## Interdits respectés

Aucune fusion, aucun push sur `main`, aucune modification de la PR #121, aucun
secret affiché ou transmis, aucun contournement de la protection Vercel.
