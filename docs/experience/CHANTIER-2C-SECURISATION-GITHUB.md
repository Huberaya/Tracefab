# Chantier 2C — Phase 1 : audit et sécurisation GitHub

Date : 2026-10-10. Branche : `arena/91844ee9-tracefab`. PR #34. Phase 1 uniquement : aucune modification de workflow, aucun réglage GitHub, aucune base de données touchée, aucun déploiement.

Légende des statuts : **VÉRIFIÉ** (constaté maintenant par une commande), **HISTORIQUE** (repris d'un rapport précédent, non revérifié), **NON VÉRIFIABLE** (accès refusé ou inexistant).

---

## 1. Résumé exécutif

- Le dépôt est propre et aligné : HEAD local = HEAD distant = `d06fe79`. La PR #34 est ouverte, mergeable, non brouillon, sans revue.
- Les quatre checks attendus sont verts sur `d06fe79` (`Socle`, `Parcours`, `Base`, `Verification`). Ils ne sont **pas** configurés comme checks requis, car `main` n'est pas protégée.
- **Constat P0 : le workflow CI contient une étape qui exécute des scénarios d'écriture sur la base référencée par `secrets.DATABASE_URL`, sans environnement protégé.** Elle se déclenche sur tout push, sur `workflow_dispatch` et sur les pull requests du même dépôt. Un contributeur ayant le droit d'écriture peut modifier le workflow sur sa branche et lire ce secret. Cette étape doit être retirée de la CI.
- **Constat P0 : la branche `main` n'est pas protégée** (`protected: false`, lu via l'API). Tout contributeur ayant le droit d'écriture peut pousser directement sur `main` et contourner la CI.
- L'environnement `Production` n'a ni approbateur, ni restriction de branche, et les administrateurs peuvent le contourner.
- Trois actions tierces sont référencées par tag flottant majeur (`@v4`) et non par SHA. Les SHA correspondant aux dernières versions `v4.x` ont été vérifiés.
- Les paramètres Actions du dépôt, les règles de protection (API), les noms des secrets et des variables sont **non vérifiables** avec les accès actuels (HTTP 403).

---

## 2. État vérifié du dépôt et de la PR #34

| Élément | Valeur | Statut |
|---|---|---|
| Branche courante | `arena/91844ee9-tracefab` | VÉRIFIÉ (`git rev-parse --abbrev-ref HEAD`) |
| HEAD local | `d06fe79304b860b592970b0eeb996d28ffcd1a64` | VÉRIFIÉ |
| HEAD distant | `d06fe79304b860b592970b0eeb996d28ffcd1a64` | VÉRIFIÉ (`git fetch`, `ls-remote`) |
| Arbre de travail | 0 ligne de `git status --porcelain` | VÉRIFIÉ |
| Index | vide | VÉRIFIÉ |
| Stash | 0 | VÉRIFIÉ |
| PR #34 | ouverte, non brouillon, `MERGEABLE`, `reviewDecision` vide (aucune revue) | VÉRIFIÉ (`gh pr view 34`) |
| Head de la PR | `d06fe79` | VÉRIFIÉ |
| Historique de la branche | 244 commits ; 19 commits du remote absents de l'ancien HEAD local, réalignés | VÉRIFIÉ |

### Derniers résultats CI (commit exact)

| Commit | Run | Job | Résultat |
|---|---|---|---|
| `d06fe79` | 38040348069 | Socle — types, compilation, isolation | success |
| `d06fe79` | 38040348069 | Parcours — navigateur reel | success |
| `d06fe79` | 38040348069 | Verification — suite de tests | success |
| `d06fe79` | 38040348069 | Base — isolation RLS executee | success |
| `d06fe79` | 38040345604 | (second run, même commit) | success |
| `f57e0b0` | 38007702987 | CI | success |
| `675e5a4` | 38007642377 / 38007645870 | CI | cancelled (annulés par une poussée plus récente, `concurrency`) |

**Noms exacts des checks publiés par GitHub** (à utiliser dans une règle de protection) : ce sont les champs `name:` des jobs, et non les identifiants courts :

