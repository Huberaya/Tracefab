# P1 staging — exécution réelle authentifiée sur une Preview

Ce document est le mode opératoire du chantier P1 : **exécuter** la suite
`npm run test:p1:staging` contre une Preview Vercel vivante, avec des sessions
Clerk réelles, et mesurer l'identité du rôle PostgreSQL du runtime.

Il ne remplace pas `docs/architecture/28-p1-catalog-import-export.md` (le
contrat fonctionnel) ni `docs/operations/variables-environnement.md` (la sonde
d'identité). Il décrit **comment on exécute**, et **ce qui bloque aujourd'hui**.

---

## 1. Pourquoi l'exécution part d'un runner GitHub

Le bac à sable d'analyse n'a aucun accès réseau à `*.vercel.app` ni à
`api.clerk.com` : mesuré, `curl` renvoie `SSL_ERROR_SYSCALL` (code 35) sur
`tracefab.vercel.app`, `tracefab-<sha>-….vercel.app`, `api.vercel.com`,
`clerk.com`, `accounts.dev` et `frontend-api.clerk.dev`, alors que
`api.github.com` répond 200 et `registry.npmjs.org` répond 200.

Une suite staging lancée depuis ce bac à sable n'atteindrait jamais
l'application : elle ne mesurerait rien. Les runners GitHub ont un accès
Internet complet. L'exécution réelle part donc de `.github/workflows/`.

> Corollaire : les journaux de run sont servis par un hôte de stockage hors du
> périmètre réseau de l'analyse. **Les mesures doivent donc aussi sortir en
> annotations** (`::notice::`), seul canal lisible depuis `api.github.com`.
> C'est ce que fait `scripts/lib/annotations.mjs`.

---

## 2. Cible : le déploiement Preview **du SHA testé**

### 2.1 Ce qui a été corrigé le 2026-10-23

Le pré-vol testait une **URL figée** dans le workflow
(`https://tracefab-git-arena-e13749-….vercel.app`, un alias de branche). Il a
reçu, sur les trois routes :

```
/api/health_http=307
/api/health_classe=inconnue
/api/health_content_type=text/plain
/api/health_redirection_chemin=/api/health
```

Le chemin de destination étant **identique** au chemin demandé, la mesure a été
lue comme une « redirection vers elle-même ». Elle ne l'était pas : la sonde
n'affichait que le **chemin**, jamais l'**hôte**. Un alias de branche qui ne
désigne plus le déploiement du commit est re-canonicalisé par Vercel par un
**307 vers un autre hôte**. Le run mesurait donc une redirection, pas
l'application — et le `exit code 5` ne disait rien d'autre.

Deux défauts distincts, corrigés séparément :

| Défaut | Correction | Preuve |
|---|---|---|
| URL de Preview **figée** dans le workflow, périmée à chaque commit | résolution du déploiement par l'API GitHub des Deployments, à partir du SHA | `scripts/resolve_preview_deployment.mjs` |
| diagnostic qui ne lit que le **chemin** d'une redirection | mesure de la classe **et de l'hôte** de la destination, puis diagnostic nommé | `scripts/lib/preview_surface.mjs` |

### 2.2 Mécanisme de sélection (aucune URL figée, aucun jeton Vercel)

L'application GitHub de Vercel crée un **Deployment** par build, portant le
`sha` du commit et un statut dont `environment_url` est l'URL **immuable** du
déploiement. Le workflow lit cette source avec le jeton du run et la seule
permission `deployments: read`.

Le step `Resoudre le deploiement Preview du commit teste` :

1. cherche les déploiements du SHA testé (`?sha=`), puis **garde uniquement
   ceux dont le champ `sha` égale exactement le SHA testé** — le paramètre de
   requête filtre des refs, il ne garantit rien sur le build ;
2. attend que le dernier soit à l'état `success` (20 min au plus, 15 s
   d'intervalle) ; un état `pending`, `in_progress`, `failure` ou `error` est
   **nommé**, jamais ignoré ;
3. refuse toute URL qui n'est pas `https://<projet>-….vercel.app` du projet,
   qui porte des paramètres, ou qui vise un **hôte de production** ;
4. publie `preview_url`, `deployment_id`, `deployment_sha` en sorties de step,
   et une annotation qui rend la correspondance vérifiable sans journal.

L'URL ainsi résolue alimente **le pré-vol et les quatre étapes de test**. Un
step de preuve refuse le job si `deployment_sha != TF_TARGET_SHA` (code 14).

Vérification indépendante, depuis n'importe quelle machine où `gh` est
authentifié :

```bash
gh api "repos/Huberaya/Tracefab/deployments?sha=<SHA>" \
  --jq '.[] | {id, sha, environment, created_at}'
gh api "repos/Huberaya/Tracefab/deployments/<ID>/statuses" \
  --jq '.[] | {state, environment_url, created_at}'
```

### 2.3 Ce qui n'est jamais accepté

- une URL imposée (`workflow_dispatch.inputs.preview_url`) qui **n'est pas**
  l'URL du déploiement `success` de ce SHA → échec `cause=url_imposee_hors_du_deploiement_du_sha`, code 14 ;
- un déploiement d'un **autre commit**, même sur la même branche ;
- une URL de **production** (`tracefab.vercel.app`) ;
- un déploiement dont l'URL porte un paramètre (un jeton ne doit jamais entrer
  dans une URL, donc une URL qui en porte est refusée).

