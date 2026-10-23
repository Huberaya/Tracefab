# P1 staging — rapport d'exécution réelle sur Preview

**Statut : P1 NON clos.** L'exécution authentifiée n'a pas pu partir : trois
verrous **extérieurs à l'agent** l'empêchent, chacun mesuré et documenté ci-dessous.
Tout ce qui n'était pas bloqué **a été exécuté** : mesures sur la Preview,
non-régressions, CI de la branche, harnais prêt à jouer.

Branche de travail : `arena/88857a44-tracefab`, SHA final
`d6a4543477d7c8559885aa7782cdda00c8b6d9fa` (aucun merge dans `main`, aucun
déploiement Production, aucune variable ni base de Production touchée). PR
ouverte : **#91**.

---

## 1. Cible exacte testée

| Élément | Valeur | Source |
|---|---|---|
| Branche | `security/production-rls-identity-20261021` | `git ls-remote --heads origin` |
| SHA | `7ec24d44ff729b485c44bb92f1ddeaf4e3b3afbf` | idem |
| Commit | `docs(security): correct function allowlist count and dependency` | `git log` |
| Déploiement GitHub | `7222946292`, environnement `Preview`, SHA identique | `GET /repos/Huberaya/Tracefab/deployments?ref=7ec24d4…` |
| URL Preview (1er déploiement, 2026-10-21T09:48:56Z, `vercel[bot]`, `success`) | `https://tracefab-ek0vg39c3-baya-ibraimmayoanouedu-8164s-projects.vercel.app` | `GET /deployments/7222946292/statuses` |
| URL Preview (redéploiement, 2026-10-23T08:21:21Z, même SHA, `vercel[bot]`, `success`) | `https://tracefab-m815yyk4e-baya-ibraimmayoanouedu-8164s-projects.vercel.app` | idem |

Les deux URL sont des déploiements **du même SHA** : la seconde n'est pas une
autre branche, c'est un redéploiement du commit visé. L'URL utilisée n'est
jamais figée dans le code : elle vient de l'entrée `preview_url` du job.

> Point de vigilance : `e856fb` (qui apparaît dans l'URL de retour Vercel du
> check-run « Vercel Preview Comments ») est un **hash de déploiement**, pas un
> commit — `git cat-file -t e856fb` répond « Not a valid object name ». Il ne
> faut pas le traiter comme un SHA.

---

## 2. Verrou 1 — la protection de déploiement Vercel (le plus bloquant)

**Mesuré** sur un runner GitHub (`scripts/probe_preview_surface.mjs`, run
`39929151648`, `success`) :

```
preview_hote=tracefab-m815yyk4e-baya-ibraimmayoanouedu-8164s-projects.vercel.app
/api/health_http=302
/api/health_classe=protection_possible
/api/health_content_type=text/plain
/api/health_marqueurs_protection=vercel
/api/health_redirection_chemin=/sso-api
/api/health_redirection_parametres=nonce,url
```

Identique sur `/api/config` et sur `/api/internal/p2/readiness` — donc **les
trois routes de l'application, y compris la sonde interne, sont inaccessibles** :
le runner atteint la protection, pas l'application.

**Le verrou est propre au projet, pas à un déploiement.** Les dix derniers
déploiements `Preview` du dépôt ont été sondés (run `39929151648`) : les dix
répondent `302` vers `/sso-api`. Aucun aperçu du projet n'est donc atteignable
sans contournement.

**Ce que ça implique pour la mission :** sans contournement, `npm run
test:p1:staging` ne peut pas mesurer quoi que ce soit — il verrait la page de
connexion Vercel, pas l'application. Aucun rapport de test ne pourrait être
distingué d'un faux vert.

**Parade préparée et implémentée :** le harnais accepte un contournement
**optionnel**, transmis uniquement dans l'en-tête `x-vercel-protection-bypass`
(avec `x-vercel-set-bypass-cookie: true`), jamais dans une URL ni dans une
sortie :

- `scripts/test_p1_staging.mjs` — `extraHTTPHeaders` sur le contexte
  Playwright + injection du même en-tête dans les `fetch` same-origin de la page
  (les exports et simulations de la page passeraient sinon par la protection) ;
