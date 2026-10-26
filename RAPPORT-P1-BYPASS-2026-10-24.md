# P1 staging — déblocage du bypass Vercel : cause racine, correctif, preuves, blocage résiduel

**Date** : 2026-10-24 · **Branche** : `arena/fd3fb758-tracefab`
**Commit code** : `403a2728d5572af15d34a8c1f0df338ef702c5d6` (le SHA final est la tête de branche ; les
preuves ci-dessous portent sur ce commit code et sont revérifiées sur le SHA final par la CI de PR)
**PRs** : #91 (historique), #92, #93 (sessions précédentes), nouvelle PR de cette branche (laissée ouverte)

> **Statut : P1 NON clôturé, mais le bypass est désormais PROUVÉ.** Pendant cette session, la
> politique de branche a été levée pour `arena/f9effa2e-tracefab` (action propriétaire) et le run
> authentifié [40043764425](https://github.com/Huberaya/Tracefab/actions/runs/40043764425) a passé le
> pré-vol : `cause=application_atteinte`, `/api/health` 200 JSON, `/api/config` 200 (`pk_test`),
> contournement accepté. Le blocage a donc **migré** : l'étape « Préparer les trois sessions Clerk »
> échoue (exit 1) avant la suite d'isolation et la sonde DB. Aucun test n'a été supprimé, assoupli
> ou transformé en succès.

---

## 1. Cause racine démontrée (trois défauts cumulés)

### 1.1 L'en-tête qui fabriquait le 307

Run [`40035513421`](https://github.com/Huberaya/Tracefab/actions/runs/40035513421) (branche autorisée
`arena/88857a44-tracefab`, commit `50e7070`), étape « Pre-vol », exit code 5 :

```
preview_hote=tracefab-git-arena-e13749-...vercel.app
/api/health_http=307                    /api/health_content_type=text/plain
/api/health_redirection_chemin=/api/health
/api/config_http=307                    /api/internal/p2/readiness_http=307
```

307 vers **la même URL**, corps `text/plain`, **sans** passage par `vercel.com/sso-api` : ce n'est ni
l'application ni la protection SSO. Le pré-vol envoyait deux en-têtes :

```
x-vercel-protection-bypass: <secret>
x-vercel-set-bypass-cookie: true
```

Documentation Vercel, « Protection Bypass for Automation » : *« This will set the authorization bypass
as a cookie using a redirect with a Set-Cookie header. »* Demander la pose du cookie **fabrique** le
307. Un `fetch` serveur n'a pas de bocal à cookies : il voit un 307 sans fin. Sur le même hôte, sans
en-tête, la sonde mesure `302 → vercel.com/sso-api` : c'est la signature d'une protection active, et
c'est aussi ce qui prouve que le secret était **présent et accepté** (un secret invalide produit un
302 SSO, pas une poignée de main).

### 1.2 La cible figée

L'URL testée était un **alias de branche** (`tracefab-git-arena-e13749-…`), qui ne désigne aucun
déploiement immuable et devient faux au commit suivant.

### 1.3 Le verrou qui empêchait toute mesure (découvert dans cette session)

```
Branch "arena/fd3fb758-tracefab" is not allowed to deploy to tracefab-clerk-test
due to environment protection rules.   (job mort en 1 s, avant la première étape)
```

