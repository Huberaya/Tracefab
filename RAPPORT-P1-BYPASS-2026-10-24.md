# P1 staging — déblocage du bypass Vercel : cause racine, correctif, preuves, blocage résiduel

**Date** : 2026-10-24 · **Branche** : `arena/fd3fb758-tracefab`
**Commit code** : `403a2728d5572af15d34a8c1f0df338ef702c5d6` (le SHA final est la tête de branche ; les
preuves ci-dessous portent sur ce commit code et sont revérifiées sur le SHA final par la CI de PR)
**PRs** : #91 (historique), #92, #93 (sessions précédentes), nouvelle PR de cette branche (laissée ouverte)

> **Statut : P1 NON clôturé.** Le bypass est réparé côté client et son échec passé est expliqué et
> prouvé ; la protection Vercel est confirmée active sur le SHA testé ; mais la passe « avec secret »
> n'a pas encore pu être exécutée, faute d'une règle de politique de branche GitHub que seul le
> propriétaire peut ajouter. Aucun test n'a été supprimé, assoupli ou transformé en succès.

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
| 3 | Passe B (avec secret) | **BLOCKED** | `portee_secret=environnement_seulement_ou_absent` : `VERCEL_AUTOMATION_BYPASS_SECRET` n'existe qu'au niveau de l'environnement `tracefab-clerk-test`, inaccessible à cette branche (§1.3) |
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

## 4. Action manuelle restante (une seule, propriétaire)

**GitHub → `Huberaya/Tracefab` → Settings → Environments → `tracefab-clerk-test` →
« Deployment branches and tags » → Add rule → `arena/fd3fb758-tracefab`** (ou le motif `arena/*`,
qui couvre les sessions suivantes), puis approuver le déploiement du run authentifié
(bouton « Review deployments » sur la page du run ; `prevent_self_review` est actuellement décoché).

Vérification : `gh api repos/Huberaya/Tracefab/environments/tracefab-clerk-test/deployment-branch-policies`
doit passer de `total_count: 2` à `3`. Un push sur la branche relance alors les trois workflows, et
la suite complète s'exécute sans autre modification de code.

## 5. Sécurité — confirmations explicites

- Aucune valeur de secret lue, affichée, comparée, commitée ou transmise (présences seules).
- Protection SSO Vercel **non désactivée** : prouvée active sur le SHA testé (passe A).
- Aucun secret de production touché, aucune base de production jointe, `main` non modifié.
- PR laissée ouverte, aucune fusion, aucun déploiement en production.