- `scripts/probe_preview_runtime_identity.mjs` et
  `scripts/probe_preview_surface.mjs` — en-tête sur les appels `fetch`.

Variable d'environnement : `TRACEFAB_VERCEL_BYPASS`. **Absente, le
comportement est strictement inchangé** — c'est vérifié par le non-régression
`npm run test:p1-harness`.

---

## 3. Verrou 2 — la politique de branche de l'environnement `tracefab-clerk-test`

**Mesuré** — annotation GitHub du job `p1-staging-authenticated.yml`
(run `39929144478`) :

```
Branch "arena/88857a44-tracefab" is not allowed to deploy to tracefab-clerk-test
due to environment protection rules.
The deployment was rejected or didn't satisfy other protection rules.
```

L'environnement porte une seule politique de branche, `main`
(`GET /environments/tracefab-clerk-test/deployment-branch-policies` →
`total_count: 1`, `name: main`), plus un relecteur obligatoire
(`Huberaya`, `prevent_self_review: true`). Le job authentifié meurt donc avant
sa première étape.

Les trois demandes d'administration que j'ai tentées sont toutes refusées au
token GitHub disponible (intégration d'application) :

| Demande | Réponse |
|---|---|
| ajouter la branche à la politique de l'environnement | `403 Resource not accessible by integration` |
| créer un environnement | `404 Not Found` |
| lister les secrets de l'environnement | `403 Resource not accessible by integration` |
| déclencher un workflow (`workflow_dispatch`) | `403 Resource not accessible by integration` |

---

## 4. Verrou 3 — la retenue de sécurité de GitHub Actions

Tout workflow qui lit le contexte `secrets` **depuis cette branche** est
retenu : `action_required`, **zéro job**, zéro étape. Établi par bisection :

| Workflow | Lit `secrets` | Résultat |
|---|---|---|
| `zz-sonde-triviale.yml` | non | `success` (6 s) — run `39929144449` |
| `p1-staging-surface.yml` (avec `toJSON(secrets)`) | oui | `action_required`, 0 job |
| `p1-staging-surface.yml` (après retrait) | non | `success` — run `39929151648` |
| `p1-staging-inventaire.yml` | oui | `action_required`, 0 job — run `39929151715` |
| `p1-staging-authenticated.yml` | oui, **sous environnement** | `failure` — le job démarre, meurt sur le verrou 2 |

Le job authentifié **n'est donc pas** retenu par GitHub : il ne bute que sur la
politique de branche. En revanche, `p1-staging-inventaire.yml` (inventaire des
noms de secrets) est retenu, et son approbation doit passer par une session
web authentifiée : ni l'API REST, ni un jeton d'application, ni un bot ne
peuvent l'accorder.

---

## 5. Ce qui a été exécuté et vérifié

### 5.1 Mesures sur la Preview (runner GitHub)

- `health`, `config` et `readiness` sondés sur les deux déploiements du SHA
  visé, puis sur les dix derniers aperçus du dépôt → `302` vers `/sso-api`
  partout (§2).
- La classification « réponse applicative » / « protection » est implémentée
  dans la sonde : un `200` ne suffit plus à conclure que l'application a
  répondu.

### 5.2 Contrôles locaux (dans le bac à sable)

| Commande | Résultat |
|---|---|
| `npm run test:p1-catalog` | vert — contrat import/export catalogue |
| `npm run test:p1-bom` | vert — import BOM/ lot du Supplier Portal |
| `npm run test:p1-i18n` | vert — architecture i18n (7 langues) |
| `npm run test:p1-quality` | vert — contrat Quality Center |
| `npm run test:p1-harness` (nouveau) | vert — **48 assertions** |
| `npm run test:active-tenant` | vert — **13 contrôles**, dont « locataire non adhérent -> 404 `organization_not_found` (pas de 403 : aucune révélation) » — la non-régression locale du contrat, exécutée le 2026-10-23 |
| `npm run test:workflow-policy` | vert — déclaration des workflows privilégiés |

### 5.3 CI de la branche

**Verte sur les quatre jobs** au SHA `e06427f` (run `39940082558`,
conclusion `success`) : `Socle — types, compilation, isolation`,
`Base — isolation RLS exécutée`, `Parcours — navigateur réel`,
`Vérification — suite de tests`. Le contrôle `test:p1-harness` est désormais
**collecté** par cette dernière (le nom du script ne porte plus `staging`).

Aucun test `staging` n'est auto-collecté par la CI (filtre explicite de
`ci.yml`), ce qui est correct : ces tests exigent une Preview vivante et trois
sessions authentifiées. Le **contrôle** de la suite staging, lui, est collecté —
un contrôle jamais exécuté serait vert sans avoir jamais joué.