---

## 3. Ce que le job doit produire

`scripts/test_p1_staging.mjs` exige quatre variables, et refuse tout repli
mock/demo :

| Variable | Rôle |
|---|---|
| `TRACEFAB_STAGING_URL` | URL de base de la Preview (HTTPS) |
| `TRACEFAB_P1_BRAND_STORAGE_STATE` | état de session Playwright — marque A |
| `TRACEFAB_P1_SUPPLIER_STORAGE_STATE` | état de session Playwright — fournisseur |
| `TRACEFAB_P1_SECOND_BRAND_STORAGE_STATE` | état de session Playwright — marque B, **organisation distincte** |

Les cinq contrôles que la suite exerce, et qui doivent être verts :

1. **authentification Clerk réelle, non démo** — `state.demo === false`,
   `state.user` et `state.clerk.session` présents ;
2. **simulation d'import catalogue** — `POST /api/catalog/products/import` en
   `dryRun`, `valid === true`, et la réponse **ne doit pas** containdre la
   valeur CSV (`P1-STAGING-DRY-RUN`) ;
3. **validation BOM sans persistance** — `POST
   /api/supplier/materials/import-bom` avec `autoSaveMaterials: false`,
   `isValid === true` et **`savedMaterialsCount === 0`** ;
4. **disclaimer Quality Center** — la page contient « statuts déclaratifs »
   et « certification » ;
5. **organisations marque A/B réellement distinctes et export
   inter-organisation refusé** — quatre requêtes, avec deux personnes
   réellement différentes, chacune authentifiée dans **sa** organisation :

   | # | Requête (jeton de la marque B) | Locataire résolu | Attendu |
   |---|---|---|---|
   | 1 | en-tête `X-Tracefab-Organization-Id: <A>` | A (étranger) | **404 `organization_not_found`**, **zéro ligne** de données |
   | 2 | `?organizationId=<A>`, sans en-tête | A (étranger) | **404 `organization_not_found`**, **zéro ligne** de données |
   | 3 | en-tête `<B>` + `?organizationId=<A>` | B (propre) | **200**, corps **identique** à l'export propre |
   | 4 | en-tête `<B>` seul — contrôle positif | B (propre) | **200**, export des données autorisées |

   Le statut ne suffit pas : une réponse de refus doit être un **document JSON
   d'erreur** (pas un CSV), sans **aucune** référence — ni de l'organisation
   étrangère, ni du locataire appelant. La route est
   `api/_routes/catalog/products/export.ts`, qui appelle `requireActiveTenant`
   : le refus y est un **404 `organization_not_found`** par conception de
   sécurité (« un 403 révélerait que l'organisation existe »), et non un 403.
   Mesures publiées en annotations : `inter_tenant_export_refusal_status`,
   `inter_tenant_export_refusal_error`, `inter_tenant_export_data_rows`,
   `own_brand_a_rows`, `own_brand_b_rows`, `foreign_only_refs`,
   `own_export_with_foreign_parameter`.

Et, en complément, la sonde d'identité du runtime (§6).

---

## 4. Les trois sessions Clerk de test

`scripts/prepare_p1_staging_sessions.mjs` fabrique les trois sessions dans
l'**instance Clerk de test** (`sk_test_`), jamais en production.

| Persona | Adresse (domaine `.test`) | Organisation |
|---|---|---|
| marque A | `p1-brand-a@tracefab.test` | Tracefab P1 Marque A (`brand`) |
| fournisseur | `p1-supplier@tracefab.test` | Tracefab P1 Fournisseur (`supplier`) |
| marque B | `p1-brand-b@tracefab.test` | Tracefab P1 Marque B (`brand`) |

Deux phases :

- `TF_P1_PHASE=inspect` — **lecture seule** : décrit l'instance (strategies de
  connexion), liste les comptes et organisations de test déjà présents ;
