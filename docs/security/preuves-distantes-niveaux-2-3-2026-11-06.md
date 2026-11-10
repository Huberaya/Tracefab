# Preuves distantes Niveau 2 / Niveau 3 — PR #113

**Date de l'audit :** 6 novembre 2026, 09:39–10:53 UTC (10:39–10:53 Europe/Paris).
**Branche imposée :** `arena/0f697b3e-tracefab` (inchangée, non renommée).
**Objet :** reprendre l'état exact de la PR #113, confirmer le SHA à valider, obtenir les preuves distantes manquantes (Niveau 2 : Neon isolé + Vercel Preview ; Niveau 3 : Production/Préproduction en lecture seule), produire la matrice HTTP, l'analyse de compatibilité #108–#114 et un verdict indépendant par élément.
**Décision finale :** **NO-GO** — voir §14.

> Ce rapport est un **fichier de travail non commité**, conformément à l'interdiction de committer/pusher. Il complète, sans le remplacer, [`docs/security/preuves-isolation-globale-2026-11-06.md`](../security/preuves-isolation-globale-2026-11-06.md) (Niveau 1) et [`docs/security/matrice-autorisations-tenant-actif.md`](../security/matrice-autorisations-tenant-actif.md).

---

## 1. Objet, périmètre, méthode et interdictions respectées

**Opérations réellement effectuées (lecture seule) :**

| Nature | Détail |
| --- | --- |
| Git local | `git fetch --no-tags origin` + création de **références locales** `refs/remotes/audit/pr108…114` (aucune branche déplacée, aucun commit, aucun rebase, aucun push) ; `git diff`, `git show`, `git merge-base`, `git merge-tree --write-tree` (calcul en mémoire, aucun arbre écrit dans le dépôt). |
| GitHub REST / `gh` | lecture des PR #108–#114, têtes, états, `mergeable_state`, checks, statuts de commit, check-suites, déploiements (pages 1–5), statuts de déploiements, contenus de documents versionnés, workflows, environnements, historique des runs CI. |
| HTTP publics | `GET` sans en-tête d'authentification et sans contournement sur `https://tracefab.vercel.app/api/health`, `/api/config`, `/api/internal/p2/readiness`, et sur cinq URLs de déploiements Vercel. |
| Connecteur Vercel | `validate_credential`, `get_authenticated_user`, puis tentatives de lecture (projets, déploiements, domaines, noms de variables, webhooks, événements, équipes, déploiements par ID). |
| Connecteurs Neon / Clerk | `list_connector_tools` → `unsupported` pour les deux. |

**Interdictions : aucune n'a été enfreinte.** Aucun commit, push, fusion, fermeture de PR, commentaire GitHub, déploiement, migration/SQL en écriture sur un environnement existant, modification de secret/variable/rôle/RLS, bascule de `systeme_strict`, déclenchement de webhook réel, lecture de données client, contournement de SSO, extraction ou affichage de valeur secrète. Une tentative de `gh workflow run "Sondage HTTP de la Preview (aucun secret)" --ref main` a été **refusée en 403** (`Resource not accessible by integration`) : **aucun run n'a été créé**.

**Ce que ce rapport ne fait pas :** il ne rejoue pas les 77 contrôles PGlite, ne reconstruit pas le Niveau 1, ne transforme jamais un manque d'accès en résultat positif, et ne déclare jamais un environnement sain parce qu'il est inaccessible.

---

## 2. État GitHub reconstruit (mesure du 2026-11-06T09:49:38Z)