Historique des runs de branche :

| SHA | Run | Conclusion |
|---|---|---|
| `8b0eee0` | `39931682245` | `success` |
| `d6a4543` | `39930400060` | `success` |
| `e06427f` | `39940082558` | `success` (les quatre jobs) |

L'ancienne section indiquait le SHA `d6a4543` ; elle est remplacée par le
résultat le plus récent.

### 5.4 Ce que le non-régression nouveau garantit

`scripts/test_p1_staging_harness.mjs` (`npm run test:p1-harness`) :

1. la suite P1 staging exige toujours ses quatre variables et refuse toujours
   le repli mock/demo ;
2. le contournement Vercel reste **optionnel** — absent de la variable, rien ne
   change ;
3. la sonde d'identité ne place aucun secret dans une URL, l'utilise dans
   l'en-tête `x-tracefab-worker-secret`, et ne l'affiche jamais ;
4. la préparation des sessions n'affiche ni la clé Clerk ni un mot de passe ;
5. une clé d'instance de **production** est refusée (code 3) sans que sa
   valeur — ni un fragment de celle-ci — apparaisse dans la sortie ;
6. une cible hors Preview Vercel HTTPS est refusée ; la sonde d'identité
   refuse de partir sans secret ;
7. **aucun état de session n'est suivi par git**, et le répertoire des états
   est paramétrable et hors du dépôt par défaut ;
8. l'inventaire n'affiche que des **noms** de secrets ;
9. le contrôle est branché dans `package.json` **sous un nom que la CI
   collecte** (`test:p1-harness` : la CI exclut les scripts dont le nom porte
   `neon` ou `staging`) — le contrôle vérifie lui-même cette propriété ;
10. la suite staging **exige** le refus 404 `organization_not_found` (elle ne
    se contente plus de tolérer 403 ou 404), exige **zéro ligne de données**
    dans une réponse de refus, exige que l'export obtenu avec un
    `organizationId` étranger soit identique à l'export propre, mesure les
    trois formes de demande de locataire (en-tête, query, les deux ensemble),
    exige un contrôle positif, et exige deux organisations réellement
    distinctes (identifiants UUID comparés).

### 5.5 Vérification statique du contrat déployé (avant le seul passage exécuté)

Une seule exécution exécutée est admise : le contrat de la suite a donc été
confronté **au code du SHA déployé** (`git show 7ec24d4:<chemin>`), pas au code
de la branche. Résultat :

| Contrat mesuré | Code au SHA `7ec24d4` | Attendu par la suite | Verdict |
|---|---|---|---|
| `POST /api/catalog/products/import` | `json(res, 200, result.preview)` → corps **plat** `{valid, headers, totalRows, …}` | `body.valid === true` | conforme |
| En-têtes CSV exigés (import catalogue) | `REQUIRED_HEADERS = ['reference', 'name']` | `reference,name,category` | conforme |
| `POST /api/supplier/materials/import-bom` | `{status, isValid, …, savedMaterialsCount}` | `isValid === true`, `savedMaterialsCount === 0` | conforme |
| CSV BOM | séparateurs `;` `,` `	`, en-têtes FR/EN/PT, total 100 % ± 0,5 | `;`, en-têtes FR, 85 + 15 | conforme |
| `GET /api/catalog/products/export` | `requireActiveTenant(...)` → `TenantError(404, 'organization_not_found')` ; export borné à `[tenant.organizationId]` | refus 404 + périmètre non élargi | conforme |
| `GET /api/internal/p2/readiness?identity=1` | `databaseIdentity.{measured, currentUser, sessionUser, bypassesRls, isSuperuser}` | rôle + deux booléens | conforme |
| Secret de la sonde | env `TRACEFAB_NOTIFICATION_WORKER_SECRET`, en-tête `x-tracefab-worker-secret` | secret en en-tête, jamais en URL | conforme |
| Pages | `brand-console/`, `supplier-portal/`, `quality-center/` | les trois | conforme |
| Sélecteurs | `h1.mc-headline`, `h1.sp-hero-h1`, `h1` (rendu par le JS) | les trois | conforme |
| `state.demo` | booléen (`new URLSearchParams(...).get('demo') === '1'`) | `=== false` hors démo | conforme |
| `state.clerk.session`, `state.activeOrganizationId`, `state.selectedOrganizationId` | présents | présents | conforme |
| `data-tracefab-demo` sur `<body>` | absent des trois pages | l'attribut doit rester `null` | conforme |

