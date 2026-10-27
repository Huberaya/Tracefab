# 01 — ÉTAT FINAL — publication, CI et blocages Preview

**Date** : 2026-10-26 (Europe/Paris)
**Branche publiée** : `arena/647ac97c-tracefab` — **nouvelle** branche distante (absente de `origin` avant cette mission), dédiée à cette livraison. La contrainte de session Arena impose de rester sur cette branche ; elle joue donc le rôle de « branche dédiée au nom explicite ». Aucune autre branche locale ou distante n'a été créée.
**PR** : [#101](https://github.com/Huberaya/Tracefab/pull/101) — **ouverte, non fusionnée**, état `MERGEABLE`, base `main`.
**Base** : `origin/main = bf55f2ae6534cde84d072d9b975520216c7b6d4e` (inchangée pendant toute la mission).
**SHA du CODE ayant passé tous les contrôles CI** : **`3d2f61fc0abe3db2ad4f6c3f0f76634c1a260a7b`** (run [`40409887448`](https://github.com/Huberaya/Tracefab/actions/runs/40409887448), 4/4 jobs verts).
**SHA local = SHA distant** : vérifié par `git ls-remote origin refs/heads/arena/647ac97c-tracefab`.

> Ce fichier est un commit de **documentation** ajouté après le SHA validé ci-dessus. Sa propre exécution CI est consignée dans le commentaire de clôture de la PR #101 (et dans la réponse de l'agent). Le SHA qui porte les contrôles techniques reste `3d2f61f`.

---

## 0. Écart constaté avant toute action (consigné, pas masqué)

Le rapport `00-CLOTURE.md` annonçait `462d022`, `17ed269`, `fd7c849` et deux tags. **Aucun de ces objets n'existait plus** : le workspace avait été re-cloné depuis `bf55f2a`, l'intégralité du travail étant présente sous forme de **41 fichiers modifiés/non suivis** non commités, sans reflog, sans objet non référencé (`git fsck` vide). L'environnement d'exécution avait lui aussi disparu (`node_modules`, PostgreSQL, Chromium, `/tmp/*`).

**Action** : reconstruction de l'historique à partir des fichiers **intacts**, sans réinitialisation, sans nettoyage, sans remplacement. L'arbre du premier commit reconstruit est **identique** à celui annoncé (36 fichiers, `+1970/−35`) ; preuve que le contenu n'a pas été altéré.

| Objet annoncé | Objet réel conservé | Commentaire |
|---|---|---|
| `462d022` | `bf0eb483130afdb2207757190775f69d79a7020d` | mission fonctionnelle, 36 fichiers, arbre identique |
| `17ed269` | `1c290ce1767e42904de9880c82ab50eae583b9ef` | preuves HTTP + correctif 401 |
| `fd7c849` | `fcc2117345892cae3f7a16642de7cd5172d71934` | rapport `00-CLOTURE.md` + note de reconstruction |
| — | `3d2f61fc0abe3db2ad4f6c3f0f76634c1a260a7b` | correctif CI + durcissement §7 (ce SHA a la CI verte) |
| tag `mission-fonctionnelle-2026-10-26` | → `bf0eb48` | repositionné localement |
| tag `mission-finalisation-2026-10-26` | → `fcc2117` | repositionné localement |

`00-CLOTURE.md` a été **conservé** ; seule une note d'en-tête expliquant la reconstruction y a été ajoutée. Aucune preuve précédente n'a été effacée.

---

## 1. Publication

| Élément | Résultat | Verdict |
|---|---|---|
| `git push -u origin arena/647ac97c-tracefab` | `[new branch]`, push normal, **aucune option `--force`** | **PASS** |
| SHA distant après 1er push | `fcc2117345892cae3f7a16642de7cd5172d71934` | **PASS** |
| `gh pr create --base main --head arena/647ac97c-tracefab` | PR [#101](https://github.com/Huberaya/Tracefab/pull/101) créée, `MERGEABLE`, titre et description factuels | **PASS** |
| SHA distant après correctif | `3d2f61fc0abe3db2ad4f6c3f0f76634c1a260a7b` (fast-forward, sans force) | **PASS** |
| Contenu étranger | `git diff bf55f2a..HEAD` = **42 fichiers, +3099/−41**, tous rattachés à cette mission (routes DPP, i18n, rapports, harnais, 1 ligne de workflow CI) | **PASS** |
| `main` modifié directement / PR fusionnée / déploiement de production / secret / rôle DB / migration de production / protection désactivée | **aucun** | **PASS** |

---

## 2. CI — preuve sur le SHA exact

### Run 1 — [`40407249849`](https://github.com/Huberaya/Tracefab/actions/runs/40407249849) sur `fcc2117` : **FAIL**

| Job | Conclusion | URL |
|---|---|---|
| Socle — types, compilation, isolation | success | [job](https://github.com/Huberaya/Tracefab/actions/runs/40407249849/job/121868084342) |
| Parcours — navigateur réel | success | [job](https://github.com/Huberaya/Tracefab/actions/runs/40407249849/job/121868470096) |
| Base — isolation RLS exécutée | success | [job](https://github.com/Huberaya/Tracefab/actions/runs/40407249849/job/121868470138) |
| **Verification — suite de tests** | **failure** | [job](https://github.com/Huberaya/Tracefab/actions/runs/40407249849/job/121868470277) |

**Cause exacte** (obtenue via `gh api .../check-runs/121868470277/annotations`, les journaux bruts étant hébergés hors des hôtes autorisés) :

```
suites en echec : test:mission-functional
NON EXECUTE — DATABASE_URL absent(s).
scripts/test_mission_functional_dpp.mjs : aucune cible fournie, donc aucune execution.
Un test qui ne tourne pas ne vaut pas un test qui passe : sortie 2.
```

Le job `verification` énumère tous les scripts `test:*` mais **ne monte pas de PostgreSQL**. La suite DB ajoutée par notre mission s'y trouvait donc sans base.

**Correction appliquée** (sans affaiblir la suite) :
- `package.json` : `test:mission-functional` → **`test:neon:mission-functional`** (convention du dépôt, déjà exclue de l'énumération du job `verification` par `!k.includes('neon')`).
- `.github/workflows/ci.yml` : ajout d'une étape explicite `Mission fonctionnelle DPP — persistance, preuves, aperçu privé, isolation` dans le job **`base-de-donnees`**, où PostgreSQL jetable, 57 migrations, `tracefab_app` et le seed existent réellement. **La suite tourne désormais en CI** au lieu d'être ignorée.
- Aucune assertion modifiée ; `test:workflow-policy`, `test:workflow-policy-temoins`, `test:db-routing`, `test:ci-no-production-access` vérifiés en local : tous `exit=0`.

### Run 2 — [`40409887448`](https://github.com/Huberaya/Tracefab/actions/runs/40409887448) sur **`3d2f61f`** : **SUCCESS** (4/4)

| Job | Conclusion | Durée | URL |
|---|---|---|---|
| Socle — types, compilation, isolation | success | 43 s | [job](https://github.com/Huberaya/Tracefab/actions/runs/40409887448/job/121877541741) |
| Base — isolation RLS exécutée | success | 59 s | [job](https://github.com/Huberaya/Tracefab/actions/runs/40409887448/job/121877916676) |
| Parcours — navigateur réel | success | 6 min 16 | [job](https://github.com/Huberaya/Tracefab/actions/runs/40409887448/job/121877916492) |
| Verification — suite de tests | success | 7 min 44 | [job](https://github.com/Huberaya/Tracefab/actions/runs/40409887448/job/121877916529) |

`gh run watch 40409887448 --exit-status` → `exit=0`. `gh pr checks 101` → 6/6 `pass` (4 jobs CI + `Vercel` + `Vercel Preview Comments`).

Étapes notables vérifiées **vertes sur ce SHA** : `Generer le client Prisma` (génération **native**), `Compilation complete` (`npm run build`), `Suite complete des scripts test:*`, `Couverture HTTP de l'authentification des routes tenant` (159/159), `Chargement des modules de route` (140 routes), `Isolation multi-locataires`, `Contexte de locataire actif`, `Routage des suites destructives`, `Politique des workflows`, `Isolation inter-organisations`, `Contexte de locataire actif en base`, `Cycle de vie documentaire`, **`Mission fonctionnelle DPP — persistance, preuves, aperçu privé, isolation`**.

### Génération Prisma standard — distinction réseau / code

| Méthode | Résultat |
|---|---|
| `npm run db:generate` en CI (4 jobs, `npm ci` + génération native) | **PASS** sur `fcc2117` **et** sur `3d2f61f`. Ce n'est **pas** une déduction depuis `bf55f2a` : l'étape `Generer le client Prisma` est verte dans les jobs du run `40409887448`. |
| `npm run db:generate` en local | **BLOCKED (réseau)** — `request to https://binaries.prisma.sh/.../schema-engine.gz.sha256 failed, reason: Client network socket disconnected before secure TLS connection was established`, `exit=1`. Erreur d'environnement, **pas une erreur de code**. Aucun miroir de binaire natif disponible sur les hôtes autorisés (`@prisma/engines@6.19.3` ne contient que 10 fichiers JS). |
| `npm run db:generate:offline` + `npm run verify:prisma-client` | **PASS** — client WASM officiel, 49 modèles, moteur 2 297 601 octets, magie `\0asm`, `@prisma/adapter-pg` présent. Méthode de repli local, **jamais** présentée comme la génération standard. |

---

## 3. Matrice des parcours HTTP authentifiés

Tous les contrôles ci-dessous sont exécutés par `NODE_ENV=test TF_HTTP_INTEGRATION_HARNESS=1 npx tsx scripts/test_mission_http_integration.mjs` contre le **vrai routeur `api/index.ts` sur un vrai socket TCP**, le **vrai `verifyToken`**, le **vrai client Prisma** sous `tracefab_app` (`bypassrls=false`) et un vrai PostgreSQL 16.2 jetable. **53/53 contrôles = PASS.**

| # | Parcours demandé | Contrôles | Local | Preview |
|---|---|---|---|---|
| 1 | Produit créé, modifié, relu dans une nouvelle transaction, après rechargement | A1–A5 (5) | **PASS** | **BLOCKED** |
| 2 | Dépôt document, URL signée SigV4, transfert des octets, scan antivirus, téléchargement, intégrité | B1–B10 (10) | **PASS** | **BLOCKED** |
| 3 | Acceptation, rejet avec motif, historique des décisions | C1–C4 (4) | **PASS** | **BLOCKED** |
| 4 | Aperçu privé du DPP brouillon + en-têtes `Cache-Control: no-store, private`, `X-Robots-Tag: noindex, nofollow` | D1–D5 (5) | **PASS** | **BLOCKED** |
| 5 | Requêtes anonymes → 401 | F (5) | **PASS** | **BLOCKED** |
| 6 | Jeton invalide / forgé / expiré / malformé → 401 ; jeton valide toujours accepté | F6, F10, F11.1–3, F12 (6) | **PASS** | **BLOCKED** |
| 7 | Isolation Alpha/Beta (produits, documents, DPP) | E0–E10 (11) | **PASS** | **BLOCKED** |
| 8 | Fichier de test EICAR rejeté par l'antivirus, non téléchargeable | F7–F9 (3) | **PASS** | **BLOCKED** |
| 9 | Protections Vercel actives | §6 ci-dessous | **PASS** (mesure directe) | — |

Mesures complémentaires : F13/F14/F15 (3) — distinction erreurs jeton / erreurs serveur ; F11 agrégé (1). Total 53.

### Résultats d'isolation Alpha/Beta (HTTP, deux identités, deux organisations)

| Contrôle | Résultat |
|---|---|
| Beta → `GET /api/products/:idAlpha` | 404 |
| Beta → `GET /api/documents?productId=:idAlpha` | 200, `documents: []` |
| Beta → `GET /api/documents/:docAlpha/download` | 404 |
| Beta → `POST /api/documents/:docAlpha/validation` | 404 |
| Beta → `POST /api/documents/:docAlpha/scan` | 404 |
| Beta → `GET /api/products/:idAlpha/dpp/preview` | 404 |
| Catalogue de Beta | aucun produit d'Alpha |
| Jeton Alpha + en-tête `X-Tracefab-Organization-Id: orgBeta` | 404 (le serveur ne suit pas un locataire non autorisé) |
| Alpha tente d'associer une preuve au produit de Beta | 404 `product_not_found` |

Aucune lecture ni modification croisée n'a réussi. Rôle applicatif mesuré : `current_user=tracefab_app`, `rolbypassrls=f`.

---

## 4. État de Clerk, du stockage privé, de l'antivirus et des protections Vercel

| Composant | Ce qui est réellement validé | Ce qui reste **BLOCKED** |
|---|---|---|
| **Clerk** | Instance **de test locale** JWKS/BAPI, jetons RS256 signés et vérifiés par le vrai `verifyToken` ; cas valide / absent / malformé / expiré / forgé. | Aucune clé `sk_test_…` d'instance Clerk réelle disponible. `verify:routes:isolation` → `exit=2 NON EXECUTE — CLERK_SECRET_KEY absente`. Présence des secrets GitHub illisible : `403 Resource not accessible by integration`. **Aucune clé `sk_live_` utilisée.** |
| **Stockage privé** | Bucket S3 **de test local** vérifiant réellement SigV4 (signature, méthode, expiration). Résultat : `2 objets, 5 lectures signées, 2 refus de signature`. URL non signée → 403 ; signature falsifiée → 403. Octets relus à l'identique. | Bucket managé (S3/R2) non configuré/validé. Les 7 variables `PRIVATE_STORAGE_*` sont absentes localement ; `list_env_vars` Vercel → **Access denied**. |
| **Antivirus** | Endpoint `tracefab-v1` **de test local** : `POST` des octets + `X-Tracefab-Scan-Protocol` + bearer ; verdict `{clean,mimeType}`. Fichier sain → `available`, EICAR → `rejected` et non téléchargeable. | Antivirus managé non validé. |
| **Protection Vercel** | **Mesurée active** : `GET https://tracefab-git-arena-b9a1c6-…vercel.app/api/health` renvoie la page `Protected Deployment – Vercel` avec redirection vers `vercel.com/login?.../sso-api?...`. **Aucun contournement tenté.** | Le secret de bypass (`VERCEL_AUTOMATION_BYPASS_SECRET`) est indispensable pour que le pré-vol P1 atteigne l'application ; il est inaccessible ici. |

**Conclusion honnête** : les 53 contrôles prouvent le **code et les protocoles**, pas les services managés de Preview. Les parcours HTTP sur une véritable Preview restent **BLOCKED**, de même que le stockage et l'antivirus managés.

---

## 5. Sécurité et qualité du correctif `api/_lib/auth.ts`

| Exigence §7 | Preuve | Verdict |
|---|---|---|
| Aucun jeton non vérifié accepté | `claims.sub` reste exigé après le `try/catch` ; aucune branche ne retourne un utilisateur sans vérification. F12 : le jeton valide est accepté, les 5 jetons invalides sont refusés. | **PASS** |
| Jeton invalide → 401 | F6 (forgé), F10 (expiré), F11.1–3 (structure, base64, `alg:none`), F1–F5 (absent) : tous 401. | **PASS** |
| Erreurs serveur inattendues NON masquées en 401 | Le `catch` est étroit : seules les 9 raisons `TokenVerificationErrorReason` liées au jeton deviennent `UnauthorizedError` ; les 6 raisons d'exploitation (`secret-key-invalid`, `jwk-remote-*`, `jwk-local-missing`, `jwk-failed-to-resolve`) sont **relancées** → 500 journalisable. `isRejectedTokenVerification()` exportée et éprouvée (F13/F14/F15). | **PASS** |
| Cas valides, absents, malformés, expirés, forgés couverts | 5 familles couvertes par des contrôles nommés ; 53/53 locaux + 159/159 couverture de routes en CI. | **PASS** |
| Aucun secret/jeton dans les journaux ou rapports | `grep -cE 'eyJ[A-Za-z0-9_-]{20,}\|Bearer …\|sk_test_[A-Za-z0-9]{20,}'` sur les trois journaux locaux → `0` partout. Le harnais n'imprime que des compteurs et des statuts. `git diff` audit avant push : aucune valeur. | **PASS** |
| Aucune assertion affaiblie | Le correctif CI a **ajouté** une étape d'exécution ; aucune suite n'a été exclue d'un test qu'elle pouvait exécuter. | **PASS** |

---

## 6. PR concurrentes — état distant réel et conflits

Conflits mesurés par `git merge-tree --write-tree HEAD origin/pr/N` après `git fetch --unshallow` (clone à nouveau superficiel). `HEAD` = `3d2f61f`.

| PR | État | Conflits | Analyse |
|---|---|---|---|
| **#99** | **MERGED**, merge commit `effe0dc7034737d5f49c226e23c08f775f525dee` | 0 | A réellement fusionné **23 fichiers** : cycle de vie archivage/restauration complet (API `restoreRequested`, audit `product.restored`, garde `owner/admin`, `reuseSourceProduct`, provenance `source_archived_product_id`, 9 catalogues i18n, tests `test_customer_journey_release_blockers.mjs`). |
| **#98** | open, `dirty`, head `359d593` | **3** : `api/_routes/products/[productId].ts`, `assets/i18n/fr.json`, `assets/js/brand-console.1.js` | Ne touche que **4 fichiers**. Sa logique (archivage + restauration + réutilisation) est **un sous-ensemble redondant** de #99 déjà dans `main`, avec des noms de clés incompatibles (`archivedProducts*` vs `pa*`, `modalProductTemplate` vs `reuseSourceProduct`). `git merge-tree origin/main origin/pr/98` confirme 3 conflits. **Un seul apport utile non intégré** : une confirmation utilisateur avant restauration (`window.confirm(bt('archivedProductsRestoreConfirm'))`), absente de `restoreArchivedProduct()` dans `main`. **Recommandation** : ne pas fusionner #98 telle quelle ; demander à son auteur un rebase sur `main` ne conservant que la confirmation + sa clé i18n (9 locales + parité stricte), puis fermer #98. **Aucune PR fermée** — décision laissée à l'humain. |
| **#80** | open, `behind` | **0** | `clerk-tenant-journeys.yml` : `on: workflow_dispatch`, `if: github.ref == 'refs/heads/main'`, `environment: tracefab-clerk-test`, `TF_ROUTES_TEST_HARNESS=1`, `CLERK_SECRET_KEY: ${{ secrets.CLERK_SECRET_KEY }}`, PostgreSQL 17 jetable en service. **Blocage précis** : (a) la condition `if` interdit l'exécution sur toute branche de PR ; (b) l'environnement est protégé (relecteur requis `Huberaya` + `custom_branch_policies: true`) ; (c) présence du secret illisible (403). **Correction autorisée recommandée** : ajouter une entrée `workflow_dispatch` avec paramètre de branche et assouplir le `if` **sans** supprimer l'environnement protégé. |
| **#91** | open, `behind` | **0** | `p1-staging-authenticated.yml`, `p1-staging-surface.yml`, `p1-staging-inventaire.yml`, `scripts/list_secret_names.mjs` (noms uniquement). **Blocage précis** : (a) `on.push.branches: ['arena/88857a44-tracefab']` et URLs de Preview d'autres branches codées en dur par défaut ; (b) 3 secrets requis (bypass Vercel, `CLERK_SECRET_KEY` de test, secret worker) ; (c) pré-vol `TF_PROBE_STRICT=1` échoue tant que la Preview répond `Protected Deployment – Vercel` — ce que nous avons mesuré. **Correction autorisée recommandée** : lancer en `workflow_dispatch` avec `preview_url` = l'URL de la Preview de la PR #101, et configurer le secret de bypass ; ne jamais désactiver la protection. |
| **#70** | open (draft), `dirty` | **5** : `docs/experience/CHANTIERS-RESTANTS.md`, migration `20261021120000_limit_app_function_execute/migration.sql` (add/add), `scripts/lib/tracefab_app_role.mjs`, `scripts/lib/tracefab_runtime_functions.mjs` (add/add), `scripts/test_privileges_role_app.mjs` | Conflits de sécurité add/add. **Plan sans action interdite** : faire rebaser #70 par son auteur sur `main` + notre branche, arbitrer les deux versions de la migration, puis relancer `test:neon:privileges-role-app`, `test:neon:ecarts-privileges` et `test:workflow-policy`. Aucune fusion effectuée. |
| **#82** | open, `dirty` | **1** : `docs/experience/CHANTIERS-RESTANTS.md` | Conflit documentaire. Plan : résolution additive du journal de chantier, puis revue sécurité. |
| **#92 / #93 / #94** | open, `behind` | **1 chacune** : `package.json` | Trois ajouts de scripts npm concurrents dans la même zone. Plan : fusion additive des lignes de scripts (aucune suppression), puis `test:i18n`, `test:assets`, `test:routes`. Aucune fusion effectuée. |

---

## 7. Secrets, permissions et blocages externes — sans aucune valeur

| Constat | Détail |
|---|---|
| GitHub — secrets | `gh api repos/Huberaya/Tracefab/actions/secrets` → **403 `Resource not accessible by integration`**. Idem pour `environments/{Preview,Production,tracefab-clerk-test}/secrets` et `actions/variables`. Le jeton de la session n'a pas `secrets:read`. Présence des secrets donc **non vérifiable**. |
| GitHub — environnement | `tracefab-clerk-test` existe (id `24943335828`) ; `deployment_branch_policy.custom_branch_policies=true`, règle `branch_policy`, **relecteur requis**. Toute exécution sur cet environnement demande une approbation humaine. |
| Vercel — connecteur | `validate_credential` → success ; `list_teams` → `[]` ; `list_projects`, `list_deployments`, `list_env_vars` → **Access denied** ; `get_deployment` sur l'identifiant fourni par le bot Vercel → **404 Deployment not found**. Le token est valide mais **sans portée projet**. |
| Vercel — Preview | Déploiement créé pour la PR (`Vercel` et `Vercel Preview Comments` = `pass`), URL `https://tracefab-git-arena-b9a1c6-…vercel.app`. La protection de déploiement est **active**. |
| Local | `CLERK_SECRET_KEY`, `TRACEFAB_STAGING_URL`, `PRIVATE_STORAGE_*`, `PRIVATE_STORAGE_ANTIVIRUS_*` : **ABSENTS**. Aucune valeur demandée, lue, écrite ou journalisée. |

### Variables à configurer et où (noms uniquement)

| Environnement | Emplacement exact | Variables |
|---|---|---|
| GitHub **Environment `tracefab-clerk-test`** | `Settings → Environments → tracefab-clerk-test → Environment secrets` | `CLERK_SECRET_KEY` (obligatoirement `sk_test_…`, **jamais** `sk_live_`), `VERCEL_AUTOMATION_BYPASS_SECRET` (ou `VERCEL_PROTECTION_BYPASS_SECRET` / `VERCEL_BYPASS_SECRET`), `TRACEFAB_NOTIFICATION_WORKER_SECRET` (ou `TRACEFAB_STAGING_WORKER_SECRET` / `TRACEFAB_WORKER_SECRET`), `VERCEL_READONLY_TOKEN` |
| Vercel projet `tracefab`, cible **Preview uniquement** | `Vercel → Project → Settings → Environment Variables`, cocher `Preview` | `DATABASE_URL` (base de test), `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET`, `TRACEFAB_AUTHORIZED_PARTIES`, `PRIVATE_STORAGE_ENDPOINT` (HTTPS), `PRIVATE_STORAGE_BUCKET` (= `tracefab-private`), `PRIVATE_STORAGE_REGION`, `PRIVATE_STORAGE_ACCESS_KEY_ID`, `PRIVATE_STORAGE_SECRET_ACCESS_KEY`, `PRIVATE_STORAGE_PRESIGN_SECONDS` (60–3600), `PRIVATE_STORAGE_ANTIVIRUS_URL`, `PRIVATE_STORAGE_ANTIVIRUS_TOKEN` |
| Permissions | Vercel → Team → Settings → Tokens | Étendre la portée du token au projet `tracefab` (actuellement `Access denied`). |
| Antivirus | Service dédié de test | Contrat `tracefab-v1` : `POST` des octets bruts + `X-Tracefab-Scan-Protocol: tracefab-v1` + bearer ; réponse `{"clean":true|false,"mimeType":"…"}`. Le scanner doit exiger son jeton. |

### Commandes exactes à rejouer après configuration (à ne pas lancer avant)

```bash
# 1. Présence des secrets, sans jamais afficher de valeur (administrateur)
gh secret list --env tracefab-clerk-test          # noms uniquement

# 2. Parcours Clerk d'isolation sur PostgreSQL jetable (PR #80 fusionnée ou workflow dispatché)
TF_ROUTES_TEST_HARNESS=1 \
DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/tracefab_test' \
TF_APP_PASSWORD='<mot de passe jetable>' \
TF_RLS_APP_URL='postgresql://tracefab_app:<mot de passe jetable>@127.0.0.1:55432/tracefab_test' \
CLERK_SECRET_KEY='<sk_test_… fourni par mecanisme securise>' \
npm run verify:routes:isolation

# 3. Pré-vol puis suite P1 sur la Preview de la PR #101 (PR #91 fusionnée ou dispatchée)
TRACEFAB_STAGING_URL='https://tracefab-git-arena-<…>.vercel.app' \
TRACEFAB_VERCEL_BYPASS='<secret de bypass>' \
CLERK_SECRET_KEY='<sk_test_…>' \
npm run test:p1:staging

# 4. Rejouer les 53 contrôles HTTP contre la Preview (apres adaptation du harnais
#    pour cibler une URL distante au lieu des services locaux — travail restant)
```

---

## 8. Commandes exécutées localement — résultats

| Commande | Résultat |
|---|---|
| `npm ci --ignore-scripts --no-audit --no-fund` | `added 174 packages`, `exit=0` |
| `npm run db:generate:offline` / `npm run verify:prisma-client` | `exit=0` / `exit=0` (49 modèles, WASM officiel) |
| `npm run db:generate` (local) | `exit=1` — TLS `binaries.prisma.sh` (réseau) |
| Reconstruction PostgreSQL : `initdb` + 57 migrations + `bootstrap_app_role.mjs` | `57/57`, 50 tables, 130 fonctions, `tracefab_app` `bypass=false` |
| `NODE_ENV=test TF_HTTP_INTEGRATION_HARNESS=1 npx tsx scripts/test_mission_http_integration.mjs` | **`53/53`**, `exit=0` |
| `npm test` | `exit=0` |
| 23 étapes de `npm run build` hors `db:generate` | `0` échec |
| `typecheck`, `api:typecheck`, `audit:e2e`, `test:chantiers` | `exit=0` |
| `test:routes`, `test:router-load`, `verify:prisma-client`, `test:assets`, `test:i18n`, `test:private-storage` | `exit=0` |
| `TF_OFFLINE_PRISMA_PRELOAD=1 NODE_OPTIONS=--import … npm run test:route-auth-coverage` | `exit=0` — 159 refus, 0 échec |
| `test:copy`, `test:mission-ui:states`, `test:mission-ui`, `test:journeys` | `exit=0` (Chromium épinglé `@sparticuz/chromium` + libs AL2023) |
| `test:neon:mission-functional` + 6 suites DB | `exit=0` — « TOUTES LES PREUVES REUSSIES » |
| `test:workflow-policy`, `test:workflow-policy-temoins`, `test:db-routing`, `test:ci-no-production-access`, `test:db-guard`, `test:db-guard-driver`, `test:minified-comments` | `exit=0` |
| `git diff --check` | `exit=0` |
| Harnais sans drapeau / avec `sk_live_` factice | `exit=3` / `exit=3` (fail-closed) |

---

## 9. Fichiers modifiés (42 depuis `bf55f2a`)

**API (6)** : `api/_lib/auth.ts`, `api/index.ts`, `api/_routes/documents.ts` (nouveau), `api/_routes/documents/upload-intent.ts`, `api/_routes/documents/[documentId]/validation.ts` (nouveau), `api/_routes/products/[productId]/dpp/preview.ts` (nouveau).

**CI / configuration (2)** : `.github/workflows/ci.yml` (1 étape DB), `package.json` (3 scripts, aucune dépendance).

**Front (17)** : `assets/js/brand-console.1.js`, 7 catalogues `assets/i18n/*`, 9 pages HTML (empreintes d'assets).

**Scripts et harnais (11)** : `scripts/db-generate-offline.mjs`, `scripts/lib/local_test_services.mjs`, `scripts/lib/offline-prisma-preload.mjs`, `scripts/test_mission_functional_dpp.mjs`, `scripts/test_mission_http_integration.mjs`, `scripts/test_mission_ui_real_states.mjs`, `scripts/run-db-suite.mjs`, `scripts/test_destructive_suite_routing.mjs`, `scripts/test_router_module_load.mjs`, `scripts/verify_prisma_client.mjs`, `package.json` (déjà compté).

**Documentation / preuves (6)** : `docs/experience/mission-fonctionnelle-2026-10-26/{00-ETAT-TACHES,01-RAPPORT-FINAL,02-CORRECTIONS,03-PREUVES-TECHNIQUES}.md`, 2 captures PNG, `docs/experience/mission-finalisation-2026-10-26/{00-CLOTURE,01-ETAT-FINAL}.md`.

Aucun fichier de `prisma/migrations/`, aucun secret, aucun rôle DB, aucune variable de production, aucune protection de branche ou d'environnement modifié.

---

## 10. Tableau de clôture

| Domaine | Verdict | Commentaire |
|---|---|---|
| État Git, 41 fichiers, arbre propre | **PASS** | Écart d'historique reconstruit et consigné (§0) |
| Branche distante publiée + PR #101 | **PASS** | Push normal, aucune fusion |
| SHA distant exact identifié | **PASS** | `3d2f61fc0abe3db2ad4f6c3f0f76634c1a260a7b` |
| CI complète verte sur ce SHA | **PASS** | Run `40409887448`, 4/4 jobs |
| Génération Prisma standard (native) | **PASS** (CI) / **BLOCKED** (local réseau) | Distinction explicite, aucune confusion avec le WASM |
| Build, tests unitaires/intégration, typage, routes, couverture auth | **PASS** | CI + local |
| Tests de persistance produits, documents, aperçu DPP | **PASS** | 53/53 locaux + étape DB en CI |
| Tests DB et isolation multi-organisation | **PASS** | CI + local |
| Correctif §7 (jetons valides/absents/malformés/expirés/forgés, erreurs serveur non masquées) | **PASS** | F6/F10/F11/F12/F13/F14/F15 |
| Conflits et dépendances des PR documentés | **PASS** | §6, aucune PR fermée ni fusionnée |
| Aucune modification non autorisée de production | **PASS** | — |
| Parcours HTTP authentifiés sur **Preview réelle** | **BLOCKED** | Protection Vercel active + secrets absents/illisibles |
| Stockage privé et antivirus **managés** | **BLOCKED** | Variables Vercel absentes/illisibles ; seuls les services de test locaux sont validés |
| Isolation Alpha/Beta par HTTP sur Preview | **BLOCKED** | Validée uniquement sur l'environnement de test local |
| Lecture de la présence des secrets GitHub / Vercel | **BLOCKED** | `403 Resource not accessible by integration` ; Vercel `Access denied` / `404` |
| Fusion des PR #98/#70/#82/#92/#93/#94 | **NOT RUN** | Interdite par la mission ; plans fournis |
| Fermeture de la PR #98 | **NOT RUN** | Arbitrage humain requis, justification fournie |
| Préparation à la commercialisation | **NOT RUN / NON DECLAREE** | Dépend des validations Preview et sécurité réelles |

---

## 11. Changements restants et responsables

| # | Action | Responsable |
|---|---|---|
| 1 | Configurer les secrets de l'environnement GitHub `tracefab-clerk-test` (`sk_test_…`, bypass Vercel, secret worker) et approuver l'environnement (relecteur requis) | **Administrateur GitHub** |
| 2 | Configurer les 12 variables Vercel **Preview** (base de test, Clerk de test, `PRIVATE_STORAGE_*`, antivirus `tracefab-v1`) ; créer le bucket privé et le scanner de test | **Administrateur Vercel / ops** |
| 3 | Étendre la portée du token du connecteur Vercel au projet `tracefab` | **Administrateur Vercel** |
| 4 | Fusionner #80 et #91 (0 conflit) ou dispatcher leurs workflows avec l'URL de la Preview de #101 ; adapter le `if` de #80 et les URLs codées en dur de #91 | **Mainteneur du dépôt** |
| 5 | Rejouer `verify:routes:isolation`, `test:p1:staging`, puis adapter le harnais HTTP pour cibler la Preview distante (Clerk + S3 + antivirus réels) et rejouer les 53 contrôles | **Équipe technique** |
| 6 | Décider du sort de #98 : rebase ne conservant que la confirmation de restauration + clés i18n, ou clôture justifiée | **Responsable produit / mainteneur** |
| 7 | Résoudre les conflits de #70/#82 (sécurité DB) et #92/#93/#94 (`package.json`) sans écraser de code concurrent | **Mainteneurs des PR** |
| 8 | Revue et fusion de la PR #101 (non effectuée ici) | **Relecteur humain** |

---

## 12. Décision factuelle

- **Prêt pour la revue de PR : OUI.** La branche `arena/647ac97c-tracefab` est publiée, la PR #101 est ouverte et la CI est **verte sur le SHA exact `3d2f61f`** (4/4 jobs, génération Prisma native incluse).
- **Prêt pour les tests de Preview : NON.** La Preview existe et ses protections Vercel sont actives, mais les secrets de test (`sk_test_…`, bypass Vercel, stockage privé, antivirus) sont absents ou non vérifiables depuis cette session (`403` GitHub, `Access denied` Vercel, environnement protégé avec relecteur).
- **Statut global : BLOQUÉ — intervention humaine requise.** Les sous-tâches terminées sont clôturées ci-dessus ; les validations réelles de Preview, du stockage managé, de l'antivirus managé et de l'isolation HTTP sur Preview restent à exécuter.

**TraceFab n'est pas déclaré prêt pour la commercialisation.**

---

# 13. Mission de déblocage Preview — 2026-10-27

Cette section **complète** le rapport sans en effacer les preuves. Elle repart de la PR #101 ouverte et de la CI verte (`40411584880`, SHA `27981ac108f80f25036c309212bab93945f5e8e6`).

## 13.1 État distant reverifie

| Controle | Mesure | Verdict |
|---|---|---|
| `git fetch origin --prune` ; `origin/main` | `bf55f2ae6534cde84d072d9b975520216c7b6d4e` (inchangé) | **PASS** |
| Branche `arena/647ac97c-tracefab` distante | `27981ac108f80f25036c309212bab93945f5e8e6` | **PASS** |
| PR #101 | `OPEN`, `MERGEABLE`, 43 fichiers, base `main` | **PASS** |
| CI sur le SHA concerne | run `40411584880` = `success`, 4/4 jobs ; `40409887448` = `success` sur `3d2f61f` | **PASS** |
| Arbre de travail local | Workspace restaure depuis `bf55f2a` avec les fichiers non commités. `git write-tree` = `65adbeb631e4c002bd9e59637c413a0a3e2ccd78` = arbre de `27981ac` : **identiques**. Réalignement par `git update-ref` sans toucher aux fichiers, sans force push, sans perte. Les deux tags locaux, perdus avec le workspace, ont été recréés sur `bf0eb48` et `fcc2117`. | **PASS** |

## 13.2 Blocages de permissions — re-mesures, toujours presents

| Blocage | Commande / outil | Resultat exact | Verdict |
|---|---|---|---|
| Secrets GitHub | `gh api repos/Huberaya/Tracefab/actions/secrets`, `.../actions/variables`, `.../environments/{tracefab-clerk-test,Preview}/secrets` | `403 Resource not accessible by integration` (4/4) | **BLOCKED** |
| Environnement protege | `gh api .../environments/tracefab-clerk-test` | `deployment_branch_policy.custom_branch_policies=true`, regles `branch_policy` + `required_reviewers` | **PASS** (protection conservée) |
| Vercel — identite | `get_authenticated_user` | `limited: true`, `defaultTeamId` present | **PASS** (identification) |
| Vercel — projet/equipe/env | `list_projects`, `get_team`, `list_env_vars` (avec et sans `team_id`) | `Access denied. Your token may not have the required permissions... team scope` | **BLOCKED** |
| Preview — protection | `fetch_page https://tracefab-git-arena-b9a1c6-….vercel.app/api/health` | `Protected Deployment – Vercel`, redirection `vercel.com/login?.../sso-api?...` — **mesure directe, aucun contournement** | **PASS** (protection active) |
| Sortie reseau du sandbox | `TF_PREVIEW_HARNESS=1 … node scripts/test_preview_http_journeys.mjs` (sans secret, sans bypass) | `BLOCKED — pre-vol : la Preview est injoignable (fetch failed)`, `exit=2` | **BLOCKED** |

**Nouvelle conclusion technique** : meme avec tous les secrets, **ce sandbox ne peut pas joindre `*.vercel.app`**. Le seul chemin d'execution viable est donc un **runner GitHub Actions** (reseau ouvert) avec l'environnement `tracefab-clerk-test` approuve. C'est precisement ce que le correctif ci-dessous met en place. Aucune valeur de secret n'a ete demandee, lue, ecrite ou journalisee.

## 13.3 Correctif independant livre (au lieu d'un nouvel audit)

| Fichier | Role | Verdict |
|---|---|---|
| `scripts/test_preview_http_journeys.mjs` | Harnais des 9 parcours contre une **vraie Preview**. Aucun service local, aucun mock, aucun import d'un module interne de l'API. Vrais jetons de session d'une instance Clerk `sk_test_` via la BAPI, vraies requetes HTTPS, vrai PUT presigne vers le stockage prive, vrai antivirus, vrai rejet EICAR. Pre-vol fail-closed, refus `sk_live_`, refus d'une cible non-Preview, refus HTTP non TLS, journalisation expurgee (jetons, cles, URLs de base, UUID). | **PASS** (gardes) / **BLOCKED** (execution) |
| `scripts/test_preview_journeys_guards.mjs` | Regression CI des gardes, **sans aucun secret ni reseau** : 7 cas (refus sans drapeau, refus production, refus `sk_live_`, expurgation 5/5, variables manquantes, hote non autorise, HTTP non TLS). | **PASS** (7/7) |
| `.github/workflows/preview-http-journeys.yml` | Workflow **manuel** `workflow_dispatch` avec `preview_url` en entree (aucune URL codee en dur), `environment: tracefab-clerk-test` (approbation conservee), `permissions: contents: read`, actions epinglees par SHA, presence des secrets affichee **sans valeur**, gardes puis harnais. Ne depend d'aucune fusion de #80/#91. | **PASS** (politique) |
| `docs/security/workflow-privileged-allowlist.json` | Declaration explicite du nouveau workflow dans `secretUsingWorkflows` et `environmentBoundJobs` (regles A et F). Aucune regle de politique n'a ete assouplie. | **PASS** |
| `package.json` | Ajout de `test:preview-harness` (script de gardes, executabe en CI sans secret). | **PASS** |

### Pourquoi ce workflow plutot que #80 / #91

- **#80** (`clerk-tenant-journeys.yml`) : `if: ${{ github.ref == 'refs/heads/main' }}` et `environment: tracefab-clerk-test`. Il ne peut pas s'executer sur la branche de la PR #101 ; le modifier imposerait de pousser sur sa branche (interdit). Il teste en outre une base PostgreSQL locale au runner, **pas une Preview**.
- **#91** (`p1-staging-*`) : `on.push.branches: ['arena/88857a44-tracefab']`, URLs de Preview d'autres branches codees en dur dans les valeurs par defaut, trois secrets requis, pre-vol `TF_PROBE_STRICT=1` qui echoue face a `Protected Deployment – Vercel`. L'executer imposerait une fusion (interdite) ou un push sur sa branche (interdit).
- Le nouveau workflow corrige ces deux references obsoletes **dans la seule branche autorisee** : aucune branche en dur, URL fournie par l'operateur, approbation d'environnement conservee, protection Vercel verifiee par le cas P9 au lieu d'etre desactivee.

### Matrice des parcours du nouveau harnais

| Cas | Parcours | Attendu | Preview | Local (53/53 precedent) |
|---|---|---|---|---|
| J1.1–J1.4 | Produit cree, modifie, relu, liste | 201/200/200/200 | **BLOCKED** | PASS |
| J2.1–J2.7 | Intention, PUT presigne, lien public refuse, scan, download, integrite SHA-256 | 201/200/≥400/200/200/200/identique | **BLOCKED** | PASS |
| J3.1–J3.4 | Acceptee, rejet sans motif refuse, rejet motive, historique via `/dpp/claims` | 200/400/200/≥2 | **BLOCKED** | PASS |
| J4.1–J4.3 | Apercu prive, `no-store private` + `noindex`, description persistee | 200 + en-tetes | **BLOCKED** | PASS |
| J5 | 5 requetes anonymes | 401 | **BLOCKED** | PASS |
| J6.1–J6.4 | Forge, malforme, **expire via BAPI** (`expires_in_seconds`), valide toujours accepte | 401/401/401/200 | **BLOCKED** | PASS |
| J7.0–J7.4 | Alpha/Beta : produit, document, decision, scan, apercu, usurpation de tenant, lien inter-tenant | 404/200 vide/404 | **BLOCKED** | PASS |
| J8.1–J8.2 | EICAR rejete par l'antivirus manage, non telechargeable | `rejected` / 404 | **BLOCKED** | PASS |
| P0 / P9 | Pre-vol applicatif ; protection Vercel active sans bypass | 200 / non-200 | **P9 PASS** (mesure `Protected Deployment`) ; **P0 BLOCKED** | n/a |

## 13.4 Actions minimales pour l'administrateur

| Variable | Emplacement | Responsable |
|---|---|---|
| `CLERK_SECRET_KEY` (`sk_test_…` d'une instance dediee, **jamais** `sk_live_`) | GitHub `Settings → Environments → tracefab-clerk-test → Environment secrets` | Administrateur GitHub |
| `TF_PREVIEW_USER_ALPHA`, `TF_PREVIEW_USER_BETA` (e-mails ou IDs de deux utilisateurs de test) | idem | Administrateur GitHub |
| `VERCEL_AUTOMATION_BYPASS_SECRET` (secret de bypass **autorise**, protection conservee) | idem | Administrateur GitHub |
| `TF_PREVIEW_ORG_ALPHA`, `TF_PREVIEW_ORG_BETA` (optionnels ; sinon `TF_PREVIEW_ALLOW_PROVISION=1` cree deux organisations via `POST /api/organizations`) | idem | Administrateur GitHub |
| `DATABASE_URL` (base de **test** isolee), cles Clerk de test, `TRACEFAB_AUTHORIZED_PARTIES` (origines de la Preview), 7 `PRIVATE_STORAGE_*` (bucket prive `tracefab-private`, HTTPS), `PRIVATE_STORAGE_ANTIVIRUS_URL`/`_TOKEN` (protocole `tracefab-v1`) | Vercel `Project tracefab → Settings → Environment Variables`, cible **Preview** uniquement | Administrateur Vercel |
| Portee projet du token du connecteur Vercel | Vercel `Team → Settings → Tokens` | Administrateur Vercel |
| Autoriser la branche `arena/647ac97c-tracefab` dans la politique de branches de l'environnement, et **approuver** le run | GitHub `Settings → Environments → tracefab-clerk-test` | Relecteur humain |

Commande exacte a rejouer apres configuration (depuis le runner GitHub, **pas depuis ce sandbox** car il ne peut pas joindre `*.vercel.app`) :

```bash
gh workflow run preview-http-journeys.yml \
  --ref arena/647ac97c-tracefab \
  -f preview_url='https://tracefab-git-arena-<...>.vercel.app' \
  -f allow_provision='1'
# puis approuver l'environnement dans l'onglet Actions, et lire :
gh run list --workflow preview-http-journeys.yml --limit 3
```

En local, sur un poste disposant de la sortie reseau et des secrets fournis par un mecanisme securise :

```bash
TF_PREVIEW_HARNESS=1 \
TRACEFAB_STAGING_URL='https://<preview>.vercel.app' \
CLERK_SECRET_KEY='<sk_test_…>' \
TF_PREVIEW_USER_ALPHA='<utilisateur de test A>' \
TF_PREVIEW_USER_BETA='<utilisateur de test B>' \
TF_VERCEL_BYPASS='<secret de bypass autorise>' \
TF_PREVIEW_ALLOW_PROVISION=1 \
TF_PREVIEW_EVIDENCE=/tmp/tf-preview-evidence.json \
node scripts/test_preview_http_journeys.mjs
```

## 13.5 CI et statut global

Le commit de cette section est pousse sur `arena/647ac97c-tracefab` par un push normal (aucune force). Le run CI correspondant et son SHA exact sont consignes dans le commentaire de cloture de la PR #101 ; la CI precedente reste verte sur `27981ac` (run `40411584880`). Les controles locaux de cette mission : `npm test`, `typecheck`, `api:typecheck`, `test:preview-harness`, `test:workflow-policy`, `test:workflow-policy-temoins`, `test:db-routing`, `test:routes`, `test:assets`, `test:i18n`, `test:minified-comments`, `test:ci-no-production-access`, `verify:prisma-client` : **tous `exit=0`**. `test:router-load` et `test:route-auth-coverage` affichent leurs assertions OK puis echouent en local sur `The adapter option for PrismaClient is required` (client WASM sans PostgreSQL local) — artefact d'environnement deja documente ; ces deux suites passent en CI avec les moteurs natifs.

**Statut global : BLOQUÉ — intervention humaine requise.** Sous-taches reellement terminees : permissions re-mesurees, protection Vercel confirmee active, harnais Preview reel livre et garde par 7 regressions, workflow independant pret avec approbation conservee, registre de securite mis a jour, politique de workflows verte, aucun secret expose, aucune protection desactivee, aucune modification de production. Restent **BLOCKED** : execution des 9 parcours sur la Preview, usage effectif de Clerk de test, stockage prive et antivirus manages, isolation Alpha/Beta par HTTP sur Preview, rejet EICAR par l'antivirus manage.

**TraceFab n'est pas declare pret pour la commercialisation.**