- `TF_P1_PHASE=provision` — crée ce qui manque (comptes, organisations,
  adhésions), puis ouvre **trois sessions réelles par l'IHM Clerk de
  l'application** et écrit les trois états de session.

Les mots de passe sont générés par le script : ils ne sont jamais affichés,
jamais journalisés, jamais demandés en clair. Les états de session sont écrits
dans `TF_P1_STATE_DIR` (`/tmp/p1-storage-states` sur le runner) : **jamais
versionnés, jamais publiés en artefact**. Le non-regression
`npm run test:p1-harness` vérifie qu'aucun état de session n'est suivi
par git.

---

## 5. Quatre verrous externes, et la parade pour chacun

Les trois sont **extérieurs à l'agent** : ils relèvent de l'administration
du dépôt GitHub et du projet Vercel. Aucun n'est contournable
depuis la session : le jeton GitHub disponible est une intégration d'
application, et l'API Vercel disponible est en lecture seule sur le profil
utilisateur.

### Verrou 1 — la protection Vercel de déploiement (le plus bloquant)

**Mesure** (`scripts/probe_preview_surface.mjs`, runner GitHub) — sur un
déploiement **du SHA testé**, sans en-tête de contournement :

```
preview_hote=tracefab-7xgup5zjo-baya-ibraimmayoanouedu-8164s-projects.vercel.app
contournement_disponible=false
/api/health_http=302
/api/health_classe=redirection
/api/health_redirection_classe=sso_vercel
/api/health_redirection_hote=tracefab-7xgup5zjo-baya-ibraimmayoanouedu-8164s-projects.vercel.app
/api/health_redirection_chemin=/sso-api
/api/health_redirection_parametres=nonce,url
```

Identique sur `/api/config` et sur `/api/internal/p2/readiness`. Les trois
routes de l'application — dont la sonde interne — sont **inaccessibles** : le
runner atteint la protection, pas l'application.

Sur une URL qui **n'est pas** le déploiement du commit, la sonde produit une
mesure différente, et c'est tout l'intérêt de l'hôte dans la mesure :

```
/api/health_http=307
/api/health_classe=redirection
/api/health_redirection_classe=autre_deploiement
/api/health_redirection_hote=<un AUTRE deploiement>
/api/health_redirection_chemin=/api/health
/api/health_redirection_parametres=aucun
```