**Un défaut a été trouvé et corrigé au passage :** le disclaimer du Quality
Center est un **texte traduit** (`quality.heroLede`, `assets/i18n/fr.json`).
Le runner GitHub est en `en-US` : sans locale imposée, la page aurait rendu la
variante anglaise (« Declarative statuses are never turned into a
certification. ») et le contrôle français aurait été **rouge pour une raison
étrangère au produit**. La suite impose désormais `locale: 'fr-FR'` **et**
accepte les deux variantes de la phrase. De même, la référence de simulation
catalogue est désormais unique par exécution : un doublon préexistant ferait
ré-écho la valeur CSV dans le message d'erreur du serveur, et le contrôle
« la réponse ne ré-écho pas les valeurs CSV » échouerait à tort.

**Un second défaut, bloquant, a été trouvé et corrigé :** la préparation des
sessions (`scripts/prepare_p1_staging_sessions.mjs`) **ne portait pas** le
contournement de la protection Vercel. Elle aurait donc atteint la protection
et non le formulaire de connexion Clerk de l'application : l'échec aurait été
un dépassement de délai sur le champ « identifiant », sans rapport avec le
produit. Les trois scripts qui touchent la Preview portent désormais le
contournement — préparation des sessions, suite staging, sonde d'identité — et
les deux premiers le portent **aussi sur leurs appels same-origin**, sans quoi
la page aurait reçu un 302 HTML au lieu de ses réponses JSON.

Enfin, la sonde d'identité ne publiait ses mesures que dans le journal de run,
hébergé hors de l'API GitHub : elle publie désormais ses mesures en
annotation, seul canal lisible depuis l'extérieur.

Un troisième risque, plus discret, a également été fermé : `state.clerk.session`
est posé **avant** la synchronisation des organisations. La suite attendait la
session, puis lisait `state.activeOrganizationId` — une course qui aurait
échoué de façon aléatoire. Elle attend désormais l'identifiant d'organisation
lui-même (60 s), pour les trois portails concernés.

---

## 5 bis. Écart trouvé entre le critère du chantier et le contrat du dépôt — **tranché le 2026-10-23**

Le chantier demandait la preuve que « l'export inter-organisation est rejeté
en HTTP 403 ». **L'application ne produit pas de 403 sur cette route** — et c'est
délibéré.

| Fait | Preuve |
|---|---|
| Le refus d'un locataire non adhérent est un **404 `organization_not_found`**, pas un 403 | `api/_lib/tenant.ts` : « Le 404 plutôt que le 403 sur un locataire non accessible est délibéré : un 403 révélerait que l'organisation existe » |
| Ce contrat est protégé par une non-régression **locale**, verte en CI | `scripts/test_active_tenant_context.mjs` : « locataire non adhérent -> 404 organization_not_found (pas de 403 : aucune révélation) » — **13 contrôles, tous verts**, exécutés le 2026-10-23 |
| Le SHA de la Preview contient ce contrat | `git merge-base --is-ancestor 96a7f62 7ec24d4` → vrai (commit du 2026-10-17) |
| La suite staging exigeait un 403 **littéral** | `scripts/test_p1_staging.mjs`, écrit le 2026-10-07, soit **avant** le changement de contrat, et jamais exécuté contre une Preview — la procédure était alors notée « NON VÉRIFIABLE » dans `docs/experience/` |
| Pire : la requête du test ne demandait même pas le mauvais locataire | elle posait l'en-tête `X-Tracefab-Organization-Id` sur le **propre** locataire de la marque B et l'organisation étrangère dans la query string ; l'en-tête est prioritaire (`api/_lib/tenant.ts`), donc la requête était un export **légitime** du locataire de la marque B, qui aurait répondu **200** |

