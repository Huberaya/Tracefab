# Chantier 2C.3 — Validation finale de la PR #34 et plan de sécurisation

Date : 2026-10-10 (Europe/Paris)
Branche : `arena/91844ee9-tracefab`
Tête vérifiée : `4db9ef9` (identique au distant, arbre propre)
PR : #34 (ouverte, non brouillon, base `main`, tête `4db9ef9`)

## Verdict

**Phase A : PR #34 NON PRÊTE À LA FUSION.**
Aucune fusion n'a été effectuée. Aucun paramètre GitHub, secret, environnement, déploiement, migration ni base de données n'a été modifié.

Motifs :

1. **Fusion sur `main` = mise en production automatique.** Vercel crée un déploiement Production à chaque évolution de `main` (28 déploiements Production existants, le dernier sur `b0c976f`, créé par `vercel[bot]`, statut `success`, 2026-10-09T18:36Z). La PR ajoute une migration (`20261010120000_publication_explicite`) non appliquée en production, alors que le code de la PR appelle des fonctions qu'elle crée (`tracefab_product_is_public`, `tracefab_public_brand`). Risque d'incohérence code/base à l'arrivée sur `main`. Le déploiement n'est pas autorisé à ce stade.
2. **Contrôle de secret : aucune fuite réelle détectée** (voir Phase A, section 3). Le seul motif trouvé est une URL de test de la CI.
3. **Scan `detect-secrets` non comparable** à la référence (voir Phase A, section 3).
4. **Phases B à E** décrites ci-dessous ; les réglages de protection et d'environnement restent à appliquer par le propriétaire.

## Phase A — Vérification avant fusion

### A.1 Tête et checks