- `Socle — types, compilation, isolation`
- `Verification — suite de tests`
- `Parcours — navigateur reel`
- `Base — isolation RLS executee`

Le check `Vercel` et `Vercel Preview Comments` existent aussi sur la PR, mais ne sont pas des contrôles CI du dépôt. Ne pas les inclure parmi les checks requis sans décision du propriétaire.

Le run `figer-reference-visuelle` le plus récent est `37999615510` (poussée sur `1016f97`, succès). Il ne concerne pas `d06fe79`.

---

## 3. Audit des workflows

### 3.1 `ci.yml` — « CI »

| Élément | Constat | Statut |
|---|---|---|
| Déclencheurs | `push` sur `**` (toutes les branches), `pull_request`, `workflow_dispatch` | VÉRIFIÉ |
| Permissions workflow | `contents: read` | VÉRIFIÉ |
| Permissions de job | aucune (héritent du niveau workflow) | VÉRIFIÉ |
| `environment:` | aucun job rattaché à un environnement | VÉRIFIÉ |
| Secrets utilisés | `secrets.DATABASE_URL` uniquement, aux lignes 258 et 324 | VÉRIFIÉ |
| Actions tierces | `actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4` | VÉRIFIÉ |
| Écriture | aucune écriture dans le dépôt ; `upload-artifact` (captures d'échec) | VÉRIFIÉ |
| Concurrence | `group: ci-${{ github.ref }}`, `cancel-in-progress: true` | VÉRIFIÉ |

**Étape à risque** (ligne 319 et suivantes) : `Scenarios croises contre la base de production`.

- Condition : `if: ${{ env.TF_SECRET_PRODUCTION != '' }}`, où `TF_SECRET_PRODUCTION` reçoit `secrets.DATABASE_URL` au niveau du job (ligne 258).
- Elle exécute `test:neon:security`, `test:neon:supplier`, `test:neon:product`, `test:neon:quality`, `test:neon:collection`.
- Le commentaire du workflow indique que la base visée est la base de production.
- Vérifié dans le code : `test_neon_security.mjs` et `test_neon_product_flow.mjs` exécutent des `UPDATE`, des `DROP ROLE IF EXISTS` ; `test_neon_quality_flow.mjs` crée des utilisateurs, organisations et fournisseurs (`createMany`, `create`) ; `test_neon_supplier_flow.mjs` et `test_neon_data_collection_flow.mjs` créent des données. Aucun ne nettoie après lui.
- Le commentaire de l'étape (« Optionnels ») et le commentaire du job (« Ce job ne depend plus d'aucun secret ») se contredisent.

**Pourquoi c'est P0** : le secret est exposé à tout run de ce workflow sur n'importe quelle branche. Un contributeur ayant le droit d'écriture peut modifier `ci.yml` ou un script `test_neon_*.mjs` sur sa branche (le workflow exécuté est celui de la branche) pour afficher la variable. Aucun environnement, aucune approbation ne protège ce secret.

Le secret est-il effectivement présent ? **NON VÉRIFIABLE** (`gh secret list` renvoie 403). Le workflow est cependant conçu pour l'exécuter dès qu'il existe.

### 3.2 `figer-reference-visuelle.yml` — « Figer la reference visuelle »

| Élément | Constat | Statut |
|---|---|---|
| Déclencheurs | `workflow_dispatch`, `push` limité au chemin `tests/regression/reference/.figer` (sur toute branche) | VÉRIFIÉ |
| Permissions workflow | `contents: write` | VÉRIFIÉ |
| Permissions de job | aucune (un seul job `figer`) | VÉRIFIÉ |
| Secrets | aucun (seul `GITHUB_TOKEN` implicite) | VÉRIFIÉ |
| Écriture | `git push` vers la branche qui a déclenché le workflow, via `GITHUB_TOKEN` | VÉRIFIÉ |
| Code exécuté | le code de la branche (`npm ci`, scripts de test) s'exécute avec un jeton en écriture | VÉRIFIÉ |
| Actions tierces | `actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4` | VÉRIFIÉ |