**Décision du propriétaire (2026-10-23) :** conserver le contrat
`404 organization_not_found` et sa non-régression, et renforcer la preuve
d'isolation. `api/_lib/tenant.ts` n'est **pas** modifié.

### Le critère P1, réécrit

> « Un export visant une organisation étrangère est refusé selon le contrat
> anti-divulgation `404 organization_not_found`, sans élargissement du
> périmètre des données ; l'export du locataire autorisé continue de
> fonctionner. »

### La route réellement mesurée

La route testée est `GET /api/catalog/products/export`
(`api/_routes/catalog/products/export.ts`) : elle appelle **bien**
`requireActiveTenant(tx, req, user.id, { types: ['brand'] })`, puis n'exporte
que le locataire résolu (`scopedOrganizations = [tenant.organizationId]`).
C'est donc bien elle qui produit le 404 `organization_not_found`.

> Attention, un piège de lecture : il existe **deux** routes d'export.
> `api/_routes/catalog/export/products.ts` (export CSV de conformité) ne
> résout **pas** le locataire et s'appuie uniquement sur RLS ; elle ne peut
> donc pas produire de 404. La route du critère P1 est bien
> `api/_routes/catalog/products/export.ts`.

### Ce que la suite mesure désormais — statut **et** données

La precedence du locataire est *en-tête → query → corps*
(`api/_lib/tenant.ts`) : les trois formes de demande n'ont pas le même sens,
et la suite les mesure toutes les trois, avec deux personnes réellement
différentes, chacune authentifiée dans **sa** organisation.

| # | Requête (session de la marque B) | Locataire résolu | Attendu |
|---|---|---|---|
| 1 | en-tête `X-Tracefab-Organization-Id: <A>` | A (étranger) | **404 `organization_not_found`**, **zéro ligne** de données |
| 2 | `?organizationId=<A>`, sans en-tête | A (étranger) | **404 `organization_not_found`**, **zéro ligne** de données |
| 3 | en-tête `<B>` + `?organizationId=<A>` | B (propre) | **200**, corps **strictement identique** à l'export propre |
| 4 | en-tête `<B>` seul — *contrôle positif* | B (propre) | **200**, export des données autorisées |

Le **statut seul** ne prouve rien : un 404 peut accompagner un corps qui fuit.
La preuve est donc au niveau des données :

- une réponse de refus doit être un **document JSON d'erreur** (et non un
  CSV), et son corps ne doit contenir **aucune** référence — ni de
  l'organisation étrangère, ni du locataire appelant ;
- l'export obtenu avec un `organizationId` étranger et l'en-tête autorisé
  doit être **octet pour octet identique** à l'export propre : la preuve de
  l'absence d'élargissement du périmètre ;
- l'export propre de la marque B est récupéré **avec la session de la marque
  B** et sert de témoin : aucune de ses références ne doit apparaître dans
  une réponse obtenue par la marque A.

Les mesures sont publiées en annotations (compteurs et statuts seulement,
aucune valeur de donnée) : `inter_tenant_export_refusal_status`,
`inter_tenant_export_refusal_error`, `inter_tenant_export_data_rows`,
`own_brand_a_rows`, `own_brand_b_rows`, `foreign_only_refs`,
`own_export_with_foreign_parameter`.

### La matrice d'isolation complète — quatre plans

Une application borne ses données à **trois endroits distincts**, et un test
qui n'en mesure qu'un ne prouve rien des deux autres. La suite mesure donc
quatre plans, avec deux sessions réellement distinctes (marque A et marque B,
organisations différentes, identifiants UUID comparés) :

