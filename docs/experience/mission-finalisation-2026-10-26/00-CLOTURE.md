# Mission de finalisation — tableau de clôture

> **NOTE DE RECONSTRUCTION (session suivante).** Ce rapport est une preuve
> historique figée. Le workspace Arena a été restauré depuis `bf55f2a` avec
> l'intégralité du travail sous forme de modifications non commitées : les
> objets Git `462d022`, `17ed269`, `fd7c849` et les deux tags avaient disparu.
> L'historique a été reconstruit à partir des **41 fichiers intacts** (arbre du
> premier commit identique : 36 fichiers, `+1970/-35`). Les SHA cités ci-dessous
> correspondent donc à l'historique AVANT reconstruction ; les SHA effectivement
> publiés et leurs preuves CI figurent dans `01-ETAT-FINAL.md`. Aucune ligne
> de ce rapport n'a été effacée.

**Date** : 2026-10-26 (Europe/Paris)
**Branche** : `arena/647ac97c-tracefab` — arbre de travail propre
**Base distante** : `origin/main` = `bf55f2ae6534cde84d072d9b975520216c7b6d4e` (inchangée, `git fetch origin` du jour)
**Livraison locale** : `462d022b10ac10dc1632903e5f1c26de3c605d38` (mission fonctionnelle, tag `mission-fonctionnelle-2026-10-26`) → `17ed269c883cc64423a37bc67909c0e1b323a8bc` (parcours HTTP + correctif 401) → `HEAD` = ce rapport (tag `mission-finalisation-2026-10-26`)
**Portée** : terminer les preuves, préparer la livraison. **Aucun push, aucune PR, aucun run CI, aucun déploiement, aucune migration, aucun changement de rôle/RLS/secret en production n'ont été effectués.**

> Avertissement de lecture : les services externes utilisés pour les nouveaux parcours HTTP sont des **services de test locaux** (Clerk compatible JWKS/BAPI, bucket S3, antivirus) démarrés sur `127.0.0.1` avec des clés éphémères. Le code applicatif, la vérification de jeton, Prisma, PostgreSQL/RLS et la signature SigV4 sont **ceux du dépôt**. Cela valide le parcours et le protocole — **pas** la configuration Clerk, le bucket managé ni l'antivirus de préproduction.

---

## 1. État initial mesuré (avant action)

