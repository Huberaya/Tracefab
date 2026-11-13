# P10.7 — Rapport final

Branche de travail : `arena/0f6eb7a9-tracefab` (aucune fusion, aucune modification de `main`).

## SHA

| Objet | SHA |
| --- | --- |
| Tête de la PR #121 (état initial) | `01c50a268fd7ff7050c9b59dddbff7e134bd84e9` |
| `main` de référence | `a24406dce86d805e07afae48633ccddcdac60839` |
| Candidat final (tête de branche) | `a0bb04e` |

## Commits créés

| SHA | Objet |
| --- | --- |
| `9d2bae0` | La sonde runtime s'ouvre sur le candidat + instrumentation des quatre preuves |
| `dfb3f02` | P10.8 — la session du migrateur s'ouvre aussi quand `TF_ADMIN_URL` est fourni |
| `441136e` | P10.8 — E1/E3 doivent viser la base jetable quand `TF_ADMIN_URL` est fourni |
| `d58fe79` | Preuves locales régénérées sur chaîne propre (100/100) |
| `f88b462` | La porte de sonde tourne sans build ni Prisma en CI |
| `998470a` | Résolution de l'URL Preview par l'API deployments |
| `c8b472c` | Filtrage du SHA côté client (`?sha=` est ignoré par l'API) |
| `6eb13e1` | Attente bornée du déploiement Vercel du SHA |
| `a0bb04e` | Refus sans jeton prouvés, blocages nommés, contrôle de branche |

## Phase A — Compatibilité avec `main`

`main` est un **sur-ensemble strict** de l'arbre de la PR #121 : le seul fichier
présent dans la PR et absent de `main` est `livrables-finalisation/p105-rapport-final.md`,
un livrable de rapport. **Rien à cherry-picker.** La PR #121 était `OPEN`, draft,
`CONFLICTING`/`DIRTY`, sans ancêtre commun avec `main` — d'où la comparaison par
arbres et non par plages de commits.

## Défauts trouvés et corrigés

| # | Défaut | Preuve | État |
| --- | --- | --- | --- |
| 1 | `runtimeProbeAuthorized` n'ouvrait la sonde qu'en développement local : aucune preuve runtime n'était possible sur le déploiement réel | 15/15 — Production + bonne branche + bon jeton ⇒ **false** ; Preview + branche citée + jeton ⇒ true | Corrigé (`9d2bae0`) |
| 2 | P10.8 : avec `TF_ADMIN_URL`, la session du migrateur s'ouvrait avec un mot de passe inconnu ⇒ `auth_failed` avant la migration 1 | 19/19 sans `TF_ADMIN_URL` | Corrigé (`dfb3f02`) |
| 3 | P10.8 : avec `TF_ADMIN_URL`, E1 transmettait l'URL **telle quelle** — la chaîne s'appliquait sur la base de travail, pas sur la base jetable. E3 croyait mesurer un refus de préflight, il tombait sur la migration 62 | 19/19 **avec et sans** `TF_ADMIN_URL` | Corrigé (`441136e`) |
| 4 | Le test de la porte sortait en code 2 dans le workflow : `npm ci --ignore-scripts` + Node 20 n'importe pas un `.ts` | 15/15 dans une simulation d'arbre CI sans `.prisma` | Corrigé (`f88b462`) |
| 5 | Le workflow ne pouvait pas résoudre l'URL Preview ; puis filtrait sur un `?sha=` que l'API **ignore** ; puis concluait « aucun déploiement » avant que Vercel ne l'ait créé | run 43342154582 : `Resoudre l URL Preview` = success, SHA vérifié | Corrigé (`998470a`, `c8b472c`, `6eb13e1`) |
| 6 | Le script de preuve runtime jetait les refus déjà observés si le jeton manquait, et laissait remonter une exception réseau brute | arrêt nommé, verdicts C3.1–C3.3 conservés | Corrigé (`a0bb04e`) |

## Tableau de clôture

| Contrôle | PASS/FAIL | Preuve | SHA-environnement |
| --- | --- | --- | --- |
| Compatibilité avec `main` | **PASS** | `main` ⊇ arbre PR #121 ; seul delta = un rapport | `a24406d` |
| Identité signée runtime (C1) | **FAIL (non obtenu)** | Complément local 21/21 : la base ACCEPTE le jeton signé, REJETTE clé erronée / modifié / MAC forgé / MAC majuscules / deux points / expiré / 1 an / jeton utilisateur rejoué / nul / vide. **Aucune mesure sur le processus Vercel.** | `a0bb04e` |
| HMAC chargé dans le processus réel (C2) | **FAIL (non obtenu)** | Aucune observation du processus déployé sans le jeton de sonde. Aucun secret affiché, ni en clair ni en fragment. | `a0bb04e` |
| Anti-usurpation (C3) | **FAIL (partiel)** | Local 21/21. Sur le déploiement : refus sans jeton **non mesuré** (le job s'arrête avant, secret absent). | `a0bb04e` |
| Identité PostgreSQL effective (C4) | **FAIL (non obtenu)** | Local 12/12 : `current_user = session_user = tracefab_app`, `rolbypassrls = false`, aucun membre privilégié, `SET ROLE` vers migrateur/worker refusé, RLS 53/54 forcée, 0 ligne inter-locataire dans les deux sens, GUC nul après commit, DDL refusé. **Connexion de contrôle, pas celle du runtime.** | `a0bb04e` |
| RLS et isolation tenant | **PASS (local)** | 0 ligne inter-locataire dans les deux sens ; `tracefab_app` sans BYPASSRLS | `a0bb04e` |
| Tests P10.7 | **PASS** | 10/10 suites vertes, deux passes consécutives ; `sonde-runtime-porte` 15/15 | `a0bb04e` |
| Non-régression P10.5/P10.6/P10.8 | **PASS** | 20/20 suites vertes, deux passes ; P10.8 19/19 avec **et** sans `TF_ADMIN_URL` | `a0bb04e` |
| Déploiement de validation | **FAIL (bloqué)** | Preview résolu et SHA vérifié par le workflow (run 43342154582), puis arrêt | Preview de `6eb13e1` |
| Production | **NON TESTÉ** | Aucune opération de Production effectuée | — |

## Réserves bloquantes

Les quatre preuves de runtime **ne sont pas obtenues**. Deux causes indépendantes,
toutes deux hors de portée du dépôt :

1. **Secret `TRACEFAB_RUNTIME_PROBE_TOKEN` absent** du dépôt GitHub. Mesure : le
   step « Preuves C1 à C4 » dure **0 seconde** et le script local avec la même
   entrée refuse en 44 ms ⇒ il quitte avant tout appel réseau. Sans ce secret, la
   sonde rend 401 sur son propre jeton — refus correct, mais pas une preuve.
   Provisionnement : `gh secret set TRACEFAB_RUNTIME_PROBE_TOKEN` avec la **même
   valeur** que la variable Vercel Preview. Aucune valeur n'a été inventée.
2. **La branche déployée n'est pas autorisée par la porte.** `BRANCHES_SONDE_RUNTIME`
   vaut `['release/p107-runtime-production-20261110', 'fix/tracefab-p11-identity-runtime-20261109']`.
   `arena/0f6eb7a9-tracefab` n'y figure pas : même avec le bon jeton, le runtime
   déployé rendrait 401. Le contrôle ajouté en `a0bb04e` le mesure et échoue
   explicitement au lieu de laisser croire à un défaut de sécurité.

Le déploiement Vercel s'est également arrêté après `6eb13e1` : plus aucun
déploiement n'est créé pour les SHA suivants, ce qui a bloqué le run `a0bb04e`.

## Décision

# GO SOUS RÉSERVES

Les corrections sont livrées et prouvées, toute la non-régression est verte, et
les mécanismes de sécurité (identité signée, HMAC, anti-usurpation, identité
PostgreSQL, RLS) sont démontrés **localement, avec le vrai code du dépôt**. Les
quatre preuves de runtime exigées par la clôture **ne sont pas obtenues**, donc
P10.7 ne peut pas être déclaré terminé.

## Actions restantes

1. `gh secret set TRACEFAB_RUNTIME_PROBE_TOKEN` (valeur identique côté Vercel Preview).
2. Ajouter `arena/0f6eb7a9-tracefab` à `BRANCHES_SONDE_RUNTIME`, **ou** déployer
   `release/p107-runtime-production-20261110` au SHA candidat et pousser les
   correctifs sur cette branche — la seconde option ne change pas le code de
   sécurité et respecte la liste gelée.
3. Relancer `P10.7 — preuves runtime sur la Preview réelle` sur le SHA candidat,
   vérifier que les steps 9 et 10 passent, et récupérer l'artefact
   `p107-preuves-runtime`.
4. Alors seulement, basculer la décision et ouvrir la décision de fusion de la PR #121.

## Ce qui n'est pas une preuve

Un script local, un test unitaire, une variable déclarée dans un tableau de bord,
un job CI qui rejoue le code sur le runner, ou une connexion PostgreSQL de
contrôle **ne sont pas** des preuves de runtime. Les résultats locaux ci-dessus
sont étiquetés « complément local » et le resteront dans le dossier
`livrables-finalisation/preuves/`.