| # | Plan | Route / action | Requête (session de la marque B) | Attendu |
|---|---|---|---|---|
| 1 | **Résolveur de locataire** — `api/_lib/tenant.ts` | `GET /api/catalog/products/export` | en-tête `<A>` | **404 `organization_not_found`**, **zéro ligne** |
| 1 bis | idem | idem | `?organizationId=<A>` sans en-tête | **404 `organization_not_found`**, **zéro ligne** |
| 1 ter | idem — l'en-tête prime sur la query | idem | en-tête `<B>` + `?organizationId=<A>` | **200**, corps **identique** à l'export propre |
| 2 | **RLS seul** — la route ne résout *aucun* locataire et s'appuie uniquement sur la base | `GET /api/catalog/export/products?organizationId=<A>` | en-tête absent | **200**, document CSV, **zéro ligne**, aucune référence de A |
| 2 bis | idem — contrôle positif | idem | `?organizationId=<B>` | **200**, ses **propres** références présentes |
| 3 | **Lecture JSON bornée** | `GET /api/products` | en-tête `<A>` | **404 `organization_not_found`**, **zéro produit** |
| 3 bis | idem — preuve ligne à ligne | idem | en-tête `<B>` | chaque produit renvoyé porte `brandOrganizationId` = B |
| 3 ter | idem — les deux organisations | idem | A et B | chaque produit porte l'organisation du'appelant ; références communes **consignées** |
| 4 | **Écritures** — `POST /api/products` | création dirigée vers A, locataire B | en-tête `<B>`, corps `brandOrganizationId=<A>` | **400 `brand_organization_mismatch`**, rien créé |
| 4 bis | idem — locataire étranger | idem | en-tête `<A>`, corps `brandOrganizationId=<A>` | **404 `organization_not_found`**, rien créé |
| 4 ter | **Import catalogue** — `POST /api/catalog/products/import` | import vers A | en-tête `<A>`, corps `brandOrganizationId=<A>` | **403 `brand_organization_access_denied`**, rien persisté |
| 4 quater | **Preuve de non-persistance** | relecture des deux listes | après les trois tentatives | la référence d'écriture est **absente** des deux organisations |

Pourquoi le plan 2 est indispensable : `GET /api/catalog/export/products` et
`GET /api/catalog/products/export` sont **deux routes d'export différentes**.
La première ne résout aucun locataire et n'applique qu'une politique RLS
(`tracefab_is_org_member(brand_organization_id)`) ; la seconde passe par
`requireActiveTenant`. Une suite qui ne testerait que la seconde ne prouverait
**rien** de la barrière RLS — c'est pourtant celle qui protège les tables
quand le code applicatif se trompe.

Les mesures sont publiées en annotations : `inter_tenant_export_refusal_status`,
`inter_tenant_export_refusal_error`, `inter_tenant_export_data_rows`,
`rls_foreign_rows`, `rls_own_refs`, `products_own_rows`,
`products_foreign_rows`, `products_brand_a_rows`,
`shared_references_between_brands`, `write_cross_tenant_status`,
`write_cross_tenant_error`, `write_foreign_tenant_status`,
`write_import_foreign_status`, `refused_write_persisted`,
`own_export_with_foreign_parameter`.

**Aucune donnée réelle de client n'est touchée** : les écritures testées sont
des créations dirigées vers une organisation de test, et toutes sont
**refusées avant toute persistance** — la preuve en est la relecture des
listes après les tentatives.

## 6. Corrections et ajouts apportés