| Élément | État constaté |
|---|---|
| Commit `462d022` | Présent, 36 fichiers tous présents, 4 rapports + 2 captures, tag local. Non poussé, sans PR ni CI. |
| Branche | Propre, `HEAD = 462d022`, parent `bf55f2a`. `main`/`origin/main` = `bf55f2a`. |
| CI connue | Run [`40373818672`](https://github.com/Huberaya/Tracefab/actions/runs/40373818672) sur `bf55f2a` : 4/4 jobs **SUCCESS**. PR [`#100`](https://github.com/Huberaya/Tracefab/pull/100) **MERGED**. Aucune CI sur `462d022` ni sur `17ed269`. |
| Parcours HTTP Clerk | **BLOQUÉ** : `verify:routes:isolation` sort `NON EXECUTE — CLERK_SECRET_KEY absente` (code 2). Aucune clé `sk_test_...` disponible localement. |
| Stockage objet réel | **BLOQUÉ** : aucune variable `PRIVATE_STORAGE_*` dans l'environnement local ; seules des fixtures navigateur existaient. |
| Génération Prisma standard | **BLOQUÉ localement** : `npm run db:generate` → `binaries.prisma.sh ... TLS socket disconnected`. Méthode WASM hors ligne déjà **PASS**. |
| Conflits PR | Non mesurables : clone superficiel (`refusing to merge unrelated histories`). |

---

## 2. Tableau de clôture

Légende : **PASS** = exécuté et prouvé · **FAIL** = exécuté et en échec · **BLOQUÉ** = prérequis externe manquant · **NON EXÉCUTÉ** = volontairement non lancé (autorisation ou environnement absent).

| # | Domaine | Statut initial | Action réalisée | Fichiers / SHA | Commandes & tests | Preuve (expurgée) | Verdict | Intervention humaine restante |
|---|---|---|---|---|---|---|---|---|
| 1 | Conservation du travail | Commit local non publié | Vérification de l'objet Git, du parent, de l'arbre propre et des 36 fichiers ; aucun reset/rebase/clean/force-push | `462d022`, tag `mission-fonctionnelle-2026-10-26` | `git cat-file -t`, `git show -s`, `git diff-tree --no-commit-id --name-status -r 462d022`, `git status` | 36 fichiers présents ; `HEAD` = `462d022` avant ajout | **PASS** | Aucune |
| 2 | Base distante | `origin/main` potentiellement déplacée | `git fetch origin --prune` + `git ls-remote` | `origin/main` = `bf55f2a` | `git diff --stat bf55f2a..HEAD` | `41 files changed, 2967 insertions(+), 39 deletions(-)` après finalisation | **PASS** | Aucune |
| 3 | Conflits réels avec les PR ouvertes | Non calculables (clone shallow) | `git fetch --unshallow` (lecture seule) puis `git merge-tree --write-tree HEAD origin/pr/N` pour 8 PR | `/tmp/tf-mt-*.txt` (hors dépôt) | cf. §3 | Vrais conflits identifiés, pas de suppression du travail d'autrui | **PASS** | Décision humaine sur la PR #98 et sur les conflits `package.json` (§3) |
| 4 | Parcours HTTP authentifiés | **BLOQUÉ** (pas de clé `sk_test_`) | Création d'une instance Clerk **de test locale** (JWKS + `/v1/users`, jetons RS256 réels vérifiés par le vrai `verifyToken`) et d'un adaptateur TCP du vrai routeur `api/index.ts` | `scripts/lib/local_test_services.mjs`, `scripts/test_mission_http_integration.mjs`, `17ed269` | `NODE_ENV=test TF_HTTP_INTEGRATION_HARNESS=1 npx tsx scripts/test_mission_http_integration.mjs` | `44/44 contrôles réels réussis` : création/modification/relecture produit, documents, décisions, aperçu privé, refus inter-locataires, 401, EICAR | **PASS** (scope local) | Rejouer sur Preview avec la vraie instance Clerk de **test** (`sk_test_...`) ; jamais `sk_live_` |
| 5 | Défaut découvert par le parcours HTTP | Jeton forgé → **500** au lieu de 401 | `verifyToken` (wrappé par `withLegacyReturn`) **lève** ses erreurs ; `requireClerkUser` ne les attrapait pas. Ajout d'un `try/catch` strict : toute erreur de vérification devient `UnauthorizedError` → 401. Aucun jeton non vérifié n'est accepté | `api/_lib/auth.ts`, `17ed269` | même harnais, cas `F6` | Avant : `500 internal_server_error` ; après : `401`. `npm test` + `test:route-auth-coverage` 159/159 | **PASS** | Aucune (correctif de sécurité, non un assouplissement) |
| 6 | Cycle de vie documentaire réel | **BLOQUÉ** (pas de stockage) | Bucket S3 **de test local** vérifiant réellement SigV4 (signature, méthode, expiration) + endpoint antivirus `tracefab-v1` ; exécution du vrai code `storage.ts` / `documents.ts` | `scripts/lib/local_test_services.mjs`, `scripts/test_mission_http_integration.mjs` | cas B1–B10, F7–F9 | PUT presigné 200, 1 objet écrit, URL non signée 403, signature falsifiée 403, scan `clean`, octets relus à l'identique, EICAR → `rejected` et non téléchargeable ; `2 objets, 5 lectures signées, 2 refus de signature, 2 analyses` | **PASS** (scope local) | Configurer le bucket managé privé + l'antivirus de Preview et rejouer ; le stockage managé n'est **pas** validé |
| 7 | Isolation multi-locataires par HTTP | Partiellement prouvée en SQL seulement | 11 mesures HTTP avec deux identités/ organisations réelles sous `tracefab_app` (sans BYPASSRLS) | idem | cas E0–E10 | Beta : 404 sur produit, preuve, aperçu, scan, validation ; listes vides ; jeton Alpha + en-tête Beta → 404 ; association à un produit Beta → `product_not_found` | **PASS** (scope local) | Rejouer sur Preview avec deux organisations de test réelles |
| 8 | Aperçu DPP brouillon privé | Prouvé en SQL | Vérification des en-têtes et du contenu par HTTP | `api/_routes/products/[productId]/dpp/preview.ts` (`462d022`) | cas D1–D5 | `Cache-Control: no-store, private`, `X-Robots-Tag: noindex, nofollow`, `published=false`, aucun `publicSlug`, description persistée | **PASS** | Aucune |
| 9 | Politique de routage des suites DB | Une nouvelle suite écrivant en base n'était pas déclarée | Déclaration explicite dans le registre des suites destructives **non rattachées** : le harnais reste opt-in, jamais atteignable par `npm test`, `npm run build` ni la CI | `scripts/test_destructive_suite_routing.mjs`, `17ed269` | `npm run test:db-routing` | `Politique de routage : OK.` ; `test_mission_http_integration.mjs — toujours rattachee a aucune commande` | **PASS** | Aucune |
| 10 | Régression complète | À relancer après le correctif auth | Relance de l'intégralité des suites locales avec l'environnement adéquat (`LD_LIBRARY_PATH`, précharge WASM, serveur statique :3000) | tout le dépôt | `npm test`, 23 étapes de `npm run build` hors `db:generate`, `verify:prisma-client`, `test:router-load`, `test:routes`, `test:route-auth-coverage`, `test:assets`, `test:i18n`, `test:copy`, `test:private-storage`, `test:mission-functional`, `test:mission-ui:states`, `test:mission-ui`, `test:journeys`, 6 suites DB | `npm test exit=0` · `etapes=23 echecs=0` · `test:route-auth-coverage 159/159` · `test:mission-functional TOUTES LES PREUVES REUSSIES` · 6/6 suites DB `exit=0` · `git diff --check` propre | **PASS** | Aucune |
| 11 | Prisma — méthode hors ligne | Déjà **PASS** | Régénération et vérification stricte sur l'état livré | `scripts/db-generate-offline.mjs`, `scripts/verify_prisma_client.mjs` (`462d022`) | `npm run db:generate:offline`, `npm run verify:prisma-client` | `exit=0` ; 49 modèles, moteur WASM officiel 2 297 601 octets, magie `\0asm`, `@prisma/adapter-pg` présent | **PASS** | Aucune |
| 12 | Prisma — méthode standard CI | **BLOQUÉ** localement (réseau) | Tentative mesurée + vérification que la définition CI n'a pas changé ; recherche d'un miroir de binaires sur les hôtes autorisés (`registry.npmjs.org`, `pypi.org`) — aucun binaire natif disponible | `.github/workflows/ci.yml` inchangé ; `package.json` ne modifie que des scripts, aucune dépendance | `npm run db:generate` ; `npm pack @prisma/engines@6.19.3 --dry-run` ; CI du run `40373818672` | `exit=1` : `binaries.prisma.sh ... TLS socket disconnected` (**erreur d'environnement/réseau, pas du projet**). Le tarball `@prisma/engines` ne contient que 10 fichiers JS, aucun binaire. Sur `bf55f2a`, les 4 jobs CI ont exécuté `npm ci` + `npm run db:generate` avec succès | **BLOQUÉ** local · **PASS** sur la base en CI · **NON EXÉCUTÉ** sur `17ed269` (pas de push) | Autoriser le push pour obtenir un run CI réel sur le commit livré |
| 13 | Secrets — inventaire par présence | Inconnu | Lecture des **noms** d'environnements et des références de workflows. Aucune valeur lue, aucun secret déchiffré | `.env.example`, `.github/workflows/*`, PR #91 / #80 | `gh api repos/Huberaya/Tracefab/environments`, `gh api .../actions/secrets` (403), `gh secret list` (403), `vercel validate_credential` / `list_projects` | Environnements : `Preview`, `Production`, `tracefab-clerk-test`. Secrets GitHub : **illisible** (`403 Resource not accessible by integration`). Vercel : identifiants valides, `list_teams` vide, `list_projects`/`list_deployments` **Access denied**. Variables locales : toutes **ABSENTES** | **BLOQUÉ** | §4 : vérifier/configurer les secrets dans les deux consoles ; étendre le scope du token Vercel |
| 14 | Parcours P1 staging existants | **BLOQUÉ** | Tentatives mesurées, sans contournement | `scripts/test_routes_tenant_isolation.mjs`, `scripts/test_p1_staging.mjs` | `TF_ROUTES_TEST_HARNESS=1 npm run verify:routes:isolation` ; `npm run test:p1:staging` | `exit=2 NON EXECUTE — CLERK_SECRET_KEY absente` ; `exit=1 ... TRACEFAB_STAGING_URL ... required; no mock/demo fallback is allowed` | **BLOQUÉ** | Fournir `sk_test_...` + URL Preview + états de session ; ne jamais contourner la protection Vercel |
| 15 | Publication (push / PR / CI) | Non autorisée | **Aucune** opération distante d'écriture | branche locale uniquement | `git status`, `git log`, `git ls-remote origin` | `origin` ne contient **pas** `462d022`, ni `17ed269`, ni le rapport de clôture ; aucune PR, aucun run CI pour ces commits | **NON EXÉCUTÉ** | Autorisation explicite requise ; commandes en §5 |
| 16 | Gardes du nouveau harnais | À prouver | Trois refus fail-closed mesurés | `scripts/test_mission_http_integration.mjs` | sans drapeau ; avec `sk_live_...` factice ; sans `DATABASE_URL` | `exit=3` (drapeau absent), `exit=3` (clé live refusée), `exit=2` (prérequis) | **PASS** | Aucune |
| 17 | Données de production | Inchangées | Aucune connexion, migration, rôle, RLS, secret ou workflow de production modifié | — | `git diff --name-only bf55f2a..HEAD` | Aucun fichier de `.github/workflows/`, `prisma/migrations/`, ni de politique de sécurité modifié | **PASS** | Aucune |

**Bilan** : 13 **PASS**, 0 **FAIL**, 3 **BLOQUÉ**, 1 **NON EXÉCUTÉ** (la publication), auxquels s'ajoute le standard CI Prisma **BLOQUÉ localement / NON EXÉCUTÉ sur le commit livré**.

---

## 3. Conflits réels avec les PR ouvertes

Mesurés par `git merge-tree --write-tree HEAD origin/pr/N` après approfondissement de l'historique. mesure effectuee sur `17ed269` ; le commit de ce rapport n'ajoute que de la documentation et ne change donc aucun conflit.

| PR | Titre | État | Conflits avec notre branche | Nature / dépendance |
|---|---|---|---|---|
| **#98** | Add archived products workspace and restoration | open, `mergeable_state=dirty` | **3** : `api/_routes/products/[productId].ts`, `assets/i18n/fr.json`, `assets/js/brand-console.1.js` (`assets/i18n/en.js` fusionne seul) | **Redondance fonctionnelle** : `main` contient déjà la PR #99 fusionnée, qui implémente le même « archivé → réutiliser » avec `reuseSourceProduct` / clés `pa*` ; #98 (base `4eac0205`, antérieure à #99) utilise `modalProductTemplate` / `archivedProducts*`. Fusionner #98 tel quel **dupliquerait** la fonctionnalité et écraserait des gardes i18n. Décision humaine : clore #98 ou la faire rebaser par son auteur sur `main` en arbitrant les deux implémentations. |
| **#91** | ci(p1): exécution réelle authentifiée P1 staging | open, `behind` | **0** | Fusionne proprement. Dépendance clé pour rejouer les parcours sur Preview : ajoute les workflows `p1-staging-*` et `scripts/list_secret_names.mjs` (noms uniquement). |
| **#80** | security: automate Clerk tenant-isolation journeys safely | open, `behind` | **0** | Fusionne proprement. Ajoute `.github/workflows/clerk-tenant-journeys.yml` (environnement `tracefab-clerk-test`, `TF_ROUTES_TEST_HARNESS=1`, `CLERK_SECRET_KEY=sk_test_...`). |
| **#70** | Sécurité DB — privilèges minimaux et RLS runtime | open (draft), `dirty` | **5** : `docs/experience/CHANTIERS-RESTANTS.md`, migration `20261021120000_limit_app_function_execute`, `scripts/lib/tracefab_app_role.mjs`, `scripts/lib/tracefab_runtime_functions.mjs`, `scripts/test_privileges_role_app.mjs` | Conflits **add/add** sur du code de sécurité. À ne pas fusionner automatiquement : arbitrage humain obligatoire. |
| **#82** | security: réduire les privilèges DML de `tracefab_app` | open, `dirty` | **1** : `docs/experience/CHANTIERS-RESTANTS.md` | Conflit documentaire simple, mais décision de sécurité à confirmer. |
| **#92 / #93 / #94** | correctifs CI P1 | open | **1 chacune** : `package.json` | Conflits d'ajout de scripts npm (même zone que `test:mission-functional` / `test:mission-ui:states`). Résolution additive, sans perte. |

Notre branche ne touche à aucun des fichiers de workflow de ces PR, et ne supprime aucun de leurs fichiers.

---

## 4. Secrets : présence, et où les configurer exactement

**Mesure du jour (présence uniquement, jamais de valeur)** : environnements GitHub `Preview`, `Production`, `tracefab-clerk-test` présents ; lecture des secrets GitHub refusée (`403 Resource not accessible by integration`) ; connecteur Vercel : identifiants valides mais `list_projects` / `list_deployments` **Access denied**, `list_teams` vide. Localement, `CLERK_SECRET_KEY`, `TRACEFAB_STAGING_URL` et les 7 variables `PRIVATE_STORAGE_*` sont **absentes**. Aucune valeur n'a été lue, écrite, journalisée ni commitée. Aucune clé `sk_live_` n'a été utilisée.

### 4.1 GitHub — environnement protégé `tracefab-clerk-test`

Chemin : **Settings → Environments → `tracefab-clerk-test` → Environment secrets** (ou repo-level **Settings → Secrets and variables → Actions → Secrets**).

| Nom attendu | Rôle | Exigence |
|---|---|---|
| `CLERK_SECRET_KEY` (ou `CLERK_TEST_SECRET_KEY` / `CLERK_INSTANCE_SECRET_KEY`) | Création des sessions de test par `scripts/test_routes_tenant_isolation.mjs` et `prepare_p1_staging_sessions.mjs` | **obligatoirement `sk_test_...`** d'une instance Clerk de test sans donnée réelle. Toute clé `sk_live_` est refusée par les harnais. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` (ou `VERCEL_PROTECTION_BYPASS_SECRET` / `VERCEL_BYPASS_SECRET`) | Pré-vol P1 : distinguer une Preview protégée d'une application qui répond | Secret d'environnement `tracefab-clerk-test`, jamais contourné |
| `TRACEFAB_NOTIFICATION_WORKER_SECRET` (ou `TRACEFAB_STAGING_WORKER_SECRET` / `TRACEFAB_WORKER_SECRET`) | Sonde d'identité DB `/api/internal/p2/readiness?identity=1` | Uniquement pour la dernière étape du workflow P1 |
| `VERCEL_READONLY_TOKEN` | Workflow `vercel-log-search.yml` | Lecture seule, déjà référencé dans les workflows existants |

### 4.2 Vercel — projet Tracefab, cible **Preview** uniquement

Chemin : **Vercel → Projet → Settings → Environment Variables**, cocher **Preview** (pas Production). Le connecteur Vercel de cette session n'a pas le scope projet : un administrateur doit soit vérifier ces noms dans la console, soit étendre les droits du token.

| Groupe | Noms | Exigence |
|---|---|---|
| Clerk | `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET`, `TRACEFAB_AUTHORIZED_PARTIES` | Clés de l'instance **de test** ; `TRACEFAB_AUTHORIZED_PARTIES` = origines HTTPS de la Preview (obligatoire quand `NODE_ENV=production`) |
| Base | `DATABASE_URL`, `TF_RLS_APP_URL` (si utilisé) | Base de **test** distincte de Neon Production, rôle `tracefab_app` sans BYPASSRLS |
| Stockage privé | `PRIVATE_STORAGE_ENDPOINT`, `PRIVATE_STORAGE_BUCKET` (`tracefab-private` **obligatoire**), `PRIVATE_STORAGE_REGION`, `PRIVATE_STORAGE_ACCESS_KEY_ID`, `PRIVATE_STORAGE_SECRET_ACCESS_KEY`, `PRIVATE_STORAGE_PRESIGN_SECONDS` (60–3600) | Bucket S3/R2 **privé**, endpoint **HTTPS** en production, signature SigV4, aucune ACL publique |
| Antivirus | `PRIVATE_STORAGE_ANTIVIRUS_URL`, `PRIVATE_STORAGE_ANTIVIRUS_TOKEN` | `POST` des octets bruts + `X-Tracefab-Scan-Protocol: tracefab-v1` + bearer ; réponse JSON `{"clean":true\|false,"mimeType":"..."}` ; le scanner doit exiger son jeton et ne jamais être exposé sans auth |
| Sonde | `TRACEFAB_NOTIFICATION_WORKER_SECRET` | Cohérent avec le secret GitHub ci-dessus |

Ordre recommandé : (1) configurer ces variables sur **Preview**, (2) déployer une Preview de la branche livrée, (3) fusionner #80/#91 (0 conflit avec notre branche) pour disposer des workflows, (4) lancer `workflow_dispatch` avec l'URL de Preview, (5) exécuter `test:p1:staging` et `verify:routes:isolation`.

---

## 5. Commandes de publication — **NON EXÉCUTÉES** (autorisation absente)

```bash
# 1. Vérification finale (locale, sans effet distant)
cd /home/user/Tracefab
git status                       # doit être propre
git log --oneline -4             # HEAD <- 17ed269 <- 462d022 <- bf55f2a
git diff --stat bf55f2a..HEAD    # 41 fichiers

# 2. Push en avance rapide NON FORCÉ (à n'exécuter qu'après autorisation explicite)
git push -u origin arena/647ac97c-tracefab

# 3. PR sans fusion, sans déploiement de production
gh pr create \
  --base main \
  --head arena/647ac97c-tracefab \
  --title "feat(dpp): persistance produit/document, aperçu brouillon privé et preuves HTTP authentifiées" \
  --body "Reprend 462d022 (mission fonctionnelle) et 17ed269 (parcours HTTP authentifiés, correctif 401). Voir docs/experience/mission-finalisation-2026-10-26/00-CLOTURE.md. Aucune modification de production, de migration, de rôle/RLS ou de secret. Conflits connus : PR #98 (redondance avec #99), #70/#82, #92/#93/#94 (package.json)."

# 4. CI réelle sur le commit livré (remplace le « NON EXÉCUTÉ » du tableau)
gh run list --branch arena/647ac97c-tracefab --limit 3
gh run watch <run_id> --exit-status
```

Le diff exact à relire avant publication :

```bash
git diff --name-status bf55f2ae6534cde84d072d9b975520216c7b6d4e..HEAD
git diff bf55f2ae6534cde84d072d9b975520216c7b6d4e..HEAD -- api/ package.json
```

41 fichiers : 5 routes API (dont 3 nouvelles), 1 correctif `api/_lib/auth.ts`, 1 registre de routes, 1 bundle console, 7 catalogues i18n, 9 pages HTML (empreintes d'assets), `package.json` (3 scripts, aucune dépendance), 8 scripts de génération/test/précharge, 2 nouveaux harnais, 4 rapports + 2 captures de la mission fonctionnelle, 1 rapport de clôture, 1 modification de la politique de routage des suites DB.

---

## 6. Ce qui n'est **pas** prouvé — et ce qui reste à faire

1. **Aucune validation sur Preview/staging avec les vrais services managés.** Les parcours HTTP de cette mission utilisent des services de test locaux. Ils prouvent le code, pas la configuration Clerk, ni le bucket S3/R2, ni l'antivirus de préproduction.
2. **Aucun run CI sur `462d022` / `17ed269` / ce rapport** : la génération Prisma standard de CI reste **NON EXÉCUTÉE** sur le commit livré. Elle est prouvée sur la base `bf55f2a` (run `40373818672`, 4/4 jobs verts) et la définition CI n'a pas changé ; seul un push autorisé lèvera cette incertitude.
3. **Aucune lecture de secret** : la présence effective de `CLERK_SECRET_KEY=sk_test_...` dans `tracefab-clerk-test` et des variables `PRIVATE_STORAGE_*` dans Vercel n'a pas pu être vérifiée (403 / Access denied). Un administrateur doit le faire.
4. **Conflits ouverts** : #98 (redondance avec #99), #70/#82 (sécurité DB), #92/#93/#94 (`package.json`). Aucun travail d'un autre agent n'a été supprimé.
5. **Aucune déclaration de conformité réglementaire ni de mise sur le marché.** Les rapports de la mission fonctionnelle restent des profils techniques internes : ce ne sont ni une certification ni une attestation de conformité. La préparation commerciale ne peut être déclarée qu'après : (a) parcours HTTP authentifiés sur Preview avec `sk_test_...` réel, (b) cycle documentaire sur le stockage privé managé avec antivirus réel, (c) isolation multi-locataires mesurée par HTTP sur Preview, (d) CI verte sur le commit publié.
