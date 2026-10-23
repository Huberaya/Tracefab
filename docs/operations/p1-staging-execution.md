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
5. **organisations marque A/B distinctes et export inter-organisation refusé**
   — `GET /api/catalog/products/export?organizationId=<A>` avec le jeton de la
   marque B renvoie **HTTP 403**.

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
`npm run test:p1-staging:harness` vérifie qu'aucun état de session n'est suivi
par git.

---

## 5. Trois verrous externes, et la parade pour chacun

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
non-regression `npm run test:p1-staging:harness` le vérifie.

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
npm run test:p1-staging:harness     # non-regression du harnais
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