**L'écriture est-elle indispensable ?** Oui, dans la conception actuelle : le workflow régénère les références et les pousse sur la branche, ce qui est sa seule fonction. Le retirer supprimerait la fonctionnalité, ce qui n'est pas demandé. Le risque est le suivant : un contributeur ayant le droit d'écriture peut pousser un changement du `.figer` sur n'importe quelle branche et exécuter son propre code avec `contents: write`.

Ce risque n'est pas une élévation de privilège au-delà des droits d'écriture déjà accordés. Il devient un vrai problème uniquement si `main` n'est pas protégée, ce qui est le cas (voir section 5). La correction prioritaire est donc la protection de `main`, et non une modification du workflow. Les options de durcissement sont listées en section 7.

### 3.3 Réglages Actions du dépôt

| Réglage | Statut |
|---|---|
| Permissions par défaut du `GITHUB_TOKEN` (lecture seule ou écriture) | NON VÉRIFIABLE (403 sur `/actions/permissions/workflow`) |
| Actions autorisées (GitHub uniquement / vérifiées / toutes) | NON VÉRIFIABLE (403 sur `/actions/permissions`) |
| Approbation requise pour les workflows des contributeurs externes | NON VÉRIFIABLE |
| Variables Actions du dépôt | NON VÉRIFIABLE (403) |
| Secrets du dépôt et des environnements | NON VÉRIFIABLE (403) |

Le dépôt est **public** (`visibility: public`) et `allow_forking: true`. Les pull requests de fork ne reçoivent pas les secrets par défaut, mais ce comportement dépend des réglages Actions non vérifiables.

---

## 4. Actions tierces : épinglage par SHA

Toutes les actions tierces utilisées (12 usages sur 2 workflows) :

| Action | Référence actuelle | Usages |
|---|---|---|
| `actions/checkout` | `@v4` (tag majeur flottant) | 5 |
| `actions/setup-node` | `@v4` (tag majeur flottant) | 5 |
| `actions/upload-artifact` | `@v4` (tag majeur flottant) | 2 |

Aucune autre action tierce n'est utilisée. Les commandes `npx playwright install` et `npm ci` ne sont pas des actions GitHub.

### SHA vérifiés (API GitHub, commandes ci-dessous)

| Action | Version cible | SHA complet | Type de l'objet | Vérification |
|---|---|---|---|---|
| `actions/checkout` | v4.4.0 | `11d5960a326750d5838078e36cf38b85af677262` | commit | `gh api repos/actions/checkout/git/ref/tags/v4.4.0` ; tag `v4` pointe vers le même SHA |
| `actions/setup-node` | v4.4.0 | `49933ea5288caeca8642d1e84afbd3f7d6820020` | commit | `gh api repos/actions/setup-node/git/ref/tags/v4.4.0` ; tag `v4` pointe vers le même SHA |
| `actions/upload-artifact` | v4.6.2 | `ea165f8d65b6e75b540449e92b4886f43607fa02` | commit | `gh api repos/actions/upload-artifact/git/ref/tags/v4.6.2` ; tag `v4` pointe vers le même SHA |

Les versions `v4.x.y` ont été choisies comme dernière patch disponible de la même majeure : le changement est minimal et ne saute aucune version majeure. Le SHA n'a pas été déduit : il provient directement du tag publié.

**Limite** : la vérification du SHA se fait par l'API GitHub (type et correspondance avec le tag). Elle ne remplace pas une revue du code de chaque action à cette version.

---

## 5. Protections de `main`

