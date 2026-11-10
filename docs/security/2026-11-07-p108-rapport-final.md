# P10.8 — Rapport final

**Mission** : réconciliation définitive des migrations #111/#114 et sécurisation de l'outbox.
**Ordre imposé, respecté** : diagnostiquer → mesurer → corriger → tester → intégrer → vérifier → documenter. L'objectif était une **correction techniquement démontrée**, pas un audit supplémentaire.
**Date** : 2026-11-07 · **Branche** : `arena/0f697b3e-tracefab` (PR #113) · **SHA de départ** : `8846184735d8d27314b69ffc5f03511a6e5cfef9` · `main` = `788df22019c0d2b39301678ecfbc43ac868561bf`.
**Statuts utilisés, exclusifs** : `PASS`, `FAIL`, `BLOCKED`, `NOT RUN`, `NOT APPLICABLE`.

> **Synthèse** : la dépendance #111 → #114 est **résolue par une nouvelle migration additive**, mesurée sur **PostgreSQL 17.11 réel** avec de vraies sessions `tracefab_app`. 41 scénarios / 41 PASS, 7 chaînes appliquées sans échec, 156 suites `test:*` / 156 OK. **Aucune** fusion, **aucun** déploiement, **aucune** migration distante, **aucun** secret, **aucune** désactivation de RLS, **aucune** élévation. **A = GO technique local**, **B = GO intégration (sans fusion)**, **C = NO-GO / BLOCKED**, **D = NO-GO Production**.

---

## Phase 0 — État initial et condition d'arrêt

| Contrôle | Mesure | Statut |
|---|---|---|
| Branche / HEAD / origin | `arena/0f697b3e-tracefab`, `8846184…`, identiques | PASS |
| `main` | `788df22019c0d2b39301678ecfbc43ac868561bf` | PASS |
| Arbre de travail au départ | propre | PASS |
| STOP CONDITION (branche/SHA modifiés de façon inattendue) | non déclenchée ; un rafraîchissement distant a été fait | PASS |

Rafraîchissement distant en **lecture seule** : `git fetch origin --prune`, `gh pr list --state all`, `gh pr checks 113`, `gh run list` sur SHA exacts, `git ls-remote --heads`, `gh api search/code`. #110 a avancé **deux fois** pendant la mission (`9b86f18` → `b0f7b73` → `9a0fa5a` à 16:10:14Z) ; le dernier diff ne touche **que** `.github/workflows/preproduction-prisma-readonly.yml`, aucune migration. Ce fait est consigné, pas ignoré.

---

## Phase A — Cartographie et collisions

**Statut : PASS.** Détail et empreintes : `docs/security/2026-11-07-p108-chaine-migrations.md`, `…p108-chaine-migrations.json`, `…p108-chaine-canonique.json`.

* 7 chaînes appliquées **depuis une base vierge** sur PostgreSQL 17.11 : S1 70/70, S2 86/86, S3 87/87, S4 72/72, **S5 canonique 73/73**, T1 87/87, T2 94/94. **0 migration échouée**.
* Chaîne canonique définitive : `main(69) + #113(2) + #114(1, f0aeb51) + correctif P10.8(1) = 73`, empreinte `64d26a68af371c34f088c45ce687c578e659770a1c5000b97b74704c24153c8a`.
* Collisions : **4 paires historiques acceptées**, **0 nouvelle** sur la chaîne canonique. T1 (ancienne #114) et T2 (#110/#112) en ont 5 — chaînes **exclues**, non « réparées ».
* 7 noms identiques / contenus différents entre `main` et #110/#111/#112, empreintes des deux jeux consignées. **Aucune migration historique modifiée**.
* Renommage amont #114 tracé : `20261105120000_identite_systeme_signee` → `20261106130000_identite_systeme_signee`, contenu également modifié. Un seul renommage de préparation reste pour la chaîne étendue, **non appliqué**.
* Ambiguïté d'ordre du candidat P10.7 (`20261106120300` avant `20261106130000`) **résolue** par le nom `20261107120000` : il trie après #114. Aucune branche distante `outbox`/`p108`, aucun correctif appliqué ailleurs.
* Cohérence Prisma ↔ SQL ↔ fonctions ↔ rôles : 130 `SECURITY DEFINER`, 0 exécutable par PUBLIC, 53 tables RLS forcée, 3 politiques outbox, `pg_proc.proowner`/`pg_get_userbyid`/`pg_get_functiondef`/`pg_policies` mesurés.

## Phase B — Reproduction, cause racine, correction

**Statut : PASS.** Détail : `docs/security/2026-11-07-p108-outbox-preuves.md` §2–§3.

Reproduction **avant** correction sur PostgreSQL 17.11 réel, session `tracefab_app` non superutilisée :

| Chaîne | Résultat mesuré |
|---|---|
| S1 `#114 seule` (70 migrations) | `42501 permission denied for function tracefab_identite_systeme` |
| S2 `#111 + #114` (87) | claim `processing/1` → **PASS** |
| S3 canonique **sans** correctif (72) | `42501 permission denied for function tracefab_identite_systeme` |
| S3b canonique **avec** correctif (73) | claim `processing/1` → **PASS** |
| R1 propriété pleine, sans correctif | **0 ligne, sans erreur** (défaut silencieux) |
| R2 propriété pleine, avec correctif | 1 ligne revendiquée |

Deux causes racines indépendantes : (1) le prédicat `SECURITY INVOKER` n'a d'`EXECUTE` que pour `tracefab_worker`, alors que les opérations `SECURITY DEFINER` sont possédées par le rôle de migration ; (2) la politique RLS **forcée** `notification_outbox_update_trusted` exige `current_user='tracefab_worker'` en USING **et** WITH CHECK. Un simple GRANT n'aurait donc pas suffi.

Correction : **une** nouvelle migration idempotente `20261107120000_p108_outbox_proprietaire_et_dependances` (sha256 `6bf720822f7a361bf2703a85c7583e66f056f05e5303a6c910ce783f0e7d31dc`), transfert catalogue-driven des 13 opérations gardées vers `tracefab_worker`, privilèges minimaux, dépendances explicites, pré/postconditions bloquantes, aucune élévation automatique. Vérifiée idempotente (`I1`) et applicable par un rôle **NOSUPERUSER** (`I2`).

## Phase C — Harnais PostgreSQL 17.11

**Statut : PASS (41/41).** `docs/security/2026-11-07-p108-outbox-scenarios.json`.

Harnais jetable, vraies sessions applicatives, chaîne canonique depuis base vierge. Cas obligatoires **tous couverts** : création, insertion autorisée, claim, claim concurrent (deux workers / deux transactions, 2 lignes distinctes), complete autorisé, complete rôle non autorisé (`42501`), modification directe (`42501`), accès inter-tenant (1 ligne A / 0 ligne B), sans contexte (`42501 authentication_required`), avec contexte, réutilisation idempotente, reprise après échec, RLS active/forcée, superutilisateur jamais utilisé pour une opération métier. Ajouts : rollback après claim, crash entre claim et complete, retry après timeout, doublon (`23505`), complete répété (`P0001`), claim expiré, événements de deux organisations, `SET ROLE` refusé, comparaison `SET ROLE` ↔ vraie session, secret illisible.

Chaque scénario consigne SQL, rôle actif, session (`session_user`, `current_user`, `rolsuper`, `rolbypassrls`), obtenu/attendu, SQLSTATE, preuve RLS active, preuve d'absence d'élévation. `preuve_superutilisateur_jamais_metier = true`.

## Phase D — HMAC, non-régression

**Statut : PASS.** 107 assertions / 0 échec (`test:hmac:chaine-confiance`) ; 12 scénarios HMAC `H1`–`H11` sur PostgreSQL 17.11 réel tous PASS (forme canonique, suffixe, plafond 600 s mesuré sur l'horloge de la base, MAC falsifié, comparaison sans sortie anticipée via rotation, révocation immédiate, refus d'élévation, secret illisible, GUC transactionnel, fail-closed, compatibilité RLS). `p107:antirejeu` : 23 mesures / 0 échec. **La politique anti-rejeu n'a pas été modifiée** ; risque R1 accepté, mission distincte.

## Phase E — Intégration et vérification

**Statut local : PASS. Statut CI : PASS après correction d'un défaut réel détecté par la CI (voir § « CI sur le SHA final »).**

La **première** exécution CI sur `b441ff746be2f634c98b32aeaf322992c71f7397` (run `42390411409`) a été **`failure`** : le job « Base — isolation RLS exécutée » a échoué à l'étape 21 `test:garde-fous:neon` (code 2), tandis que la nouvelle étape « P10.8 — outbox : claim / complete prouvés sur PostgreSQL 17.11 réel » (étape 11) était **déjà `success`**. Cause mesurée : le harnais `p108:ci` réécrivait `docs/security/2026-11-07-p108-ci-mesures.json` **dans le dépôt**, rendant `git status --porcelain` non vide ; le banc déclare alors les scénarios 4/5/8 « NON JOUÉS » et sort en 2, conformément à sa règle « un banc qui ne s'exécute pas ne vaut pas un banc qui passe ». **Aucun garde-fou n'a été désactivé** : la cible de l'artefact a été rendue configurable (`TF_P108_CI_SORTIE`), la CI écrit désormais dans `runner.temp`, et le harnais détruit sa base jetable en fin d'exécution. Le test échouant avant (`test:garde-fous:neon` en CI) passe après sur le SHA final.

| Contrôle | Résultat |
|---|---|
| Boucle des 156 scripts `test:*` pertinents, avec `LD_LIBRARY_PATH=/tmp/al2023/lib` | **156/156 OK, 0 échec** |
| `npm test` | exit 0 |
| `npm run api:typecheck` | exit 0 |
| `git diff --check` | exit 0 |
| `npm run test:hmac:chaine-confiance` | 107/0 |
| `npm run test:reconciliation-chaine-canonique` | **94/0** (90 → 94, couverture augmentée) |
| `npm run test:chantiers` | 6/6 |
| `npm run test:db-routing`, `test:workflow-policy`, `test:workflow-policy-temoins` | OK (après déclaration des 3 harnais comme outils **auto-gardés**) |
| `npm run p107:chaines` / `p107:outbox` / `p107:antirejeu` | 75 conformes/0 écart · scénarios historiques inchangés · 23/0 |
| `npm run p108:chaines` | 7 chaînes, 0 échec |
| `npm run p108:outbox` | 41 PASS / 0 FAIL |
| `npm run p108:ci` | 8 PASS / 0 FAIL / 1 `NOT APPLICABLE` |
| Secret scan / variables distantes | 0 motif, aucune `DATABASE_URL`, `TRACEFAB_IDENTITY_KEY`, `VERCEL_TOKEN`, `NEON_API_KEY`, `CLERK_SECRET_KEY` |
| Aucun test désactivé, aucune couverture réduite | PASS |

Trois ajustements de **garde-fous** ont été nécessaires et sont documentés, jamais contournés : (i) nouvelle étape CI déclarée et nom YAML quoté ; (ii) les 3 harnais P10.8 portent eux-mêmes `requireThrowawayDb` et sont inscrits dans `SELF_GUARDED_DB_TOOLS` avec vérification F2 ; (iii) le registre des chantiers passe de 71 à **72 migrations**, et le manifeste de chaîne canonique P10.8 remplace le candidat (94 assertions au lieu de 90). Le manifeste historique P10.7 est conservé sans réécriture.

### CI sur le SHA final

Les identifiants de workflow, de run, de job, la version exacte de PostgreSQL lue dans le service `postgres:17`, les durées, les étapes ignorées et les erreurs sont consignés dans **`docs/security/2026-11-07-p108-ci-preuves.json`**, fichier d'observation rempli **après** la mesure CI sur le SHA final (un fichier ne peut pas contenir l'identifiant du run que son propre commit déclenche). Ce fichier consigne **aussi le run en échec** `42390411409` et sa cause : une CI « verte » obtenue en taisant un échec n'aurait aucune valeur. Le rapport de fin de mission et la réponse finale portent la synthèse. Aucun run antérieur — en particulier `42372217777` / `42372217809` du SHA `8846184`, ni `42390411409` du SHA intermédiaire `b441ff7` — n'est présenté comme preuve du SHA final.

Une nouvelle étape a été ajoutée au job `Base` de `ci.yml` : `npm run p108:ci`, avec `TF_P108_PG_URL` pointant sur le service `postgres:17` **jetable** de la CI. Ce harnais est autonome (aucune ref Git d'audit), applique les 72 migrations du checkout depuis une base vierge et exécute claim/complete par une vraie session `tracefab_app`. Il mesure et consigne `PostgreSQL 17.11` exactement, ce que PGlite 18.6 ne pouvait pas faire.

## Phase F — Comparaison au SHA de départ

**Statut : PASS.**

| Élément | Mesure |
|---|---|
| `main` | **inchangé** (`788df220…` avant et après, vérifié par `git ls-remote origin main`) |
| Migration créée | **1** : `20261107120000_p108_outbox_proprietaire_et_dependances` (232 lignes) |
| Migrations historiques touchées | **0** (`git diff 788df220..HEAD -- prisma/migrations` : aucun fichier modifié/supprimé) |
| Fichiers suivis modifiés | 5 : `ci.yml`, `CHANTIERS-RESTANTS.md` (1 ligne), `package.json` (+6/−1), `test_destructive_suite_routing.mjs` (+10), `test_reconciliation_chaine_canonique.mjs` (+31/−12) |
| Commits P10.8 sur la branche | 2 : livrables, puis correctif D6 (`TF_P108_CI_SORTIE` + rangement de la base jetable) |
| Nouveaux fichiers | 13 : 1 migration, 5 scripts/lanceur, 7 documents/artefacts de preuve |
| Rôles / permissions | 13 opérations → `tracefab_worker` ; aucun `GRANT` nouveau à `tracefab_app` ni à PUBLIC sur l'outbox ou le prédicat |
| RLS | 3 politiques outbox **inchangées**, active **et** forcée ; 53 tables toujours forcées ; 0 désactivation |
| HMAC / anti-rejeu | **aucun changement** de format, de secret ou de politique |
| Secrets | aucun affiché, copié, transmis ou modifié |
| Fusion / déploiement / migration distante / `_prisma_migrations` distant | **aucun** |
| Élévation artificielle | **aucune** : aucun `SET ROLE` pour simuler une session, aucun superutilisateur pour une opération métier, aucune appartenance de rôle accordée |
| Régressions | 156/156 suites, HMAC 107/0, chaîne 94/0, chaînes réelles 7/7, outbox 41/41 |

## Phase G — Observation distante, strictement en lecture seule

| Contrôle | Statut | Mesure |
|---|---|---|
| Vercel : projets, déploiements, variables par cible | **BLOCKED** | connecteur `enabled`, `validate_credential` OK, mais `list_projects` → `Access denied … token permissions/team scope`. Aucune autre tentative d'escalade. |
| Neon / Préproduction / Production : `_prisma_migrations`, `pg_roles`, `pg_policies`, RLS live | **BLOCKED** | aucun `DATABASE_URL`/`DIRECT_URL`, pas de `psql`/`neonctl`, connecteur Neon `unsupported` |
| Clerk : utilisateurs U/A/B/S, parcours HTTP authentifiés | **BLOCKED** | connecteur Clerk `unsupported`, aucun secret |
| Preview SSO / SHA servi / corrélation HTTP → Prisma → Neon | **BLOCKED** | SSO Vercel, aucun contournement tenté |
| GitHub : PR, checks, journaux CI | **PASS** | lecture seule autorisée et utilisée |
| `gh pr checks 113` sur le SHA **précédent** `8846184` | 7/7 PASS | **historique**, explicitement non présenté comme preuve du SHA P10.8 |

Aucun `BLOCKED` n'a été transformé en `PASS`. Aucune action distante modifiant une base, un rôle, une permission, une configuration ou un déploiement n'a été exécutée.

---

## Tableau des défauts — reproduction, cause, correction, preuves

| Défaut | Reproduit avant | Cause racine | Correction minimale | Test échouant avant | Test passant après | Non-régression |
|---|---|---|---|---|---|---|
| D1 `42501 permission denied for function tracefab_identite_systeme` sur claim/complete | S1 (70/70), S3 (72/72), PG 17.11 réel, session `tracefab_app` | prédicat `SECURITY INVOKER`, `EXECUTE` worker seulement ; appelant `SECURITY DEFINER` possédé par le rôle de migration | transfert des 13 opérations vers `tracefab_worker` + `GRANT EXECUTE` du prédicat au worker | `S1`, `S3` → `42501` | `S3b`, `C3`, `C5`, `C10`, `CI06` → PASS | 156/156, HMAC 107/0, chaîne 94/0 |
| D2 claim silencieusement à 0 ligne | R1 (modèle propriété pleine, sans correctif) | politique RLS forcée `notification_outbox_update_trusted` exige `current_user='tracefab_worker'` | même transfert de propriétaire (une seule migration) | `R1` → 0 ligne | `R2` → 1 ligne, `C3` → 3 lignes | 3 politiques conservées, RLS active/forcée |
| D3 ordre ambigu du candidat `20261106120300` | mesure de tri : `< 20261106130000` (#114) | nom du correctif antérieur à sa précondition | nouvelle migration `20261107120000…`, candidat non recopié | `test:reconciliation-chaine-canonique` (2 échecs sur le manifeste P10.7) | 94/0, « trie APRÈS #114 » | 73 entrées, 0 nouvelle collision, 0 historique modifié |
| D4 dépendance #111 non intégrable | S2 PASS, S1/S3 FAIL ; #110/#111/#112 réécrivent 7 migrations de `main` | #111 seul apportait le transfert de propriétaire | migration additive autonome, valable avec **et** sans #111/#114 | `S1`/`S3` | `S3b`, `p108:ci` (branche seule, 72/72) | `I1` idempotent, `I2` rôle non superutilisateur |
| D5 faux positifs de garde-fous (YAML, routage, registre) | 4 suites en échec après ajout de la migration | nouveaux fichiers non déclarés / YAML non quoté | déclaration explicite + garde `requireThrowawayDb` + mise à jour du registre | `test:db-routing`, `test:workflow-policy`, `test:workflow-policy-temoins`, `test:chantiers` | 4/4 OK | couverture **augmentée** (90 → 94 assertions, +3 outils auto-gardés vérifiés) |
| D6 arbre Git sali en CI (détecté par la CI, pas localement) | run `42390411409` → `failure`, job `Base`, étape 21 `test:garde-fous:neon` code 2 | `p108:ci` écrivait son artefact JSON **dans le dépôt**, donc `git status --porcelain` non vide → scénarios de révision NON JOUÉS | `TF_P108_CI_SORTIE` vers `runner.temp`, aucun fichier écrit dans l'arbre, base jetable détruite en fin de harnais | `test:garde-fous:neon` (CI, code 2) ; la suite était exclue de la boucle locale 156 | `test:garde-fous:neon` PASS sur le SHA final, 4/4 jobs CI verts | aucun test désactivé, aucun `continue-on-error`, `test:db-routing`/`test:workflow-policy`/témoins OK |

**Leçon consignée** : la boucle locale 156/156 ne remplace pas la CI. `test:garde-fous:neon` exige une `DATABASE_URL` **et** un arbre propre ; il ne pouvait donc pas être joué localement sans base, et la CI seule pouvait révéler le défaut. Ce n'est pas une régression du correctif SQL (l'étape 11 `p108:ci` était verte dès le premier run), mais un défaut d'intégration du harnais.

---

## Décisions finales — séparées, non amalgamées

| Décision | Verdict | Fondement / réserve |
|---|---|---|
| **A — GO technique local** | **GO** | 41/41 scénarios sur PostgreSQL 17.11 réel, 7/7 chaînes depuis base vierge, 156/156 suites, 0 régression, défaut reproduit avant et corrigé après. |
| **B — GO intégration** | **GO (sans fusion)** | branche `arena/0f697b3e-tracefab` poussée, PR #113 toujours compatible avec ce périmètre, CI verte sur le SHA final. **Aucune fusion, aucun merge/close, aucun déploiement.** L'intégration de #114 reste une décision distincte : la corrective est conçue pour fonctionner avec et sans #114. |
| **C — GO environnemental** | **NO-GO / BLOCKED** | aucune preuve Neon/Préproduction/Preview : SHA servi, base isolée, `_prisma_migrations` réel, `strict` Preview, corrélation Vercel → Prisma → Neon, lecture privilégiée Production. Accès `BLOCKED`, jamais `PASS`. |
| **D — GO Production** | **NO-GO** | par défaut et maintenu : preuves distantes et autorisations explicites absentes ; aucune migration appliquée sur Production, aucun secret/rôle/grant distant modifié, aucune bascule `strict`. |

**Interdictions absolues respectées** : pas de modification directe de `main`, pas de fusion/fermeture de PR, pas de déploiement Production, pas de `prisma migrate deploy`/`resolve` distant, pas de modification d'`_prisma_migrations` distant, pas de migration historique modifiée, pas de désactivation RLS, pas de superutilisateur pour masquer un défaut, pas d'affaiblissement de `SECURITY DEFINER`/`search_path`/contrôles de privilèges, aucun secret affiché/copié/transmis, aucun contournement Vercel SSO, aucune modification distante de secret/rôle/grant/configuration.

---

## Livrables

| Fichier | Contenu |
|---|---|
| `docs/security/2026-11-07-p108-rapport-final.md` | ce rapport, phases 0/A–G, décisions A/B/C/D |
| `docs/security/2026-11-07-p108-chaine-migrations.md` | cartographie, 7 chaînes, collisions, renommages, ordre |
| `docs/security/2026-11-07-p108-outbox-preuves.md` | reproduction, causes racines, correction, 41 scénarios, HMAC |
| `docs/security/2026-11-07-p108-chaine-migrations.json` | 7 scénarios, empreintes sha256 de chaque migration |
| `docs/security/2026-11-07-p108-outbox-scenarios.json` | 41 scénarios détaillés + 4 reproductions + 2 causes racines |
| `docs/security/2026-11-07-p108-ci-preuves.json` | workflow / run / SHA / PG / jobs / durées / étapes ignorées / erreurs |
| `docs/security/2026-11-07-p108-ci-mesures.json` | mesures du harnais CI autonome |
| `docs/security/2026-11-07-p108-chaine-canonique.json` | manifeste définitif 73 entrées |
| `prisma/migrations/20261107120000_…/migration.sql` | migration corrective |
| `scripts/lib/p108_pg17.mjs`, `scripts/p108_pg17_demarrer.sh` | socle + lanceur PostgreSQL 17.11 jetable |
| `scripts/harnais_p108_chaines.mjs`, `harnais_p108_outbox.mjs`, `harnais_p108_ci.mjs` | harnais reproductibles (`p108:chaines`, `p108:outbox`, `p108:ci`) |

**Reproduire** : `bash scripts/p108_pg17_demarrer.sh` → `npm run p108:chaines` → `npm run p108:outbox` → `npm run p108:ci`.
