# Chantier 2C.2 — Protection de `main`, audit de `DATABASE_URL`, préparation des tests Neon isolés

Date : 2026-10-10. Branche : `arena/91844ee9-tracefab`. PR #34 : ouverte, non fusionnée.

Aucune modification de code fonctionnel, de workflow, de paramètre GitHub, de secret ou de base de données. Aucun workflow Neon créé. Aucune suite `test:neon:*` exécutée sur une base distante.

Légende : **VÉRIFIÉ** (constaté par une commande ou un run consulté ce jour), **NON VÉRIFIABLE** (accès refusé ou inexistant), **HISTORIQUE** (repris d'un rapport antérieur, non revérifié).

---

## 1. Résumé exécutif

1. **Le correctif 2C.1 n'est pas sur `main`.** `origin/main` (`b0c976f`) contient toujours l'étape `Scenarios croises contre la base de production`, avec `secrets.DATABASE_URL`. Le correctif (`326c3ae`) n'existe que sur la branche de travail, et il ne sera effectif sur `main` qu'après fusion de la PR #34, non autorisée à ce stade.
2. **L'étape destructrice n'a pas été exécutée sur les runs examinés.** Les 15 derniers runs CI de `main`, les 4 derniers runs de push de la branche et le run `pull_request` de `d664f11` affichent l'étape en `skipped`. Sa condition repose sur `secrets.DATABASE_URL` : le secret n'était donc pas disponible pour ces runs. Cette conclusion est tirée des métadonnées de jobs, non des journaux (illisibles). Elle ne prouve pas que le secret est absent des paramètres du dépôt, qui restent non vérifiables (403).
3. **La protection de `main` n'existe pas.** `protected: false` (VÉRIFIÉ). La liste des rulesets est vide (VÉRIFIÉ). L'endpoint de protection détaillée renvoie 403 (NON VÉRIFIABLE comme protection legacy).
4. **Les environnements `Preview` et `Production` n'ont aucun relecteur, aucune restriction de branche, et les administrateurs peuvent contourner** (VÉRIFIÉ, relu ce jour).
5. **Un point nouveau, absent des rapports précédents** : la suite `test:neon:supplier:advanced` (hors des cinq suites) contient des `CREATE ROLE`, `DROP ROLE` et des `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public`. Elle n'est référencée nulle part dans les workflows (VÉRIFIÉ).
6. **Un couplage nouveau** : la clé HMAC du limiteur de débit dérive de `DATABASE_URL` si `TRACEFAB_RATE_LIMIT_SALT` est absent (VÉRIFIÉ dans le code et la documentation). Le secret de production est donc aussi une clé de dérivation côté runtime.

---

## 2. Phase A — Contrôle du résultat de 2C.1

| # | Contrôle | Résultat | Statut |
|---|---|---|---|
| A.1 | Commit distant de la branche | `c3717cd` = HEAD local, arbre propre | VÉRIFIÉ |
| A.1 | État de la PR #34 | ouverte, non brouillon, non fusionnée, tête `c3717cd`, sans revue | VÉRIFIÉ |
| A.2 | Run `push` sur `c3717cd` (`38043172281`) | success : `Socle`, `Parcours`, `Verification`, `Base` | VÉRIFIÉ |
| A.2 | Run `pull_request` sur `c3717cd` (`38043176685`) | success | VÉRIFIÉ |
| A.3 | `DATABASE_URL` référencé dans `ci.yml` | `secrets.DATABASE_URL` absent des étapes ; seule référence active : `DATABASE_URL: postgresql://…@localhost:5432/tracefab_test` au niveau du job `base-de-donnees` (valeur locale, non secrète) | VÉRIFIÉ sur la branche |
| A.3 | `DATABASE_URL` référencé dans `main` (`b0c976f`) | étape prod et `TF_SECRET_PRODUCTION: secrets.DATABASE_URL` présentes | **VÉRIFIÉ — écart** |
| A.4 | Cinq suites `test:neon:*` présentes et commandes | voir tableau ci-dessous | VÉRIFIÉ |
| A.5 | SHA des actions | `checkout` → `11d5960a…`, `setup-node` → `49933ea5…`, `upload-artifact` → `ea165f8d…` : égaux aux tags `v4.4.0`, `v4.4.0`, `v4.6.2` | VÉRIFIÉ |
| A.5 | Références non épinglées | aucune dans `.github/workflows/` (grep) | VÉRIFIÉ |

**Commandes des cinq suites** (`package.json`) :

| Script | Commande |
|---|---|
| `test:neon:security` | `node scripts/test_neon_security.mjs` |
| `test:neon:supplier` | `node scripts/test_neon_supplier_flow.mjs` |
| `test:neon:product` | `node scripts/test_neon_product_flow.mjs` |
| `test:neon:quality` | `node scripts/test_neon_quality_flow.mjs` |
| `test:neon:collection` | `node scripts/test_neon_data_collection_flow.mjs` |

### Écarts avec les rapports précédents (A.6)

| Rapport antérieur | État constaté | Commentaire |
|---|---|---|
| 2C.1 §12.2 : « le secret n'est plus lu par la CI » | Vrai sur la branche, **faux sur `main`** | Le correctif n'est pas encore fusionné |
| 2C phase 1 §3.1 : étape prod « déclenchée sur toute branche » | Déclencheur confirmé, mais l'étape était `skipped` sur tous les runs examinés | Risque latent, non réalisé sur ces runs |
| 2C.1 §12.6 : « `c3717cd` non relu » | Relu : vert | Mise à jour |
| Phase 1 : `test:neon:supplier:advanced` non mentionné | Destructif (`REVOKE`, `CREATE/DROP ROLE`), hors CI | Nouveau point à traiter |
| Phase 1 : `DATABASE_URL` présenté comme secret de CI uniquement | Aussi clé de dérivation du limiteur de débit (runtime) | Nouveau couplage |

---

## 3. Phase B — Protection de `main`

### 3.1 État réel (lecture seule)

| Contrôle | Résultat | Statut |
|---|---|---|
| `branches/main` → `protected` | `false` | VÉRIFIÉ |
| `rulesets` (liste) | vide | VÉRIFIÉ (lecture réussie) |
| `branches/main/protection` | HTTP 403 | NON VÉRIFIABLE (protection legacy) |
| Noms de checks publiés (run `c3717cd`) | voir ci-dessous | VÉRIFIÉ |

**Noms exacts des checks** (check-runs GitHub Actions sur `c3717cd`) :

- `Socle — types, compilation, isolation`
- `Verification — suite de tests`
- `Parcours — navigateur reel`
- `Base — isolation RLS executee`

Le libellé demandé « Verification » correspond au nom publié `Verification — suite de tests`. Il faut utiliser le nom complet. Les noms `Socle`, `Parcours` et `Base` seuls ne correspondent à aucun check publié.

### 3.2 Procédure manuelle (à exécuter par le propriétaire)

Chemin : **Settings → Rules → Rulesets → New branch ruleset**.

1. **Ruleset name** : `protection-main`.
2. **Enforcement status** : `Active`.
3. **Bypass list** : vide (aucun contournement).
4. **Target branches** : `Include default branch` (`main`).
5. **Branch rules** :
   - **Restrict deletions** : coché.
   - **Block force pushes** : coché.
   - **Require a pull request before merging** : coché.
     - *Required approvals* : **1** (voir l'avertissement ci-dessous).
     - *Dismiss stale pull request approvals when new commits are pushed* : coché.
     - *Require approval of the most recent reviewable push* : coché.
     - *Require conversation resolution before merging* : coché.
   - **Require status checks to pass** : coché.
     - *Require branches to be up to date before merging* : **non coché** (évite de bloquer les merges sans bénéfice immédiat ; à décider).
     - Ajouter les quatre checks exacts de §3.1.
   - **Require linear history** : non coché (décision du propriétaire, sans impact sécurité direct).
6. **Create**.

**Avertissement bloquant** : GitHub n'accepte pas l'approbation d'une PR par son auteur. Si le dépôt n'a qu'un seul collaborateur ayant le droit d'approuver (c'est le cas : VÉRIFIÉ ce jour, `gh api repos/Huberaya/Tracefab/collaborators` ne renvoie qu'un collaborateur direct, `Huberaya`, avec les droits admin et écriture), la règle « 1 approbation » rend toute PR **non fusionnable**. Deux options, à trancher par le propriétaire :

- **Option 1** : ajouter un second relecteur, avec le droit d'écriture, avant d'activer la règle à 1 approbation.
- **Option 2** : mettre *Required approvals* à **0**, tout en gardant la PR obligatoire, le blocage des push directs et les quatre checks. Ce mode bloque toujours les pushs directs sur `main`, mais ne garantit pas de relecture humaine.

Un contournement « pour les administrateurs uniquement en mode PR » peut aussi être ajouté à la bypass list. Ce choix élargit les droits et doit être explicitement accepté.

### 3.3 Vérification en lecture seule après configuration

À exécuter après que le propriétaire a configuré le ruleset. Aucune de ces commandes ne modifie quoi que ce soit.

```bash
# 1. Lister les rulesets et récupérer l'identifiant du ruleset créé (ne pas l'inventer)
gh api repos/Huberaya/Tracefab/rulesets --jq '.[]|{id,name,target,enforcement}'

# 2. Lire les règles du ruleset (remplacer <ID> par l'identifiant obtenu en 1)
gh api repos/Huberaya/Tracefab/rulesets/<ID> --jq '{enforcement, bypass_actors, rules: [.rules[]|{type, parameters}]}'

# 3. Règles effectivement appliquées à main
gh api repos/Huberaya/Tracefab/rules/branches/main --jq '.[]|{type, parameters}'

# 4. État de protection de main (doit renvoyer true)
gh api repos/Huberaya/Tracefab/branches/main --jq '.protected'
```

Critères de réussite :
- le ruleset est `active` et cible `main` ;
- `bypass_actors` est vide, ou correspond exactement à la décision documentée ;
- les règles `pull_request`, `required_status_checks`, `non_fast_forward` (blocage des force-push) et `deletion` sont présentes ;
- `required_status_checks` contient exactement les quatre contextes de §3.1 ;
- `protected` vaut `true`.

Si la lecture renvoie 403, le résultat est **non vérifiable**, et non réussi. Il faut alors contrôler dans l'interface.

**Test fonctionnel recommandé** (à faire par le propriétaire, pas par l'agent) : tenter un `git push` direct sur `main` depuis un compte sans bypass, et vérifier qu'il est refusé.

---

## 4. Phase C — Audit de `DATABASE_URL`

Aucune valeur n'a été lue ni affichée. Les URL ont été relues avec identifiants masqués.

### 4.1 Usages

| Fichier | Ligne(s) | Fonction | Catégorie | Action |
|---|---|---|---|---|
| `.github/workflows/ci.yml` | 251 | Variable du job `base-de-donnees` : `postgresql://…@localhost:5432/tracefab_test` (Postgres jetable) | CI — valeur locale | Aucune |
| `.github/workflows/ci.yml` | 220 | Commentaire historique | Documentation | Aucune |
| `main` : `.github/workflows/ci.yml` | ~247, ~280 | `TF_SECRET_PRODUCTION` et `DATABASE_URL: secrets.DATABASE_URL` pour l'étape prod | CI — **usage de production, présent sur `main`** | Retrait via fusion de la PR #34 |
| `api/_lib/rate-limit.ts` | 290 | Repli de la clé HMAC : `CLERK_SECRET_KEY \|\| DATABASE_URL` si `TRACEFAB_RATE_LIMIT_SALT` absent | **Runtime** | Voir 4.3 |
| `api/_lib/rate-limit.ts` | 387 | Garde de l'étage base du compteur de débit | **Runtime** | Légitime |
| `api/_lib/readiness-probes.ts` | 65 | Sonde de disponibilité : `DATABASE_URL` absent → `reachable: false` | **Runtime** | Légitime |
| `prisma/schema.prisma` | 7 | `url = env("DATABASE_URL")` | **Runtime et CLI Prisma** | Légitime |
| `api/` (autres) | — | Aucun autre usage | — | — |
| `scripts/audit_production_env.mjs` | 8, 90–95 | Contrôle : schéma `postgresql`, `sslmode` strict, pas de rôle `owner`/`postgres` | Audit de configuration | Légitime |
| `scripts/bootstrap_app_role.mjs` | 9, 16, 20 | Connexion **propriétaire** pour créer le rôle `tracefab_app` | Administration (manuel) | Légitime, à ne jamais lancer sur la production sans autorisation |
| `scripts/seed_rls_fixture.mjs` | 8, 33, 37 | Connexion propriétaire, fixtures | Administration / test | À cibler uniquement sur une base de test |
| `scripts/seed_pilot.ts` | 18, 313–318 | Écriture de données pilote ; `--dry-run` sans écriture | Administration | Exige une vérification de cible |
| `scripts/verifier_checksums_migrations.mjs` | 28, 47–49 | Lecture des checksums de migrations | Lecture | Légitime |
| `scripts/lib/tracefab_app_role.mjs` | 74 | Commentaire : DATABASE_URL = propriétaire | Documentation | Aucune |
| `scripts/lib/test_prisma_client.mjs` | 27 | Commentaire : le rôle applicatif ne doit pas venir de DATABASE_URL | Documentation | Aucune |
| `scripts/test_neon_security.mjs` | 4, 6 | Suite destructive (voir §5) | Test Neon | Retrait de la CI, conservée |
| `scripts/test_neon_supplier_flow.mjs` | 4, 5 | Suite destructive | Test Neon | Idem |
| `scripts/test_neon_product_flow.mjs` | 4, 5 | Suite destructive | Test Neon | Idem |
| `scripts/test_neon_quality_flow.mjs` | 4, 5 | Suite destructive | Test Neon | Idem |
| `scripts/test_neon_data_collection_flow.mjs` | 4, 5 | Suite destructive | Test Neon | Idem |
| `scripts/test_neon_supplier_advanced.mjs` | 4, 5 | Suite destructive, **hors des cinq** (§5.6) | Test Neon | Idem, à traiter |
| `scripts/test_rls_isolation.mjs` | 43, 47 | Propriétaire + `TF_RLS_APP_URL` ; `NON EXECUTE` si absent | Test (CI, base jetable) | Légitime en CI |
| `scripts/test_neon_auth_provisioning.mjs` | 29, 33 | Idem | Test (CI, base jetable) | Légitime en CI |
| `scripts/test_neon_dpp_provenance.mjs` | 27, 31 | Idem | Test (CI, base jetable) | Légitime en CI |
| `scripts/test_neon_publication_deploiement.mjs` | 17, 37, 39, 283 | Répétition de déploiement ; **garde : hôte local uniquement** | Test (CI, base jetable) | Légitime en CI |
| `scripts/test_dossier_securite.mjs` | 102 | Recherche de la chaîne « DATABASE_URL » dans les documents | Contrôle documentaire | Aucune |
| `scripts/test_production_readiness.ts` | — | Contrôle des variables requises | Garde-fou | Légitime |
| `.env.example` | 2 | Valeur placeholder (vérifiée sans affichage : utilisateur de type owner, mot de passe factice) | Modèle | Ne jamais remplacer par une vraie valeur dans le dépôt |
| `README.md` | 44, 46, 145 | Instructions d'installation locale | Documentation | Aucune |
| `docs/operations/variables-environnement.md` | 22, 124 | Variable bloquante ; dérivation du sel | Documentation | Aucune |
| `docs/operations/production-hardening.md` | 40, 81 | Rôle runtime dédié, jamais `postgres` ou `neondb_owner` | Documentation | Aucune |
| `docs/operations/runbook-sauvegarde-restauration.md` | 111 | `pg_restore -d "$DATABASE_URL"` | Procédure de restauration | **À encadrer** : ne jamais exécuter sans cible vérifiée |
| `docs/architecture/13-neon-clerk.md` | 72–77, 101 | Commandes de migration | Documentation | Aucune |
| Fichiers de configuration Vercel | — | `vercel.json` absent du dépôt | — | Non vérifiable (variables Vercel hors dépôt) |

### 4.2 Le secret de dépôt `DATABASE_URL` : peut-il être supprimé ?

**Usages légitimes du secret GitHub Actions après 2C.1** : aucun dans les workflows de la branche de travail. Sur `main`, la seule référence est l'étape prod, qui est `skipped`.

**Ce qu'on sait** :
- le secret de dépôt n'est visible d'aucun job dans les runs examinés ;
- les variables Vercel (runtime) sont un contexte distinct : un secret GitHub Actions n'alimente pas l'application déployée ;
- son existence n'est **pas** vérifiable (403 sur `actions/secrets`).

**Recommandation** (décision du propriétaire, non exécutée) :
1. Après fusion de la PR #34 (qui retire la référence de `main`), supprimer le secret de dépôt `DATABASE_URL` s'il existe.
2. Si un futur workflow Neon a besoin d'un secret, le créer sous un nom distinct (`NEON_TEST_DATABASE_URL`) dans un environnement dédié, jamais au niveau du dépôt.
3. Ne pas recréer de secret de production au niveau du dépôt.

**Rotation du mot de passe de production** : non recommandée à ce stade sur la seule base de ces runs, mais à envisager si le propriétaire constate, dans les journaux d'accès Neon (non consultés), une connexion inattendue. Les journaux d'exécution des runs ne sont pas lisibles.

### 4.3 Usage runtime : clé HMAC du limiteur de débit

`api/_lib/rate-limit.ts` (fonction `hmacKey`) : si `TRACEFAB_RATE_LIMIT_SALT` est absent, la clé est `CLERK_SECRET_KEY`, sinon `DATABASE_URL`. La documentation le dit explicitement (`docs/operations/variables-environnement.md`, ligne 124).

Conséquences :
- la rotation du mot de passe de la base modifie la clé et réinitialise les empreintes (effet attendu, mais à documenter) ;
- le sel de production, requis par 2C et absent, reste le bon mécanisme ;
- ce couplage n'est pas une fuite en soi (la clé ne sort pas du serveur), mais il étend la portée du secret de production.

Aucune modification n'est proposée dans ce chantier. Recommandation : définir `TRACEFAB_RATE_LIMIT_SALT` dans l'environnement Vercel `Production`, généré hors dépôt.

---

## 5. Phase D — Préparation des tests Neon isolés

### 5.1 Vue d'ensemble

Les cinq suites partagent le même schéma d'exécution : un `try` / `finally`, des identifiants UUID aléatoires, des rôles nommés avec le PID du processus, et un nettoyage par `deleteMany` dans le `finally`. Elles exigent le **rôle propriétaire** (`CREATE ROLE`, `GRANT ... TO CURRENT_USER`), donc un secret de niveau propriétaire.

### 5.2 Rôles et privilèges modifiés

| Suite | Création de rôle | Privilèges accordés | Révocations | Suppression de rôle |
|---|---|---|---|---|
| `security` | `tracefab_rls_test_<pid>` (`NOLOGIN`) | `GRANT <rôle> TO CURRENT_USER`, `USAGE` sur `public`, `EXECUTE` sur toutes les fonctions de `public` | `REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM <rôle>`, `REVOKE USAGE`, `REVOKE <rôle> FROM CURRENT_USER` | `DROP ROLE IF EXISTS <rôle>` |
| `product` | `tracefab_product_rls_test_<pid>` | `GRANT <rôle> TO CURRENT_USER`, `USAGE` sur `public` | `REVOKE <rôle> FROM CURRENT_USER`, `REVOKE USAGE` | `DROP ROLE IF EXISTS` |
| `supplier` | aucun (utilise les rôles du schéma) | — | — | — |
| `quality` | aucun | — | — | — |
| `collection` | aucun | — | — | — |
| `supplier:advanced` (hors des cinq) | `tracefab_adv_test_<pid>` | `GRANT USAGE`, puis `REVOKE ALL PRIVILEGES` **sur toutes les tables, séquences et le schéma** | idem | `DROP ROLE IF EXISTS` |

**Points de vigilance** :
- `CREATE ROLE` et `DROP ROLE` opèrent au niveau du **cluster**, pas de la base. Un rôle oublié après un crash reste visible de toute la base.
- `REVOKE ... ON ALL TABLES IN SCHEMA public FROM <rôle>` est ciblé sur le rôle de test, donc sans effet sur les autres rôles. C'est vrai uniquement si le rôle de test n'est jamais le rôle applicatif : un contrôle positif est nécessaire (§5.7).

### 5.3 Tables et données modifiées

| Suite | Tables et fonctions touchées | Création | Suppression | Mises à jour |
|---|---|---|---|---|
| `security` | `organizations`, `user`, `suppliers`, `tracefab_update_supplier_profile` | organisations, utilisateurs, fournisseurs (UUID aléatoires) | `organizations.deleteMany`, `user.deleteMany` dans `finally` | `UPDATE suppliers` tenté sous rôle restreint (attendu 0 ligne) |
| `product` | `tracefab_products`, `tracefab_create_product`, `tracefab_create_material`, `tracefab_update_product_data`, `tracefab_add_product_identifier`, `tracefab_add_product_material`, `tracefab_start_product_revision` | produits, matières, identifiants | `organizations.deleteMany`, `user.deleteMany` | `UPDATE tracefab_products` tenté (attendu 0 ligne) |
| `supplier` | `tracefab_invite_supplier`, `tracefab_accept_organization_invitation`, `tracefab_update_supplier_profile`, `tracefab_submit_supplier_profile` | organisations, utilisateurs, invitations (hash aléatoire) | `organizations.deleteMany`, `user.deleteMany` | via fonctions |
| `quality` | `tracefab_create_product`, `tracefab_compute_product_quality`, `tracefab_compute_supplier_quality`, `tracefab_acknowledge_quality_issue`, `tracefab_waive_quality_issue` | organisations, utilisateurs, fournisseur, produit | `organizations.deleteMany`, `user.deleteMany` | via fonctions |
| `collection` | `tracefab_create_data_request`, `tracefab_send_data_request`, `tracefab_add_data_request_item`, `tracefab_submit_data_request`, `tracefab_submit_data_response`, `tracefab_review_data_response`, `tracefab_notification_outbox`, `tracefab_claim_notification_outbox`, `tracefab_complete_notification_outbox` | demandes, réponses, outbox de notifications | `organizations.deleteMany`, `user.deleteMany` | via fonctions |
| `supplier:advanced` | `organizations`, rôles de test | idem `supplier` | idem | — |

**Fonctions appelées** : 23 fonctions `tracefab_*` distinctes sont référencées par les cinq suites. Elles doivent exister, avec leurs droits, après migration.

**Note** : les suites `quality` et `collection` créent des données sans rôle de test. Elles travaillent donc avec le rôle propriétaire, et la RLS n'est pas exercée par le rôle restreint. Ce n'est pas une anomalie de sécurité pour le test lui-même, mais cela limite ce qu'elles prouvent.

### 5.4 Prérequis de schéma et de migrations

1. Toutes les migrations du dépôt appliquées sur la base de test (à ce jour, 36 migrations, dont `20261010120000_publication_explicite`).
2. Le rôle applicatif `tracefab_app` créé par `scripts/bootstrap_app_role.mjs`, **sans** `BYPASSRLS`. Les suites `security` et `product` l'utilisent indirectement via `SET LOCAL ROLE`.
3. Un rôle connecté ayant les droits `CREATEROLE` et la propriété du schéma. C'est le rôle propriétaire de la base de test, et il ne peut pas être un rôle partagé avec la production.
4. Les fixtures : les cinq suites créent leurs propres données. La nécessité de `seed_rls_fixture.mjs` n'a pas été établie pour elles ; à vérifier.

### 5.5 Risques d'exécution concurrente

| Risque | Mécanisme | Atténuation |
|---|---|---|
| Collision de rôles | `CREATE ROLE` cluster-wide ; noms en `<pid>` | Unicité par processus ; mais deux jobs sur le même PID et la même base peuvent collisionner. Sérialiser les runs |
| Rôle orphelin après crash | `finally` ne s'exécute pas si le processus est tué | Nettoyage préalable : `DROP ROLE IF EXISTS` sur les noms de test avant exécution |
| Interférence de privilèges | `REVOKE ... ON ALL TABLES` ciblé sur un rôle | Vrai seulement si le rôle n'est pas partagé. Contrôle positif requis |
| Lecture de données d'un autre run | Données UUID : pas de collision de clés | Faible |
| Blocage de transactions | Non documenté dans les suites | Sérialiser |

**Mesure recommandée** : un `concurrency` GitHub Actions avec un groupe unique (`neon-test-db`) et `cancel-in-progress: false`, pour que deux runs n'accèdent jamais à la même base de test en même temps.

### 5.6 Le cas `test:neon:supplier:advanced`

- Présent dans `package.json` (ligne 37), absent des cinq suites, et **non appelé par aucun workflow** (VÉRIFIÉ : `grep` sur `.github`, `package.json` et `scripts`).
- Il contient `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public` et `REVOKE ALL PRIVILEGES ON SCHEMA public`. Il doit être traité **avec** les cinq suites, et non après.
- Recommandation : l'exclure de tout futur workflow tant qu'il n'a pas été relu, ou le conserver dans le même workflow dédié avec les mêmes garde-fous.

### 5.7 Critères permettant de confirmer que la cible est une base de test isolée

Aucun critère pris isolément n'est une preuve. Le nom d'une variable n'en est pas une. Les contrôles ci-dessous sont **positifs** (la cible doit présenter une propriété attendue) et doivent tous réussir, avec leurs limites.

| Contrôle | Principe | Limite |
|---|---|---|
| C1. Secret dédié | `NEON_TEST_DATABASE_URL` dans un environnement GitHub `Test-Neon`, jamais au niveau du dépôt | Ne prouve rien sur la cible elle-même |
| C2. Liste blanche d'hôtes | L'hôte doit appartenir à une liste fournie en variable non secrète (par exemple l'endpoint du projet de test) | L'hôte peut être modifié dans le secret ; la liste doit être comparée au projet de test, pas au nom |
| C3. Empreinte du système | `SELECT system_identifier FROM pg_control_system()` comparé à une empreinte **hachée** de la production, stockée en secret dédié. Refus si égal | Nécessite une empreinte de production obtenue une fois, par le propriétaire, en lecture seule |
| C4. Marqueur de test | Une table `tracefab_test_target` contenant un jeton aléatoire, créée par le propriétaire **uniquement** dans la base de test. Le jeton est comparé à un condensat stocké en secret | Un marqueur peut être copié ; la production ne doit jamais recevoir cette table |
| C5. Absence de données réelles | Avant exécution : aucune ligne dans `organizations` ou `user` hors des fixtures (`clerk_id` commençant par `test_`, `email` se terminant par `@example.test`) | Vérifie les données visibles, pas les données cachées par RLS (la lecture se fait en propriétaire) |
| C6. Projet sans parent | La base de test ne doit pas être une **branche créée depuis la production**, car elle contiendrait des données réelles. Vérifiable seulement dans la console Neon | Non vérifiable par la CI |
| C7. Rôle non BYPASSRLS pour les tests RLS | Vérifié par les suites elles-mêmes | Ne concerne pas la cible |
| C8. Refus par défaut | Si l'une des vérifications C2 à C5 ne peut pas être évaluée, le workflow échoue | — |

**Pourquoi C6 est essentiel** : une branche Neon créée depuis la production partage le stockage et contient des données réelles. Les suites y seraient exécutables, mais les données ne seraient pas « sans données réelles ». Le contrôle doit donc être fait sur le projet, dans la console, et consigné.

**Conclusion** : la seule garantie forte est organisationnelle : un projet Neon de test distinct, sans parent de production, avec un secret propre et un environnement protégé. Les contrôles C2 à C5 réduisent le risque d'erreur de cible. Ils ne le suppriment pas.

### 5.8 Architecture proposée du workflow (non créé)

Nom proposé : `.github/workflows/neon-tests-isoles.yml`.

Principes :
- **déclenchement** : `workflow_dispatch` uniquement, aucun `push`, aucun `pull_request` ;
- **référence** : `main` uniquement (`if: github.ref == 'refs/heads/main'`) ;
- **environnement** : `environment: Test-Neon`, avec relecteur requis ;
- **secret** : `NEON_TEST_DATABASE_URL`, jamais `DATABASE_URL` ;
- **permissions** : `contents: read`, rien d'autre ;
- **concurrence** : `group: neon-test-db`, `cancel-in-progress: false` ;
- **actions** : épinglées par SHA, mêmes versions que la CI ;
- **étapes** :
  1. checkout, setup-node, `npm ci`, `npm run db:generate` ;
  2. garde : script de contrôle C2 à C5, refus si l'un échoue ; la sortie ne contient aucune URL ni valeur ;
  3. les suites, une par étape, avec `timeout-minutes` ;
  4. publication d'un résumé dans `$GITHUB_STEP_SUMMARY` : nom de la suite, succès ou échec, sans valeur ;
- **publication** : aucun secret, aucune URL, aucun identifiant dans les logs ou le résumé ;
- **nommage** : titre explicite « Tests Neon isolés (base de test, manuel) », jamais « production ».

Prérequis avant création (à faire par le propriétaire) :
1. Un projet Neon de test, créé vide, sans parent de production ; URL et identifiants consignés hors dépôt.
2. Application des migrations sur ce projet, puis création du rôle `tracefab_app` (`bootstrap_app_role.mjs`), exécutées par le propriétaire.
3. L'environnement `Test-Neon` créé dans GitHub, avec relecteur requis, branche `main` uniquement, et le secret `NEON_TEST_DATABASE_URL` défini dans cet environnement (pas au niveau du dépôt).
4. Les variables non secrètes de la liste blanche (C2) et l'empreinte hachée de production (C3) définies dans l'environnement `Test-Neon`.
5. Une validation des garde-fous par un test négatif : pointer le workflow vers un hôte non autorisé doit le faire échouer. Ce test est à faire **sans** cible de production.

Ce workflow ne doit pas être créé tant que ces prérequis ne sont pas remplis et validés.

---

## 6. Phase E — Environnement `Production`

### 6.1 État réel (lecture seule, ce jour)

| Contrôle | Résultat | Statut |
|---|---|---|
| Existence | oui | VÉRIFIÉ |
| Relecteurs requis | 0 | VÉRIFIÉ |
| Restriction de branches | aucune (`deployment_branch_policy: null`) | VÉRIFIÉ |
| Administrateurs peuvent contourner | oui | VÉRIFIÉ |
| Secrets de l'environnement | non lisibles (403) | NON VÉRIFIABLE |
| Job rattaché à l'environnement | aucun | VÉRIFIÉ |

`Preview` : mêmes constats (0 relecteur, pas de restriction, contournement possible).

### 6.2 Procédure manuelle (propriétaire)

Chemin : **Settings → Environments → Production**.

1. **Required reviewers** : ajouter au moins une personne. Décider si un second relecteur est nécessaire pour qu'un auteur ne soit jamais son propre approbateur.
2. **Prevent self-review** : coché (si l'option apparaît avec les relecteurs).
3. **Deployment branches and tags** : `Selected branches and tags`, puis ajouter uniquement `main`.
4. **Environment secrets** : déplacer dans cet environnement les seuls secrets de déploiement nécessaires. Ne pas y mettre de secret de test.
5. **Administrators can bypass** : décision à prendre. Si décoché, aucun administrateur ne peut déployer sans approbation, y compris en urgence : prévoir la procédure d'urgence avant de décocher.
6. Ne rattacher un job à `Production` que dans un workflow dédié, déclenché manuellement, depuis `main`.

Une fois le réglage fait, relire l'état avec : `gh api repos/Huberaya/Tracefab/environments/Production --jq '{can_admins_bypass, protection_rules, deployment_branch_policy}'`.

---

## 7. Contrôles réellement exécutés, résultats et limites

### 7.1 Exécutés et vérifiés ce jour

| Contrôle | Résultat |
|---|---|
| Relecture de `c3717cd` (push et pull_request) | success |
| Checks publiés sur `c3717cd` | 4 noms exacts relevés |
| État de la PR #34 | ouverte, non fusionnée |
| SHA des trois actions | égaux aux tags |
| Références non épinglées | aucune |
| État de la protection de `main` | `protected: false` ; rulesets vides |
| Environnements `Preview` / `Production` | relevés (§6.1) |
| Étape prod sur les 15 derniers runs `main` | `skipped` pour les 15 |
| Étape prod sur les runs de branche (`d664f11` push et PR, `273eb16`, `f57e0b0`, `675e5a4`) | `skipped` pour tous |
| Usages de `DATABASE_URL` (recherche exhaustive du dépôt) | §4.1 |
| Cinq suites : commandes et opérations | §5 (lecture du code, **non exécutées**) |

### 7.2 Non exécutés

- Aucune suite `test:neon:*` n'a été exécutée. Ni localement (pas de client Prisma généré : le téléchargement du moteur est bloqué), ni sur une base distante (interdit en l'absence de cible vérifiée).
- Le contrôle C6 (projet sans parent) est impossible sans accès à la console Neon.

### 7.3 Impossibles faute d'accès

- Lecture des règles de protection détaillées de `main` (403).
- Lecture des rulesets : liste vide, mais le détail de chaque règle n'est pas disponible si le ruleset n'existe pas (cas actuel).
- Lecture des secrets (dépôt et environnements) et des variables (403).
- Lecture des paramètres Actions du dépôt (403).
- Lecture des journaux de jobs (non accessibles par API).
- Vérification des variables d'environnement Vercel (hors dépôt, pas d'accès).
- Consultation des journaux d'accès Neon.

---

## 8. Actions manuelles du propriétaire, par ordre de priorité

1. **Fusionner la PR #34** (après validation explicite de l'agent) pour retirer la référence au secret de production de `main`. C'est le correctif le plus important, et il n'est pas encore effectif sur `main`.
2. **Créer le ruleset de `main`** (§3.2), après avoir choisi l'option sur le nombre d'approbations (§3.2, avertissement).
3. **Vérifier le ruleset** avec les commandes de §3.3, puis tester un push direct refusé.
4. **Configurer l'environnement `Production`** (§6.2).
5. **Supprimer le secret de dépôt `DATABASE_URL`** s'il existe, après la fusion de la PR #34 (§4.2). Vérifier d'abord, dans l'interface, la liste des noms de secrets.
6. **Décider de la rotation du mot de passe de production** : seulement si les journaux d'accès Neon montrent une connexion inattendue (§4.2).
7. **Définir `TRACEFAB_RATE_LIMIT_SALT`** dans l'environnement Vercel `Production`, généré hors dépôt (§4.3).
8. **Décider du sort de `test:neon:supplier:advanced`** (§5.6).
9. **Préparer le projet Neon de test** et les prérequis de §5.8, sans lancer de workflow.

---

## 9. Risques résiduels

| Niveau | Risque | Commentaire |
|---|---|---|
| P0 | Le correctif 2C.1 n'est pas sur `main` | Résolu par la fusion de la PR #34, non autorisée à ce stade |
| P0 | `main` non protégée | Résolu par le ruleset (§3), à faire par le propriétaire |
| P1 | Étape prod latente sur `main` | Réalisable dès qu'un secret `DATABASE_URL` apparaît au niveau du dépôt, avec tout écrivain pouvant modifier un workflow sur sa branche |
| P1 | Environnement `Production` non protégé | §6 |
| P1 | `supplier:advanced` destructif, hors CI, non traité | §5.6 |
| P1 | Pas de tests Neon en CI | Régressions RLS et fonctions non détectées par les suites retirées ; le job `base-de-donnees` couvre une partie des mêmes garanties sur le Postgres jetable |
| P2 | Clé HMAC du limiteur dérivée de `DATABASE_URL` | §4.3 |
| P2 | `runbook-sauvegarde-restauration.md` utilise `DATABASE_URL` pour une restauration | À encadrer par une cible vérifiée |
| P2 | Secret scanning et push protection non vérifiés | Réglage propriétaire |
| P2 | Réglages Actions non lisibles (403) | Vérification manuelle |

---

## 10. Recommandations de correction non appliquées

Aucune modification de code n'est appliquée dans ce chantier. Les recommandations ci-dessous sont à valider séparément :

1. **Fusion de la PR #34** : retire l'étape prod de `main` au moment de la fusion. Aucun autre changement n'est nécessaire pour ce point.
2. **Retirer `test:neon:supplier:advanced` des scripts**, ou le conserver avec le même statut que les cinq suites (non appelé par la CI).
3. **Ajouter `concurrency` et `environment` dans le futur workflow Neon**, comme décrit en §5.8.
4. **Compléter `.env.example`** avec les variables Apple, Google, `TRACEFAB_RATE_LIMIT_SALT`, `TRACEFAB_ERROR_WEBHOOK_*` et `TRACEFAB_STAGING_*` (déjà signalé en 2C phase 1).

---

## 11. Fichiers et commandes

**Fichiers modifiés par ce chantier** : `docs/experience/CHANTIER-2C-2-PROTECTION-ET-NEON.md` (ce rapport). Aucun autre.

**Commandes de lecture exécutées** (sans valeur de secret) :

```text
git fetch origin ; git rev-parse HEAD ; git status --porcelain
gh pr view 34 --json state,isDraft,mergedAt,headRefOid,reviewDecision
gh run list --branch arena/91844ee9-tracefab ; gh run watch <id> --exit-status
gh run view <id> --json jobs            # conclusion des étapes
gh run list --branch main --workflow ci.yml --limit 15
gh api repos/Huberaya/Tracefab/branches/main --jq .protected
gh api repos/Huberaya/Tracefab/branches/main/protection   -> 403
gh api repos/Huberaya/Tracefab/rulesets                    -> []
gh api repos/Huberaya/Tracefab/environments/{Preview,Production}
gh api repos/Huberaya/Tracefab/actions/secrets             -> 403
gh api repos/Huberaya/Tracefab/commits/<sha>/check-runs
gh api repos/<action>/git/ref/tags/<tag>                   (SHA des actions)
git show origin/main:.github/workflows/ci.yml | grep ...
grep -rn "DATABASE_URL" (avec masquage des identifiants d'URL)
grep -n "test:neon" package.json ; grep -rn "supplier:advanced" .github package.json scripts
```

**Limites générales** :
- Les journaux des jobs ne sont pas lisibles : les conclusions d'étapes servent de preuve d'exécution ou de saut.
- `skipped` établit que la condition était fausse ; il ne montre pas la valeur de la variable, et ne décrit que les runs examinés.
- Les rulesets et les secrets restent non vérifiables au-delà de ce qui est listé en §7.3.
