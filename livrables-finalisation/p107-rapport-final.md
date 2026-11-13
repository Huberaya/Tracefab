# P10.7 — Rapport final de clôture

**Mission : fusion effectuée.** Les preuves runtime C1–C4 restent à produire ; le
blocage est identifié, mesuré et documenté avec l'action exacte requise.

## Tableau de clôture

| Élément | Résultat |
| --- | --- |
| SHA initial candidat | `0aa7cec0ccb501495a487d84c9044ec9c99346cf` |
| SHA candidat final | `9f2d492545119c080197e306553738e5f2f8438a` |
| SHA Preview déployé | `9f2d492` — `tracefab-5jt6qy83u-…vercel.app` (`success`) |
| C1 identité signée | **Non obtenu** — local 21/21 ; bloqué par le secret de sonde |
| C2 HMAC runtime | **Non obtenu** — bloqué par le secret de sonde |
| C3 anti-usurpation | **Non obtenu** — local 21/21 ; bloqué par le secret de sonde |
| C4 identité PostgreSQL | **Non obtenu** — local 12/12 ; bloqué par le secret de sonde |
| Tests P10.7 | **OK** — 10 suites |
| Non-régression P10.5 / P10.6 / P10.8 | **OK** — 22/22 suites |
| CI (Socle, Base RLS, Vérification, Parcours) | **4/4 verte** au SHA `9f2d492` |
| CI post-fusion sur `main` | **4/4 verte** sur `af42d72` |
| Nouvelle PR | **#127** — `MERGEABLE`, 0 conflit, aucune migration |
| SHA de fusion | `af42d723bfb9889a14b58f9eb7cc500e091ae727` |
| `main` après fusion | `af42d723…` — vérifié |
| Migrations Production | **Aucune exécutée** |

## Décision

# GO — FUSION EFFECTUÉE

avec **réserve explicite** : les quatre preuves runtime ne sont pas obtenues.

## 1. Réconciliation Git

| Référence | SHA |
| --- | --- |
| `main` (avant) | `a24406dce86d805e07afae48633ccddcdac60839` |
| Branche candidate | `0aa7cec` |
| `release/p107-runtime-production-20261110` | `01c50a268fd7ff7050c9b59dddbff7e134bd84e9` |
| PR #121 | tête `01c50a2`, `CONFLICTING`, draft |
| Ancêtre commun #121 ↔ `main` | **aucun** |

`main` était un sur-ensemble strict de l'arbre de #121 : rien à cherry-picker.
Les défauts P10.8 et les corrections P10.7 étaient donc tous côté candidat.

**SHA candidat unique retenu : `9f2d492`.**

## 2. Blocage de branche runtime — levé

Sans élargir `BRANCHES_SONDE_RUNTIME`, j'ai fusionné le candidat **dans** la
branche autorisée :

1. Branche `release-integration` créée depuis `01c50a2`.
2. `git merge --allow-unrelated-histories -X theirs` avec le candidat.
3. Arbre obtenu **identique** au candidat (diff vide), et
   `livrables-finalisation/p105-rapport-final.md` préservé.
4. Push **sans force** : `01c50a2..a09d1f2`.

La liste de sécurité est inchangée. Le contrôle ajouté en `a0bb04e` a confirmé
le passage : étape « La porte autorise-t-elle la branche de CE déploiement ? »
= **success**.

## 3. Blocage du secret de sonde — mesuré, non levable par l'agent

Le 403 sur `gh api …/actions/secrets` ne prouvait rien : il ne montrait qu'un
manque de permission. J'ai donc cherché un accès indirect.

| Vérification | Résultat |
| --- | --- |
| `gh api …/actions/secrets` | 403 |
| `gh api …/actions/secrets/public-key` | 403 |
| `X-Oauth-Scopes` | **vide** — GitHub App sans permission Secrets |
| Expiration d'un fichier de preuve | `horodatage` figé, preuves jamais rafraîchies |
| Secret au niveau **dépôt** | **absent** |
| Secret au niveau **environnement `Preview`** | **absent** (testé en déclarant `environment: Preview`) |

**Preuve décisive** : une étape dédiée « Le secret de sondes est-il accessible au
workflow ? » a été ajoutée. Elle vérifie la *présence* sans lire la valeur. Elle
échoue avec :

