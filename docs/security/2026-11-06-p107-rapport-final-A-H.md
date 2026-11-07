# P10.7 — Réconciliation finale, anti-rejeu et preuves distantes

**Rapport final A–H** · **Date** : 2026-11-06 (UTC) · **Branche** : `arena/0f697b3e-tracefab` (`pr_open`, PR #113)
**SHA de référence (Phase 0)** : `37552b198c0ef1d8b8d4507c802e5d1b79ff7733`
**SHA de code candidat** : `4cf760f6f61ccd3b9cd34b2188f14efd08666191` (commit + push sur la seule branche autorisée)
**SHA de ce rapport** : commit documentaire suivant (voir réponse finale)

> **Verdict : NO-GO global · NO-GO Production.** Les chantiers A–E sont mesurés, corrigés localement et vérifiés sur le SHA exact ; F (Neon isolé), G (Preview authentifiée) et H (Production lecture seule privilégiée) restent **BLOCKED** faute d'accès. Aucun `BLOCKED` n'est transformé en `PASS`, aucun GO artificiel n'est recherché, aucune fusion, aucun déploiement Production, aucune bascule `strict` distante.

---

## 0. Synthèse et cycle imposé

| Étape | Ce qui a été fait | Statut |
|---|---|---|
| Diagnostiquer | Phase 0 sur l'état réel ; inventaire PR #108–#114, migrations, dépendances, permissions GitHub/Neon/Vercel/Clerk | **PASS** |
| Mesurer | 5 chaînes de migrations, 4 scénarios outbox, 23 mesures anti-rejeu, 107 assertions HMAC, rejeu du renommage #114 | **PASS** |
| Corriger | suite HMAC enrichie, harnais reproductibles, manifeste à empreintes, correctif outbox **candidat**, step CI de version PostgreSQL | **PASS** (local) |
| Tester | 156/156 scripts `test:*` en local, 15 contrôles liés, 6 chaînes PGlite, boucle CI complète | **PASS** |
| Intégrer | commit + push sur `arena/0f697b3e-tracefab` uniquement ; aucune autre branche ni PR modifiée | **PASS** |
| Vérifier | CI `42249334243` 4/4 jobs, migrations `42249334409`, `gh pr checks 113` 7/7 PASS sur `4cf760f` ; `git diff --check` | **PASS** |
| Documenter | ce rapport, manifestes JSON, chaîne canonique, preuves CI | **PASS** |

**Décisions de clôture séparées**

| Critère | Décision | Motif directeur |
|---|---|---|
| **GO technique** | **NO-GO** | Toutes les preuves locales et CI sont vertes, mais la forme de propriété non superutilisée n'est mesurée que sur PGlite (le PostgreSQL 17.11 de CI a `prop=postgres`), et la compatibilité sur un environnement **déjà migré** après le renommage #114 n'est pas prouvée |
| **GO anti-rejeu** | **NO-GO** | Stratégie retenue : **ne pas implémenter v2**, risque résiduel R1 explicitement accepté ; aucun anti-rejeu livré |
| **GO environnemental** | **NO-GO** | F/G/H = `BLOCKED` ; pas de Neon isolé, pas de Preview authentifiée, pas de `strict` Preview, pas de corrélation HTTP/SQL distante |
| **GO intégration** | **NO-GO** | Checks verts et diff relu, mais #114 a avancé en cours de mission avec un renommage de migration déjà déployée en Preview, #110/#112 restent non intégrables, et le correctif outbox reste un candidat non matérialisé en migration du dépôt |
| **Production** | **NO-GO** | Nécessitera une **nouvelle autorisation explicite** ; aucune précondition de bascule n'est mesurée sur l'environnement réel |

---

## 1. Phase 0 et état Git réel

Mesures du 06-11 à 15:25:36Z, puis **remesurées à 15:57:09Z après détection d'une avancée distante** :

- worktree unique `/home/user/Tracefab`, branche `arena/0f697b3e-tracefab`, HEAD de Phase 0 `37552b1`, `git status` = un seul fichier non versionné (`preuves-distantes-niveaux-2-3-2026-11-06.md`), aucun commit exécuté depuis.
- `main = 788df22019c0d2b39301678ecfbc43ac868561bf`, inchangé, protégé (lecture de la protection : 403).
- CI de référence `42207575971` sur `37552b1` : 4/4 jobs `success` ; `gh pr checks 113` 7/7 PASS ; run migrations `42207575966` `success`.
- `757af24` = 4 fichiers (`+807/−1`) : migration corrective `20261106120000_p107_hmac_forme_canonique_et_ttl` (sha256 `e66c4706…`), suite HMAC, `package.json`, `CHANTIERS-RESTANTS.md`. `37552b1` = `757af24` + **uniquement** `docs/security/2026-11-06-p107-rapport-final.md` (214 lignes). Corrective unique vérifiée.
- PR : #108 `2d62609` draft `CLEAN` ; #109 `751004e` `BLOCKED` ; #110 `9b86f18` OPEN ; #111 `064fb34` **MERGED dans #110** ; #112 `da8fa54` draft ; #113 `37552b1` OPEN `CLEAN` ; #114 `537bc31` `CLEAN`.

### 1.1 Événement postérieur à la Phase 0 — explication des différences

Le **06-11 à 15:34:35Z**, après la Phase 0, la PR **#114 a avancé** : `537bc31` → **`f0aeb51cb52ce778f7f9a5e857438603d81fa5ad`**, branche `arena/b8fe1a44-tracefab`, `mergeStateStatus` `CLEAN` → `BLOCKED`. Le nouveau commit `f0aeb51` :

1. **renomme** `20261105120000_identite_systeme_signee` → `20261106130000_identite_systeme_signee` ;
2. durcit son propre vérificateur `tracefab_identite_systeme_jeton_valide` (MAC 64 hex minuscules, plafond 600 s par horloge de la base, XOR 32 octets sans sortie anticipée avec remise à zéro par clé) ;
3. met à jour 5 fichiers de documentation/tests de sa branche.

**Conséquence : toutes les mesures de cette mission ont été rejouées sur `f0aeb51`** (`refs/remotes/audit/pr114-nouveau`), l'ancienne tête restant témoin (`A2`, `B2`). Le durcissement de #114 porte sur le vérificateur **système**, celui de `20261106120000` sur le vérificateur **utilisateur** : les deux migrations sont complémentaires, la chaîne canonique `73/73` s'applique sans erreur. La branche de travail, `main` et #108–#113 n'ont pas bougé.

### 1.2 Permissions réellement disponibles

| Accès | Mesure | Effet |
|---|---|---|
| GitHub | `Huberaya` via `GH_TOKEN`, `admin/maintain/pull/push/triage=true` | push sur la branche imposée : autorisé ; `branches/main/protection` 403 ; `actions/permissions/workflow` 403 ; `gh workflow run` 403 |
| Vercel | `get_authenticated_user` → `limited=true`, `defaultTeamId=team_BdnOPU97H1GOmMxy7T06nijQ`, `list_teams=[]` ; `list_projects`, `list_deployments`, `list_shared_env_vars`, `get_team`, `get_deployment` → `Access denied` / 404 | aucun inventaire, aucune variable par cible, aucun détail de déploiement |
| Neon / Clerk | connecteurs `unsupported` ; aucun `DATABASE_URL`, `NEON_API_KEY`, `VERCEL_TOKEN`, `CLERK_SECRET_KEY`, `neonctl`, `vercel`, `psql`, `pg_ctl`, `initdb`, `postgres`, `docker` | aucune base distante, aucun utilisateur de test |
| HTTP public | `tracefab.vercel.app` : `/api/health` `{"ok":true}`, `/api/config` clé **publique** seule, `/api/internal/p2/readiness` `worker_unauthorized` ; URLs `*.vercel.app` des déploiements : **écran SSO Vercel** | lectures seules, aucune donnée métier, aucun SHA servi lisible, aucune protection contournée |

---

## 2. Chantier A — Préservation et rejeu des corrections HMAC

La conception HMAC validée n'a **pas** été réécrite : `20261106120000` ne fait que `CREATE OR REPLACE` sur `tracefab_identity_jeton_utilisateur(text)`. Forme `v1|<user>|<org>|tracefab_identity|<exp>.<HMAC-SHA256 hex>`, usage `tracefab_identity`, GUC `tracefab.identity`, TTL applicatif 60 s, plafond vérificateur 600 s, politique `strict` non désactivable par le runtime, clés illisibles/insignables par `tracefab_app`.

**Suite portée de 87 à 107 assertions, 0 échec** (`npm run test:hmac:chaine-confiance`, PGlite/PostgreSQL 18.6, clés `crypto.randomBytes(32)` en mémoire) :

- forme canonique, suffixe ambigu `.EXTRA`, MAC falsifié (remplacement déterministe du dernier caractère, 5 répétitions), MAC en majuscules refusé, `exp=999999999999` refusé, bornes par `extract(epoch FROM now())` ;
- **5 clés actives** essayées sans sortie anticipée, rotation/révocation, aucune clé active → fail-closed ;
- COMMIT / ROLLBACK / connexion réutilisée, isolation des GUC, identités et usages substitués, GUC forgé, frontière d'organisation ;
- **véritable connexion applicative** : `SET SESSION AUTHORIZATION tracefab_app` (pas un simple `SET ROLE` depuis un superutilisateur), `SET ROLE worker/migrator/postgres` refusés, refus de signature par le runtime ;
- inventaire S8bis : `SECURITY DEFINER`, langages SQL/PLpgSQL, propriétaires nommés, `search_path` épinglé, aucune entrée ACL PUBLIC, gardes des 3 fonctions d'attestation par réécriture de `pg_get_functiondef`, absence de relecture du GUC non signé.

**Régression mesurée, non corrigée par choix** : R1, rejeu inter-transactions d'un jeton valide (5 transactions acceptées, rejeu après COMMIT et après ROLLBACK accepté). Voir §5.

---

## 3. Chantier B — Réconciliation des migrations et des PR

**Chaîne canonique unique : `main(69)` + #113(2) + #114(1, tête `f0aeb51`) + correctif outbox candidat(1) = 73 entrées.** Définition et commandes : `docs/security/2026-11-06-p107-chaine-canonique-migrations.md` ; manifeste : `docs/security/2026-11-06-p107-chaine-canonique.json` (73 empreintes sha256, 69 historiques byte-pour-byte).

- Les 69 migrations déjà appliquées de `main` sont conservées **sans renommage ni réécriture**. Aucune migration n'a été ajoutée au dépôt : le correctif outbox reste `docs/security/candidats/…`, matérialisé en `/tmp` par le harnais.
- #110/#111/#112 réécrivent **7** migrations historiques de `main` → **exclues** de la chaîne canonique (liste assertée par le test statique). #109 supersédée par #113 ; #108 documentation seule ; #111 déjà fusionnée dans #110.
- **Collisions** : 4 paires historiques acceptées (`20261006120000`, `20261006200000`, `20261006220000`, `20261017120000`). `20261105120000` **résolue en amont par #114** (renommage) : chaîne étendue 6 → 5 collisions avant préparation. `20261105180000` subsiste **uniquement dans la chaîne étendue** : renom de préparation `…180010` mesuré, aucun renom appliqué sur la chaîne canonique. `20261106120000` ne crée ni ne masque aucune collision. 8 horodatages `HH>23` documentés, non renommés.
- `npm run p107:chaines` : **6 chaînes** appliquées sur PGlite — `A_canonique_114_actuelle` 73/73, `A2_canonique_114_ancienne` 73/73, `B_etendue_110_112` 94/94 (5→4 collisions), `B2_etendue_114_ancienne` 94/94 (6→4), `C_114_seule` 70/70, `D_111_114` 87/87 ; `SECURITY DEFINER` 127→131 ; **75 contrôles de manifeste conformes, 0 écart** (empreintes recalculées sur le contenu réellement appliqué).
- Contrôles : `test:migrations:horodatages`, `test:migrations:controle`, `test:reconciliation-historique`, `test:reconciliation-options`, `test:migration-history`, `test:rejeu-migrations`, `test:reprise-migrations`, `test:divergences-migrations`, `test:scripts-migration-obsoletes`, `test:plm-migrations-jumelles`, `test:chantiers`, `test:db-routing`, `test:workflow-policy`, `test:ci-no-production-access`, `test:reconciliation-chaine-canonique` (**90 assertions/0**) : **15/15 exit 0**.

### 3.1 Risque nouveau : renommage #114 sur un environnement déjà migré

Une Preview a déployé l'ancienne tête `537bc31` le 06-11 à 09:30:00Z (déploiement GitHub `7596820548`, `success`). Son journal `_prisma_migrations` contient potentiellement `20261105120000_identite_systeme_signee`, alors que la chaîne attend `20261106130000_…`.

Scénario `E_rejeu_renommage_114` (base jetable, 72 migrations historiques, journal simulé, ré-application du SQL de la nouvelle tête puis enregistrement du nouveau nom comme le ferait Prisma) : **`SQL REUSSI (idempotent)`, `noms_distincts=2`, `fonction_verif=1`, `colonne_mode=1`**. Le SQL est idempotent (`CREATE OR REPLACE`, `ADD COLUMN IF NOT EXISTS`, `ON CONFLICT DO NOTHING`) mais le journal finit avec **deux noms et deux checksums pour une seule définition d'objets**. La lecture du journal **réel** exige un accès non accordé : ce point reste **`BLOCKED`** et interdit de déclarer la chaîne « compatible avec un environnement déjà migré ».

---

## 4. Chantier C — Dépendance outbox #114 / #111

**Conclusion : #114 n'est PAS autonome de #111.** Cause mesurée : #114 rend claim/complete dépendantes de `public.tracefab_identite_systeme()` (`SECURITY INVOKER`, `EXECUTE` accordé à `tracefab_worker` seulement) ; sur `main` ces deux fonctions restent possédées par le rôle de migration. Avec le propriétaire non superutilisé **modélisé** `tracefab_migrator` et `SET SESSION AUTHORIZATION tracefab_app`, le claim rend `42501 permission denied for function tracefab_identite_systeme`. #111 (`20261105235900`) transfère la propriété au worker et accorde les DML.

| Scénario (tête `f0aeb51`) | Chaîne | Claim | Complete | Sans jeton |
|---|---|---|---|---|
| S1 #114 seule | 70/70 | **FAIL** `42501` | **FAIL** | REFUS |
| S2 #111 + #114 | 87/87 | **PASS** 1 ligne `processing`, `attempts=1` | **PASS** `sent` | `authentication_required` |
| S3 canonique sans correctif | 72/72 | **FAIL** `42501` | **FAIL** | REFUS |
| S3b canonique + correctif candidat | 73/73 | **PASS** | **PASS** | `authentication_required` |

Rôle effectif `tracefab_app` (`session_user = current_user`), propriétaire des fonctions outbox transféré à `tracefab_migrator` pour la modélisation, `worker_update=true`, `app_update=false`, 3 politiques RLS conservées (RLS jamais désactivée), états initial / après claim / après complete consignés dans `docs/security/2026-11-06-p107-outbox-scenarios.json`. **Correctif minimal** : `docs/security/candidats/2026-11-06-proprietaire-outbox-identite-systeme.sql` (1 migration candidate `20261106120300_outbox_owner_identite_systeme`, postconditions par `aclexplode`). Il n'est **pas** appliqué au dépôt : décision laissée à l'intégration humaine.

---

## 5. Chantier D — Anti-rejeu : analyse, comparaison, décision

`npm run p107:antirejeu` → **23 mesures, 0 échec** (PGlite/PostgreSQL 18.6, 71 migrations, `strict=true` jetable, aucun stockage persistant).

**Mesure du défaut** : même jeton v1 → 5 contextes authentifiés dans 5 transactions distinctes ; rejeu après COMMIT accepté ; rejeu après ROLLBACK accepté ; frontière d'organisation refusée (`null`) ; jeton expiré refusé ; aucun nonce / request-id / version de clé / type d'opération dans le corps ; aucun request-id dans `api/_lib/context.ts`. Le TTL de 600 s **n'est pas un anti-rejeu** : il borne la validité, il n'interdit pas la réutilisation dans la fenêtre. Idempotence propre aux opérations, indépendante du jeton : claim #1 = 1 ligne, claim #2 = 0, complete #2 refusé `notification_outbox_item_not_processing`, 1 contrainte `UNIQUE(event_key)`.

**Comparaison des mécanismes**

| Mécanisme | Sécurité | Retries / rollback | Concurrence | Stockage | Complexité | Verdict |
|---|---|---|---|---|---|---|
| TTL 600 s actuel | nul contre le rejeu | neutre | neutre | 0 | 0 | **insuffisant** |
| Nonce à usage unique en base | bon | rollback à traiter, retries à re-signer | verrou/unicité | 1 table + purge | purge, rétention, rotation | écarté (coût opérationnel) |
| Identifiant d'opération + idempotence transactionnelle | bon si généralisé | dépend de chaque écriture | par opération | par opération | généralisation lourde | écarté (périmètre) |
| v2 lié à la transaction / au contexte | bon | retry légitime = nouveau jeton ; nouveau jeton après ROLLBACK | xid distinct | **0 nonce**, 1 `SELECT` par requête | **incompatibilité architecturale** | **non implémenté** |
| Accepter le risque résiduel | — | — | — | 0 | 0 | **retenu** |

Prototype v2 **jetable uniquement, jamais livré** : `txid_current()` distinct par transaction (`897`, `899`, `900`), jeton signé **dans sa transaction** accepté, même jeton rejoué ailleurs `null`, retry légitime accepté, après ROLLBACK nouveau jeton accepté, deux opérations indépendantes distinguées, jeton signé **hors** transaction refusé. C'est précisément le point bloquant : l'application signe le jeton côté Node **avant** l'ouverture de la transaction Prisma ; `pg_current_xact_id()` / `txid_current()` imposeraient de signer après `BEGIN`, donc de refondre la chaîne de signature, les webhooks répétés et les retries. Compatibilité lecture seule / consommation d'un XID sur PostgreSQL 17 non mesurée (`a_evaluer_sur_postgres_17`).

**Décision : ne pas implémenter v2, ni aucun autre anti-rejeu. Risque résiduel R1 explicitement accepté et documenté.** Aucune correction de rejeu n'est revendiquée ; le **GO anti-rejeu reste NO-GO**.

---

## 6. Chantier E — Readiness réelle de l'identité système, rôles et version PostgreSQL

- Rôles jetables non superutilisés : `tracefab_worker`, `tracefab_migrator`, `tracefab_app` (`NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`). Véritable connexion applicative via `SET SESSION AUTHORIZATION`, jamais `SET ROLE` depuis un superutilisateur.
- 107 assertions HMAC (§2) + S8bis : `SECURITY DEFINER`, `search_path` épinglé, aucune exécution par PUBLIC, propriétaires nommés, fonctions d'attestation gardées par réécriture de `pg_get_functiondef`, aucune fonction attendue ignorée silencieusement (inventaire non vide asserté).
- **PostgreSQL serveur réel de CI, version EXACTE mesurée** (step ajouté, poussé et exécuté sur `4cf760f`) : `PostgreSQL 17.11 (Debian 17.11-1.pgdg13+2) on x86_64-pc-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit`, image `postgres:17`, digest `sha256:748a18a54d38…`, log du 06-11 à 16:12:41.1396071Z, step 6 `success`, exit 0. Voir `docs/security/2026-11-06-p107-preuves-ci.json`.
- Même job : 71 migrations appliquées, `tracefab_app` `NOSUPERUSER/NOBYPASSRLS/NOCREATEROLE/NOCREATEDB`, **179 fonctions dont 128 `SECURITY DEFINER`, 0 exécutable par PUBLIC**, `ok toute fonction SECURITY DEFINER fige son search_path`, **135 politiques RLS sur 53 tables**, aucune table sans RLS forcée.
- **Limite explicite** : dans ce job CI les objets appartiennent à `postgres` (`prop=postgres`, superutilisateur). La forme de propriété non superutilisée n'est donc **modélisée que sur PGlite** (harnais outbox) ; elle n'est pas mesurée sur PostgreSQL 17 ni sur un PostgreSQL managé. Ce point empêche le GO technique.

---

## 7. Chantier F — Neon isolé : `BLOCKED`

Garanties exigées avant toute migration distante : permissions Neon, branche de test isolée, absence d'application utilisatrice, absence de données client, connexions migrateur/runtime distinctes, impossibilité d'atteindre Production. **Aucune n'a pu être vérifiée** : connecteur Neon `unsupported`, aucun `NEON_API_KEY`, aucun `DATABASE_URL`, aucun `neonctl`/`psql`, `scripts/audit_neon_readonly.mjs` sort « NON EXÉCUTÉ ». Le `list_connector_tools neon` n'est pas un échec technique : c'est une **absence d'accès**.

En conséquence : **aucune commande de migration sur Neon Production ou Préproduction**, aucune création de branche, aucun `SELECT` live, aucune lecture de `_prisma_migrations` / `pg_roles` / `pg_policies`, aucun test d'identité ni d'outbox distants, aucune bascule `strict`. Statut **`BLOCKED`**, pas `PASS`, pas `FAIL`.

---

## 8. Chantier G — Preview authentifiée : `BLOCKED`

Une CI verte et un check Vercel `PASS` ne prouvent pas HTTP. Éléments réellement observés :

- déploiement GitHub `7598586210` pour `37552b198…` (`Preview`, `success`, 11:06:13Z) → URL `tracefab-f6yg5u54d-….vercel.app` : **écran de connexion Vercel SSO**, aucun parcours HTTP applicatif. Protection conservée, jamais contournée.
- check `Vercel` `PASS` sur `4cf760f` (déploiement `A5igk6bMPherNsVGgpcbLSUGJD4y`) ; `get_deployment` → `Access denied` / 404, token `limited=true`, aucun droit d'inventaire ni de lecture des variables par cible.
- Domaine public `tracefab.vercel.app` (cible d'environnement **non vérifiée**, le token Vercel ne permet pas de l'établir) : `/api/health` `{"ok":true,"service":"tracefab-api"}` (aucun SHA, aucune version), `/api/config` clé publique seule, `/api/internal/p2/readiness` **`worker_unauthorized`** ; `/` n'expose aucun identifiant de révision.

**Non mesurés** : SHA exact servi par la Preview, Clerk de test, utilisateurs/organisations fictifs, base Neon isolée, stockage/antivirus de test, les **15 parcours obligatoires** (login/logout, sync user, création/sync organisation, sync adhésion, révocation, identité signée, vérification base, webhook test, claim outbox ligne réelle, complete, absence de double traitement, jeton invalide, jeton expiré, comportement strict, accès interdit autre organisation), preuve centrale de readiness (mode signé + identité vérifiée par la base + SHA applicatif + bonne base + absence de fallback permissif), `strict` Preview réel, corrélation HTTP ↔ Prisma ↔ Neon. Statut **`BLOCKED`** ; `/api/health` 200 n'est pas une preuve.

---

## 9. Chantier H — Production lecture seule : `BLOCKED` (hors quelques lectures publiques)

Lectures **publiques, sans écriture, sans secret, sans contournement** : `/api/health`, `/api/config`, `/`, `/api/internal/p2/readiness` (réponse `worker_unauthorized`). Dernier déploiement `Production` enregistré côté GitHub : `7521679246`, SHA `e0653b915…`, 03-11 à 14:38:25Z — **aucun lien avec le SHA candidat**.

**Non mesurés, car ils exigent un accès privilégié** : SHA réellement servi, état du déploiement, version applicative et version de schéma, rôle runtime, readiness réelle, cohérence des migrations, préconditions de bascule. Statut **`BLOCKED`** ; aucune écriture SQL, aucune migration, aucune activation stricte, aucune modification de secret/rôle, aucun déploiement.

**Préconditions d'une future bascule, à confirmer séparément et dans cet ordre** : (1) révision applicative compatible avec la chaîne validée ; (2) chaîne de 73 entrées validée sur branche isolée, journal `_prisma_migrations` réconcilié ; (3) clé `TRACEFAB_IDENTITY_KEY` provisionnée par un responsable autorisé, **jamais communiquée dans cette conversation ni dans un rapport** ; (4) clé vérifiée par la base (clé active, `strict` non basculé par une migration) ; (5) readiness `identitySysteme.mode = "signe"` et `verifiee_par_la_base = true` ; (6) webhook Clerk de test rejoué ; (7) outbox fonctionnelle, retries et idempotence mesurés ; (8) `strict` testé sur Preview **uniquement** ; (9) retour arrière documenté et répété. **Le `strict` ne doit jamais être activé en Production sans nouvelle autorisation explicite.**

---

## 10. Tableau de preuves

Statuts exclusifs : `PASS` · `FAIL` · `BLOCKED` · `NOT RUN` · `NOT APPLICABLE`. Dates en UTC du 06-11-2026. Sauf mention, SHA = `4cf760f` pour les mesures finales, `37552b1` pour la Phase 0.

| ID | Contrôle | Env. / SHA | Commande ou requête | Attendu | Observé (date · exit · artefact) | Statut |
|---|---|---|---|---|---|---|
| P01 | Phase 0 worktree/branche/HEAD/refs | local / `37552b1` | `git worktree list`, `git branch --show-current`, `git rev-parse HEAD`, `git ls-remote --heads origin` | branche imposée, `main` inchangé | 15:25:36Z · 0 · `/tmp/p107/` | **PASS** |
| P02 | CI et checks de référence | GitHub / `37552b1` | `gh run view 42207575971`, `gh pr checks 113` | 4 jobs verts, 7 checks | 4/4 `success`, 7/7 PASS · 0 | **PASS** |
| P03 | Contenu `757af24` et `37552b1` | local | `git show --stat`, `sha256sum` | 4 fichiers puis 1 doc seule | `+807/−1` puis 214 lignes · 0 | **PASS** |
| P04 | Avancée #114 détectée et réévaluée | GitHub / `f0aeb51` | `gh pr view 114`, `git fetch …pr114-nouveau`, `git diff` | nouvelle tête prise en compte | 15:34:35Z, renommage + durcissement, 6 fichiers · 15:57:09Z · 0 | **PASS** |
| P05 | Chaîne HMAC complète | PGlite 18.6 / `4cf760f` | `npm run test:hmac:chaine-confiance` | 107 assertions, 0 échec | 107/0 · 0 · `/tmp/p107/final3_test_hmac_chaine-confiance.log` | **PASS** |
| P06 | Connexion applicative réelle | PGlite / `4cf760f` | `SET SESSION AUTHORIZATION tracefab_app`, `SET ROLE …` | `session_user=current_user=tracefab_app`, élévation refusée | 3 refus mesurés, 0 échec · P05 | **PASS** |
| P07 | Rejeu inter-transactions R1 | PGlite / `4cf760f` | `npm run p107:antirejeu` §1 | idéalement refusé | **5 transactions acceptées**, après COMMIT et ROLLBACK accepté · `…antirejeu-mesures.json` | **FAIL** |
| P08 | Corrective 71e appliquée | PGlite / `757af24` | `db.exec(migration.sql)` | 71 migrations, formes ambiguës refusées | 71/71, suffixe et `exp` lointain refusés · 0 | **PASS** |
| P09 | Chaîne canonique | PGlite / `4cf760f` | `npm run p107:chaines` (`A`) | 73/73 | 73/73, 130 `SECURITY DEFINER` · 0 · `…chaines-canoniques.json` | **PASS** |
| P10 | 6 chaînes + 2 têtes #114 | PGlite / `4cf760f` | `npm run p107:chaines` | toutes appliquées | 73, 73, 94, 94, 70, 87 · 0 | **PASS** |
| P11 | Empreintes du manifeste | PGlite / `4cf760f` | recalcul sha256 sur le SQL appliqué | 73 conformes | **75 conformes, 0 écart** · 0 | **PASS** |
| P12 | Collisions d'horodatage | local / `4cf760f` | `test:migrations:horodatages`, harnais | 4 historiques, aucune nouvelle | 4→4 canonique ; 5→4 étendue · 0 | **PASS** |
| P13 | 15 contrôles de réconciliation | local / `4cf760f` | `npm run test:…` (liste §3) | 15 exit 0 | 15/15 · 0 · `/tmp/p107/garde_*.log` | **PASS** |
| P14 | 69 historiques byte-pour-byte | local / `4cf760f` | `test:reconciliation-chaine-canonique` | 90 assertions, 0 échec | **90/0** · 0 | **PASS** |
| P15 | #114 seule : défaut d'autonomie | PGlite / `f0aeb51` | `npm run p107:outbox` S1 | claim refusé (défaut démontré) | `42501 permission denied for function tracefab_identite_systeme` · 0 · `…outbox-scenarios.json` | **PASS** |
| P16 | #111+#114 et correctif candidat | PGlite / `f0aeb51` | `npm run p107:outbox` S2, S3b | claim 1 ligne, complete `sent` | S2 87/87, S3b 73/73, `authentication_required` sans jeton · 0 | **PASS** |
| P17 | Mesures anti-rejeu + v2 jetable | PGlite / `4cf760f` | `npm run p107:antirejeu` | 23 mesures cohérentes | 23/0 · 0 · `…antirejeu-mesures.json` | **PASS** |
| P18 | Protection anti-rejeu livrée | dépôt / `4cf760f` | lecture du diff | mécanisme effectif | **aucun** ; décision documentée d'accepter R1 | **FAIL** |
| P19 | Décision anti-rejeu tracée | docs / `4cf760f` | §5 du rapport | stratégie, comparaison, risque | 5 mécanismes comparés, NO-GO conservé | **PASS** |
| P20 | Version PostgreSQL EXACTE de CI | GH Actions PG17 / `4cf760f` | step 6 : `select version() as v` | version mineure consignée | **`PostgreSQL 17.11 (Debian 17.11-1.pgdg13+2)`**, 16:12:41Z · 0 · `…preuves-ci.json` | **PASS** |
| P21 | Boucle locale `test:*` | local / `4cf760f` | 156 scripts, `LD_LIBRARY_PATH=/tmp/al2023/lib` | 0 échec | **156/156**, 0 échec · 0 · `/tmp/p107/final3_*.log` | **PASS** |
| P22 | Boucle CI + jobs + checks | GH Actions / `4cf760f` | step 10 `Suite complete des scripts test:*`, `gh run view 42249334243` | tout vert sur SHA exact | step `success`, **4/4 jobs**, migrations `42249334409` `success`, **7/7 checks PASS** · 0 | **PASS** |
| P23 | Rôles/RLS/`SECURITY DEFINER` sur PG17 | GH Actions PG17 / `4cf760f` | journal job `128002580427` | forme conforme | 128 `SECURITY DEFINER`, 0 PUBLIC, 135 policies/53 tables, `tracefab_app` non superutilisé · 0 | **PASS** |
| P24 | Propriétaire non superutilisé sur PG managé | Neon / — | `pg_proc.proowner` sur Neon | forme production mesurée | `prop=postgres` en CI ; modélisation PGlite seule ; aucun accès Neon | **BLOCKED** |
| P25 | Rejeu du renommage #114 (modèle) | PGlite / `f0aeb51` | scénario `E_rejeu_renommage_114` | journal cohérent | `SQL REUSSI`, **`noms_distincts=2`**, 2 checksums/1 définition · 0 · `…chaines-canoniques.json` | **FAIL** |
| P26 | Journal `_prisma_migrations` réel de la Preview | Neon/Preview / — | `SELECT … FROM "_prisma_migrations"` | noms résolus | aucun accès ; divergence non tranchée | **BLOCKED** |
| P27 | Preview sert exactement le SHA candidat | Vercel / `4cf760f` | `get_deployment`, requête HTTP authentifiée | SHA + URL + base isolée | check Vercel PASS (build), `Access denied`, URL SSO ; SHA non lisible | **BLOCKED** |
| P28 | 15 parcours HTTP + Clerk/stockage/antivirus de test | Preview / — | parcours authentifiés | 15/15 | aucun compte de test, aucune base isolée, protection SSO conservée | **BLOCKED** |
| P29 | `strict` Preview réel | Preview / — | bascule + readiness | mode signé vérifié par la base | non exécuté ; interdit sans préconditions | **BLOCKED** |
| P30 | Lectures publiques sans écriture (domaine public, cible non vérifiée) | `tracefab.vercel.app` | `GET /api/health`, `/api/config`, `/api/internal/p2/readiness` | aucune donnée sensible | `ok:true`, clé publique seule, `worker_unauthorized` · 15:57Z | **PASS** |
| P31 | SHA servi, schéma, rôle runtime, readiness, cohérence migrations en Production | Production / — | lecture privilégiée | préconditions mesurées | accès privilégié absent ; dernier déploiement `e0653b915` (03-11) | **BLOCKED** |
| P32 | Corrélation HTTP ↔ Prisma ↔ Neon | distant / — | trace de requête | corrélation prouvée | aucune | **BLOCKED** |
| P33 | Aucune fusion / déploiement Production / `strict` Production / écriture distante | GitHub, Vercel, Neon | `gh pr list --state all`, `git ls-remote`, `gh run list` | 0 action interdite | 0 fusion, 0 déploiement Production, 0 bascule, `main` inchangé | **PASS** |
| P34 | `git diff --check` + absence de secret dans les artefacts | local / `4cf760f` | `git diff --check`, scan de motifs | exit 0, 0 secret | exit 0, 0 occurrence | **PASS** |
| P35 | Branche locale dédiée séparée | session | — | branche candidate | session liée à `arena/0f697b3e-tracefab` : création/bascule/push vers une autre branche interdits ; candidat livré sur la branche imposée + chaîne reproductible | **NOT APPLICABLE** |
| P36 | `npm test`, `api:typecheck` | local / `4cf760f` | `npm test`, `npm run api:typecheck` | exit 0 | 0 / 0 | **PASS** |

---

## 11. Réponses explicites aux 12 questions

1. **La correction HMAC est-elle intacte ?** **OUI.** `20261106120000` (sha256 `e66c4706…`) n'a pas été réécrite ; la conception validée est préservée, `strict` n'est pas basculé, aucun format de jeton légitime n'a changé. La suite est passée de 87 à **107 assertions/0** avec des contrôles supplémentaires (horloge base, 5 clés, COMMIT/ROLLBACK, refus de signature, inventaire `pg_get_functiondef`). Le durcissement apporté par la nouvelle tête #114 concerne l'autre vérificateur (système) et s'applique sans conflit (73/73).
2. **La chaîne de migrations est-elle compatible ?** **PARTIELLEMENT, pas globalement.** Compatible sur base neuve : 73/73 en PGlite, 6 chaînes, 71/71 sur PostgreSQL 17.11 en CI, 69 historiques byte-pour-byte, 15 contrôles verts. **Non prouvée sur un environnement déjà migré** : le renommage #114 produit 2 noms dans le journal simulé (P25) et le journal réel est `BLOCKED` (P26). Aucune migration historique appliquée n'a été renommée par nous.
3. **Les collisions sont-elles résolues ?** **OUI pour la chaîne canonique.** 4 paires historiques acceptées et figées, aucune nouvelle. `20261105120000` a été résolue **en amont par #114** ; `20261105180000` ne subsiste que dans la chaîne étendue, où un renom de préparation est mesuré (94/94) sans être appliqué à la chaîne canonique. `20261106120000` n'en crée ni n'en masque.
4. **#114 est-elle autonome de #111 ?** **NON, démontré par exécution.** S1 70/70 migrations mais claim/complete `42501 permission denied for function tracefab_identite_systeme` ; S2 87/87 PASS ; S3 canonique sans correctif FAIL ; S3b avec correctif candidat 73/73 PASS.
5. **L'outbox effectue-t-elle des écritures réelles avec les bons rôles ?** **OUI localement, NON prouvé à distance.** `SET SESSION AUTHORIZATION tracefab_app`, propriétaire non superutilisé modélisé, ligne réellement éligible : claim 1 ligne `processing/attempts=1`, complete `sent`, sans jeton `authentication_required`, RLS conservée (3 policies), `app_update=false`. Aucune preuve sur Neon/Preview.
6. **Le rejeu est-il traité ou accepté ?** **ACCEPTÉ explicitement**, pas traité. Décision : ne pas implémenter v2 (incompatibilité avec la signature émise avant `BEGIN`, coût de refonte, risque de blocage légitime), ni nonce, ni idempotence généralisée. R1 reste mesuré ; le TTL n'est pas un anti-rejeu ; **GO anti-rejeu = NO-GO**.
7. **La version PostgreSQL de CI est-elle validée ?** **OUI, exactement.** Step ajouté, poussé et exécuté sur `4cf760f` : **`PostgreSQL 17.11 (Debian 17.11-1.pgdg13+2)`**, `select version()`, 16:12:41Z, step 6 `success`, exit 0, run `42249334243` job `128002580427`. Ce n'est plus `NOT RUN`.
8. **Une branche Neon isolée a-t-elle été testée ?** **NON — `BLOCKED`.** Aucun connecteur, aucune clé, aucun CLI, aucune garantie d'isolation, donc aucune migration distante (et aucune sur Production/Préproduction).
9. **La Preview sert-elle exactement le SHA candidat ?** **NON PROUVÉ — `BLOCKED`.** Un déploiement `success` existe pour `37552b1` et un check Vercel `PASS` pour `4cf760f`, mais le token est `limited`, `get_deployment` est refusé, les URLs sont sous SSO et aucun SHA servi n'est lisible. Un build vert n'est pas une preuve HTTP.
10. **Le `strict` Preview est-il réel ?** **NON — `BLOCKED`.** Aucune bascule, aucune readiness centrale (mode signé + identité vérifiée par la base + SHA + base isolée + absence de fallback) ; `worker_unauthorized` sur la sonde publique.
11. **La Production est-elle prête sans modification ?** **NON — NO-GO.** Les neuf préconditions de §9 ne sont pas mesurées ; le dernier déploiement Production enregistré (`e0653b915`, 03-11) ne correspond pas au candidat. Toute bascule exigera une **nouvelle autorisation explicite** et l'intervention d'un responsable autorisé pour la clé.
12. **Quelles actions nécessitent une autorisation humaine ?** Voir §12 : création d'une branche Neon isolée et lecture de son journal, jeton Vercel à portées lecture + périmètre d'équipe, compte Clerk de test avec accès SSO, bucket/antivirus de test, bascule `strict` sur Preview après préconditions, provisionnement de `TRACEFAB_IDENTITY_KEY` par un responsable, réconciliation du journal `_prisma_migrations` après le renommage #114, intégration du correctif outbox comme migration du dépôt, et toute décision Production.

---

## 12. Accès manquants — contrôle impossible, permission minimale, responsable, procédure, preuve attendue

| Accès | Contrôle impossible | Permission minimale | Responsable | Procédure sécurisée | Preuve attendue après déblocage |
|---|---|---|---|---|---|
| Neon | branche isolée, `_prisma_migrations`, `pg_roles`, `pg_policies`, `select version()`, tests d'identité/outbox, `strict` | clé d'API Neon avec lecture des branches + création d'**une seule** branche de test ; chaîne de connexion migrateur et runtime distinctes | administrateur Neon du projet | créer la branche depuis un snapshot **sans application utilisatrice ni donnée client**, vérifier par lecture qu'elle ne peut pas atteindre Production, consigner l'ID ; ne jamais exécuter de migration sur Production/Préproduction | ID de branche, version PostgreSQL, liste des 73 migrations appliquées, propriétaires effectifs, RLS, readiness, résultats claim/complete, mode strict |
| Vercel | SHA servi, URL, variables par cible, détail des déploiements, 15 parcours | jeton avec `projects:read`, `deployments:read`, `env:read` et **périmètre d'équipe** (`team_BdnOPU97H1GOmMxy7T06nijQ`) | propriétaire du compte/équipe Vercel | fournir un accès via un canal sécurisé hors de cette conversation ; **ne jamais communiquer de valeur de secret ici** ; ne pas contourner le SSO : ouvrir un compte de test autorisé par l'administrateur | SHA exact servi, corrélation Preview→Prisma→Neon, 15 parcours, `strict` Preview, jeton invalide/expiré, refus inter-organisation |
| Clerk test | utilisateurs/organisations fictifs, login/logout, webhook répété | environnement Clerk de test en lecture/écriture, clé de test | administrateur Clerk | créer U/A/B/S fictifs, rejouer un webhook de test, ne jamais utiliser de comptes clients | journaux des 6 parcours d'identité, adhésion/révocation, absence de double effet |
| Stockage / antivirus | dépôt et scan d'un fichier de test | bucket de test isolé + scanner de test | administrateur stockage | fichier fictif, aucun document client | ID objet, résultat de scan, aucune donnée réelle |
| GitHub | `gh workflow run` (403), lecture de la protection de branche (403), journaux CI via API (`EOF`) | `actions:write` pour un déclenchement manuel ; `administration:read` pour la protection | administrateur du dépôt | n'accorder que si un workflow de sondage HTTP sans secret est réellement nécessaire ; les journaux ont pu être lus par URL signée en HTTP | run déclenché, protection lisible, journaux complets |
| Production (lecture privilégiée) | SHA servi, schéma, rôle runtime, readiness, cohérence des migrations | accès **lecture seule** à la sonde interne par un canal authentifié d'opérateur | responsable opérations | l'opérateur exécute lui-même la sonde ; la valeur du secret d'accès n'est **jamais** transmise dans le chat ni dans un rapport | JSON de readiness complet, version applicative/schéma, rôle runtime, état des migrations, aucune écriture |
| Intégration du correctif outbox | transformer le candidat en migration versionnée | validation humaine du diff | responsable technique | relire le diff, vérifier l'ordre `20261106120300` après `20261106130000`, ajouter un test de régression, jamais réécrire une migration appliquée | migration commitée, chaîne 73/73 rejouée, checks verts |

**Règle appliquée** : absence d'accès → `BLOCKED` ; échec technique mesuré → `FAIL`. Aucune clé, aucun secret, aucune valeur de jeton n'apparaît dans ce rapport, dans les artefacts, dans les journaux partagés ni dans le terminal.

---

## 13. Clôture

Le cycle demandé a été exécuté jusqu'à une décision d'intégration techniquement défendable, **sans chercher un GO artificiel** : les niveaux F, G, H restent `BLOCKED`, le rejeu R1 est `FAIL` et assumé, la divergence de journal induite par le renommage #114 est `FAIL` en modèle et `BLOCKED` sur l'environnement réel. Le chantier n'est donc **pas déclaré globalement terminé** : **NO-GO global, NO-GO Production**.

Aucune fusion, aucune fermeture de PR, aucune modification de `main` ni des branches de #108–#114, aucune écriture distante, aucun déploiement Production, aucune activation de `strict` en Production, aucun secret affiché. Le seul changement distant est le push `37552b1..4cf760f` (puis le commit documentaire de ce rapport) sur `arena/0f697b3e-tracefab`.

**Artefacts** : `docs/security/2026-11-06-p107-rapport-final-A-H.md` (ce fichier) · `…chaine-canonique.json` · `…chaine-canonique-migrations.md` · `…chaines-canoniques.json` · `…outbox-scenarios.json` · `…antirejeu-mesures.json` · `…preuves-ci.json` · `docs/security/candidats/2026-11-06-proprietaire-outbox-identite-systeme.sql` · `scripts/harnais_p107_*.mjs` · `scripts/test_reconciliation_chaine_canonique.mjs` · `docs/security/2026-11-06-p107-rapport-final.md` (rapport A–G de `37552b1`, conservé) · `docs/security/preuves-distantes-niveaux-2-3-2026-11-06.md` (rapport #113, versionné dans `4cf760f`, antérieur à l'avancée de #114).