`GET /environments/tracefab-clerk-test/deployment-branch-policies` → `total_count: 2` :
`main`, `arena/88857a44-tracefab`. Toute branche de travail non listée est rejetée **avant** la
première étape : aucune requête HTTP ne part, donc aucune preuve n'est productible. Le jeton
d'intégration de cette session est en lecture seule (Administration/Actions : `403 Resource not
accessible by integration`, mesuré sur POST branch-policy, rerun, dispatch). Le run d'inventaire
[`40035513385`](https://github.com/Huberaya/Tracefab/actions/runs/40035513385) est toujours en
`pending`, zéro job : c'est le « workflow en attente » du constat initial.

## 2. Corrections appliquées

| Fichier | Correction | Origine |
|---|---|---|
| `scripts/lib/preview_deployment.mjs` | `entetesBypass()` n'envoie **que** `x-vercel-protection-bypass` ; `cookieDeBypass()` en mémoire, jamais journalisé | session #93 |
| `scripts/lib/preview_surface.mjs` | poignée de main 307 rejouée **une fois, même hôte** ; causes nommées (`contournement_invalide`, `handshake_bypass_*`, `cible_obsolete`) ; hôte de destination mesuré | session #93 |
| `scripts/resolve_preview_deployment.mjs` | cible = URL immuable du déploiement Preview **du SHA testé**, via l'API GitHub des Deployments ; host de production refusé avant tout appel | session #93 |
| `.github/workflows/p1-staging-*.yml` | branche `arena/fd3fb758-tracefab` ajoutée aux déclencheurs (les trois workflows ne se déclenchaient pas sur cette branche) | **cette session** |
| `.github/workflows/p1-staging-bypass-proof.yml` | **nouveau** : mesure HTTP A/B sur l'URL du SHA — sans en-tête la protection doit intercepter (302 SSO), avec en-tête l'application doit répondre 200 JSON. Aucun environnement, aucun secret affiché ; si le secret n'est visible qu'en environnement, la passe B est refusée avec la cause nommée au lieu d'un vert trompeur | **cette session** |
| `docs/security/workflow-privileged-allowlist.json` | le nouveau workflow est déclaré au registre (portée, lecture seule, journal, fin de vie) ; listes de branches mises à jour | **cette session** |

Le périmètre applicatif n'est pas touché. Aucun test de sécurité, d'isolation ou d'identité DB n'a
été modifié. `main` est intact (`b1ae726`).

## 3. Preuves obtenues sur le SHA testé (`403a2728…`)

| # | Contrôle | Résultat | Preuve |
|---|---|---|---|
| 1 | Cible = déploiement du SHA | **PASS** | deployment `7291443275`, `state=success`, `environment_url=https://tracefab-oc2d38ap5-baya-ibraimmayoanouedu-8164s-projects.vercel.app`, `deploiement_sha=403a2728…` = `sha_teste` (vérifié aussi par API indépendante) |
| 2 | Protection Vercel toujours active (passe A, sans en-tête) | **PASS** | `/api/health`, `/api/config`, `/api/internal/p2/readiness` → `302`, `redirection_classe=sso_vercel`, `redirection_hote=vercel.com`, `redirection_chemin=/sso-api` — runs [40043716354](https://github.com/Huberaya/Tracefab/actions/runs/40043716354) et [40043716345](https://github.com/Huberaya/Tracefab/actions/runs/40043716345) |
| 3 | Passe B (avec secret) — **sur cette branche** | **BLOCKED** | `portee_secret=environnement_seulement_ou_absent` : `VERCEL_AUTOMATION_BYPASS_SECRET` n'existe qu'au niveau de l'environnement `tracefab-clerk-test`, inaccessible à `arena/fd3fb758-tracefab` (§1.3) |
| 3bis | Passe B — **preuve réelle obtenue en parallèle** | **PASS** | run [40043764425](https://github.com/Huberaya/Tracefab/actions/runs/40043764425) (branche `arena/f9effa2e-tracefab`, SHA `dbe73b7b`, déploiement `7291449688`, hôte `tracefab-erjxjapcj-…`) : pré-vol `cause=application_atteinte code=0`, `/api/health_http=200 classe=application`, `/api/config_http=200`, `config_clerk=pk_test`, `/api/internal/p2/readiness_http=401` JSON (protection applicative, attendue sans secret de sonde), `contournement_disponible=true`, correspondance SHA exacte. **Le secret est donc accepté par le projet Vercel : le bypass fonctionne.** |
| 3ter | Provisioning des 3 sessions Clerk | **FAIL** | même run, étape « Préparer les trois sessions Clerk de test » : exit 1 en ~49 s, après une inspection réussie. Le journal détaillé n'est pas téléchargeable depuis ce bac à sable (hôte de logs injoignable, mesuré) : la cause exacte (formulaire de connexion, stratégie Clerk, compte refusé) doit être lue dans le journal du job 120720616272. Aucune hypothèse n'est présentée comme un fait. |
| 4 | Bypass « présent ≠ prouvé » | **levé comme ambiguïté** | la présence dans l'environnement est attestée (runs 40035513421 : `secret_bypass=present`, `secret_clerk=present`) ; l'acceptation par Vercel était déjà démontrée par la poignée de main 307 (§1.1) ; seul le 200 final reste à mesurer |
| 5 | Tests locaux | **PASS** | `test:workflow-policy` OK (nouveau workflow validé : secrets déclarés, actions épinglées par SHA) · `test:p1-harness` OK · `test:p1:preview-deployment` 19/19 · `test:sonde-preview` 18 assertions |
| 6 | Exécution authentifiée / Clerk / isolation / identité DB | **NOT RUN** | jobs rejetés en 1 s par la politique de branche : runs [40043716325](https://github.com/Huberaya/Tracefab/actions/runs/40043716325), [40043716439](https://github.com/Huberaya/Tracefab/actions/runs/40043716439) |
| 7 | App Vercel connectée à la conversation | **NOT RUN** | `list_projects` → « Access denied » : le jeton du connecteur n'a pas la portée requise ; aucune lecture ni écriture effectuée |
| 8 | Production | **intacte** | aucun déploiement `Production` créé ; `main` inchangé ; aucune protection abaissée, aucun secret divulgué |

### Ce que la suite authentifiée exécutera (déjà écrite, inchangée)

- sessions Clerk de test (marque A, fournisseur, marque B) via l'API Clerk, clé `sk_test_` exigée ;
- import catalogue (dry-run), validation BOM sans persistance ;
- isolation inter-organisations sur **4 plans** : resolveur de locataire (refus
  `organization_not_found`, zéro ligne, aucune référence fuie), politiques RLS sur route sans
  resolveur (0 ligne étrangère, contrôle positif par contenu), lectures JSON bornées, écritures W1–W3
  (`brand_organization_mismatch` 400, `organization_not_found` 404, `brand_organization_access_denied` 403) ;
- sonde d'identité DB runtime : `current_user`, `session_user`, `rolsuper=false`, `rolbypassrls=false`.

## 4. Actions restantes (dans l'ordre)

1. **Lire la cause de l'échec Clerk** (propriétaire ou session autorisée) : page du run
   [40043764425](https://github.com/Huberaya/Tracefab/actions/runs/40043764425), job
   `120720616272`, étape « Préparer les trois sessions Clerk de test » — la première ligne d'erreur
   nomme la cause (délai d'attente du champ identifiant/mot de passe, stratégie de connexion de
   l'instance de test, ou refus de création de compte/organisation). Relancer ensuite le workflow
   authentifié sur `arena/f9effa2e-tracefab` (déjà autorisée) : les étapes suivantes — suite
   d'isolation 4 plans et sonde d'identité DB — n'ont **jamais encore tourné**.
2. **Pour cette branche-ci** (si on veut les preuves sur son SHA) : Settings → Environments →
   `tracefab-clerk-test` → « Deployment branches and tags » → Add rule → `arena/fd3fb758-tracefab`
   (ou `arena/*`), puis approuver le run. Vérification :
   `gh api repos/Huberaya/Tracefab/environments/tracefab-clerk-test/deployment-branch-policies`
   doit faire apparaître la branche (état actuel mesuré : `main`, `arena/88857a44-tracefab`,
   `arena/f9effa2e-tracefab`).

## 5. Sécurité — confirmations explicites

- Aucune valeur de secret lue, affichée, comparée, commitée ou transmise (présences seules).
- Protection SSO Vercel **non désactivée** : prouvée active sur le SHA testé (passe A).
- Aucun secret de production touché, aucune base de production jointe, `main` non modifié.
- PR laissée ouverte, aucune fusion, aucun déploiement en production.
