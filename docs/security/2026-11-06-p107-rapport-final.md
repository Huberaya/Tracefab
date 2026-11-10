# P10.7 — Finalisation de l'identité runtime et du HMAC · Rapport final A–G

**Date** : 2026-11-06 (Europe/Paris) · **Dépôt** : `Huberaya/Tracefab`
**Branche de travail imposée** : `arena/0f697b3e-tracefab` · **PR de la branche** : [#113](https://github.com/Huberaya/Tracefab/pull/113)
**PR visée par la mission** : [#108](https://github.com/Huberaya/Tracefab/pull/108) — **non modifiée**, voir §A.3
**`main`** : `788df22019c0d2b39301678ecfbc43ac868561bf` (protégée, inchangée)
**Tête #108** : `2d62609d37457fe48d191b310965a14b54a6e81a` (`ops/p107-runtime-proof-20261103`, brouillon, 18 commits, 1 fichier, inchangée)
**SHA initial de la branche de travail** : `bfaeae07da4f13e2da80946b7b5b0dc7f6d348a7`
**SHA de la révision applicative vérifiée** : `757af24076716d39b0b7040166ba1c0c06dde3f3`
**SHA final de la branche** : ce rapport est le commit suivant, **documentation seule, aucun code** ; un fichier versionné ne peut pas contenir son propre SHA. Le SHA final est communiqué dans la réponse de l'agent et lisible par `git rev-parse HEAD` / `gh pr checks 113`.

> **DÉCISION : NO-GO.**
> La chaîne cryptographique a été auditée, deux défauts réels ont été mesurés puis corrigés, et 87 assertions d'attaque passent sur PostgreSQL jetable. Mais **aucune clé n'a été provisionnée sur un environnement servant**, **aucune bascule `strict` n'a été activée sur une Preview**, **aucune mesure SQL/HTTP corrélée n'a pu être faite sur Vercel → Prisma → Neon**, et **le rejeu inter-transactions d'un jeton volé reste ouvert**. Un GO exigerait de transformer des preuves locales en preuves d'exploitation ; ce serait une falsification de la conclusion.

---

## A — État initial, état final, périmètre

### A.1 Ce qui existait, ce qui fonctionne, ce qui manque

| Domaine | Constat mesuré |
|---|---|
| **Existant / fonctionne** | P10.5 et P10.6 sont déjà en place : l'application **signe** (`api/_lib/identite-jeton.ts`, `createHmac('sha256')`), la base **vérifie** (`public.tracefab_identity_jeton_utilisateur(text)`, `SECURITY DEFINER`, `search_path` épinglé), la clé est stockée dans `public.tracefab_identity_cles` (aucun privilège pour `tracefab_app`), `tracefab_current_user_id()` ne retombe jamais sur le GUC brut quand un jeton est présent, la rotation essaie toutes les clés `actif`. `strict = false` par défaut (mode permissif de transition). |
| **Partiel** | La vérification est correcte sur l'essentiel mais laissait passer une suffixe après le MAC et une expiration sans plafond ; la comparaison du MAC n'était pas à temps constant. Corrigé par la 71ᵉ migration. |
| **Incorrect (mesuré avant correction)** | `corps.mac.EXTRA` → identité rendue ; `exp = 999999999999` → identité rendue ; `v_candidat = v_mac` en texte. Mesures du 2026-11-06 sur PGlite 0.5.12 / PostgreSQL 18.6, chaîne de 70 migrations, clé générée en mémoire. |
| **Manque** | Aucune clé d'identité sur un environnement servant ; aucune Preview représentative déployée avec `strict = true` ; aucun accès Neon/Clerk/Vercel en lecture ; aucun corrélat HTTP ↔ SQL. |
| **Testé dans cette mission** | 87 assertions sur chaîne complète de 71 migrations, 20 scénarios cryptographiques, rotation/révocation, portée des GUC sur connexion réutilisée, élévation de privilèges, compatibilité RLS, fail-closed. 155/155 scripts `test:*` en local. CI verte sur `757af24`. |
| **Jamais démontré** | Rôle PostgreSQL *effectif* du déploiement Vercel, appartenances transitives du cluster Neon, présence/format de la clé par cible Vercel, bascule `strict` réelle, parcours HTTP authentifiés, cohérence Preview ↔ Production, absence de contournement RLS en Production. |

### A.2 Noms réels — le prompt ne correspondait pas à l'implémentation

| Nom cité dans la mission | Réalité du dépôt |
|---|---|
| `TRACEFAB_IDENTITY_KEY` | **Existe** : `api/_lib/identite-jeton.ts` → `etatCleIdentite()` / `cleIdentiteValide()` / `CleIdentiteInvalide`. Hex, paire, ≥ 64 caractères. **Aucune valeur n'est écrite ni lue ici.** |
| `TRACEFAB_IDENTITY_MODE` | **N'existe pas** (0 fichier). |
| `TRACEFAB_IDENTITY_STRICT` | **N'existe pas** (0 fichier). |
| *« mode strict »* | Ce n'est **pas** une variable d'environnement : c'est une colonne `BOOLEAN` d'une ligne unique, `public.tracefab_identity_politique.strict`, lisible par le runtime mais non modifiable par lui. La bascule est un `UPDATE` par le **propriétaire de la table**, pas un redeploy. |
| `tracefab_identity` | Chaîne d'usage dans le **corps signé** (`v1\|user\|org\|tracefab_identity\|exp`). Le GUC, lui, s'appelle **`tracefab.identity`** (avec un point). |
| *« registre »* | `public.tracefab_runtime_function_registry` (95 entrées sur la chaîne). La correction n'en ajoute aucune. |
| *« HMAC »* | `public.hmac(convert_to(corps,'UTF8'), secret, 'sha256')` de **pgcrypto**, appelée uniquement depuis une fonction `SECURITY DEFINER`. Les deux seules fonctions nommées `hmac` dans `public` sont les primitives pgcrypto (`SECURITY INVOKER`, `IMMUTABLE`, `bytea`) : ce ne sont pas des oracles de signature, et le runtime ne peut pas leur fournir une clé stockée (mesuré : `42501`). |
| *« GUC »* | `tracefab.user_id`, `tracefab.user_email`, `tracefab.active_organization_id`, `tracefab.identity` (tous posés en `set_config(..., true)`, **transaction-local**), `tracefab.public_context`, `tracefab.internal_document_update`. |
| *« Prisma »* | `api/_lib/context.ts` → `withTracefabUserContext` / `withTracefabWorkerContext` / `withTracefabPublicContext` ; le jeton est posé sur le `tx` de la transaction. |
| Accès à la sonde | `GET /api/internal/p2-readiness` (avec `TRACEFAB_NOTIFICATION_WORKER_SECRET`), `?identity=1` pour `probeDatabaseIdentity()`, `?probe=live` pour les services. Sans secret : `worker_unauthorized` (mesuré le 06/11 sur Production). |

### A.3 Pourquoi la PR #108 n'a pas été modifiée

La session est liée à `arena/0f697b3e-tracefab` ; il est interdit de changer de branche, d'en créer une autre ou de pousser ailleurs. La tête de #108 est une **autre** branche (`ops/p107-runtime-proof-20261103`). Aucun rebase, aucun push, aucun commit n'a donc été fait sur #108. La procédure exacte de report, à exécuter par un mainteneur après validation, est en §F.4. **Ce rapport ne prétend pas avoir livré #108.**

### A.4 Ce qui a été livré (4 fichiers, +807/−1 sur `757af24`)

| Fichier | Rôle |
|---|---|
| `prisma/migrations/20261106120000_p107_hmac_forme_canonique_et_ttl/migration.sql` | 71ᵉ migration, 197 lignes. `CREATE OR REPLACE` sur **une seule** fonction existante. |
| `scripts/test_p107_chaine_confiance_pglite.mjs` | 608 lignes, 87 assertions, PGlite. Aucun secret, aucun accès distant. |
| `package.json` | `test:hmac:chaine-confiance` (pris en charge par la boucle CI « Suite complete des scripts test:* »). |
| `docs/experience/CHANTIERS-RESTANTS.md` | Compteur 70 → 71 et description de la correction. |

Aucune migration déjà appliquée n'a été modifiée ; `20261006210000_plm_erp_gs1_interoperability` et son **checksum historique** n'ont pas été touchés (le dossier ne figure pas dans le diff). P10.7 et la réconciliation globale Neon restent deux chantiers séparés.

---

## B — Identité PostgreSQL effective

**Niveau 1 (jetable local) — MESURÉ.** Sous `SET SESSION AUTHORIZATION tracefab_app` (seule modélisation fidèle d'une connexion applicative ; un simple `SET ROLE` depuis une session superutilisateur autorise `SET ROLE` vers n'importe quel rôle et aurait produit une conclusion fausse) :

| Mesure | Résultat |
|---|---|
| `current_user` / `session_user` | `tracefab_app` / `tracefab_app` |
| Attributs | `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEROLE`, `NOCREATEDB` |
| Appartenances **transitives** (CTE récursive sur `pg_auth_members`) | aucune ne porte `rolsuper` ni `rolbypassrls` ; `pg_auth_members` de `tracefab_app` = `[]` |
| `SET ROLE tracefab_worker` / `tracefab_migrator` / `postgres` / `neondb_owner` | **4 refus mesurés** (`permission denied to set role`) |
| `SELECT secret FROM tracefab_identity_cles` | `42501 permission denied` |
| `UPDATE tracefab_identity_politique` | `42501 permission denied` |
| `ALTER TABLE … DISABLE ROW LEVEL SECURITY` | refusé |
| Primitives HMAC avec clé stockée | refusé |
| 128 fonctions `SECURITY DEFINER` | toutes avec `search_path` épinglé, **aucune** exécutable par `PUBLIC` (`aclexplode` sur `acldefault`) |
| Propriétaire de `tracefab_identity_cles` et du vérificateur | rôle de migration (`postgres` sur le jetable) ; vérificateur `SECURITY DEFINER` avec `search_path=pg_catalog, public` |

**Niveaux 3/4 — NON MESURÉ.** Aucun `DATABASE_URL`, `TF_RLS_APP_URL`, `TRACEFAB_LECTURE_URL`, `DATABASE_ADMIN_URL`, `psql`, `neonctl`, `vercel` CLI, ni connecteur `neon`/`clerk` (`unsupported`) n'est disponible. Le connecteur Vercel est `limited=true`, `list_teams=[]`, et `list_projects` / `list_deployments` / `list_env_vars` / `get_project` / `get_deployment` répondent `Access denied` (ou 404). `gh api deployments` donne des déploiements, pas l'identité SQL d'un processus. Le document de #108 (`2026-11-03-p107-preuve-runtime-production.md`) rapporte une mesure du **2026-11-03** (`current_user=session_user=tracefab_app`, PG 18.6, `identityKeyState=absente`) : c'est une preuve **historique**, pas une mesure du 06/11, et elle concluait déjà **NO-GO**. **Je ne l'ai pas réutilisée comme preuve courante.**

**Corrélation HTTP → Prisma → pool → Neon : NON EXÉCUTÉE.** Les URLs de Preview et de Production répondent « Vercel SSO / Login » ; `/api/health` (`ok:true`) et `/api/config` (clé publique Clerk) sont publics et ne prouvent ni SHA, ni base, ni RLS, ni rôle. `?identity=1` exige le secret worker, absent. Aucun contournement SSO n'a été tenté.

---

## C — Audit cryptographique du HMAC

### C.1 Conception : validée, pas réécrite

La frontière est la bonne : **l'application signe, PostgreSQL vérifie**. La clé n'est jamais accessible au rôle runtime ; un simple contrôle applicatif avant SQL ne serait pas suffisant, et il n'est pas utilisé comme tel. `tracefab_current_user_id()` lit le corps **signé**, pas le GUC. L'algorithme est HMAC-SHA256 de la bibliothèque standard (`node:crypto` côté app, `pgcrypto` côté base) — aucun mécanisme maison. Corps : `v1|<user_id>|<org_id>|tracefab_identity|<exp>`, MAC = 64 hex minuscules, TTL émis 60 s, horloge de la **base**.

### C.2 Trois défauts mesurés puis corrigés (71ᵉ migration)

| | Avant (mesuré) | Après (mesuré) |
|---|---|---|
| **D1 sérialisation non canonique** | `split_part(p_jeton,'.',1\|2)` ignorait tout ce qui suit le 2ᵉ point : `corps.mac.EXTRA` rendait l'identité | Regex `^[^.]+\.[0-9a-f]{64}$` : suffixe, double point, MAC tronqué, MAC non hex, champ surnuméraire → `NULL` |
| **D2 aucun plafond d'expiration** | `exp = 999999999999` accepté | `exp` = exactement 10 chiffres sans zéro initial, `now() < exp <= now() + 600 s` ; `+120 s` et `+599 s` acceptés, `+3600 s` et `+999999999999` refusés |
| **D3 comparaison non constante** | égalité de texte avec sortie anticipée | XOR accumulé sur les 32 octets, sans `RETURN` anticipé, pour **chaque** clé active ; `v_valide` agrégé |

Postconditions de la migration : `SECURITY DEFINER` conservé, `search_path` épinglé, `EXECUTE` conservé pour `tracefab_app`. `CREATE OR REPLACE` préserve OID, propriétaire et ACL. Aucun jeton légitime émis par `signerIdentite()` ne change de format — les suites P10.5/P10.6/P10.7 n'ont pas eu à être réécrites, et aucune ne l'a été.

### C.3 20 scénarios d'attaque — tous exécutés

`C01` signature valide · `C02` MAC modifié · `C03` identité modifiée après signature · `C04` tenant modifié après signature · `C05` usage non autorisé · `C06` expiré · `C07` signature absente · `C08` clé non provisionnée · `C09` MAC d'une autre clé · `C10` version inconnue · `C11` champ obligatoire absent · `C12` suffixe ambigu · `C13` mauvaise catégorie · `C14` signature d'un autre usage · `C15` réutilisation dans une autre transaction · `C16` rejeu d'un jeton expiré · `C17` rotation (ancienne clé encore acceptée) · `C18` révocation (ancien jeton refusé) · `C19` contexte user/tenant incohérent · `C20` GUC forgé seul en `strict`. **Aucun test n'est un test de présence de chaîne** : chaque assertion appelle le moteur. Des témoins positifs accompagnent les refus, pour qu'un vérificateur cassé ne « réussisse » pas tous les tests.

### C.4 Risques résiduels — non dissimulés

| Id | Risque | État |
|---|---|---|
| **R1 (élevé)** | **Rejeu inter-transactions** : un jeton `v1` valide est accepté dans une transaction distincte (mesuré, assertion dédiée). Le corps ne porte ni nonce, ni identifiant de clé/version, ni transaction/request id, ni type d'opération. Le plafond de 600 s réduit la fenêtre mais n'est **pas** une protection anti-rejeu. | **OUVERT** |
| **R2 (moyen)** | Aucune liaison du jeton à une opération, un service émetteur ou une transaction : un jeton volé vaut pour toute route du même tenant pendant sa durée de vie. | OUVERT |
| **R3 (moyen)** | Pas d'identifiant de clé dans le corps : la rotation exige d'essayer toutes les clés actives (comportement correct, mais non ciblé). | OUVERT |
| **R4 (structurel)** | `strict = false` partout où la base n'a pas été basculée : en permissif, un appel **sans jeton** garde l'ancien comportement (`tracefab.user_id`). La chaîne HMAC ne protège que les appels qui présentent un jeton. | OUVERT tant que la bascule n'est pas faite et prouvée |
| **R5** | Le correctif anti-rejeu « à usage unique » casserait les retries HTTP/worker (chaque retry d'un même corps serait refusé). Il exige une conception **v2** liée à `pg_current_xact_id()` et une validation sur une Preview réelle. | **Non implémenté volontairement** : je n'ai pas activé un mécanisme que je ne pouvais pas éprouver en conditions réelles. |

---

## D — Tests et contrôles globaux

| Contrôle | Résultat |
|---|---|
| `npm run test:hmac:chaine-confiance` | **87 assertions, 0 échec**, 5 exécutions consécutives stables (un test de falsification non déterministe a été corrigé, pas désactivé) |
| Chaîne de migrations | **71/71** appliquées sans erreur sur PGlite/PostgreSQL 18.6 |
| Boucle exacte de CI `Suite complete des scripts test:*` | **155/155** en local. 21 suites navigateur ont d'abord échoué sur `libnspr4.so` absent du sandbox ; relancées avec `LD_LIBRARY_PATH=/tmp/al2023/lib` → **21/21 OK**. Cause environnement, aucune modification de code, aucun test désactivé. |
| `npm test`, `api:typecheck` | exit 0 |
| `test:isolation:globale` 77/0 · `test:active-tenant-routes` 79/0 · matrices tenant · `test:chantiers` · `test:db-routing` · `test:db-guard` · `test:workflow-policy` · `test:ci-no-production-access` · `test:migrations:*` · `test:tables-ecriture-directe` · `test:objets-sql:comparaison` | tous exit 0 |
| `git diff --check` | propre |
| Fuite de secret | grep sur les fichiers livrés : **aucune valeur**, aucune chaîne de connexion, aucune clé. Les clés de test sont `crypto.randomBytes(32)` en mémoire, jamais écrites sur disque ni affichées (y compris aucune empreinte). |
| **CI sur `757af24`** | `CI` run [42204979544](https://github.com/Huberaya/Tracefab/actions/runs/42204979544) : 4/4 jobs `success` (Socle, Base — isolation RLS exécutée sur **PostgreSQL 17 jetable**, Vérification — « Suite complete des scripts test:* » concluante, Parcours navigateur réel). Runs migrations [42204979560](https://github.com/Huberaya/Tracefab/actions/runs/42204979560) et `42204974527` : `success`. `gh pr checks 113` : **7/7 PASS** dont Vercel et Vercel Preview Comments. Les journaux détaillés par script ne sont pas téléchargeables (`gh api …/logs` → `EOF`) : l'exécution de la nouvelle suite est établie par la boucle CI qui énumère `package.json` à l'exécution, par le step « Suite complete » concluant, et par les 155/155 locaux — **pas** par une ligne de log que je n'ai pas lue. |
| Suites `test:p105:*` / `p106:*` / `p107:*` / `test:neon:*` / `test:jetables:*` | **NON EXÉCUTÉ (code 2)** sans `DATABASE_URL` / `TF_RLS_APP_URL` / rôles applicatifs sur un serveur PostgreSQL réel. Ni PASS ni échec de code ; elles ne sont pas comptées dans les 87 assertions. |
| `verify:prisma-client` / `npm run build` | non exécutés localement (client Prisma types-only, `binaries.prisma.sh` bloqué en TLS) ; le job **Socle** de CI les exécute et est vert. |

---

## E — Les quatre niveaux de preuves

| Niveau | État | Ce qui est réellement prouvé |
|---|---|---|
| **1 · Local / statique + jetable embarqué** | ✅ **ACQUIS** | Cartographie, noms réels, 71/71 migrations, 87 assertions HMAC/RLS/rôles, 155 scripts, aucun secret, diff propre. |
| **2 · PostgreSQL jetable serveur** | ✅ **ACQUIS (CI)** | Run [42204979544](https://github.com/Huberaya/Tracefab/actions/runs/42204979544) job « Base » : chaîne sur **PostgreSQL 17** avec rôles applicatifs, verte sur `757af24`. La suite P10.7 elle-même tourne sur PGlite ; elle n'a **pas** été rejouée sur le PostgreSQL 17 serveur. |
| **3 · Branche Neon isolée + Preview Vercel représentative** | ❌ **NON EXÉCUTÉ** | Aucune branche Neon créée, aucune migration appliquée sur Neon, aucune clé provisionnée, aucun déploiement Preview de cette révision avec `strict = true`, aucun parcours HTTP authentifié, aucune corrélation Vercel→Prisma→pool→Neon. |
| **4 · Production en lecture seule** | ❌ **NON EXÉCUTÉ** | Seules les réponses publiques ont été observées (`/api/health` `ok`, `/api/config` publique, readiness `worker_unauthorized`). Aucun `SELECT` live sur `pg_roles`, `pg_policies`, `_prisma_migrations`, `tracefab_identity_politique` ou `tracefab_identity_cles`. Aucune écriture, aucun secret modifié, aucun déploiement Production déclenché. |

**Aucune preuve de niveau 3 n'a été présentée comme preuve de niveau 4, et aucune preuve de niveau 1/2 comme preuve de niveau 3.**

### E.1 Dépendances bloquantes et responsable de l'autorisation

| Dépendance | État mesuré | Responsable de l'autorisation |
|---|---|---|
| Jeton Vercel avec portées `projects:read`, `deployments:read`, `env:read`, et périmètre d'équipe | connecteur `limited=true`, `teams=[]`, `Access denied` sur l'inventaire | **Propriétaire du projet Vercel / administrateur de l'équipe** (seul détenteur des portées). À reconnecter dans Arena ou fournir un jeton dédié. |
| Accès Neon (branche isolée, `DATABASE_ADMIN_URL`, `DATABASE_URL`) | connecteur `neon` = `unsupported`, aucune variable, aucun CLI | **Administrateur de l'organisation Neon**, après vérification de l'identité de la branche et de l'absence de données de Production. |
| Secret worker `TRACEFAB_NOTIFICATION_WORKER_SECRET` et comptes Clerk de test (U/A/B/S) | absents ; connecteur `clerk` = `unsupported` | **Administrateur Clerk / mainteneur des secrets Vercel**. |
| `actions:write` pour déclencher un harnais HTTP | `gh workflow run … --ref main` → `403 Resource not accessible by integration` | **Mainteneur du dépôt GitHub**. |
| Autorisation d'activer `strict` sur une Preview, puis éventuellement en Production | **non demandée, non obtenue** | **Le demandeur / responsable sécurité données clients** — la réussite Preview n'autorise jamais l'activation automatique en Production. |

Aucun de ces accès n'est détenu par l'agent. Les parties indépendantes (Phases 0→2, audit, correction, tests, CI, documentation, procédure) ont été poursuivies jusqu'au bout malgré les blocages.

---

## F — Procédure exacte d'exploitation (préparée, **non exécutée**)

À appliquer **uniquement sur un environnement isolé**, jamais en Production, après l'autorisation humaine dédiée. Chaque étape a une preuve de sortie. Aucune valeur de clé n'apparaît dans cette procédure.

| Étape | Action exacte | Preuve attendue |
|---|---|---|
| **F1** | Vérifier l'identité de la branche Neon isolée : nom, `SELECT current_database()`, absence de données de Production, état `_prisma_migrations`. | Rapport de vérification de destination, daté. |
| **F2** | Appliquer la chaîne (dont la 71ᵉ) sur cette branche via `scripts/migrer_fidelement.mjs` avec `TF_ALLOW_WRITE=oui` et garde de cible jetable. | 71 migrations, 0 inachevée ; le checksum PLM/GS1 reste traité séparément. |
| **F3** | Générer **une clé distincte par environnement** (développement / tests / Preview / Production), 32 octets CSPRNG, format hex ≥ 64, dans le gestionnaire de secrets. **Aucune clé Preview réutilisable en Production.** Aucune valeur dans Git, PR, log, capture ou conversation. | État de provisionnement + identifiant de version uniquement. |
| **F4** | Poser deux clés actives (chevauchement) avec `TF_ALLOW_PROVISIONING=oui`, `DATABASE_ADMIN_URL=<branche isolée>`, `TF_IDENTITY_KEY_HEX` injecté par le mécanisme sécurisé, `node scripts/provisionner_cle_identite.mjs --version N`. Contrôle à froid : `node scripts/provisionner_cle_identite.mjs --verifier` (lecture seule). | `cles_actives = 2`, `tracefab_app` ne peut ni lire ni modifier la table. |
| **F5** | Déployer la révision applicative `757af24` sur une **Preview dédiée** pointant vers cette branche, avec la variable `TRACEFAB_IDENTITY_KEY` ciblée sur **Preview uniquement** (jamais Production). | `GET /api/internal/p2-readiness` (secret worker) → `identityTokens.configured = true`, `mode = 'signe'`. |
| **F6** | Corrélation : `GET /api/internal/p2-readiness?identity=1` + `SELECT` en lecture seule sur la branche, mêmes `current_user`, `session_user`, `pg_backend_pid`, mode du pooler, `strict`. | Une seule mesure concordante HTTP ↔ SQL, horodatée. |
| **F7** | Activer `strict` **sur la branche isolée**, par le propriétaire : `UPDATE public.tracefab_identity_politique SET strict = true, modifie_le = now() WHERE singleton;` | `mode_identite = 'strict'`, puis rejouer les 87 assertions et les parcours métier (produits, variantes, DPP, traçabilité, documents, imports/exports, fournisseurs, ERP/PLM, webhooks, workers, admin, public, résolveurs). Aucune régression tolérée. |
| **F8** | Rotation : désactiver l'ancienne clé (`--retirer-anciennes`), vérifier nouveau jeton accepté / ancien refusé, observer au moins un TTL + un cycle de tâches. | Aucune coupure, aucune erreur `authentication_required` anormale. |
| **Retour arrière** | `UPDATE public.tracefab_identity_politique SET strict = false, modifie_le = now() WHERE singleton;` par le propriétaire, puis retirer la clé de Preview. | Retour à l'état permissif mesuré, sans toucher à Production. |
| **Production** | **Interdite dans cette mission.** Si une action y est nécessaire : préparer action exacte, raison technique, ressources, risque, prérequis, retour arrière, preuve attendue, puis **attendre une autorisation spécifique distincte**. L'identité réelle Production est inobservable en lecture seule sans `?identity=1` + secret worker : la modification temporaire minimale serait l'ajout d'un accès sonde en lecture seule derrière ce secret, avec retrait immédiat — à demander explicitement, pas à improviser. | Aucune action Production effectuée. |

### F.4 Report vers la PR #108 (à faire par un mainteneur)

La branche de #108 est `ops/p107-runtime-proof-20261103` (`2d62609…`). Depuis un poste autorisé :
`git fetch origin && git checkout ops/p107-runtime-proof-20261103 && git cherry-pick 757af24076716d39b0b7040166ba1c0c06dde3f3 && git push origin ops/p107-runtime-proof-20261103`, puis relire `gh pr diff 108`, relancer `gh pr checks 108`, et joindre ce rapport. **Aucune fusion** de #108 ni de #113 n'a été effectuée.

---

## G — Critères de clôture et décision

L'énumération littérale `P107-01…18` n'est versionnée dans aucun fichier du dépôt ; les libellés ci-dessous sont **reconstitués à partir des 12 objectifs et des clauses de clôture de la mission** pour rendre le verdict traçable. Un critère critique n'est jamais déclaré acquis sur simple inspection statique.

| Critère | Objet | État |
|---|---|---|
| P107-01 | Reprise intégrale (SHA `main`, SHA #108, commits, CI, Preview, migrations, configs, derniers travaux) | 🟡 PARTIEL — SHA/commits/CI/configs repris ; Preview et Neon non mesurés |
| P107-02 | Noms réels découverts, sans présomption | ✅ ACQUIS (§A.2) |
| P107-03 | Identité PostgreSQL effective par SQL | 🟡 PARTIEL — mesurée sur jetable uniquement |
| P107-04 | Corrélation HTTP Vercel → Prisma → pool → Neon | ❌ NON DÉMONTRÉ |
| P107-05 | Rôles, appartenances transitives, `SET ROLE`, privilèges, propriétaires, contournements RLS | 🟡 PARTIEL — catalogue jetable complet, cluster réel non mesuré |
| P107-06 | Audit HMAC (authenticité, intégrité, falsification, rejeu, usages, expiration, rotation, non-fuite) | 🟡 PARTIEL — audit complet, **rejeu ouvert (R1)** |
| P107-07 | Payload canonique, frontière de confiance, vérification côté PostgreSQL | ✅ ACQUIS LOCAL — conception validée + D1/D2/D3 corrigés et mesurés |
| P107-08 | 20 tests d'attaque | ✅ ACQUIS — 20 scénarios exécutés + témoins positifs |
| P107-09 | Protection GUC / transactions / pool / `SECURITY DEFINER` | ✅ ACQUIS LOCAL — A→B→∅→falsifié→erreur→reprise, 128 fonctions auditées |
| P107-10 | Génération / stockage / rotation / révocation par environnement, sans exposer de valeur | 🟡 PARTIEL — procédure exacte et outil existant vérifiés ; **aucun provisionnement réel** |
| P107-11 | `strict` fail-closed activé réellement sur Preview représentative | ❌ NON DÉMONTRÉ — blocage accès |
| P107-12 | Compatibilité routes métier, RLS, DPP, workers, Prisma, Neon | 🟡 PARTIEL — 155 scripts + RLS jetable ; aucun parcours Preview/Neon |
| P107-13 | Migrations P10.7 sans toucher aux appliquées ni au checksum PLM | ✅ ACQUIS — 71ᵉ additive, diff contrôlé, checksum PLM hors périmètre |
| P107-14 | Niveau 1 — preuves locales | ✅ ACQUIS |
| P107-15 | Niveau 2 — PostgreSQL jetable | ✅ ACQUIS (CI PostgreSQL 17) |
| P107-16 | Niveau 3 — Neon isolé + Preview | ❌ NON DÉMONTRÉ |
| P107-17 | Niveau 4 — Production lecture seule | ❌ NON DÉMONTRÉ |
| P107-18 | Corrections, tests après chaque correction, contrôles globaux, diff Git, SHA final, rapport | ✅ ACQUIS pour le périmètre local/CI ; SHA final = commit de ce rapport (documentation seule) |

**Bilan : 8 acquis, 6 partiels, 4 non démontrés, 0 échec critique de code.** Aucun test désactivé, aucun contrôle contourné, aucun secret exposé, aucune modification de `main`, aucune fusion, aucun déploiement Production, aucune modification de secret ou de rôle Production, aucune désactivation RLS, aucune opération destructive sur Neon.

### Verdict : **NO-GO**

Les 12 objectifs et les 18 critères ne sont **pas** satisfaits. Il manque, sans possibilité de les simuler honnêtement : une clé réellement provisionnée par environnement, une Preview représentative avec `strict = true`, la corrélation HTTP ↔ SQL, les preuves Neon isolé et Production en lecture seule, et la fermeture du rejeu (R1). Le travail livré est une **correction vérifiée et une procédure d'activation prête**, pas une activation. Priorité absolue aux données clients : aucun compromis de sécurité n'a été consenti pour obtenir artificiellement un GO.

**Liens** : [PR #108](https://github.com/Huberaya/Tracefab/pull/108) · [PR #113](https://github.com/Huberaya/Tracefab/pull/113) · [CI 42204979544](https://github.com/Huberaya/Tracefab/actions/runs/42204979544) · [Migrations 42204979560](https://github.com/Huberaya/Tracefab/actions/runs/42204979560) · `docs/security/2026-11-02-p107-plan-activation-stricte.md` · `docs/security/2026-11-03-p108-revue-finale.md` · `docs/security/preuves-distantes-niveaux-2-3-2026-11-06.md` (mission #113, **non commité, non écrasé**).
