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

## 2. Cible exacte : SHA et déploiement Preview

Le chantier porte sur la branche `security/production-rls-identity-20261021`.

| Élément | Valeur |
|---|---|
| SHA de la branche | `7ec24d44ff729b485c44bb92f1ddeaf4e3b3afbf` |
| Commit | `docs(security): correct function allowlist count and dependency` |
| Déploiement GitHub | `7222946292`, environnement `Preview` |
| URL du déploiement (1er déploiement, 2026-10-21T09:48:56Z) | `https://tracefab-ek0vg39c3-baya-ibraimmayoanouedu-8164s-projects.vercel.app` |
| URL du redéploiement (2026-10-23T08:21:21Z, même SHA) | `https://tracefab-m815yyk4e-baya-ibraimmayoanouedu-8164s-projects.vercel.app` |

Les deux URL répondent au même SHA : ce sont deux déploiements du même commit.
Le redéploiement du 23 octobre est le plus récent ; c'est celui que le job
utilise par défaut, et son URL est **paramétrable** (`preview_url` du job) —
aucune URL n'est figée dans le code.

Vérification indépendante de l'URL :

```bash
gh api "repos/Huberaya/Tracefab/deployments?ref=7ec24d44ff729b485c44bb92f1ddeaf4e3b3afbf" \
  --jq '.[] | {id, sha, ref, environment, created_at}'
gh api "repos/Huberaya/Tracefab/deployments/7222946292/statuses" \
  --jq '.[] | {state, environment_url, created_at, creator: .creator.login}'
```

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

**Mesure** (`scripts/probe_preview_surface.mjs`, runner GitHub) :

```
preview_hote=tracefab-m815yyk4e-baya-ibraimmayoanouedu-8164s-projects.vercel.app
/api/health_http=302
/api/health_classe=protection_possible
/api/health_content_type=text/plain
/api/health_marqueurs_protection=vercel
/api/health_redirection_chemin=/sso-api
/api/health_redirection_parametres=nonce,url
```

Identique sur `/api/config` et sur `/api/internal/p2/readiness`, et identique
sur l'URL du premier déploiement (`ek0vg39c3`). Les trois routes de
l'application — dont la sonde interne — sont **inaccessibles** : le runner
atteint la protection, pas l'application.

**Parade** : le projet expose un secret « Protection Bypass for Automation ».
Il est transmis dans l'en-tête `x-vercel-protection-bypass` (avec
`x-vercel-set-bypass-cookie: true`), et **uniquement** dans l'en-tête — jamais
dans une URL, jamais dans une sortie. Le harnais le supporte déjà :

- `TRACEFAB_VERCEL_BYPASS` pour les sondes (`fetch`) ;
- `TRACEFAB_VERCEL_BYPASS` pour Playwright (`extraHTTPHeaders` + injection du
  même en-tête dans les `fetch` same-origin de la page).

Sans cette variable, le comportement est **strictement inchangé** : le
non-regression `npm run test:p1-harness` le vérifie.

### Verrou 2 — la politique de branche de l'environnement `tracefab-clerk-test`

**Mesure** — annotation GitHub du job `p1-staging-authenticated.yml` :

```
Branch "arena/88857a44-tracefab" is not allowed to deploy to tracefab-clerk-test
due to environment protection rules.
The deployment was rejected or didn't satisfy other protection rules.
```

L'environnement `tracefab-clerk-test` n'autorise aujourd'hui que `main`
(`deployment-branch-policies` → une seule entrée, `main`). Le job authentifié
doit donc être rattaché à un environnement **et** s'exécuter depuis une branche
autorisée.

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
| *Deployment branches and tags* : `main` + `arena/88857a44-tracefab` | une autre branche ne peut pas demander le déploiement | propriétaire |
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
npm run test:p1-harness     # non-regression du harnais (38 assertions)
npm run test:active-tenant  # contrat de refus 404 du locataire non adherent
npm run test:p1                     # catalogue, BOM, i18n, Quality Center
npm run test:workflow-policy        # declaration des workflows privileged
npm run test:ci-no-production-access

# 3. Mesure de la surface de la Preview (runner GitHub, aucun secret)
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