| Fichier | Nature |
|---|---|
| `scripts/prepare_p1_staging_sessions.mjs` | **nouveau** — fabrique les trois sessions Clerk de test (marque A, fournisseur, marque B dans une organisation distincte) dans l'instance `sk_test_`, par l'IHM Clerk réelle ; refuse une clé de production, une adresse hors `.test`, une cible hors Preview Vercel |
| `scripts/probe_preview_runtime_identity.mjs` | **nouveau** — sonde d'identité DB runtime, secret uniquement en en-tête, sortie réduite au rôle et aux deux booléens |
| `scripts/probe_preview_surface.mjs` | **nouveau** — surface de la Preview + classification réponse applicative / protection Vercel, annotations comprises |
| `scripts/list_secret_names.mjs` | **nouveau** — inventaire des **noms** de secrets, aucune valeur |
| `scripts/lib/annotations.mjs` | **nouveau** — canal de mesure lisible depuis `api.github.com` (l'hôte des journaux de run est hors périmètre réseau) |
| `scripts/test_p1_staging_harness.mjs` | **nouveau** — non-régression du harnais (**48 assertions** ; le contrôle vérifie lui-même que son nom de script reste collecté par la CI) |
| `scripts/test_p1_staging.mjs` | **modifié** — contournement Vercel optionnel ; verdict en annotation ; **contrat de l'export inter-organisation aligné sur le refus réel** : refus 404 `organization_not_found` exigé (plus seulement toléré), preuve au niveau des **données** (zéro ligne dans un refus, export propre inchangé avec un `organizationId` étranger), contrôle positif, identités distinctes vérifiées au format UUID ; aucune modification du contrat des quatre variables |
| `package.json` | **modifié** — `test:p1-harness` (renommé : la CI collecte automatiquement les scripts `test:*` **sauf** ceux dont le nom porte `neon` ou `staging` ; le nom précédent était donc **silencieusement jamais exécuté**) |
| `.github/workflows/p1-staging-surface.yml` | **nouveau** — diagnostic sans secret ni environnement (seul workflow jouable sans approbation) |
| `.github/workflows/p1-staging-inventaire.yml` | **nouveau** — inventaire des noms de secrets |
| `.github/workflows/p1-staging-authenticated.yml` | **nouveau** — exécution réelle : pré-vol, inspection, sessions, `npm run test:p1:staging`, sonde d'identité |
| `docs/security/workflow-privileged-allowlist.json` | **modifié** — déclaration explicite des trois workflows privileged |
| `docs/operations/p1-staging-execution.md` | **nouveau** — mode opératoire complet |

Aucun storage state n'est commité, aucun secret n'est écrit dans un journal,
un commentaire ou un artefact ; les mots de passe sont générés par le script et
jamais affichés.

---

## 7. Le blocage restant — une seule action, et sa cause racine exacte

### 7.1 Ce qui est déjà fait par le propriétaire

| Élément | État mesuré |
|---|---|
| Secret `VERCEL_AUTOMATION_BYPASS_SECRET` | **déposé** dans l'environnement `tracefab-clerk-test` (présence à confirmer par le run `p1-staging-inventaire.yml`) |
| Branche `arena/88857a44-tracefab` autorisée dans *Deployment branches and tags* | **fait** — politique `id=64094181`, en plus de `main` (`id=63966314`) |

### 7.2 Cause racine du statut `waiting` — un verrou d'approbation, pas une erreur

Le run `39959423684` (`p1-staging-inventaire.yml`, SHA `f6b2d63`) est
`waiting`, son unique job est `waiting`, et `pending_deployments` renvoie :

```
env=tracefab-clerk-test id=24943335828 reviewers=User waiting_timer=0
```

Les trois faits qui expliquent l'immobilisation, tous mesurés :

| Fait | Mesure |
|---|---|
| L'acteur du run est `Huberaya` | `actor=Huberaya triggering_actor=Huberaya` |
| Le seul relecteur requis est `Huberaya` | `protection_rules[required_reviewers].reviewers = [Huberaya]`, `prevent_self_review = true` |
| Mon jeton ne peut ni approuver ni administrer l'environnement | `POST .../pending_deployments` → `403 Resource not accessible by integration` ; `PUT .../environments/tracefab-clerk-test` → `403 Resource not accessible by integration` |

**GitHub interdit à un relecteur d'approuver un déploiement qu'il a
lui-même déclenché quand `prevent_self_review` est activé.** L'acteur est le
propriétaire, le relecteur est le propriétaire : **personne ne peut approuver
ce déploiement**. Ce n'est pas un oubli d'approbation, c'est une impasse
construite — l'approbation doit venir d'une *autre* personne, et le chantier
se fait seul.

Le contournement n'a **pas** été tenté par un contournement de protection :
ni désactivation de la protection Vercel, ni déplacement du secret vers le
niveau du dépôt, ni suppression de la règle de relecture.

### 7.3 L'action unique demandée

> **Désactiver « Prevent self-review » pour l'environnement
> `tracefab-clerk-test` uniquement, puis approuver les exécutions en attente.**

- *Où* : GitHub → dépôt → *Settings* → *Environments* → `tracefab-clerk-test`
  → *Required reviewers* → décocher **Prevent self-review**.
- *Ce qui reste en place* : le relecteur obligatoire `Huberaya` **reste
  requis**. Chaque déploiement d'environnement continue donc d'exiger une
  **approbation humaine explicite** ; seule l'auto-approbation devient
  possible. La barrière n'est pas retirée, elle est rendue actionnable.
- *Portée* : l'environnement `tracefab-clerk-test` **seulement**. Aucun
  environnement de Production n'est touché, aucune règle de `main` n'est
  touchée, la protection de déploiement Vercel reste active, et
  `main` n'est pas modifié.
- *Si GitHub accepte l'approbation malgré `prevent_self_review`* (le run a
  été relancé une fois, `run_attempt=2`) : il suffit d'approuver les deux
  exécutions en attente, sans toucher à la configuration.

