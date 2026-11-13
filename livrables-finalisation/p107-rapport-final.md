# P10.7 — Rapport final

Branche de travail : `arena/0f6eb7a9-tracefab` (aucune fusion, aucune modification de `main`).

## SHA

| Objet | SHA |
| --- | --- |
| Tête de la PR #121 (état initial) | `01c50a268fd7ff7050c9b59dddbff7e134bd84e9` |
| `main` de référence | `a24406dce86d805e07afae48633ccddcdac60839` |
| Candidat final (tête de branche) | `eb37ef4` |

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
| `cdc7adc` | Rapport Phase F |
| `eb37ef4` | Préparation de la fusion de la PR #121, sans la fusionner |

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
| Identité signée runtime (C1) | **FAIL (non obtenu)** | Complément local 21/21 : la base ACCEPTE le jeton signé, REJETTE clé erronée / modifié / MAC forgé / MAC majuscules / deux points / expiré / 1 an / jeton utilisateur rejoué / nul / vide. **Aucune mesure sur le processus Vercel.** | `eb37ef4` |
| HMAC chargé dans le processus réel (C2) | **FAIL (non obtenu)** | Aucune observation du processus déployé sans le jeton de sonde. Aucun secret affiché, ni en clair ni en fragment. | `eb37ef4` |
| Anti-usurpation (C3) | **FAIL (partiel)** | Local 21/21. Sur le déploiement : refus sans jeton **non mesuré** (le job s'arrête avant, secret absent). | `eb37ef4` |
| Identité PostgreSQL effective (C4) | **FAIL (non obtenu)** | Local 12/12 : `current_user = session_user = tracefab_app`, `rolbypassrls = false`, aucun membre privilégié, `SET ROLE` vers migrateur/worker refusé, RLS 53/54 forcée, 0 ligne inter-locataire dans les deux sens, GUC nul après commit, DDL refusé. **Connexion de contrôle, pas celle du runtime.** | `eb37ef4` |
| RLS et isolation tenant | **PASS (local)** | 0 ligne inter-locataire dans les deux sens ; `tracefab_app` sans BYPASSRLS | `eb37ef4` |
| Tests P10.7 | **PASS** | 10/10 suites vertes, deux passes consécutives ; `sonde-runtime-porte` 15/15 | `eb37ef4` |
| Non-régression P10.5/P10.6/P10.8 | **PASS** | 20/20 suites vertes, deux passes ; P10.8 19/19 avec **et** sans `TF_ADMIN_URL` | `eb37ef4` |
| Déploiement de validation | **PASS (partiel)** | Preview `eb37ef4` en `success` ; workflow : URL résolue, SHA vérifié, branche REFUSÉE (run 43404765222) | `eb37ef4` → `tracefab-1p0skmiki…vercel.app` |
| Production | **NON TESTÉ** | Aucune opération de Production effectuée | — |

## Réserves bloquantes

### Ce qui est désormais mesuré sur le déploiement réel

Run **43404765222**, SHA `eb37ef4`, Preview `tracefab-1p0skmiki-…vercel.app` :

| Step | Résultat |
| --- | --- |
| Résolution de l'URL Preview par l'API deployments | **success** |
| Refus d'une URL non-Vercel | **success** |
| Vérification que le SHA déployé est le candidat | **success** |
| La porte autorise-t-elle la branche de ce déploiement ? | **failure — motif nommé** |
| Preuves C1 à C4 | *skipped* (dépend du précédent) |

L'échec n'est plus un défaut de chaîne ni une URL introuvable : c'est la porte
qui refuse, et elle le dit.

### Blocage 1 — la branche déployée n'est pas autorisée

`BRANCHES_SONDE_RUNTIME` vaut
`['release/p107-runtime-production-20261110', 'fix/tracefab-p11-identity-runtime-20261109']`.
La branche déployée est `arena/0f6eb7a9-tracefab`. **Même avec le bon jeton, le
runtime déployé rendrait 401.** Le contrôle ajouté en `a0bb04e` mesure ce refus
et échoue explicitement, au lieu de laisser attribuer le 401 à la sécurité.

Deux voies, à votre arbitrage :

- **(A)** Déployer `release/p107-runtime-production-20261110` au SHA candidat et
  y pousser les corrections. La liste gelée ne bouge pas — c'est la voie que je
  recommande.
- **(B)** Ajouter `arena/0f6eb7a9-tracefab` à la liste. Une ligne, mais cela
  élargit durablement la surface d'ouverture de la sonde.

### Blocage 2 — le secret de sonde n'est pas lisible

`TRACEFAB_RUNTIME_PROBE_TOKEN` : mesuré absent du dépôt par deux fois.

| Observation | Interprétation |
| --- | --- |
| Run 43342154582, step « Preuves C1 à C4 » : **0 seconde** | sortie avant tout appel réseau |
| Script local, même entrée : arrêt en **44 ms** | même conclusion |
| `gh api …/actions/secrets` et `/variables` : **403** | je ne peux ni lire ni poser |
| `gh workflow run` : **403** | je ne peux pas déclencher non plus |

Sans ce secret, la sonde rend 401 sur son propre jeton : refus correct, mais
pas une preuve. **Aucune valeur n'a été inventée.**

Provisionnement attendu : `gh secret set TRACEFAB_RUNTIME_PROBE_TOKEN`, avec la
**même valeur** que la variable Vercel Preview. Format : chaîne opaque, jamais
journalisée.

### Blocage 3 — write Vercel refusé

Le connecteur Vercel répond `Access denied` sur `list_projects`, `list_deployments`
et `create_deployment`, même avec `team_BdnOPU97H1GOmMxy7T06nijQ`. Je ne peux
donc pas créer le déploiement du SHA candidat depuis la sandbox.

Bonne nouvelle mesurée : l'intégration Git Vercel **fonctionne à nouveau**. Elle
avait cessé entre `6eb13e1` et `eb37ef4` (≈ 8 h), puis `eb37ef4` a été déployé
automatiquement. Un push suffit donc à obtenir un Preview.

## Décision

# GO SOUS RÉSERVES

Les corrections sont livrées et prouvées, toute la non-régression est verte, et
les mécanismes de sécurité (identité signée, HMAC, anti-usurpation, identité
PostgreSQL, RLS) sont démontrés **localement, avec le vrai code du dépôt**. Les
quatre preuves de runtime exigées par la clôture **ne sont pas obtenues**, donc
P10.7 ne peut pas être déclaré terminé.

## Actions restantes

1. **Trancher le blocage de branche** (voie A recommandée) : déployer
   `release/p107-runtime-production-20261110` au SHA candidat.
2. `gh secret set TRACEFAB_RUNTIME_PROBE_TOKEN` — même valeur que côté Vercel Preview.
3. Relancer `P10.7 — preuves runtime sur la Preview réelle` (déclenchement par
   push, puisque le dispatch manuel m'est refusé).
4. Vérifier que les steps 9 et 10 passent, puis récupérer l'artefact
   `p107-preuves-runtime` et valider C1, C2, C3, C4 séparément.
5. Alors seulement : ouvrir la PR de fusion depuis `arena/0f6eb7a9-tracefab`
   vers `main`, puis fermer #121 sans fusion.
   Voir `livrables-finalisation/p107-preparation-fusion-pr121.md`.

## Ce qui n'est pas une preuve

Un script local, un test unitaire, une variable déclarée dans un tableau de bord,
un job CI qui rejoue le code sur le runner, ou une connexion PostgreSQL de
contrôle **ne sont pas** des preuves de runtime. Les résultats locaux ci-dessus
sont étiquetés « complément local » et le resteront dans le dossier
`livrables-finalisation/preuves/`.