| Ressource | Valeur mesurée | Lien direct |
| --- | --- | --- |
| `main` | `788df22019c0d2b39301678ecfbc43ac868561bf`, `protected: true` | [`branches/main`](https://api.github.com/repos/Huberaya/Tracefab/branches/main) |
| Règles détaillées de protection | **403** `Resource not accessible by integration` — non vérifiées | — |
| Branche de travail | `arena/0f697b3e-tracefab` = `bfaeae07da4f13e2da80946b7b5b0dc7f6d348a7`, worktree propre, `origin/...` aligné | [`PR #113`](https://github.com/Huberaya/Tracefab/pull/113) |
| Environnements GitHub | `Preview`, `Production`, `tracefab-clerk-test` (`required_reviewers` + `branch_policy`). **Aucun environnement « Préproduction ».** | [`environments`](https://api.github.com/repos/Huberaya/Tracefab/environments) |
| Déploiements (500 plus récents) | 484 `Preview`, 13 `Production`, 3 `tracefab-clerk-test`, **0 `Preproduction`** | [`deployments`](https://api.github.com/repos/Huberaya/Tracefab/deployments?per_page=100) |
| Droits du jeton GitHub | `workflow_dispatch` 403 ; noms des secrets/variables Actions 403 ; protection de branche 403 ; lecture PR/CI/déploiements OK | — |

### PR #108–#114 (API `pulls`, frais)

| PR | État | Brouillon | Base | Tête | `mergeState` | Mis à jour |
| --- | --- | --- | --- | --- | --- | --- |
| [#108](https://github.com/Huberaya/Tracefab/pull/108) | OPEN | oui | `main` | `2d62609d37457fe48d191b310965a14b54a6e81a` | `clean` | 2026-11-06T00:35:28Z |
| [#109](https://github.com/Huberaya/Tracefab/pull/109) | OPEN | non | `main` | `751004e04ed1563f56d4d9c003c895ddecb5c638` | `blocked` | 2026-11-04T00:05:42Z |
| [#110](https://github.com/Huberaya/Tracefab/pull/110) | OPEN | non | `main` | **`9b86f18eb0f43da58fddb2b3e64b85a3ec63b939`** | `blocked` | **2026-11-06T09:43:59Z** |
| [#111](https://github.com/Huberaya/Tracefab/pull/111) | **CLOSED / MERGED** | non | `fix/neon-migration-reconciliation-20261104` | `064fb34631bb4a897da0eedd7986d0eaebd7daf7` | `unknown` | **2026-11-06T09:43:15Z** |
| [#112](https://github.com/Huberaya/Tracefab/pull/112) | OPEN | oui | `main` | `da8fa542a0a98a5b4260dd8f3347ff632ae579bb` | `clean` | 2026-11-05T21:02:03Z |
| [#113](https://github.com/Huberaya/Tracefab/pull/113) | OPEN | non | `main` | `bfaeae07da4f13e2da80946b7b5b0dc7f6d348a7` | `unstable` | 2026-11-05T23:35:31Z |
| [#114](https://github.com/Huberaya/Tracefab/pull/114) | OPEN | non | `main` | `537bc310d0b6e857c4f74ec0017a130987b22497` | `clean` | 2026-11-06T09:30:00Z |

**Changement intervenu pendant cet audit :** la PR **#111 a été fusionnée** dans la branche de la #110 à `2026-11-06T09:43:15Z` (`merge_commit_sha = 9b86f18e…`). La tête de #110 n'est donc plus `b27b2afb79b2aee4b425559791433b048aad816f` ; `git merge-base --is-ancestor` confirme que #111 ⊂ #110. La CI de #110 (run [`42197160888`](https://github.com/Huberaya/Tracefab/actions/runs/42197160888)) avait encore deux jobs `pending` au moment de la mesure.

---

## 3. SHA à valider : confirmation

**Le code à valider reste `bfaeae07da4f13e2da80946b7b5b0dc7f6d348a7` (`bfaeae0`).** Aucun nouveau SHA n'est apparu.

- `git rev-parse HEAD` = `bfaeae0`, `git status --porcelain` vide (hors le présent rapport, non commité).
- `gh api repos/Huberaya/Tracefab/pulls/113` → `head.sha = bfaeae0`, `mergeable = true`, `mergeable_state = unstable`.
- `git diff --shortstat main HEAD` → **97 fichiers, 3803 insertions(+), 598 deletions(-)**.
- `main` et la tête distante de #109 (`751004e…`) n'ont pas bougé.
- Le Niveau 1 n'a **pas** été rejoué : les 11 scripts + `npm test` (tous `exit 0`) et la boucle CI 154/154 sont des résultats déjà acquis et versionnés dans le rapport du 6 novembre.

---

## 4. Niveau 1 acquis (PostgreSQL jetable / CI) — rappel de portée, pas une preuve distante

| Run CI | Lien | Résultat | Environnement |
| --- | --- | --- | --- |
| `42130549875` | [actions/runs/42130549875](https://github.com/Huberaya/Tracefab/actions/runs/42130549875) | 4/4 jobs : `Socle`, `Vérification`, `Base — isolation RLS exécutée`, `Parcours navigateur` | PostgreSQL jetable GitHub Actions |
| `42130549921` | [actions/runs/42130549921](https://github.com/Huberaya/Tracefab/actions/runs/42130549921) | `Chaîne 34/36/41` PASS | PostgreSQL 17 jetable |
| `42130449605` | [actions/runs/42130449605](https://github.com/Huberaya/Tracefab/actions/runs/42130449605) | `Chaîne 34/36/41` PASS | PostgreSQL 17 jetable |

`gh pr checks 113` (2026-11-06T09:49Z) : **5 GitHub Actions PASS** + **`Vercel` FAIL** (`Deployment rate limited — retry in 24 hours`, [`upgradeToPro=build-rate-limit`](https://vercel.com/baya-ibraimmayoanouedu-8164s-projects?upgradeToPro=build-rate-limit), statut posé le `2026-11-05T23:34:47Z`). Check-suites `vercel` et `supabase` : `queued`, sans conclusion.

Résultats locaux déjà acquis, **valables uniquement pour PostgreSQL jetable / CI sur `bfaeae0`** : `test:isolation:globale` 77/0 (fuite RLS A/B/S mesurée puis fermée par la politique RESTRICTIVE), 138 routes classées (102 `tenant-valide-explicite`, 25 `public-ou-worker`, 11 `compte-ou-calcul`, 0 non classifiée), matrice formelle 10 scénarios, 128 `SECURITY DEFINER` toutes avec `search_path` et 0 exécutable par `PUBLIC`, registre 95 noms, `test:active-tenant-routes` 79/0, `test:private-storage` PASS, 9/9 PGlite, 154/154 scripts `test:*`.

> **Une CI verte n'est pas un parcours métier validé sur Preview, ni un `SELECT` sur Neon, ni une mesure Production.** Ces chiffres ne sont pas réutilisés ci-dessous comme preuves de Niveau 2 ou 3.

---

## 5. Niveau 2 — branche Neon strictement isolée : **NON RÉALISÉ**

### Accès mesurés

| Voie | Résultat |
| --- | --- |
| Connecteur `neon` | `unsupported` (aucun outil chargé) |
| Connecteur `clerk` | `unsupported` |
| Variables d'environnement | `DATABASE_URL`, `TF_RLS_APP_URL`, `TF_ALLOW_WRITE`, `TRACEFAB_IDENTITY_KEY`, `CLERK_SECRET_KEY`, `VERCEL_TOKEN`, `NEON_API_KEY`, `TF_PREVIEW_HARNESS` : **toutes absentes** |
| CLI | `psql`, `neonctl`, `vercel` : **absents** |
| Secrets GitHub Actions | lecture des **noms** refusée en 403 |
| Fichiers du workspace | seulement `.env.example` (modèle sans valeur) ; aucun fichier de connexion utilisable |

**Conséquence mesurée :** aucune branche Neon créée, aucun `prisma migrate deploy` exécuté, aucun `SELECT` sur Production/Préproduction, aucun compte/organisation de test créé, aucune donnée fictive A/B/S/U insérée.

### Mécanisme officiel préparé (non exécuté)

1. Créer une branche Neon **explicitement isolée** depuis un snapshot nommé, jamais depuis Production servante ; consigner son identifiant, son parent et sa date.
2. Appliquer **uniquement sur cette branche** les migrations du SHA exact `bfaeae0` par le mécanisme officiel **`prisma migrate deploy`** (celui utilisé et attesté par la PR #110). `scripts/migrer_fidelement.mjs` est une réimplémentation **hors ligne** qui refuse explicitement les hôtes de Production (`REFUS — la cible est la base de PRODUCTION`, `TF_ALLOW_WRITE=oui`, préflight D6) : il **ne remplace pas** `prisma migrate deploy` et n'est pas une preuve de son comportement.
3. Vérifier en `SELECT` : `_prisma_migrations` (appliquées / `finished_at NULL` / checksums), `pg_roles` (`tracefab_app` = `NOSUPERUSER`, `NOBYPASSRLS`, `NOLOGIN` le cas échéant, appartenances transitives), `pg_policies` (politique RESTRICTIVE `documents_restrict_active_tenant` incluse), `pg_proc` (`SECURITY DEFINER`, `search_path` figé, propriétaires), ACL/GRANT/REVOKE, `public.tracefab_runtime_function_registry`, extensions (`pgcrypto`…), absence de repli vers Production.
4. Outils prêts, non lancés : [`scripts/audit_neon_readonly.mjs`](../../scripts/audit_neon_readonly.mjs) (liste blanche `SELECT/WITH/SHOW/TABLE` + `default_transaction_read_only = on` côté serveur, `--expect-database`, sortie 2 si `DATABASE_URL` absent), `scripts/lire-historique-migrations.mjs`, `scripts/lire-role-runtime.mjs`, `scripts/lire-disponibilite-role-app.mjs`, `scripts/test_neon_active_tenant.mjs`, `scripts/test_registre_fonctions_runtime.mjs`, `scripts/nettoyer_ressources_jetables.mjs`.

### Preuves historiques versionnées — **pas des mesures du 6 novembre**

- [PR #110, attestation du 2026-11-04](https://github.com/Huberaya/Tracefab/blob/b27b2afb79b2aee4b425559791433b048aad816f/docs/security/2026-11-04-neon-checksum-variance-attestation.md) : branche isolée `br-sweet-king-b1n2f4u6` (`tracefab-dpp-readiness-validation-current-20261027`) depuis `br-broad-fog-b1rgt68c`, `prisma migrate deploy` exit 0 sur 15 migrations, second deploy sans attente, **71 appliquées / 2 annulées / 0 inachevée**, écart de checksum borné sur `20261006210000_plm_erp_gs1_interoperability`, branche sale `br-late-truth-b1q7gy8j` écartée (`42P07`). Snapshot local `/tmp/neon-snapshot.json` : `captured_at=2026-11-04`, **56 appliquées, 13 `missing`, 5 `out_of_band`, 2 `rolled_back_attempts`, 0 `unfinished`, 69 répertoires**.
- [PR #108, mesure runtime du 2026-11-03T15:25:01Z](https://github.com/Huberaya/Tracefab/blob/2d62609d37457fe48d191b310965a14b54a6e81a/docs/security/2026-11-03-p107-preuve-runtime-production.md) : `current_user = session_user = tracefab_app`, `superuser=false`, `bypassRls=false`, `createRole=false`, `memberships=[]`, `privilegedRolesReachable=[]`, `readOnly.sqlState=25006`, `TRACEFAB_IDENTITY_KEY` absente ⇒ HMAC strict **NO-GO**, verdict `IDENTITE_CONFORME` ; nettoyage puis redéploiement Production depuis `main` `788df22` sous `dpl_FYHELX51z15ot9Gb2q4Cue7e773c`.

Ni l'une ni l'autre n'a été relue en direct le 2026-11-06. La branche `br-sweet-king-b1n2f4u6` est un laboratoire **d'une autre PR et d'une autre chaîne de migrations** : elle n’est pas réutilisable pour valider `bfaeae0`.

**Verdict Niveau 2 / Neon : NON DÉMONTRÉ (NO-GO).**

---

## 6. Niveau 2 — Vercel Preview dédiée au SHA : **NON RÉALISÉ**

| Mesure | Résultat | Date / lien |
| --- | --- | --- |
| Déploiements GitHub pour `bfaeae0` | **0** (`deployments?sha=…` → `[]`) | 2026-11-06T09:49Z |
| Statut de commit Vercel | `failure`, `Deployment rate limited — retry in 24 hours` | `2026-11-05T23:34:47Z` — fenêtre de réessai au plus tôt `2026-11-06T23:34:47Z` |
| Check-run Vercel Preview Comments sur `bfaeae0` | **aucun** | — |
| Connecteur Vercel | `validate_credential` OK ; `get_authenticated_user` → `limited=true`, `defaultTeamId=team_BdnOPU97H1GOmMxy7T06nijQ` ; `list_teams=[]` | 2026-11-06 |
| Lectures refusées | `list_projects`, `list_deployments` (avec/sans `team_id`, `project_id=tracefab`, `target=production`), `list_domains`, `list_project_domains`, `list_env_vars`, `list_webhooks`, `list_user_events`, `get_project('tracefab')` → **Access denied** (portées / périmètre d'équipe) | 2026-11-06 |
| `get_deployment` | `9K4bo9bHEaU53cjsAHxJ8J7z2xbr` (#108), `72Nf934mDZ5uu9YNsifD7xr9tqbA` (#114), `A2aikzfxE4bXYHSXsXqWhu6N596c` (#110), `FnL1cdNyx23efkKMf6Ez3M3oEmba` (#111) → **404 Deployment not found** ; `dpl_FYHELX51z15ot9Gb2q4Cue7e773c`, `dpl_DhWFDPARLyHcppioNkjywHeu4zcm` → **Access denied** | 2026-11-06 |

### Protection SSO mesurée sans contournement

Cinq URLs de déploiements ont renvoyé la page **« Protected Deployment – Vercel / Login »** (redirection `vercel.com/login?next=/sso-api?…`) au lieu d'un JSON applicatif :

- Preview #114 : [`tracefab-j0df5zkkr-….vercel.app/api/health`](https://tracefab-j0df5zkkr-baya-ibraimmayoanouedu-8164s-projects.vercel.app/api/health)
- Preview #111 : `tracefab-git-fix-a-8faeb0-….vercel.app/api/health`
- Preview #112 : [`tracefab-kzyobodsb-….vercel.app/api/health`](https://tracefab-kzyobodsb-baya-ibraimmayoanouedu-8164s-projects.vercel.app/api/health)
- Déploiements Production `tracefab-gx297m3z9-….vercel.app` et `tracefab-m199xp42j-….vercel.app`

**Aucun en-tête de bypass n'a été envoyé, aucune protection n'a été contournée.** Le SSO est donc actif sur les URLs de déploiement ; tout parcours HTTP applicatif exige une autorisation SSO ou un secret de bypass dédié, absent ici.

L'alias public de Production, lui, répond sans SSO :

| GET public | Corps observé (valeur secrète non reproduite) | Interprétation |
| --- | --- | --- |
| [`https://tracefab.vercel.app/api/health`](https://tracefab.vercel.app/api/health) | `{"ok":true,"service":"tracefab-api"}` | disponibilité de l'API uniquement |
| [`https://tracefab.vercel.app/api/config`](https://tracefab.vercel.app/api/config) | `{"publishableKey":"pk_live_…","proxyUrl":"https://tracefab.vercel.app/__clerk"}` | clé **publique** Clerk de type *live* (non secrète, valeur non recopiée) ⇒ Production utilise un environnement Clerk **live**, pas un Clerk de test |
| [`https://tracefab.vercel.app/api/internal/p2/readiness`](https://tracefab.vercel.app/api/internal/p2/readiness) | `{"error":"worker_unauthorized"}` (401) | la route de readiness existe et est **protégée** ; sans secret worker, aucun nom de variable ni identité runtime n'est lisible |
| `https://tracefab.vercel.app/api/internal/p2-readiness` | `{"error":"route_not_found"}` (404) | le nom de fichier n'est pas l'URL |

### Harnais officiel existant, mais non exécutable

[`.github/workflows/preview-http-journeys.yml`](https://github.com/Huberaya/Tracefab/blob/arena/647ac97c-tracefab/.github/workflows/preview-http-journeys.yml) (branche `arena/647ac97c-tracefab`, **absent de `main` et de `bfaeae0`**) définit les parcours HTTP authentifiés réels. Il exige :

- l'environnement GitHub protégé **`tracefab-clerk-test`** (relecteurs obligatoires + branch policy, confirmé par l'API `environments`) ;
- les **noms** de secrets `CLERK_SECRET_KEY`, `TF_PREVIEW_USER_ALPHA`, `TF_PREVIEW_USER_BETA`, `TF_PREVIEW_ORG_ALPHA`, `TF_PREVIEW_ORG_BETA`, `VERCEL_AUTOMATION_BYPASS_SECRET` ;
- les **noms** de variables `TF_PREVIEW_EXPECTED_ORIGIN`, `TF_PREVIEW_STORAGE_HOST`, `TF_PREVIEW_DEPLOYED_SHA`, `TF_PREVIEW_TEST_ENV_CONFIRMED` ;
- `TF_PREVIEW_HARNESS=1`, un bucket/antivirus de test et une attestation explicite de nature TEST.

Aucun de ces éléments n'est disponible dans ce bac à sable ; `workflow_dispatch` est refusé en 403 ; les noms de secrets/variables du dépôt sont refusés en 403. Le run historique [`40481526660`](https://github.com/Huberaya/Tracefab/actions/runs/40481526660) s'est arrêté en `failure` à l'étape « Parcours HTTP authentifiés sur la Preview » (pré-vol et gardes OK) ; ses journaux renvoient `EOF` et ses artefacts sont expirés (`total_count: 0`) — **preuve non reconstituable**. La sonde de protection sans secret [`40508428497`](https://github.com/Huberaya/Tracefab/actions/runs/40508428497) est `success` mais ses logs sont également inaccessibles (`EOF`).

Le contrat de noms de variables versionné dans la [PR #114](https://github.com/Huberaya/Tracefab/blob/537bc310d0b6e857c4f74ec0017a130987b22497/docs/operations/variables-environnement.md) est un **contrat de code**, pas un inventaire Vercel : il ne prouve ni les cibles, ni les valeurs, ni l'absence de repli Production.

**Verdict Niveau 2 / Preview : NON DÉMONTRÉ (NO-GO).** Un build `READY` — ici même pas obtenu — ne suffirait de toute façon pas.

---

## 7. Matrice HTTP — `Scénario | Tenant actif | Ressource | Résultat attendu | Résultat réel | Verdict`

**Légende.** « Résultat attendu » est le contrat établi au Niveau 1 (`docs/security/matrice-autorisations-tenant-actif.md`, `docs/security/route-tenant-matrix.json`, `scripts/test_isolation_globale_pglite.mjs`). « Résultat réel » est ce qui a été **mesuré sur une Preview du SHA `bfaeae0`** : **aucune requête HTTP authentifiée n'a pu être émise** (0 déploiement pour ce SHA, SSO actif, secrets de test absents, `workflow_dispatch` 403). Un test non exécuté n'est ni un succès ni un échec du code : c'est une preuve absente.

| Scénario | Tenant actif | Ressource | Résultat attendu | Résultat réel | Verdict |
| --- | --- | --- | --- | --- | --- |
| 1. Propriété produit | `A` | `GET /api/products/:id` → `P_A` | 200, produit de A | NON EXÉCUTÉ (aucune session Clerk de test) | NON DÉMONTRÉ |
| 2. ID exact cross-tenant | `A` | `P_B`, `P_C` par ID exact | 404/403 fermé | NON EXÉCUTÉ | NON DÉMONTRÉ |
| 3. Certificat A→S | `S` | `GET /api/supplier/documents/:id/download` → `D_A_VERS_S` | 200 + URL présignée ; refusé pour `B` | NON EXÉCUTÉ | NON DÉMONTRÉ |
| 4. Privé d'une marque liée | `S` | `D_B` | 404/403 | NON EXÉCUTÉ | NON DÉMONTRÉ |
| 5. Fournisseur deux marques | `S` | `D_S_PRIVE`, `D_A_VERS_S`, `D_A`, `D_B` | propres + seul partage A→S ; refus `D_A`/`D_B` | NON EXÉCUTÉ | NON DÉMONTRÉ |
| 6. Compte multi | `A → B → A` | `P_A`, `P_B`, `D_A`, `D_B` | uniquement le tenant armé | NON EXÉCUTÉ | NON DÉMONTRÉ |
| 7. Révocation `REL_AS` | `A` | `D_S_VERS_A`, `D_CERT_S`, `D_REPONSE` | refus immédiat ; `REL_BS` conservée | NON EXÉCUTÉ | NON DÉMONTRÉ |
| 8. Partage borné `scope.document_ids` | `A` | `D_S_VERS_A` / `D_S_VERS_B` | S→A autorisé, S→B refusé | NON EXÉCUTÉ | NON DÉMONTRÉ |
| 9. Accès direct / soft-delete | `A` | `D_S_PRIVE`, `D_B`, `D_A` supprimé, clé/URL directe | refus dans tous les cas | NON EXÉCUTÉ | NON DÉMONTRÉ |
| 10. Bascule sans héritage | `A → B → A` | `D_A`, `D_B`, `P_A` | aucun droit résiduel sur B au retour | NON EXÉCUTÉ | NON DÉMONTRÉ |
| P1. Partage S→A (RLS) | `A` | `D_S_VERS_A` | 200 | NON EXÉCUTÉ | NON DÉMONTRÉ |
| P2. Partage S→B refusé à A | `A` | `D_S_VERS_B` | 404/403 | NON EXÉCUTÉ | NON DÉMONTRÉ |
| P3. Partage S→B (RLS) | `B` | `D_S_VERS_B` | 200 | NON EXÉCUTÉ | NON DÉMONTRÉ |
| P4. Partage S→A refusé à B | `B` | `D_S_VERS_A` | 404/403 | NON EXÉCUTÉ | NON DÉMONTRÉ |
| P5. Propres du fournisseur | `S` | `D_S_*`, `D_A` privé, `D_A_VERS_S` | propres visibles, privé A refusé, certificat A→S visible | NON EXÉCUTÉ | NON DÉMONTRÉ |
| P6. Certificat A→S refusé à B | `B` | `D_A_VERS_S` | 404/403 (fuite mesurée puis fermée au Niveau 1) | NON EXÉCUTÉ | NON DÉMONTRÉ |
| Route sensible — téléchargement fournisseur | `S` | `/api/supplier/documents/:documentId/download` sur `D_B` | refus avant toute URL présignée | NON EXÉCUTÉ | NON DÉMONTRÉ |
| Route sensible — export catalogue | `A` | `/api/catalog/export/products` | 200 contenant **uniquement** A | NON EXÉCUTÉ | NON DÉMONTRÉ |
| Route sensible — qualité | `A` | `/api/quality/overview`, `qualityBundle` | aucune donnée de B | NON EXÉCUTÉ | NON DÉMONTRÉ |
| Route sensible — sélecteur d'organisations | `U_MULTI`, sans tenant explicite | `/api/supplier/organizations` | 400/404 fermé, aucun choix implicite | NON EXÉCUTÉ | NON DÉMONTRÉ |
| Route publique — scan sans session | — | `POST /api/documents/:id/scan` | 401 `requireClerkUser` avant tout accès | NON EXÉCUTÉ | NON DÉMONTRÉ |
| Stockage privé — clé non préfixée | `A` | `POST /api/documents/upload-intent` | refus par `document_path_must_be_tenant_scoped` | NON EXÉCUTÉ | NON DÉMONTRÉ |
| Stockage privé — URL présignée | `A` / `B` | `GET /api/documents/:id/download` | URL émise **après** garde, jamais pour B | NON EXÉCUTÉ | NON DÉMONTRÉ |

Les 138 routes de [`docs/security/route-tenant-matrix.json`](../security/route-tenant-matrix.json) (102 `tenant-valide-explicite`, 25 `public-ou-worker`, 11 `compte-ou-calcul`) sont **classées et vérifiées statiquement**, pas exercées en HTTP sur un déploiement. Aucune matrice HTTP réelle n'est donc produite ; le tableau ci-dessus est la matrice **des preuves manquantes**, pas une matrice de résultats.

---

## 8. Niveau 2 — connexion Preview→Neon, stockage privé distant, Clerk de test, webhooks

| Élément exigé | État mesuré | Verdict |
| --- | --- | --- |
| Preview exclusivement rattachée à la branche Neon isolée, sans repli `DATABASE_URL` Production | aucun déploiement, aucune variable lisible (`list_env_vars` → Access denied) | NON DÉMONTRÉ |
| Noms de variables par cible, secrets de test séparés | aucun inventaire Vercel ; seuls les noms du contrat de code sont connus | NON DÉMONTRÉ |
| Clerk de test (comptes/organisations U/A/B/S, `CLERK_*` de test) | connecteur `clerk` `unsupported`, aucun secret, Production utilise une clé publique `pk_live_*` | NON DÉMONTRÉ |
| SSO actif sur la Preview | **mesuré** : 5 URLs → page Vercel SSO Login, aucun contournement | CONFIRMÉ (protection), mais bloque les parcours |
| Stockage privé isolé + antivirus de test, aucun webhook réel | aucun bucket, aucun secret, aucun webhook déclenché ; `test:private-storage` PASS uniquement en local/CI | NON DÉMONTRÉ à distance |
| Preuve que Preview → Neon (bon hôte, bon rôle, RLS armée) | aucune requête applicative n'a atteint une base distante | NON DÉMONTRÉ |
| Données fictives A/B/S/U sur environnement isolé | aucune création | NON DÉMONTRÉ |

---

## 9. Niveau 3 — Vercel Production / Préproduction, lecture seule

### Ce qui a été mesuré en direct le 2026-11-06

| Objet | Mesure | Lien |
| --- | --- | --- |
| API Production | `GET /api/health` → `{"ok":true,"service":"tracefab-api"}` | [health](https://tracefab.vercel.app/api/health) |
| Configuration publique | `GET /api/config` → clé publique Clerk *live* + proxy `/__clerk` (valeur non reproduite) | [config](https://tracefab.vercel.app/api/config) |
| Readiness protégée | `GET /api/internal/p2/readiness` → 401 `worker_unauthorized` ; `?identity=1` et `?probe=live` non appelés | [readiness](https://tracefab.vercel.app/api/internal/p2/readiness) |
| Historique des déploiements `Production` (GitHub) | **13** déploiements du `2026-10-26T15:51:02Z` au `2026-11-03T14:38:25Z` (8 le 03/11, 1 le 02/11, 2 le 29/10, 2 le 26/10), états `success`, URLs `tracefab-*.vercel.app` | [`deployments/7521679246/statuses`](https://api.github.com/repos/Huberaya/Tracefab/deployments/7521679246/statuses), [`7518530924/statuses`](https://api.github.com/repos/Huberaya/Tracefab/deployments/7518530924/statuses) |
| Dernier statut Production | `2026-11-03T15:27:31Z`, `tracefab-gx297m3z9-….vercel.app`, `success` (redeploiement du déploiement `7518530924`, SHA `788df22`) | idem |
| URLs de déploiements Production | SSO **actif** (`Protected Deployment`), contrairement à l'alias `tracefab.vercel.app` | §6 |
| Domaine / projet / déploiement actif / SHA déployé / branche / noms de variables par cible / webhooks | **non lisibles** : connecteur Vercel `Access denied` sur tous ces endpoints | §6 |

Le [document historique de la #108](https://github.com/Huberaya/Tracefab/blob/2d62609d37457fe48d191b310965a14b54a6e81a/docs/security/2026-11-03-p107-preuve-runtime-production.md) indique que la Production a été redéployée depuis `main` `788df22` sous `dpl_FYHELX51z15ot9Gb2q4Cue7e773c`, état `READY`, alias `tracefab.vercel.app`, sans modification de `main`/données/migrations/variables. **Ce n'est pas une mesure live du 6 novembre** : ni l'ID du déploiement actif, ni son SHA, ni `VERCEL_GIT_COMMIT_SHA`, ni la branche, ni l'historique Vercel n'ont pu être confirmés via l'API. `main` étant toujours `788df22`, le code de Production **ne contient pas** `bfaeae0`.

**Préproduction Vercel :** aucun environnement, aucun déploiement, aucun domaine, aucune URL identifiée dans les 500 déploiements GitHub examinés. Son existence, son état et son SHA sont **non vérifiés** — et surtout pas déclarés sains.

**Verdict Niveau 3 / Vercel : PARTIEL.** Seule la disponibilité publique de l'alias et la protection de la route de readiness sont prouvées. L'inspection de configuration exigée est **NON VÉRIFIÉE**.

---

## 10. Niveau 3 — Neon Production / Préproduction, lecture seule

**Aucun `SELECT` n'a été exécuté sur une base distante le 2026-11-06.** Aucun `DATABASE_URL` de lecture, aucun rôle SQL en lecture seule, aucun `psql`, aucun connecteur Neon. Les éléments demandés — `_prisma_migrations`, attributs de `tracefab_app`, politiques RLS, `SECURITY DEFINER` / `search_path`, GRANT/REVOKE, registre runtime, extensions, état de `systeme_strict`, identité runtime — n'ont donc **pas été mesurés en direct**.

Éléments **historiques** versés au dossier, explicitement datés :

| Source | Date | Contenu (non relu en direct) |
| --- | --- | --- |
| [PR #110 — attestation checksum + snapshot JSON](https://github.com/Huberaya/Tracefab/blob/b27b2afb79b2aee4b425559791433b048aad816f/docs/security/2026-11-04-neon-checksum-variance-attestation.md) | 2026-11-04 | Production/Préproduction : 56 appliquées, 13 `missing`, 5 `out_of_band`, 2 `rolled_back_attempts` (`20261010120000_publication_explicite`, `20261017120000_active_tenant_context`), 0 `unfinished`, 12 objets hors bande, 69 répertoires ; première `20260923130000_tracefab_neon_initial` (`2026-10-05T13:12:46Z`), dernière `20261023120000_revoke_app_default_dml` (`2026-10-22T23:23:42Z`) ; écart `c944ce0c…` vs `6a8d03eb…` sur `20261006210000_plm_erp_gs1_interoperability`. |
| [PR #108 — preuve runtime Production](https://github.com/Huberaya/Tracefab/blob/2d62609d37457fe48d191b310965a14b54a6e81a/docs/security/2026-11-03-p107-preuve-runtime-production.md) | 2026-11-03 | `tracefab_app`, `NOSUPERUSER`, `NOBYPASSRLS`, `neondb`, PostgreSQL 18.6, pooler `session_or_direct`, `readOnly=25006`, `identityKeyState=absente` ⇒ HMAC strict NO-GO ; verdict `IDENTITE_CONFORME`. |
| [PR #114 — rapport de mission P10.7](https://github.com/Huberaya/Tracefab/blob/537bc310d0b6e857c4f74ec0017a130987b22497/docs/security/2026-11-06-rapport-mission-p107.md) | 2026-11-06 | **écrit noir sur blanc** : « Aucune mesure en Production », « Aucune mesure sur Neon », « Aucun déploiement de la révision applicative sur un environnement qui sert », « empreintes de migration Prisma : hors périmètre ». Ses 27 suites vertes portent sur des bases jetables et une « forme de production » reproduite. |

La sonde non destructive `GET /api/internal/p2/readiness?identity=1` existe dans `main` ([`api/_routes/internal/p2-readiness.ts`](../../api/_routes/internal/p2-readiness.ts)) et est protégée par `workerSecretConfigured()` puis `workerAuthorized()` : elle nécessite `TRACEFAB_NOTIFICATION_WORKER_SECRET`, non disponible et non demandé ici. Le commentaire du code le dit lui-même : « Tant que cette sonde n'a pas été exécutée sur le runtime réel, l'identité de Production reste non mesurée. »

**Verdict Niveau 3 / Neon : NON VÉRIFIÉ.** Ce n'est **pas** un constat de conformité : un environnement inaccessible n'est pas un environnement sain.

---

## 11. Compatibilité #108–#114 et ordre d'intégration proposé (sans aucune fusion)

Mesures locales sur les têtes distantes (`git diff` vs `main`, `git merge-tree --write-tree HEAD <ref>`) :

| PR | Fichiers vs `main` | Répertoires de migrations | Fichiers communs avec #113 | Conflits textuels avec #113 | CI (2026-11-06T09:49Z) |
| --- | --- | --- | --- | --- | --- |
| #108 | 1 (doc) | 69 | 0 | **0** | 6/6 PASS, `clean`, draft |
| #109 | 80 | 69 | **80** | **4** (`ci.yml`, `api/_lib/documents.ts`, `package.json`, `scripts/test_active_tenant_routes.mjs`) | `Verification` **FAIL** |
| #110 | 132 | **86** | 50 | **42** | `Socle`/`Chaîne`/`Parcours`/Vercel PASS, 2 jobs `pending` |
| #111 | 132 | 86 | 50 | 42 | 6/6 PASS — **déjà fusionnée dans #110** |
| #112 | 185 | **88** | 65 | **56** | 7/7 PASS, draft |
| #113 | **97** | **70** | — | — | 5 GitHub Actions PASS + Vercel FAIL |
| #114 | 23 | **70** | 4 | **2** (`docs/experience/CHANTIERS-RESTANTS.md`, `scripts/lib/tracefab_runtime_functions.mjs`) | 7/7 PASS, `clean` |

### Faits structurants

1. **#113 est un sur-ensemble intentionnel de #109** : sur les 80 fichiers de #109, **67 sont octet pour octet identiques** dans #113, 13 ont été modifiés (gardes de tenant, `requireActiveTenant`, `TenantError`, téléchargement fournisseur, registre, scripts) et 17 fichiers ajoutés (70ᵉ migration, 4 contrats, 3 documents de preuve). #109 n'est pas un ancêtre de #113 (`merge-base --is-ancestor` = NON) : les fusionner produit 4 conflits.
2. **Collisions de préfixe de migration** (chaînes divergentes, pas de simple concaténation possible) :
   - `20261105180000` : #113 = `_active_tenant_access_guards` ; #110/#111/#112 = `_active_tenant_tc_registration_guard`.
   - `20261105120000` : #114 = `_identite_systeme_signee` ; #110/#111/#112 = `_active_tenant_plm_ingest_enforcement`.
3. **Compteurs de migrations incompatibles** : `scripts/test_chantiers.mjs` compare « Dépôt : N migrations » au nombre réel de répertoires. #113 et #114 annoncent **70**, #110 **86**, #112 **88**. Fusionner #113 + #114 donnerait **71** répertoires pour un compte annoncé à 70 ⇒ échec CI garanti sans réconciliation explicite.
4. **Registre runtime** : `scripts/lib/tracefab_runtime_functions.mjs` est modifié différemment par #113 (3 gardes de tenant) et #114 (identité système, dérivation des droits) ⇒ conflit, union à reconstruire et à repasser par `test:neon:registre-fonctions`.
5. **#110 ⊃ #111** (fusion du 09:43:15Z). #112 n'est un descendant ni de #110 ni de #111 : c'est une **chaîne concurrente** de 88 migrations, avec 56 conflits contre #113.
6. #114 ajoute `api/_routes/internal/p2-readiness.ts` **en modification** (la route existe déjà dans `main`), `api/_lib/identite-systeme.ts`, `scripts/activer_identite_systeme_stricte.mjs` ; sa bascule `systeme_strict` est un **acte d'exploitation humain**, pas une migration, et reste interdite ici.

### Ordre d'intégration proposé (proposition seulement — aucune fusion, aucun déplacement de branche)

| Étape | Action proposée | Justification |
| --- | --- | --- |
| 0 | **Ne rien fusionner maintenant.** | Niveaux 2 et 3 non démontrés ; #113 `unstable` (Vercel rate limit) ; décision NO-GO. |
| 1 | Conserver [#108](https://github.com/Huberaya/Tracefab/pull/108) comme pièce d'archive (1 fichier, 0 conflit, 0 migration) ; la clore ou la fusionner seulement après décision humaine. | Pure documentation historique ; aucun impact code, aucun conflit avec #113. |
| 2 | **#114 avant #113** : sa migration `20261105120000` précède lexicographiquement `20261105180000` ; elle ferme l'escalade P10.7 dont dépend l’intégrité de `tracefab_current_user_id()` utilisée par les gardes de #113 ; elle fournit la route de readiness non destructive. Conditions : porter le compte « Dépôt : **71** migrations », faire l'union du registre runtime, repasser `test:chantiers` et `test:neon:registre-fonctions`. **Ne pas** activer `systeme_strict` sans autorisation humaine distincte. | Ordre des migrations + dépendance fonctionnelle + cohérence des compteurs. |
| 3 | Puis **#113** sur la base réconciliée (71 migrations, registre union). | C'est le SHA à valider ; ses 70ᵉ gardes complètent #114 sans réécrire de migration historique. |
| 4 | **#109 : clore comme superseded, ne pas fusionner.** | `Verification` FAIL, 4 conflits, 67/80 fichiers déjà repris et 13 intentionnellement corrigés dans #113. La tête distante `751004e…` reste intacte. |
| 5 | **#110 / #111 / #112 : chaîne concurrente à ne pas fusionner avec #113+#114 en l'état.** #111 est déjà dans #110. Choisir **une seule** chaîne après une réconciliation formelle sur branche Neon isolée : comparer `_prisma_migrations`, checksums (dont l'écart PLM/GS1), et rejouer `prisma migrate deploy` sur les 86/88 migrations. | 42–56 conflits, collisions de préfixe, compteurs 86/88 vs 71, 105 fichiers de divergence #110→#112. |
| 6 | Aucun déploiement Production, aucune migration Production/Préproduction, aucun secret modifié, aucun webhook réel. | Interdictions explicites de la mission. |

**Une validation de #113 ne valide pas #114, et réciproquement.** Les 7 checks verts de #114 et les 5 checks verts de #113 portent sur des SHA et des chaînes de migrations distincts.

---

## 12. Accès manquants, permissions minimales et procédure préparée — **arrêt avant exécution**

| Accès manquant | Permission minimale demandée | Opération qui deviendrait permise | Preuves impossibles sans lui |
| --- | --- | --- | --- |
| Jeton **Neon** avec portée « lecture des branches + création d'une branche de test » sur le projet Tracefab, sans accès en écriture aux branches servantes | Création d'**une** branche isolée nommée depuis un snapshot daté | `neonctl`/API : créer la branche, consigner parent/ID/date, la détruire en fin de mission après vérification d'absence de donnée réelle | §5 : branche Neon isolée, `prisma migrate deploy` sur `bfaeae0`, `_prisma_migrations`, RLS, rôles, registre, extensions |
| `DATABASE_URL` **de la seule branche isolée** (rôle migrateur) + `TF_RLS_APP_URL` (`tracefab_app`) | Chaînes de connexion de test, jamais celles de Production | `prisma migrate deploy`, `scripts/audit_neon_readonly.mjs` (`--expect-database`), `lire-historique-migrations.mjs`, `lire-role-runtime.mjs`, `test_neon_*`, création des fixtures A/B/S/U | §5, §7, §8 : preuve Preview→Neon et SQL réel |
| Rôle SQL **SELECT-only** sur Neon **Production** et **Préproduction** (`default_transaction_read_only=on`, catalogue seul, aucune table métier) | Lecture seule stricte, aucune élévation | `SELECT` sur `_prisma_migrations`, `pg_roles`, `pg_policies`, `pg_proc`, `information_schema`, ACL, registre, extensions, `tracefab_identity_politique.systeme_strict` | §10 : inspection Niveau 3 en direct |
| Jeton **Vercel** avec périmètre d'équipe `team_BdnOPU97H1GOmMxy7T06nijQ` et portées **lecture** : projets, déploiements, noms de variables d'environnement, domaines, webhooks | Aucune portée d'écriture, aucune lecture de valeur de secret | `list_projects`, `list_deployments(target=production)`, `list_env_vars` (**noms seulement**), `get_deployment`, `get_domain_config`, `list_webhooks` | §6, §9 : projet, domaine, déploiement actif, SHA, branche, historique, noms de variables par cible, SSO, stockage isolé |
| Droit GitHub `actions: write` **ou** un push sur une branche de mission dédiée (interdit ici) | Déclenchement de workflows de sonde sans secret | `gh workflow run sondage-preview.yml` / `preview-surface-probe.yml` depuis un runner GitHub (mesure HTTP réelle, détection `vercel_auth_enabled` ⇒ `INDETERMINATE`, jamais un faux PASS) | §6, §7 : sondes HTTP indépendantes |
| Environnement `tracefab-clerk-test` : secrets `CLERK_SECRET_KEY`, `TF_PREVIEW_USER_ALPHA/BETA`, `TF_PREVIEW_ORG_ALPHA/BETA`, `VERCEL_AUTOMATION_BYPASS_SECRET` ; variables `TF_PREVIEW_EXPECTED_ORIGIN`, `TF_PREVIEW_STORAGE_HOST`, `TF_PREVIEW_DEPLOYED_SHA`, `TF_PREVIEW_TEST_ENV_CONFIRMED` ; instance **Clerk de test** ; bucket S3 + antivirus de test | Relecteurs obligatoires conservés ; attestation explicite de nature TEST ; aucun fallback Production ; aucun webhook réel | `preview-http-journeys.yml` : 10 scénarios tenant actif, 6 scénarios de partage, routes sensibles de `route-tenant-matrix.json`, tests de stockage privé | §7, §8 : matrice HTTP réelle, stockage privé distant, partages fournisseur |
| Secret worker `TRACEFAB_NOTIFICATION_WORKER_SECRET` (ou équivalent opérateur) pour la sonde non destructive | Lecture de la seule route `GET /api/internal/p2/readiness?identity=1` | Mesure de `current_user`/`session_user`/`bypassesRls`/`isSuperuser` sur le runtime réel, sans écriture | §10 : identité runtime Production non destructive |

**Procédure prête, non exécutée :** (1) fournir les accès ci-dessus ; (2) attendre la fin de la fenêtre Vercel `build-rate-limit` (`2026-11-06T23:34:47Z`) ou obtenir un créneau de build ; (3) créer la branche Neon isolée et la Preview dédiée au SHA `bfaeae0` ; (4) `prisma migrate deploy` ; (5) audits `SELECT` ; (6) harnais HTTP avec comptes de test ; (7) matrice HTTP ; (8) inspection lecture seule Production/Préproduction ; (9) destruction des **seules** ressources temporaires créées, après vérification qu'elles ne contiennent aucune donnée réelle.

Conformément à la consigne, **je me suis arrêté avant l'étape 1** : aucune demande d'exécution manuelle n'est adressée à l'utilisateur pour une commande que l'agent aurait pu lancer lui-même ; ici l'agent ne peut pas, faute de permissions.

---

## 13. Limites, erreurs mesurées et impasses (ne pas réessayer à l'identique)

- **Vercel** : `list_projects`, `list_deployments` (avec/sans `team_id`, `project_id=tracefab`, `target=production`), `list_domains`, `list_project_domains`, `list_env_vars`, `list_webhooks`, `list_user_events`, `get_project('tracefab')` → `Access denied … token permissions/team scope`. `list_teams=[]` malgré `defaultTeamId` ; `validate_credential` ne confère aucun droit d'inventaire. `get_deployment` sur 4 UID issus de `gh pr checks` → 404 ; sur 2 `dpl_` historiques → Access denied ; `get_deployment_events` et URL complète en ID → 404/endpoint. **Ne pas reconstruire d'ID.**
- **GitHub** : `workflow_dispatch` 403 ; `branches/main/protection` 403 ; noms des secrets/variables Actions 403 ; logs de runs via `results-receiver.actions.githubusercontent.com` → `EOF` ; artefacts du run `40481526660` expirés (`total_count: 0`). Ne jamais conclure à partir de logs absents.
- **SSO** : `fetch_page` sur les URLs de déploiements renvoie systématiquement la page Vercel « Protected Deployment – Login ». Aucun bypass, aucun cookie, aucun jeton de contournement. L'alias `tracefab.vercel.app` est public mais ne prouve ni SHA, ni base, ni RLS, ni rôle runtime.
- **Neon/Clerk** : connecteurs `unsupported` ; aucun `DATABASE_URL`, `TF_RLS_APP_URL`, `psql`, `neonctl`, `vercel`, aucun secret de test. Les documents #108/#110/#114 sont des **preuves historiques versionnées**, pas des mesures du 2026-11-06.
- **Déploiements GitHub** : les 100 plus récents ne contiennent que `Preview` ; il a fallu lire les pages 2–5 pour trouver les 13 `Production` (2026-10-26 → 2026-11-03). Ne pas déduire l'absence de Production Vercel de la première page, ni le SHA Production de l'alias public.
- **Outils** : `npm ci` complet échoue localement sur `binaries.prisma.sh` (TLS) ; le client Prisma généré hors ligne est **types-only** (`verify:prisma-client` sort 1 localement). `migrer_fidelement.mjs` est hors ligne et refuse la Production. `docs/security/route-tenant-matrix.json` : `routes` est un **nombre** (138), pas un tableau (le tableau est `matrice`).
- **Pièges déjà rencontrés** : contrats statiques/regex ≠ PGlite ≠ harnais HTTP réel ; `set -e` avec pipe masque l'exit (`${PIPESTATUS[0]}`) ; `gh pr diff 109 --stat` invalide (utiliser `--name-only` ou `git diff --stat`) ; `test:regression` dépend des fontes système et est exclu de CI.
- **Aucun environnement actif n'a été modifié** au cours de cette mission. Un manque d'accès n'a jamais été converti en GO.

---

## 14. Verdicts indépendants et décision finale

| Élément | Environnement | Preuve disponible (date · run / déploiement) | Verdict indépendant | Limite |
| --- | --- | --- | --- | --- |
| **Code #113** | GitHub / CI Actions | `bfaeae0`, 97 fichiers, run [`42130549875`](https://github.com/Huberaya/Tracefab/actions/runs/42130549875), 5 checks PASS · 2026-11-05/06 | **VALIDÉ (code + CI jetable)** | `Vercel` FAIL `build-rate-limit` ; `unstable` ; ne valide ni N2 ni N3 |
| **PostgreSQL jetable** | PGlite / PostgreSQL 17-18 CI | 77/0, 138 routes, 154/154 scripts, 95 noms de registre · run `42130549875` | **VALIDÉ (Niveau 1)** | Aucune extrapolation vers Neon, Preview ou Production |
| **Neon isolé** | Branche Neon de test du SHA exact | **aucune branche créée**, aucun `prisma migrate deploy`, aucun `SELECT` · 2026-11-06 | **NON DÉMONTRÉ — NO-GO** | Preuves #110 du 2026-11-04 = historiques, autre SHA/chaîne |
| **Preview authentifiée** | Vercel Preview de `bfaeae0` | 0 déploiement (`deployments?sha` vide), rate limit jusqu'au `2026-11-06T23:34:47Z`, SSO mesuré sur 5 URLs | **NON DÉMONTRÉ — NO-GO** | `READY` n'aurait pas suffi ; secrets de test absents |
| **Stockage privé** | Preview + Neon isolés | `test:private-storage` PASS en local/CI uniquement | **NON DÉMONTRÉ à distance** | Aucun bucket, antivirus, clé ni URL présignée testés sur déploiement |
| **Partages fournisseur** | HTTP Preview | 6 scénarios RLS + 10 scénarios tenant actif PASS en PGlite uniquement | **NON DÉMONTRÉ à distance** | §7 : 23 lignes `NON EXÉCUTÉ` |
| **Production lecture seule** | Vercel Production + Neon Production/Préproduction | `health` 200, `config` 200 (clé publique *live*), `readiness` 401, 13 déploiements `Production` (26/10 → 03/11/2026) · mesure du 2026-11-06 | **PARTIEL / NON VÉRIFIÉ** | Projet, domaine, déploiement actif, SHA, branche, noms de variables, `_prisma_migrations`, rôles, RLS, `SECURITY DEFINER`, GRANT/REVOKE, registre, extensions, `systeme_strict` : **non mesurés** |
| **Compatibilité #108–#114** | GitHub (têtes distantes) | 0/4/42/42/56/2 conflits, collisions `20261105180000` et `20261105120000`, compteurs 70/86/88 · 2026-11-06 | **ANALYSÉE, NON TRANCHÉE** | Ordre proposé §11 ; **aucune fusion**, aucun déplacement de branche |
| **Clôture** | 16 critères de la mission | Niveau 1 seul satisfait ; N2/N3 absents | **NO-GO** | Un environnement inaccessible n'est pas un environnement sain |
| **Déploiement Production** | Vercel Production | aucun | **NON AUTORISÉ / NON EXÉCUTÉ** | Interdiction explicite ; aucune migration ni secret modifié |

### Décision

**NO-GO global.** Le SHA `bfaeae07da4f13e2da80946b7b5b0dc7f6d348a7` reste le code à valider et son Niveau 1 est solide, mais les preuves distantes exigées — branche Neon isolée migrée, Preview dédiée au SHA exact, parcours HTTP authentifiés, matrice HTTP réelle, stockage privé distant, partages fournisseur, et inspection lecture seule de Vercel/Neon Production et Préproduction — **n'ont pas pu être produites avec les accès disponibles**. Aucune d'elles n'a été remplacée par une affirmation, un build, une CI verte ou un document historique. La procédure et les permissions minimales sont préparées au §12 ; l'exécution reste à autoriser, sans fusion préalable.

---

### Livrables de cette mission

- `docs/security/preuves-distantes-niveaux-2-3-2026-11-06.md` (ce rapport, **14 sections**, non commité).
- Réutilisés sans modification : `docs/security/preuves-isolation-globale-2026-11-06.md`, `docs/security/matrice-autorisations-tenant-actif.md`, `docs/security/route-tenant-matrix.json`, `scripts/test_isolation_globale_pglite.mjs`.
- Aucun commit, aucun push, aucun commentaire, aucune fusion, aucun déploiement, aucune migration, aucune écriture SQL distante, aucune lecture de valeur secrète.