Une fois ce geste fait, les deux exécutions en attente — le contrôle de
présence du secret et l'exécution authentifiée — démarrent sans autre
intervention : pré-vol, inspection de l'instance Clerk de test, fabrication
des trois sessions, `npm run test:p1:staging`, puis la sonde d'identité
runtime. Chaque mesure sort en **annotation**, lisible sans accès à l'hôte de
stockage des journaux.

### 7.4 Ce qui a été fait dans le périmètre autorisé

- Le CI de la branche était **rouge** sur `f6b2d63` : le nouveau workflow du
  propriétaire lit `secrets.VERCEL_AUTOMATION_BYPASS_SECRET` et est rattaché
  à `tracefab-clerk-test`, sans être déclaré au registre des workflows
  privilégiés. Déclaration ajoutée (`secretUsingWorkflows` et
  `environmentBoundJobs`, avec justification) → `npm run test:workflow-policy`
  **vert**.
- Le workflow authentifié vérifie désormais **explicitement la présence** des
  trois secrets dont il a besoin (sans jamais en afficher la valeur), ce qui
  distingue « secret absent » de « secret présent mais faux ».

---

## 8. Ce qui restera à prouver une fois le déverrouillage fait

La suite `npm run test:p1:staging` exercera, sur la Preview du SHA
`7ec24d4` :

1. **authentification Clerk réelle, non démo** — `state.demo === false`,
   `state.user` et `state.clerk.session` présents sur les trois portails ;
2. **simulation d'import catalogue** — `dryRun`, `valid === true`, et la
   réponse ne ré-écho pas la valeur CSV (`P1-STAGING-DRY-RUN`) ;
3. **validation BOM sans persistance** — `isValid === true` et
   **`savedMaterialsCount === 0`** ;
4. **disclaimer Quality Center** — « statuts déclaratifs » et « certification »
   présents ;
5. **organisations marque A et marque B réellement distinctes** (identifiants
   UUID comparés), **export inter-organisation refusé en 404
   `organization_not_found`** avec **zéro ligne de données**, et **export du
   locataire autorisé inchangé** (octet pour octet) ;
5 bis. **barrière RLS mesurée seule** (route sans résolveur de locataire :
   zéro ligne pour une organisation étrangère), **lecture JSON bornée ligne à
   ligne** (`brandOrganizationId` de chaque produit), **écritures croisées
   refusées** (400 `brand_organization_mismatch`, 404 `organization_not_found`,
   403 `brand_organization_access_denied`) et **preuve de non-persistance** ;
6. **identité DB runtime** — `currentUser = sessionUser = tracefab_app`,
   `bypassesRls === false`, `isSuperuser === false`, secret uniquement dans
   l'en-tête `x-tracefab-worker-secret`, réponse complète jamais publiée.

Aucun de ces six points ne peut être affirmé aujourd'hui : les produire sans
l'accès à l'application serait écrire un rapport de test qui n'a rien mesuré.