| Élément | Résultat |
|---|---|
| Tête PR = tête distante = `4db9ef9` | Oui |
| `mergeStateStatus` (lecture) | `CLEAN` (était `UNSTABLE` lors d'un contrôle précédent, les checks étant alors en cours) |
| `reviewDecision` | vide (aucune revue) |
| Run push `38043845231` | `success`, 4 jobs verts (statut lu via `gh run view`) |
| Run pull_request `38043848465` | `success`, 4 jobs verts |
| Checks sur `4db9ef9` | `Socle — types, compilation, isolation`, `Verification — suite de tests`, `Parcours — navigateur reel`, `Base — isolation RLS executee` : verts |
| Vercel Preview | `success` |

Limite : les journaux de jobs ne sont pas lisibles par l'API (seules les annotations et métadonnées le sont). Les verts ci-dessus sont des statuts, non le contenu des logs.

### A.2 Contenu du diff (`origin/main` → `4db9ef9`)

- 105 fichiers, +4755 / −708 lignes, dont 38 fichiers PNG (références visuelles).
- Correctif 2C.1 présent : l'étape de déploiement production a été retirée de `ci.yml`. Il ne reste qu'un commentaire (ligne 220).
- Cinq suites Neon présentes dans `package.json` : `test_neon_security`, `test_neon_supplier_flow`, `test_neon_product_flow`, `test_neon_quality_flow`, `test_neon_data_collection_flow` (et `test_neon_supplier_advanced`, voir Phase D).
- Actions : 12 `uses:` épinglés par SHA dans `ci.yml`.
- Aucune référence `secrets.*` hors commentaire dans les workflows.
- Nouveau workflow `figer-reference-visuelle.yml` : absent de `main`, permissions `contents: write`, déclenché par un marqueur `.figer`. Il ne déploie rien, mais il peut écrire dans le dépôt. À relire avant fusion.
- Dépendances : `@prisma/adapter-pg`, `@sparticuz/chromium`, `playwright` (épinglé à `1.63.0` au lieu de `^1.63.0`). Toutes en `devDependencies`.
- `vercel.json` : identique à `main` (non modifié par la PR). Clés : `builds`, `headers`, `routes`, `crons`.

### A.3 Contrôle des secrets (preuves)

**Ligne signalée : `docs/experience/CHANTIER-2C-SECURISATION-GITHUB.md:171`.** Le premier balayage (`awk`) l'a signalée. Vérifications :

- Le balayage `awk` utilisait des quantificateurs `{n}` que `mawk` ne prend pas en charge : la détection était un faux positif de dialecte.
- Un second balayage en Python, sur **toutes** les lignes ajoutées par la PR (hors PNG, polices et `package-lock.json`), avec des motifs précis (clé privée PEM, `sk_live_`, `pk_live_`, `whsec_`, `AKIA…`, URL avec identifiants), ne remonte qu'**une** occurrence : une URL de test `postgresql://…@localhost` dans ce même rapport 2C.
- Cette URL utilise l'identifiant de test du Postgres jetable de la CI, déjà présent en clair dans `.github/workflows/ci.yml` (ligne 251). Il s'agit d'un identifiant local de service de test, sans lien avec un environnement distant. Il n'est pas un secret de production. Par prudence, il n'est pas recopié dans ce rapport.
- Aucune valeur n'a été affichée dans le cadre de cette vérification.

**`detect-secrets` (`--all-files`) sur `4db9ef9` : 222 détections.** Elles viennent en grande majorité de `tsconfig.tsbuildinfo`, qui n'est **pas suivi par Git** (`git ls-files` vide) et est ignoré par `.gitignore` (ligne 18). Il s'agit d'un artefact local de build. Le scan porte donc sur l'arbre de travail et non sur le dépôt. La référence de 24 n'est pas comparable. La comparaison propre (dépôt suivi, `origin/main` contre `4db9ef9`) n'a pas été réalisée dans cette passe : **non vérifié**. Elle reste à faire avant fusion pour isoler les détections nouvelles.

### A.4 Droits et environnements (lecture)

- Un seul collaborateur direct (`Huberaya`, admin). Une règle « 1 approbation » rend donc la PR non fusionnable sans second relecteur (voir Phase B).
- Environnement `Production` : 0 relecteur, pas de restriction de branche, `can_admins_bypass: true`.
- Lecture des secrets d'environnement : 403. **Non vérifié** (un 403 signifie « non vérifié », pas « absent »).

### A.5 Avant fusion : conditions restantes

1. Comparer `detect-secrets` entre `origin/main` et `4db9ef9` (dépôt suivi uniquement).
2. Relire `figer-reference-visuelle.yml` (écriture dans le dépôt).
3. Décider de l'ordre de déploiement : appliquer `20261010120000_publication_explicite` **avant** la fusion, après validation explicite du propriétaire et sur une base de test. Aucune migration n'a été lancée sur la production.
4. Validation explicite du propriétaire. Sans elle, pas de fusion.

## Phase B — Protection de `main` (instructions manuelles)

Constat (lecture) : `main` n'est pas protégée (`protected=false`), aucun ruleset. Un seul collaborateur direct.

Cible : au moins une approbation indépendante **et** un second relecteur de confiance. Le propriétaire doit configurer cela dans *Settings → Rules → Rulesets* sur `main`.

Ordre recommandé :

1. **Transitoire** (faisable seul) : exiger une PR pour fusionner, bloquer les pushs directs sur `main`, exiger les checks `Socle`, `Verification`, `Parcours`, `Base` avec branche à jour. **Sans** exiger d'approbation. Ce transitoire ne doit pas être présenté comme une revue indépendante.
2. **Cible** : ajouter un second collaborateur de confiance, puis exiger 1 approbation, avec rejet des approbations obsolètes après un nouveau push.

Points d'attention :

- Ne pas activer « 1 approbation » sans second relecteur : aucune PR ne pourrait être fusionnée.
- Le bypass administrateur doit être documenté (qui, quand, pourquoi) ou désactivé, plutôt que laissé implicite.
- Vérification en lecture seule après configuration : `gh api repos/Huberaya/Tracefab/rulesets` et `gh api repos/Huberaya/Tracefab/branches/main/protection`.

## Phase C — Environnement `Production` (instructions manuelles)

Constat important : **les déploiements Production sont créés par l'intégration Vercel** (`vercel[bot]`), et non par un workflow GitHub Actions. La protection de l'environnement GitHub `Production` ne contrôle donc pas ces déploiements. Le vrai levier se trouve dans Vercel. **Non vérifié** : le tableau de bord Vercel n'est pas accessible depuis la sandbox.

À vérifier et configurer par le propriétaire :

1. **Vercel** (projet Tracefab) : branche de production = `main` ; désactiver ou conditionner le déploiement automatique sur `main` ; activer la protection de déploiement si disponible.
2. **GitHub, environnement `Production`** : ajouter un approbateur de déploiement (second relecteur), restreindre les branches déployables à `main`, désactiver le bypass administrateur si possible. Utile dès qu'un déploiement passera par Actions.
3. **Séparation des secrets** : les secrets de production ne doivent pas être visibles dans les environnements de test ou de préprod. Vérification manuelle dans Vercel et GitHub (valeurs non consultées).
4. **Cron** : `vercel.json` déclare un cron quotidien (`0 7 * * *` UTC) sur `/api/internal/notification-outbox/schedule`. Il tourne déjà en production. La route exige `CRON_SECRET` (`cronAuthorized`, 401 sinon). Présence de la variable : **non vérifiée** (valeur non consultée).

## Phase D — Suite `test:neon:supplier:advanced` (analyse, non exécutée)

Fichier : `scripts/test_neon_supplier_advanced.mjs`. Script `package.json` : `test:neon:supplier:advanced`. Aucun workflow ne l'appelle. **Non exécutée.**

Opérations relevées :

- Exige seulement `DATABASE_URL` (ligne 4). **Aucun contrôle d'isolation de la cible** : le script écrira dans n'importe quelle base pointée par cette variable.
- Crée un rôle PostgreSQL de niveau cluster (`CREATE ROLE … NOLOGIN`, `GRANT … TO CURRENT_USER`) : nécessite des droits élevés et modifie le cluster.
- Accorde `SELECT/INSERT/UPDATE/DELETE` sur **toutes les tables** du schéma `public`, et `USAGE, SELECT` sur toutes les séquences.
- Crée des utilisateurs, organisations, membres et fournisseurs de test (e-mails `@example.test`, identifiants aléatoires), puis les supprime (`deleteMany`).
- Nettoyage en `finally` : `REVOKE ALL PRIVILEGES ON ALL TABLES/SEQUENCES/SCHEMA public`, `REVOKE` du rôle, `DROP ROLE IF EXISTS`.

Risques :

- Sur une base non jetable, la suite écrit et supprime des données, et modifie les privilèges du schéma `public`.
- Si le nettoyage échoue, un rôle de test peut rester. Le nom est suffixé par le PID, donc peu de risque de collision, mais pas de nettoyage garanti.

Proposition (non créée) pour un futur workflow **manuel** (`workflow_dispatch`) :

1. Environnement GitHub dédié `test-neon`, sans secret de production.
2. Vérification préalable de la cible : refus si l'hôte ou le nom de base ne figure pas dans une liste blanche explicite, refus si la base est la production. Le nom `NEON_TEST_DATABASE_URL` ne suffit pas comme preuve d'isolation.
3. Ne jamais utiliser `DATABASE_URL` implicitement.
4. Refus d'exécution si un contrôle échoue, aucune exécution par défaut.
5. Ne jamais se présenter comme test de production.

## Phase E — Usages de `DATABASE_URL` et limiteur de débit

Inventaire (noms et emplacements uniquement, aucune valeur) :

| Lieu | Usage |
|---|---|
| `api/_lib/rate-limit.ts:387` | Compteur du limiteur de débit stocké en base (si la variable est définie) |
| `api/_lib/rate-limit.ts:290` | **Repli de la clé HMAC** : `TRACEFAB_RATE_LIMIT_SALT`, puis `CLERK_SECRET_KEY`, puis `DATABASE_URL` |
| `api/_lib/readiness-probes.ts:65` | Sonde de disponibilité |
| `prisma/schema.prisma:7` | Source de la base pour Prisma |
| `scripts/seed_pilot.ts`, `scripts/bootstrap_app_role.mjs`, `scripts/seed_rls_fixture.mjs`, `scripts/verifier_checksums_migrations.mjs` | Scripts d'écriture ou de contrôle, exigent `DATABASE_URL` (propriétaire) |
| `scripts/audit_production_env.mjs:8-95` | Audit de l'environnement de production : vérifie le format, `sslmode`, et le rôle applicatif |
| `scripts/test_neon_*.mjs`, `scripts/test_rls_isolation.mjs` | Suites de test ; certaines exigent `DATABASE_URL` seul (voir Phase D) |
| `.github/workflows/ci.yml:251` | Base Postgres jetable de la CI (`localhost`) |
| `.env.example` | Modèle, valeur masquée |

**Repli du limiteur de débit (confirmé) :** si `TRACEFAB_RATE_LIMIT_SALT` est absent, la clé HMAC est dérivée de `CLERK_SECRET_KEY`, puis de `DATABASE_URL`. Conséquences :

- Un secret de base de données sert de clé HMAC. Ce couplage est inutile et étend la portée d'une éventuelle fuite.
- Une rotation du mot de passe de base modifie les empreintes des compteurs (réinitialisation transitoire attendue, car les fenêtres sont courtes).
- `scripts/audit_production_env.mjs` contrôle `DATABASE_URL` mais **ne contrôle pas** `TRACEFAB_RATE_LIMIT_SALT`.

Recommandation :

1. Définir `TRACEFAB_RATE_LIMIT_SALT` **dédié**, distinct de tout autre secret, dans Vercel (Production et Preview), par le propriétaire. La valeur n'est pas à coller dans le chat.
2. Ajouter ce contrôle à l'audit de production dans un chantier séparé (modification de code, non faite ici).

Rotation : **non recommandée à ce stade.** Aucun indice d'exposition établi. Les journaux Neon et Vercel n'ont pas été consultés (accès non disponible depuis la sandbox). L'absence de preuve d'accès suspect n'est donc **pas** une preuve d'absence d'incident : **non vérifié**. Une rotation ne se justifie qu'en cas d'activité suspecte ou d'exposition établie.

## Corrections du rapport 2C.2

- Le rapport 2C.2 affirme « `vercel.json` absent ». **C'est faux** : le fichier existe (clés `builds`, `headers`, `routes`, `crons`). Cette correction remplace l'affirmation précédente.

## Ce qui n'a pas été fait (et pourquoi)

- Aucune fusion de la PR #34 (validation explicite requise).
- Aucun déploiement, aucune migration, aucune requête sur la base de production.
- Aucune modification des protections GitHub, des environnements, des secrets ou de Vercel.
- Aucune exécution de `test:neon:supplier:advanced`.
- Journaux CI et journaux Neon/Vercel non lisibles : statuts et métadonnées uniquement.

## Étapes suivantes (en attente de validation explicite)

1. Propriétaire : configurer Vercel (branche de production, déploiement automatique) et la protection de `main` (étape transitoire d'abord).
2. Comparer `detect-secrets` entre `origin/main` et `4db9ef9`.
3. Relire `figer-reference-visuelle.yml`.
4. Décider de l'application de la migration `20261010120000` sur une base de test, puis en production, sur autorisation explicite.
5. Phase 2 (Neon préprod) et phase 3 (Clerk, Wallets, limiteur de débit préprod) : non commencées, uniquement après validation explicite.
