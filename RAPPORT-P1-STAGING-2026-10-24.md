# P1 — workflow staging authentifié : diagnostic, correction, état vérifiable

**Date** : 2026-10-24 · **Branche** : `arena/f9effa2e-tracefab` · **PR** : [#93](https://github.com/Huberaya/Tracefab/pull/93)
**SHA final** : `b0200bca27ac5d68c37a8854ee689df4b15ef390`

> Statut : **correction terminée et éprouvée hors ligne + CI verte** ;
> **exécution authentifiée BLOCKED** par une seule règle d'environnement GitHub
> que le jeton d'intégration ne peut pas modifier (§6). Aucun test n'a été
> supprimé, assoupli ni transformé en succès artificiel.

---

## 1. Cause racine, mesurée

Extrait **expurgé** de l'annotation du run
[`40035513421`](https://github.com/Huberaya/Tracefab/actions/runs/40035513421),
étape `Pre-vol — la Preview repond-elle comme l application ?` → `failure`,
`Process completed with exit code 5` :

```
preview_hote=tracefab-git-arena-e13749-baya-ibraimmayoanouedu-8164s-projects.vercel.app
/api/health_http=307
/api/health_classe=inconnue
/api/health_content_type=text/plain
/api/health_redirection_chemin=/api/health
/api/config_http=307
/api/config_redirection_chemin=/api/config
/api/internal/p2/readiness_http=307
/api/internal/p2/readiness_redirection_chemin=/api/internal/p2/readiness
```

Deux défauts se cumulaient.

### 1.1 L'en-tête qui fabriquait le 307

Le pré-vol envoyait **deux** en-têtes :

```
x-vercel-protection-bypass: <secret>
x-vercel-set-bypass-cookie: true
```

La documentation Vercel (« Protection Bypass for Automation », configuration
avancée) décrit le second ainsi : *« This will set the authorization bypass as a
cookie using a redirect with a Set-Cookie header. »*

Autrement dit, demander la pose du cookie **fait répondre 307 vers la même
URL**. Un `fetch` serveur n'a pas de bocal à cookies : il voit un 307 qu'il ne
peut pas terminer. La sonde classait alors la réponse `inconnue` et sortait en
code 5 — d'où l'unique message `exit code 5`.

**Ce que cela prouve aussi** : le secret de contournement était *présent et
accepté*. Sur le **même hôte**, sans en-tête, la même sonde mesure
`302 → vercel.com/sso-api` (§4, run 40039268014) ; avec l'en-tête, elle obtient
un 307 de poignée de main et non un 302 SSO. Un secret invalide produit un 302
SSO, pas une poignée de main.

### 1.2 La cible figée

L'URL testée était un **alias de branche** codé en dur
(`tracefab-git-arena-e13749-…`) : elle ne désigne aucun déploiement immuable et
devient fausse à chaque commit. Le déploiement du commit `50e7070` est
`tracefab-7xgup5zjo-…` (`deployment 7290360970`, `success`).

---

## 2. Corrections apportées

| Fichier | Correction |
|---|---|
| `scripts/lib/preview_deployment.mjs` | `entetesBypass()` n'envoie **plus que** `x-vercel-protection-bypass` ; ajout de `cookieDeBypass()` (extraction en mémoire, jamais journalisée) ; justification de l'en-tête unique dans le code |
| `scripts/lib/preview_surface.mjs` | une **poignée de main rejouée une fois**, sur le même hôte, avec le cookie renvoyé si Vercel répond 307/308 vers la même URL ; le corps exploité devient celui de la réponse finale ; deux causes nommées `handshake_bypass_sans_cookie` et `handshake_bypass_non_abouti` ; le secret ne sort toujours pas du domaine cible |
| `scripts/test_preview_deployment_selection.mjs` | 3 contrôles nouveaux : en-tête unique, poignée de main rejouée (200 applicatif, cookie jamais publié), poignée de main sans cookie nommée |
| `.github/workflows/p1-staging-authenticated.yml` | déclenchement `push` aussi sur la branche de travail `arena/f9effa2e-tracefab` |
| `.github/workflows/p1-staging-surface.yml`, `p1-staging-inventaire.yml` | même ajout de branche |
| `docs/operations/p1-staging-execution.md` | cause racine du 307, deux causes nouvelles, politique de branche comme **prérequis vérifiable** avec commande `gh api` et état attendu à 3 entrées |
| `docs/security/workflow-privileged-allowlist.json` | portée et branches de déploiement mises à jour (JSON valide) |

Aucun test de sécurité, d'isolation multi-organisation ou d'identité de rôle DB
n'a été modifié ni affaibli. Aucune URL de production n'est atteignable : la
cible est refusée en amont (`hote_de_production_interdit`, `parametres_dans_url`,
`hote_hors_du_projet`).

---

## 3. Résultats des vérifications

| # | Vérification | Résultat | Preuve |
|---|---|---|---|
| 1 | `npm run test:p1:preview-deployment` | **PASS** — 19/19 | 3 contrôles nouveaux sur les en-têtes et la poignée de main |
| 2 | `npm run test:p1-harness` | **PASS** | 73 assertions |
| 3 | `npm run test:sonde-preview` | **PASS** — 18 assertions | aucune valeur de contournement en sortie |
| 4 | `npm run test:workflow-policy` / `-temoins` | **PASS** | politique des 9 workflows après ajout de branche |
| 5 | Résolution réelle du déploiement du SHA (API GitHub, sans jeton Vercel) | **PASS** | `deployment 7290863463`, `sha=f2c6c561667154ba60fb4ee6551797512c253abf`, `etat=success`, `hote=tracefab-gis2uju5m-…`, `correspondance_sha=exacte`, `url_source=deploiement_du_sha` |
| 6 | Le déploiement du SHA est bien protégé (aucune protection désactivée) | **PASS** | `GET /api/health` sans en-tête → page `Protected Deployment – Vercel` (`vercel.com/login` → `sso-api`) |
| 7 | CI sur le SHA final `b0200bc` | **PASS** | [run 40040533330](https://github.com/Huberaya/Tracefab/actions/runs/40040533330) — 4/4 jobs `success` (socle, suite de tests, parcours navigateur, isolation RLS) |
| 8 | CI sur `f2c6c56` | **PASS** | [run 40039417150](https://github.com/Huberaya/Tracefab/actions/runs/40039417150) — 4/4 `success` |
| 9 | Diagnostic de surface sur le SHA final | **PASS** (mesure) | [run 40040533407](https://github.com/Huberaya/Tracefab/actions/runs/40040533407) / [40040528054](https://github.com/Huberaya/Tracefab/actions/runs/40040528054) |
| 10 | `p1-staging-authenticated.yml` | **BLOCKED** | [run 40040528026](https://github.com/Huberaya/Tracefab/actions/runs/40040528026) — rejeté **avant la première étape** |
| 11 | Tests Clerk réels, isolation inter-organisations exécutée, sonde d'identité DB | **NOT RUN** | dépendent de 10 |
| 12 | `main` et production | **intacts** | `origin/main` = `b1ae726` (inchangé) ; aucun déploiement `Production` créé depuis le 2026-10-23T00:10 |

### 3.1 Ce que le diagnostic de surface mesure (sans secret)

Sur les URL **immuables** des déploiements récents, sans en-tête :

```
/api/health_http=302
/api/health_redirection_classe=sso_vercel
/api/health_redirection_hote=vercel.com
/api/health_redirection_chemin=/sso-api
/api/health_redirection_parametres=nonce,url
cause=contournement_absent
```

La protection Vercel est donc bien active : le contournement reste nécessaire,
et il n'a pas été désactivé. Avec le correctif, deux issues seulement sont
possibles au pré-vol, et toutes deux sont **nommées** :

- `200` applicatif → `application_atteinte` (code 0) ;
- `302 → vercel.com/sso-api` malgré le secret → `contournement_invalide`
  (code 5), qui demande la régénération du secret dans le projet Vercel ;
- `307` même URL → poignée de main rejouée, et si elle échoue,
  `handshake_bypass_*` (code 5) avec l'action exacte.

Plus aucun `exit code 5` opaque n'est possible sans cause nommée et annotée.

---

## 4. Ce qui est encore bloqué, et l'action exacte

Le job authentifié meurt **avant sa première étape** :

```
Branch "arena/f9effa2e-tracefab" is not allowed to deploy to tracefab-clerk-test
due to environment protection rules.
The deployment was rejected or didn't satisfy other protection rules.
```

Mesures :

| Fait | Résultat |
|---|---|
| `GET /environments/tracefab-clerk-test/deployment-branch-policies` | `total_count: 2` — `main`, `arena/88857a44-tracefab` |
| ajouter la branche de travail (API) | `403 Resource not accessible by integration` |
| `workflow_dispatch` sur la branche | `403 Resource not accessible by integration` |
| relancer le run (`rerun`) | `403 Resource not accessible by integration` |

**Action humaine (une seule, propriétaire)** — *Settings* → *Environments* →
`tracefab-clerk-test` → *Deployment branches and tags* → *Add deployment branch
or tag rule* → saisir exactement `arena/f9effa2e-tracefab` (ou le motif
`arena/*`, qui couvre les sessions suivantes) → *Add rule*.

Vérification immédiate, sans interface :

```bash
gh api repos/Huberaya/Tracefab/environments/tracefab-clerk-test/deployment-branch-policies \
  --jq '.total_count, (.branch_policies[]?.name)'
# attendu : 3
#   main
#   arena/88857a44-tracefab
#   arena/f9effa2e-tracefab
```

Dès que la règle est enregistrée, un push sur la branche déclenche le workflow ;
l'approbation de l'environnement est accordée depuis la page du run
(`prevent_self_review` est décoché temporairement, cf. registre des workflows
privilégiés — à recocher en fin de campagne).

---

## 5. Sécurité — confirmations explicites

- Aucun secret n'a été lu, affiché, comparé, commité ni transmis : seules des
  **présences** (`secret_bypass=present`, `secret_clerk=present`) figurent dans
  les journaux, et l'absence de lecture est structurelle (listes de secrets en
  `403`, aucune valeur manipulée).
- Le cookie de contournement, lorsqu'il est renvoyé, reste **en mémoire** : il
  n'apparaît dans aucune mesure publiée (contrôle dédié dans le test 19/19).
- Aucune protection Vercel n'a été désactivée, aucun réglage de sécurité retiré.
- `main` n'a pas été touché (`origin/main` = `b1ae726`), aucun déploiement de
  production n'a été créé, aucune base Neon n'a été jointe ni modifiée.
- Aucun test supprimé, aucune assertion assouplie : les contrôles de sécurité,
  d'isolation multi-organisation et d'identité de rôle DB sont intacts.

---

## 6. Note de coordination

Une autre session a produit sur `arena/f54fad73-tracefab` le commit `22c3be0`
(rapport §10) qui attribue le 307 à la seule re-canonicalisation d'alias. La
mesure du §1.1 ci-dessus est plus précise : sur le **même hôte**, l'absence
d'en-tête donne 302 SSO et la présence d'en-tête donne 307 ; l'en-tête
`x-vercel-set-bypass-cookie` suffit à produire le 307. Les deux corrections
(cible résolue par SHA, mesure de l'hôte de destination) restent nécessaires et
sont conservées ; celle de ce rapport s'y ajoute.