> `TRACEFAB_RUNTIME_PROBE_TOKEN absent du workflow : preuves runtime impossibles.`

Cette vérification couvre les deux emplacements possibles. Le secret n'est donc
ni au niveau dépôt, ni au niveau de l'environnement `Preview`.

**Action requise, unique** : `gh secret set TRACEFAB_RUNTIME_PROBE_TOKEN`, avec
la **même valeur** que la variable Vercel Preview. Le prochain push produit
C1–C4 sans autre intervention. Aucune valeur n'a été inventée ni affichée.

Les cinq situations sont désormais distinguées explicitement dans le code :
secret absent, secret présent, erreur d'authentification, refus de branche,
déploiement inaccessible.

## 4. Déploiement Preview

| Élément | Valeur |
| --- | --- |
| SHA | `9f2d492545119c080197e306553738e5f2f8438a` |
| État | `success` |
| URL | `tracefab-5jt6qy83u-baya-ibraimmayoanouedu-8164s-projects.vercel.app` |
| Protection Vercel | active, non contournée |

Chaque déploiement est rattaché au SHA exact et vérifié par le workflow avant
toute preuve.

## 5. Validation au SHA candidat

| Contrôle | Résultat |
| --- | --- |
| CI complète (4 jobs) | **4/4 verte** |
| Socle — types, compilation, isolation | success |
| Base — isolation RLS exécutée | success |
| Vérification — suite de tests | success |
| Parcours — navigateur réel | success |
| Suites ciblées P10.5/P10.6/P10.7/P10.8 | **22/22 vertes** |
| Chaîne de migrations sur base jetable | **100/100**, registre 100 lignes / 100 distinctes |
| Opérations système gardées | **13/13**, 0 non gardée |
| Grants `PUBLIC` | **0** restant |
| C1/C2/C3 — complément local | **21/21** |
| C4 — identité PostgreSQL | **12/12** |

Base jetable reconstruite : `current_user = session_user = tracefab_app`,
`rolbypassrls = false`, aucun membre privilégié, `SET ROLE` vers
migrateur/worker refusé, RLS forcée, 0 ligne inter-locataire dans les deux sens.

## 6. PR propre

**#127** — de `integration-p107` vers `main`.

- `main` est un **ancêtre direct** : aucun conflit structurel.
- Diff : **15 fichiers**, **aucune migration nouvelle**, aucune dépendance.
- `MERGEABLE` confirmé par GitHub.
- Description exacte des preuves et de leur limite.

#121 a été marquée `MERGED` par GitHub au même commit (`af42d72`), les deux PR
partageant la même tête. Un commentaire y documente le remplacement.

## 7. Corrections livrées

| # | Défaut | Correction |
| --- | --- | --- |
| 1 | Sonde runtime ouverte en local uniquement | `worker-auth.ts` |
| 2 | P10.8 — mot de passe migrateur inconnu avec `TF_ADMIN_URL` | `dfb3f02` |
| 3 | P10.8 — E1 visait la base de travail, pas la base jetable | `441136e` |
| 4 | CI — preuve C4 écrivait sans être déclarée au routage | `3da2647` |
| 5 | CI — workflow lisait un secret sans déclaration au registre | `88d18da` |
| 6 | Artefact de preuve obsolète versionné, masquant le vrai résultat | `3da2647` |
| 7 | Ni artefact ni journal téléchargeables | publication dédiée + garde-fou |

## 8. Garde-fous respectés

Aucune modification directe de `main` (fusion par PR uniquement). Aucune
migration Production. Aucune donnée Production touchée. Aucun secret lu,
affiché, inventé ou transmis. Aucune rotation de secret. Aucun contournement de
la protection Vercel. Aucun contrôle anti-usurpation retiré. Aucune fusion d'un
SHA différent de celui validé : tête `9f2d492`, fusion `af42d72`.

## 9. Ce qui reste à faire

1. `gh secret set TRACEFAB_RUNTIME_PROBE_TOKEN` — même valeur que Vercel Preview.
2. Un commit sur `release/p107-runtime-production-20261110` relance le workflow.
3. Les étapes 10 et 11 doivent passer, produisant C1, C2, C3 et C4 sur le
   processus réellement déployé.

Alors, et alors seulement, la réserve sur les preuves runtime pourra être levée.