| Contrôle | Statut | Preuve |
|---|---|---|
| `main` protégée | **NON** | `gh api repos/Huberaya/Tracefab/branches/main` → `"protected": false` (VÉRIFIÉ) |
| Règles de protection détaillées (PR obligatoire, checks, pas de push direct) | NON VÉRIFIABLE | `gh api repos/.../branches/main/protection` → 403 |
| Rulesets du dépôt | liste vide, sans erreur (VÉRIFIÉ) — à confirmer dans l'interface, car la lecture des rulesets peut dépendre des droits | `gh api repos/.../rulesets` |
| Checks requis configurés | NON (la protection n'existe pas) | VÉRIFIÉ |
| Contournement par les administrateurs | NON VÉRIFIABLE | — |

**Conclusion** : `main` peut recevoir un push direct de tout contributeur ayant le droit d'écriture, sans PR, sans revue et sans CI verte. Ce point est un P0 mesuré, et non une hypothèse.

### Étapes manuelles du propriétaire (Settings → Rules → Rulesets → New branch ruleset)

1. Nom : `protection-main`. Enforcement : **Active**. Cible : branche par défaut (`main`).
2. Restrictions de branche :
   - *Restrict deletions* : activé ;
   - *Block force pushes* : activé ;
   - *Require linear history* : activé, si le projet utilise uniquement le merge par squash ou rebase (à décider).
3. *Require a pull request before merging* : activé.
   - Required approvals : 1 (au moins une personne autre que l'auteur, si l'équipe le permet ; sinon 0, mais alors noter le risque) ;
   - *Dismiss stale pull request approvals when new commits are pushed* : activé ;
   - *Require conversation resolution before merging* : activé (recommandé).
4. *Require status checks to pass* : activé. Ajouter **exactement** ces quatre checks :
   - `Socle — types, compilation, isolation`
   - `Verification — suite de tests`
   - `Parcours — navigateur reel`
   - `Base — isolation RLS executee`

   Ne pas ajouter `Vercel` ni d'autres checks sans décision. Activer *Require branches to be up to date before merging* uniquement si la file de merge le permet, car cela impose un rebase avant chaque merge.
5. *Block force pushes* et *Restrict updates* : activer pour `main`.
6. Bypass list : ne rien ajouter, ou au minimum une procédure d'urgence documentée (un administrateur, avec trace dans la PR). Ne pas laisser un bot pousser directement sur `main`.
7. Vérifier après application : `gh api repos/Huberaya/Tracefab/branches/main --jq .protected` doit renvoyer `true`.

**Point de vigilance** : le workflow `figer` pousse sur la branche qui le déclenche avec `GITHUB_TOKEN`. Si `main` est protégée, une poussée automatique vers `main` devrait être refusée. Ce comportement n'est pas testé ici : il doit être vérifié après activation de la règle, avant de s'appuyer dessus.

---

## 6. Environnement `Production`

| Contrôle | Statut | Preuve |
|---|---|---|
| Existence | oui | `gh api repos/Huberaya/Tracefab/environments` (VÉRIFIÉ) |
| Relecteurs requis (approbateurs) | **AUCUN** | `protection_rules: []` (VÉRIFIÉ) |
| Empêcher l'auto-approbation | **NON** (aucun relecteur configuré) | VÉRIFIÉ |
| Restriction des branches de déploiement | **AUCUNE** (`deployment_branch_policy: null`) | VÉRIFIÉ |
| Administrateurs peuvent contourner | **OUI** (`can_admins_bypass: true`) | VÉRIFIÉ |
| Secrets de l'environnement | NON VÉRIFIABLE (403) | `gh api .../environments/Production/secrets` |
| Lien entre un job et l'environnement | **AUCUN** job du dépôt n'utilise `environment:` | VÉRIFIÉ (grep) |
| Séparation `Preview` / `Production` | existe, mais aucun job ne les distingue ; `Preview` est sans règle non plus | VÉRIFIÉ |

**Conclusion** : l'environnement `Production` existe, mais ne protège rien. Aucun workflow ne l'utilise, donc aucun déploiement ni aucun secret n'y est soumis à approbation.

### Étapes manuelles du propriétaire (Settings → Environments → Production)

1. *Required reviewers* : ajouter au moins une personne. Ne pas laisser l'auteur du déploiement comme seul approbateur.
2. *Prevent self-review* : activer.
3. *Deployment branches and tags* : *Selected branches* → `main` uniquement.
4. *Environment secrets* : y déplacer les secrets de production (dont `DATABASE_URL` de production) **et les retirer du périmètre du dépôt** si possible. Ainsi, seul un job rattaché à `environment: Production` pourra les lire après approbation.
5. Envisager de désactiver *Administrators can bypass* (le champ `can_admins_bypass`), si le projet accepte de n'avoir aucun contournement d'urgence. Décision du propriétaire, non prise ici.
6. Un job de déploiement ne doit être rattaché à `environment: Production` que dans un workflow séparé et déclenché manuellement (`workflow_dispatch`) depuis `main`.

---

## 7. Secrets et variables : état vérifiable, sans valeurs

Aucune valeur n'a été lue, affichée, copiée ni journalisée. Le statut indique seulement la vérifiabilité avec les accès actuels.

Attendus selon `.env.example` et le code (noms uniquement) :

| Variable | Environnement attendu | Utilisée dans | Statut vérifiable |
|---|---|---|---|
| `DATABASE_URL` | Preview (jetable) ; Production (interdit en CI) | CI (étape prod), scripts neon | repo : NON VÉRIFIABLE ; env : NON VÉRIFIABLE |
| `CLERK_SECRET_KEY` | Preview / Production | code API | NON VÉRIFIABLE |
| `CLERK_WEBHOOK_SIGNING_SECRET` | Preview / Production | code API | NON VÉRIFIABLE |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Preview / Production (publique) | code front | NON VÉRIFIABLE (non secret) |
| `TRACEFAB_RATE_LIMIT_SALT` | **Production** | `api/_lib/rate-limit.ts` | NON VÉRIFIABLE — absent du `.env.example` (écart documentaire) |
| `APPLE_PASS_CERTIFICATE_PEM`, `APPLE_PASS_KEY_PEM`, `APPLE_TEAM_IDENTIFIER`, `APPLE_PASS_TYPE_IDENTIFIER` | Preview / Production | `api/_lib/wallet/apple-pass-generator.ts` | NON VÉRIFIABLE — absents du `.env.example` |
| `GOOGLE_WALLET_ISSUER_ID`, `GOOGLE_WALLET_PRIVATE_KEY` | Preview / Production | `api/_lib/wallet/google-wallet-generator.ts` | NON VÉRIFIABLE — absents du `.env.example` |
| `TRACEFAB_ERROR_WEBHOOK_URL`, `TRACEFAB_ERROR_WEBHOOK_TOKEN`, `TRACEFAB_ERROR_WEBHOOK_TIMEOUT_MS` | Production | code d'erreur | NON VÉRIFIABLE — absents du `.env.example` |
| `TRACEFAB_STAGING_WORKER_SECRET`, `TRACEFAB_STAGING_URL` | Preview | scripts de staging | NON VÉRIFIABLE — absents du `.env.example` |

**Accès utilisés** : `gh secret list` (dépôt), `gh secret list --env Production|Preview`, `gh api repos/.../actions/secrets`, `gh api repos/.../environments/<env>/secrets` : tous renvoient HTTP 403. Aucune de ces variables ne doit donc être considérée comme présente ou absente.

**Présence dans l'environnement d'exécution** : aucune variable d'intégration n'est définie (vérifié par `env`, noms seulement).

**Analyse des fichiers versionnés (sans affichage de valeur)** :

- Scan `detect-secrets` (1.5.0) sur l'arbre de travail : 24 détections, toutes examinées. Elles relèvent de placeholders (`user:password@host`, `neondb_owner` avec mot de passe de 8 caractères de type placeholder), de chaînes de test (`isolation_ci_jetable`, mot de passe de service de CI jetable), d'exemples de documentation (clé `AKIA…EXAMPLE`) ou de hachages de fixtures de référence visuelle. Aucune n'a été identifiée comme un secret actif.
- Recherche de motifs dans l'historique complet (`git log --all -G`, motifs : clé privée, `sk_live_`, `pk_live_`, `whsec_`, `AKIA`, hôte Neon, `neondb_owner:` avec mot de passe) : 6 occurrences dans 4 fichiers. Elles présentent des formes fictives ou répétitives. Aucune vérification d'activité auprès des fournisseurs n'a été faite, et cette recherche par motifs n'est pas exhaustive.
- Recommandation : activer le secret scanning et la push protection du dépôt (réglage propriétaire, non vérifiable par API ici).

**Écarts documentaires** :
- Le `.env.example` ne déclare ni les variables Apple, ni Google, ni `TRACEFAB_RATE_LIMIT_SALT`, ni les variables d'erreur ou de staging. Ces variables sont pourtant lues par le code.
- Les variables `TRACEFAB_NOTIFICATION_ALERT_*` et `PRIVATE_STORAGE_*` existent dans le `.env.example` sans être toutes lues par le code (ou sous un autre nom). Cela demande une revue, et non une correction dans cette phase.

---

## 8. Risques classés

| Priorité | Risque | Preuve | Impact | Correction proposée | Action |
|---|---|---|---|---|---|
| **P0** | Étape CI qui écrit sur la base référencée par `secrets.DATABASE_URL` (commentaire : production), déclenchée sur toute branche, sans environnement | `ci.yml` lignes 258 et 319-330 ; scripts `test_neon_*` (UPDATE, DROP ROLE, création de données) | Exposition du secret et écriture sur la base cible par tout contributeur ayant le droit d'écriture | Retirer l'étape et `TF_SECRET_PRODUCTION` (diff §9.1) | **Validation requise** |
| **P0** | `main` non protégée | `protected: false` (VÉRIFIÉ) | Push direct sur `main` sans PR ni CI | Ruleset de §5 | Propriétaire |
| **P1** | Environnement `Production` sans approbateur ni restriction de branche, administrateurs contournent | §6 (VÉRIFIÉ) | Aucun garde-fou sur un futur déploiement | §6 | Propriétaire |
| **P1** | `figer-reference-visuelle` : `contents: write` avec code de branche exécuté, déclenché par un push sur toute branche | §3.2 | Un contributeur écrivant peut pousser sur la branche déclenchante | Protection de `main` (§5) ; option §9.3 | Propriétaire + validation |
| **P1** | Trois actions tierces non épinglées par SHA (12 usages) | §4 | Une version peut changer sans revue | Épinglage (§9.2) | **Validation requise** |
| **P1** | Réglages Actions non lisibles (permissions par défaut, actions autorisées, approbation des forks) | 403 | Impossible de confirmer le moindre privilège au niveau du dépôt | Vérification manuelle (§10) | Propriétaire |
| **P1** | Secrets et environnements non vérifiables | 403 | Impossible de confirmer la présence ou l'absence des secrets requis | Vérification manuelle des noms (§10) | Propriétaire |
| **P2** | Documentation contradictoire sur les secrets dans la CI (commentaires) | `ci.yml` lignes 220-230 et 318-321 | Confusion lors des revues | Corriger les commentaires avec la correction §9.1 | Avec §9.1 |
| **P2** | `.env.example` incomplet par rapport au code (Apple, Google, sel, webhooks d'erreur, staging) | §7 | Erreurs de configuration en préproduction | Compléter le fichier avec des placeholders | Revue ultérieure |
| **P2** | Dépôt public avec forks autorisés | §3.3 | Surface d'attaque élargie si les réglages Actions ne sont pas stricts | Vérifier les réglages Actions (§10) | Propriétaire |
| **P2** | Secret scanning et push protection non vérifiés | — | Un secret peut être poussé sans alerte | Activer dans *Settings → Code security* | Propriétaire |

---

## 9. Modifications proposées (non appliquées)

Aucune de ces modifications n'a été appliquée. Elles doivent être validées, puis appliquées dans un commit distinct sur `arena/91844ee9-tracefab`, avec une revue de la CI.

### 9.1 `ci.yml` — retirer l'étape d'écriture sur la base de production

**Fichier** : `.github/workflows/ci.yml`. **Lignes** : 255-258 (commentaire et variable `TF_SECRET_PRODUCTION`), puis 318-330 (étape `Scenarios croises contre la base de production`).

```diff
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -252,10 +252,6 @@ jobs:
       TF_RLS_APP_URL: postgresql://tracefab_app:isolation_ci_jetable@localhost:5432/tracefab_test
-      # Le contexte `secrets` n'est pas disponible dans un `if:` d'etape : il
-      # faut le faire transiter par l'env du job. Sans ce detour, le workflow
-      # echoue au parsing.
-      TF_SECRET_PRODUCTION: ${{ secrets.DATABASE_URL }}
     steps:
@@ -316,15 +312,4 @@ jobs:
           npm run test:neon:deploiement-publication
           ...
-
-      - name: Scenarios croises contre la base de production
-        # Optionnels, et clairement annonces comme tels. L'etancheite est deja
-        # prouvee ci-dessus sans eux.
-        if: ${{ env.TF_SECRET_PRODUCTION != '' }}
-        env:
-          DATABASE_URL: ${{ secrets.DATABASE_URL }}
-        run: |
-          npm run test:neon:security
-          npm run test:neon:supplier
-          npm run test:neon:product
-          npm run test:neon:quality
-          npm run test:neon:collection
```

Effet : `ci.yml` ne référence plus aucun secret. Les cinq suites ne seront plus exécutées nulle part dans la CI. Si elles sont jugées utiles, elles doivent être déplacées dans un workflow distinct, `workflow_dispatch` uniquement, avec `environment: Production` (approbation requise) et une base de test, et non la base de production. **Le retrait supprime une fonctionnalité de test** : il doit être décidé explicitement (les suites restent dans le dépôt, non supprimées).

Tests de contrôle après application : `npm run test:neon:rls`, `test:neon:dpp-provenance`, `test:neon:auth-provisioning`, `test:neon:deploiement-publication` restent dans le job `Base` et doivent rester verts. Les lignes de test ne doivent pas être modifiées.

Le diff ci-dessus est **illustratif** : les en-têtes de hunks (`@@`) et le contexte doivent être régénérés à partir du fichier réel, puis vérifiés avec `git apply --check` avant toute application. Ne pas l'appliquer tel quel.

### 9.2 Épinglage des actions par SHA

Remplacements (même version fonctionnelle, SHA vérifiés en §4) :

```diff
- uses: actions/checkout@v4
+ uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0

- uses: actions/setup-node@v4
+ uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0

- uses: actions/upload-artifact@v4
+ uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
```

Occurrences à remplacer (12 au total) : `actions/checkout` 5 fois, `actions/setup-node` 5 fois, `actions/upload-artifact` 2 fois, réparties entre `ci.yml` et `figer-reference-visuelle.yml`. Liste exacte : `grep -n "uses: " .github/workflows/*.yml`. Après remplacement, aucun `@v4` ne doit subsister.

Ce changement ne modifie aucun comportement fonctionnel. Il doit être testé par une exécution complète de la CI avant d'être considéré comme valide.

### 9.3 `figer-reference-visuelle.yml` — durcissement optionnel

Le workflow garde `contents: write`, nécessaire à sa fonction. Deux options, à décider par le propriétaire :

- **Option A (recommandée)** : garder le fonctionnement actuel, et compter sur la protection de `main` (§5) et sur le fait qu'un push du bot devrait être refusé sur une branche protégée (à vérifier après activation).
- **Option B** : restreindre le déclenchement à `workflow_dispatch` sur `main`, et supprimer le déclencheur par chemin `.figer`. Cela casse le workflow de figeage par branche, documenté dans le fichier lui-même. Décision produit, non prise ici.

Ne pas ajouter de condition `if: github.actor == ...` : une telle condition est facilement contournable et donne un faux sentiment de sécurité.

---

## 10. Opérations nécessitant une action manuelle du propriétaire

Ordre de priorité :

1. **Protéger `main`** (ruleset, §5). Ajouter exactement les quatre checks dont les noms sont donnés en §2.
2. **Approuver ou refuser l'étape CI d'écriture sur la base de production** (§9.1). Décision explicite à prendre.
3. **Configurer l'environnement `Production`** (§6) : relecteurs, prévention de l'auto-approbation, branche `main` uniquement, secrets de production déplacés dans l'environnement.
4. **Vérifier les réglages Actions** (interface *Settings → Actions → General*) :
   - permissions du `GITHUB_TOKEN` : *Read repository contents permission* par défaut ;
   - actions autorisées : *Allow select actions* avec les actions de GitHub, ou épinglage imposé par SHA ;
   - approbation requise pour les workflows des contributeurs externes.
5. **Vérifier les secrets** : dans *Settings → Secrets and variables → Actions*, lire **uniquement les noms**, et comparer avec la liste de §7. Le propriétaire doit confirmer s'il existe un secret `DATABASE_URL` au niveau du dépôt, et si oui, pour quelle base.
6. **Activer le secret scanning et la push protection** (*Settings → Code security*).
7. **Appliquer l'épinglage par SHA** (§9.2), après validation.
8. **Décider du sort des suites `test:neon:*` de production** (§9.1), sans les supprimer du dépôt.

Ne jamais coller de valeur de secret dans le chat, dans le dépôt ou dans les logs.

---

## 11. Preuves, commandes et limites

### Commandes exécutées (lecture seule)

```text
git rev-parse --abbrev-ref HEAD ; git rev-parse HEAD ; git rev-parse origin/arena/91844ee9-tracefab
git status --porcelain ; git stash list ; git diff --cached --name-only
gh pr view 34 --json number,state,headRefOid,mergeable,reviewDecision
gh pr checks 34
gh api repos/Huberaya/Tracefab/commits/d06fe793.../check-runs
gh run list --branch arena/91844ee9-tracefab ; gh run view 38040348069 --json jobs
gh workflow list ; gh run list --workflow figer-reference-visuelle.yml
gh api repos/Huberaya/Tracefab/branches/main                      -> protected: false
gh api repos/Huberaya/Tracefab/branches/main/protection           -> 403
gh api repos/Huberaya/Tracefab/rulesets                            -> liste vide
gh api repos/Huberaya/Tracefab/environments                        -> Preview, Production
gh api repos/Huberaya/Tracefab/environments/Production             -> protection_rules: [], deployment_branch_policy: null, can_admins_bypass: true
gh api repos/Huberaya/Tracefab/actions/secrets                     -> 403
gh api repos/Huberaya/Tracefab/actions/variables                   -> 403
gh api repos/Huberaya/Tracefab/actions/permissions                 -> 403
gh api repos/Huberaya/Tracefab/actions/permissions/workflow        -> 403
gh api repos/actions/checkout/git/ref/tags/v4.4.0                  -> commit 11d5960a…
gh api repos/actions/setup-node/git/ref/tags/v4.4.0                -> commit 49933ea5…
gh api repos/actions/upload-artifact/git/ref/tags/v4.6.2           -> commit ea165f8d…
grep -n "uses: \|secrets\.\|environment:" .github/workflows/*.yml
detect-secrets scan --all-files (environnement virtuel temporaire /tmp, version 1.5.0)
git log --all -G<motif> -E (motifs de secrets ; sortie limitée aux noms de fichiers et de commits)
```

### Limites

- Les accès GitHub de cette session ne permettent pas de lire les réglages Actions, les secrets, les variables, ni la protection de branche détaillée (403). Ces points sont **non vérifiables**, et non absents.
- Le détecteur de secrets et la recherche par motifs ne sont pas exhaustifs. Aucune vérification d'activité auprès des fournisseurs n'a été faite.
- Les journaux des jobs CI ne sont pas lisibles (seules les annotations sont accessibles). Les résultats CI proviennent des états des checks et des runs, non de leur contenu.
- Les SHA ont été vérifiés par l'API GitHub, non par une revue du code des actions.
- Aucun test de la CI n'a été relancé dans cette phase : aucune modification de code n'a été faite. Les tests verts cités sont ceux de `d06fe79`.
- Le rapport ne déclare pas le dépôt sécurisé : `main` n'est pas protégée et l'environnement `Production` ne l'est pas non plus.