(`redirection_chemin` identique au chemin demandé : c'est précisément ce qui
masquait le changement d'hôte.)

**Parade** : le projet expose un secret « Protection Bypass for Automation ».
Il est transmis dans le **seul** en-tête `x-vercel-protection-bypass`, jamais
dans une URL, jamais dans une sortie.

> **Pourquoi pas `x-vercel-set-bypass-cookie` (cause racine du 2026-10-23).**
> Cet en-tête optionnel ne contourne rien : il demande à Vercel de **poser un
> cookie** par une *redirection 307 vers la même URL*. Un client serveur
> (`fetch`, `curl`, Node) n'a pas de bocal à cookies : il voit un 307 qui ne
> finit jamais. C'est exactement ce qu'a mesuré le run
> [40035513421](https://github.com/Huberaya/Tracefab/actions/runs/40035513421) —
> `/api/health_http=307`, `…_redirection_chemin=/api/health` — lu à tort comme
> « redirection vers elle-même », puis transformé en `exit code 5`. La sonde
> rejoue désormais **une** poignée de main sur le même hôte si un `Set-Cookie`
> est renvoyé, sans jamais publier le cookie, et nomme
> `handshake_bypass_sans_cookie` / `handshake_bypass_non_abouti` sinon.

Le harnais le supporte déjà :

- `TRACEFAB_VERCEL_BYPASS` pour les sondes (`fetch`) ;
- `TRACEFAB_VERCEL_BYPASS` pour Playwright (`extraHTTPHeaders` + injection du
  même en-tête dans les `fetch` same-origin de la page).

Sans cette variable, le comportement est **strictement inchangé** : le
non-regression `npm run test:p1-harness` le vérifie.

### Le pré-vol dit POURQUOI il échoue — un code par cause

`node scripts/probe_preview_surface.mjs` en mode `TF_PROBE_STRICT=1` bloque
les étapes dépendantes et termine avec un code **distinct par cause** ; la
même cause est publiée en annotation `::error title=P1 pre-vol — cause X::`.
« Process completed with exit code 5 » ne peut plus être le seul message.

| Code | `cause` | Signification | Action |
|---|---|---|---|
| 0 | — | l'application a répondu | aucune |
| 2 | `configuration_absente` | aucune cible fournie | résoudre le déploiement (étape précédente) |
| 3 | `hote_de_production_interdit`, `hote_hors_preview_vercel:…`, `parametres_dans_url` | cible refusée avant tout appel | corriger la cible, jamais l'accepter |
| 5 | `contournement_invalide` | 302/401/403 **alors que** le secret est présent | régénérer « Protection Bypass for Automation » dans le **projet Vercel de ce déploiement**, puis remplacer `VERCEL_AUTOMATION_BYPASS_SECRET` dans `tracefab-clerk-test` |
| 5 | `contournement_absent` | 302/401/403 et aucun secret | déposer `VERCEL_AUTOMATION_BYPASS_SECRET` dans `tracefab-clerk-test` |
| 5 | `handshake_bypass_sans_cookie` | 307 vers la **même** URL, sans `Set-Cookie` exploitable | n'envoyer que `x-vercel-protection-bypass` |
| 5 | `handshake_bypass_non_abouti` | 307 vers la **même** URL, rejeu avec cookie non concluant | retirer `x-vercel-set-bypass-cookie` des appels serveur |
| 6 | `hote_injoignable` | aucune réponse (DNS, TLS, déploiement supprimé) | vérifier que le déploiement existe encore |
| 7 | `cible_obsolete` | 307 vers un **autre** déploiement, même chemin | utiliser l'URL du déploiement du SHA testé |
| 8 | `application_joignable_base_indisponible`, `application_en_erreur` | l'application répond, sa base non | vérifier la variable de base de l'environnement Preview |
| 9 | `reponse_inattendue` | ni application, ni protection reconnue | comparer aux classes attendues |

Et, en amont, le résolveur de cible a ses propres codes : `2` configuration,
`3` API refusée, `11` aucun déploiement pour ce SHA, `12` déploiement jamais
prêt, `13` URL inutilisable (production, autre projet, paramètres), `14` URL
imposée hors du déploiement du SHA.

### Verrou 2 — la politique de branche de l'environnement `tracefab-clerk-test`

**Mesure** — annotation GitHub du job `p1-staging-authenticated.yml` :

```
Branch "arena/88857a44-tracefab" is not allowed to deploy to tracefab-clerk-test
due to environment protection rules.
The deployment was rejected or didn't satisfy other protection rules.
```

L'environnement `tracefab-clerk-test` n'autorise que des branches nommées
(`deployment-branch-policies` avec `custom_branch_policies`). Le job authentifié
doit donc être rattaché à un environnement **et** s'exécuter depuis une branche
autorisée. Les entrées autorisées sont vérifiables et modifiables par l'API :

```bash
gh api repos/Huberaya/Tracefab/environments/tracefab-clerk-test/deployment-branch-policies \
  --jq '.branch_policies[].name'
```

État attendu après correction (trois entrées, vérifiable avant de pousser) :

```
arena/88857a44-tracefab
arena/f9effa2e-tracefab
main
```

Une nouvelle branche de travail doit y être ajoutée **avant** le premier push,
sinon le run est retenu : `Branch "…" is not allowed to deploy to
tracefab-clerk-test`.

**Parade** : autoriser la branche d'exécution dans l'environnement, ou fusionner
le workflow sur `main` et le déclencher depuis `main` (déclenchement manuel,
comme `clerk-tenant-journeys.yml`).

### Verrou 3 — la retenue de sécurité de GitHub Actions

Tout workflow qui lit le contexte `secrets` **sur cette branche** est retenu :
le run passe en `action_required`, avec **zéro job** et zéro étape. C'est
établi par bisection :

| Workflow | Lecture de `secrets` | Résultat |
|---|---|---|
| `zz-sonde-triviale.yml` | non | `success` (6 s) |
| `p1-staging-surface.yml` (avant retrait) | oui (`toJSON(secrets)`) | `action_required`, 0 job |
| `p1-staging-surface.yml` (après retrait) | non | `success` |
| `p1-staging-inventaire.yml` | oui | `action_required`, 0 job |
| `p1-staging-authenticated.yml` | oui, mais **sous environnement** | `failure` — le job démarre et meurt sur la politique de branche |

Le job authentifié n'est donc **pas** retenu par GitHub : il meurt sur le
verrou 2. En revanche, l'inventaire des noms de secrets
(`p1-staging-inventaire.yml`) est retenu, et son approbation doit passer par
une **session web authentifiée** : ni l'API REST, ni un jeton d'application,
ni un bot ne peuvent l'accorder.

### Verrou 4 — le secret d'exploitation de la sonde d'identité (mesuré le 2026-10-23)

La route interne `GET /api/internal/p2/readiness?identity=1` est protégée par
`x-tracefab-worker-secret`, comparé en temps constant à
`process.env.TRACEFAB_NOTIFICATION_WORKER_SECRET` **côté application**
(`api/_lib/worker-auth.ts`). Sans ce secret dans l'environnement
`tracefab-clerk-test`, la mesure est impossible.

La sonde ne devine pas : elle appelle la route **sans** secret et lit la
réponse, qui désigne la correction.

| Réponse | Ce que cela veut dire | Correction |
|---|---|---|
| `503 worker_not_configured` | l'application de Preview n'a **aucun** secret d'exploitation configuré | poser `TRACEFAB_NOTIFICATION_WORKER_SECRET` dans l'environnement Preview du projet Vercel, puis redéployer la Preview |
| `401 worker_unauthorized` | l'application en a un ; il n'est pas dans l'environnement GitHub | déposer `TRACEFAB_NOTIFICATION_WORKER_SECRET` dans l'environnement GitHub `tracefab-clerk-test` |
| `302` vers `/sso-api` | la protection de déploiement Vercel intercepte encore | déposer `VERCEL_AUTOMATION_BYPASS_SECRET` dans `tracefab-clerk-test` |

**Règle de calibration à respecter** : un secret est exigé **à l'étape qui
s'en sert**, jamais avant. Le secret de sonde ne dépend que de la dernière
étape : l'exiger en tête supprimerait les preuves d'isolation, qui n'en
dépendent pas. `npm run test:p1-harness` vérifie cette règle.

### L'approbation de l'environnement — la procédure complète

Trois règles de `tracefab-clerk-test` se cumulent :

| Règle | Effet | Qui décide |
|---|---|---|
| *Deployment branches and tags* : `main`, `arena/88857a44-tracefab`, `arena/f9effa2e-tracefab` | une autre branche ne peut pas demander le déploiement | propriétaire |
| *Required reviewers* : `Huberaya` | chaque déploiement exige une approbation humaine | propriétaire |
| *Prevent self-review* | l'acteur du push ne peut pas approuver son propre déploiement | propriétaire |

Quand le propriétaire travaille seul, l'acteur du push **est** le relecteur :
l'approbation devient impossible par construction. Le geste qui lève l'impasse
(coché par le propriétaire le 2026-10-23, sur autorisation explicite, pour
l'environnement de test **seulement**) :

1. *Settings* → *Environments* → `tracefab-clerk-test` → *Required reviewers* →
   décocher **Prevent self-review** — le relecteur obligatoire **reste** ;
2. approuver chaque exécution en attente depuis la page du run
   (*Approve and deploy*) ;
3. **recocher** *Prevent self-review* à la fin de la campagne.

Un jeton d'intégration GitHub ne peut ni approuver
(`POST /actions/runs/{id}/pending_deployments` → `403 Resource not accessible
by integration`) ni modifier l'environnement (`PUT /environments/{nom}` →
`403`) : l'approbation passe par une session web.

### Ce que la suite d'isolation mesure — quatre plans

L'application borne ses données à **trois endroits distincts** ; en mesurer un
seul ne prouve rien des deux autres.

| # | Plan | Route / action | Requête (session de la marque B) | Attendu |
|---|---|---|---|---|
| 1 | Résolveur de locataire | `GET /api/catalog/products/export` | en-tête `<A>` | **404 `organization_not_found`**, **zéro ligne** |
| 1 bis | idem | idem | `?organizationId=<A>` sans en-tête | **404 `organization_not_found`**, **zéro ligne** |
| 1 ter | l'en-tête prime sur la query | idem | en-tête `<B>` + `?organizationId=<A>` | **200**, corps **identique** à l'export propre |
| 2 | RLS seul | `GET /api/catalog/export/products?organizationId=<A>` | en-tête absent | **200**, CSV, **zéro ligne** |
| 2 bis | contrôle positif | idem | `?organizationId=<B>` | **200**, ses **propres** références |
| 3 | Lecture JSON bornée | `GET /api/products` | en-tête `<A>` | **404 `organization_not_found`**, **zéro produit** |
| 3 bis | ligne à ligne | idem | en-tête `<B>` | chaque produit porte `brandOrganizationId` = B |
| 4 | Écritures | `POST /api/products` | `brandOrganizationId=<A>`, locataire B | **400 `brand_organization_mismatch`**, rien créé |
| 4 bis | locataire étranger | idem | en-tête `<A>` | **404 `organization_not_found`**, rien créé |
| 4 ter | Import catalogue | `POST /api/catalog/products/import` | `brandOrganizationId=<A>` | **403 `brand_organization_access_denied`**, rien persisté |
| 4 quater | Non-persistance | relecture des deux listes | après les trois tentatives | la référence d'écriture est **absente** |

`GET /api/catalog/products/export` et `GET /api/catalog/export/products` sont
**deux routes d'export différentes** : la première s'appuie sur
`requireActiveTenant`, la seconde **uniquement** sur RLS. Tester seulement la
première ne prouverait rien de la barrière RLS.

---

## 6. Sonde d'identité du rôle PostgreSQL runtime

```bash
curl --fail-with-body -sS \
  -H "x-tracefab-worker-secret: $TRACEFAB_NOTIFICATION_WORKER_SECRET" \
  "$TRACEFAB_APP_URL/api/internal/p2/readiness?identity=1"
```

Le secret va **uniquement dans l'en-tête**. Jamais dans l'URL, jamais dans un
journal. La réponse attendue :

| Champ | Valeur attendue |
|---|---|
| `databaseIdentity.measured` | `true` |
| `databaseIdentity.currentUser` | `tracefab_app` |
| `databaseIdentity.sessionUser` | `tracefab_app` |
| `databaseIdentity.bypassesRls` | `false` |
| `databaseIdentity.isSuperuser` | `false` |

`scripts/probe_preview_runtime_identity.mjs` fait l'appel et n'affiche **que**
le rôle courant, le rôle de session et les deux booléens — jamais la réponse
complète.

---

## 7. Reproduire l'exécution

```bash
# 1. Sur la branche de travail
git checkout arena/88857a44-tracefab

# 2. Contrôles qui ne demandent aucun privilege
npm run test:p1-harness              # non-regression du harnais
npm run test:p1:preview-deployment   # selection de la cible + diagnostic (hors ligne, 16 controles)
npm run test:active-tenant  # contrat de refus 404 du locataire non adherent
npm run test:p1                     # catalogue, BOM, i18n, Quality Center
npm run test:workflow-policy        # declaration des workflows privileged
npm run test:ci-no-production-access

# 3. Quelle cible le workflow va-t-il utiliser pour ce SHA ?
GITHUB_REPOSITORY=Huberaya/Tracefab GH_TOKEN="$(gh auth token)" \
  TF_TARGET_SHA="$(git rev-parse HEAD)" TF_PREVIEW_WAIT_SECONDS=0 \
  node scripts/resolve_preview_deployment.mjs

# 4. Mesure de la surface de la Preview (runner GitHub, aucun secret)
gh run list --branch arena/88857a44-tracefab --workflow "P1 staging — diagnostic de surface"

# 4. Exécution authentifiée : exige les trois parades ci-dessus
#    (variables posees par l'environnement GitHub, pas en clair dans un shell
#    partagé ni dans un commit)
npm run test:p1:staging
```

---

## 8. Ce que le harnais ne fait jamais

- il n'affiche aucun secret, aucun cookie, aucun jeton, aucun mot de passe ;
- il n'écrit aucun état de session dans le dépôt ;
- il ne contacte aucune base Neon de production ;
- il ne crée aucun compte en dehors de l'instance Clerk de test ;
- il ne fusionne rien dans `main` et ne déploie rien en Production ;
- il ne contourne pas une protection : il signale qu'elle est active.
