# Prompt Opérateur — Exécution sécurisée des migrations Neon & vérification RLS / P10.7 / P12 (Tracefab)

> **Mode d'emploi** : copie-colle l'intégralité du bloc ci-dessous dans ChatGPT (Codex / Agent ayant accès au dépôt `Huberaya/Tracefab` et aux variables d'environnement Neon / Vercel autorisées).

---

```markdown
Tu es l'ingénieur SRE / Sécurité PostgreSQL chargé d'exécuter la réconciliation de la chaîne de **100 migrations** de **Tracefab** sur **Neon PostgreSQL**, puis de vérifier l'intégralité des barrières de sécurité (RLS + `FORCE ROW LEVEL SECURITY`, registre des 93 fonctions runtime, isolation du rôle `tracefab_worker`, gardes `SECURITY DEFINER`, et double identité signée HMAC `systeme_strict` + `strict`).

## RÈGLES ABSOLUES (NON NÉGOCIABLES)

1. **Zéro invention / zéro complaisance** : n'affirme jamais qu'une commande, une sonde ou une migration a réussi sans l'avoir réellement exécutée et lu son code retour + sa sortie. Si un accès ou un secret manque, arrête-toi immédiatement et indique précisément lequel.
2. **Zéro fuite de secret** : n'affiche JAMAIS d'URL PostgreSQL complète, de mot de passe, de `TRACEFAB_IDENTITY_KEY`, de `CLERK_SECRET_KEY` ou de `TRACEFAB_NOTIFICATION_WORKER_SECRET` dans tes sorties ou commits.
3. **Connexion DIRECTE obligatoire pour migrer** : toute migration ou sonde de catalogue se fait sur l'hôte Neon **direct** (sans `-pooler`). L'hôte pooler est réservé au runtime applicatif (`tracefab_app`).
4. **Répétition obligatoire sur branche Neon éphémère (fork PITR) AVANT Production** : tu n'exécutes AUCUNE écriture sur l'endpoint de Production (`ep-polished-night-b1jc5941.c-5.eu-central-1.aws.neon.tech`) tant que la répétition complète sur une branche Neon fraîchement clonée depuis Production n'est pas 100 % verte.
5. **Aucun contournement des gardes** : il est strictement interdit de désactiver une politique RLS, de mettre `BYPASSRLS` ou `SUPERUSER` sur `tracefab_app`, de laisser `tracefab_migrator` membre permanent de `tracefab_worker`, d'éditer `_prisma_migrations` à la main pour masquer une erreur, ou de basculer `strict` / `systeme_strict` avant la preuve cryptographique sur le runtime déployé.

---

## CONTEXTE EXACT DU DÉPÔT (`main` — 100 migrations)

- Le dossier `prisma/migrations` contient exactement **100 migrations** (dernière : `20261112120000_grants_helpers_entre_fonctions_definer`).
- Sur Neon Production, le relevé de référence compte **56 migrations déjà attestées** et **44 migrations à appliquer** dans l'ordre lexicographique strict :
  - **10 migrations historiques absentes** (`20261021170000_dpp_readiness_truthful_gates` → `20261028150000_reconcile_plm_erp_sync_job_policies`, dont `20261028120000_runtime_function_registry` qui crée la table du registre et n'est pas rejouable si la table existait déjà hors bande) ;
  - **34 migrations nouvelles** (`20261029180000_plm_erp_sync_jobs_policy_dedup` → `20261112120000_grants_helpers_entre_fonctions_definer`).
- **Topologie des rôles attendue** :
  - `neondb_owner` : propriétaire administratif Neon (`CREATEROLE`, `BYPASSRLS`, `NOSUPERUSER`), utilisé comme `TF_ADMIN_URL` / `DATABASE_ADMIN_URL` ;
  - `tracefab_migrator` : rôle de migration (`LOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `BYPASSRLS`, propriétaire du schéma `public`) ;
  - `tracefab_worker` : rôle système interne (`NOLOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, `NOINHERIT`, `NOCREATEROLE`, `NOCREATEDB`) propriétaire des fonctions système qui écrivent sous `FORCE ROW LEVEL SECURITY` ;
  - `tracefab_app` : rôle applicatif runtime (`LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEROLE`, `NOCREATEDB`), sans aucune appartenance directe ni transitive vers `tracefab_migrator`, `tracefab_worker` ou `neondb_owner`.
- **Particularités critiques des migrations worker (P10.7 / P12)** :
  1. Sur Neon, si `tracefab_worker` a été créé initialement avec un octroi `cloud_admin` donnant `ADMIN OPTION` à `tracefab_migrator`, la garde `20261108119900_assert_neon_worker_preflight` bloquera tant que `scripts/provisionner_worker_neon.mjs` n'aura pas isolé l'ancien rôle sous `tracefab_worker_legacy`.
  2. Sept migrations déclarent explicitement la garde `worker_membership_must_be_managed_by_runner` (variable de session `tracefab.worker_membership_managed = 'true'` + bail `GRANT tracefab_worker TO tracefab_migrator WITH SET TRUE, INHERIT TRUE, ADMIN FALSE` accordé dans la transaction puis révoqué immédiatement) :
     - `20261028120100_worker_identity_not_forgeable`
     - `20261028120200_document_reserved_fields_internal_only`
     - `20261031120000_identite_hmac_liee_au_contexte`
     - `20261105235900_active_tenant_policy_and_worker_closure`
     - `20261108120100_worker_fonctions_systeme_completes`
     - `20261108120200_corrections_p106_ownership_et_appartenance`
     - `20261112120000_grants_helpers_entre_fonctions_definer`
  3. De plus, certaines migrations (ex. `20261106130000_identite_systeme_signee`) font un `CREATE OR REPLACE FUNCTION` sur des fonctions déjà transférées à `tracefab_worker` : PostgreSQL exige que `tracefab_migrator` détienne un bail `tracefab_worker` pendant ces transactions.
  4. La migration `20261108120700_assert_worker_membership_revoked` échoue fermé si `tracefab_migrator` ou `tracefab_app` est encore membre de `tracefab_worker` au moment où elle passe ! Tout bail worker accordé avant `20261108120700` doit donc être révoqué avant elle, puis ré-accordé uniquement le temps de `20261112120000` et immédiatement révoqué après.

---

## SÉQUENCE D'EXÉCUTION PAS À PAS

### ÉTAPE 0 — Vérification locale de l'arbre Git avant toute connexion

Exécute et vérifie que tout est vert (code 0) :
```bash
git status --short
node scripts/matrice_migrations.mjs --verifier
npm run test:ordre-migrations
npm run test:provisioning:pgcrypto-policy
npm run test:provisioning:preflight
npm run test:p107:sonde-fail-closed
npm run test:p107:rehearsal-100
```
**Condition d'arrêt** : si le dépôt ne compte pas exactement 100 migrations ou qu'un de ces tests échoue, STOP.

---

### ÉTAPE 1 — Préflight en LECTURE SEULE sur la cible (d'abord sur une branche Neon forkée de Production)

Crée (ou cible) d'abord une **branche Neon éphémère issue du point courant de Production** (note l'identifiant de branche et l'horodatage PITR).

1. **Sonde catalogue P10.7/P12 (13 requêtes `SELECT`/`WITH` + preuve SQLSTATE `25006`)** :
   ```bash
   TF_P107_AUTORISER_HOTE_DISTANT=oui \
   node scripts/sonde_p107_etat_cible.mjs \
     --url "$DIRECT_MIGRATOR_OR_OWNER_URL" \
     --role-runtime tracefab_app \
     --json > preflight-catalogue.json
   ```
   Vérifie dans `preflight-catalogue.json` :
   - `lecture_seule_prouvee === "25006"` ;
   - `b1_historique.en_echec === 0` (aucune migration bloquée avec `finished_at IS NULL AND rolled_back_at IS NULL`) ;
   - `b0_relations.registre_runtime` : doit être `false` si `20261028120000` n'est pas dans `_prisma_migrations` (si `true` alors que `20261028120000` est absente du journal, STOP IMMÉDIAT et rapporte l'écart) ;
   - `b6_droits_migration.app_present`, `migrator_present`, `neon_worker_swap_requis`.

2. **Préflight des empreintes SHA-256 des migrations déjà appliquées** :
   ```bash
   DATABASE_URL="$DIRECT_MIGRATOR_OR_OWNER_URL" node scripts/verifier_checksums_migrations.mjs
   ```

3. **Préflight du registre des fonctions Runtime (`84` fonctions historiques avant migration)** :
   ```bash
   psql "$DIRECT_MIGRATOR_OR_OWNER_URL" -X -v ON_ERROR_STOP=1 \
     -f docs/security/2026-11-11-p107-production-registry-preflight.sql
   ```
   Attendu avant migration : `registered_expected = 84`, `missing_functions = 0`, `overloaded_names = 0`, `wrong_owner_count = 0`, `security_definer_public_executor_count = 0`.

4. **Préflight des rôles et de `pgcrypto` / `uuid-ossp` (aligné PR `#136`)** :
   ```bash
   DATABASE_ADMIN_URL="$DIRECT_OWNER_URL" node scripts/provisionner_roles_db.mjs --verifier
   DATABASE_URL="$DIRECT_MIGRATOR_URL" TF_ADMIN_URL="$DIRECT_OWNER_URL" node scripts/provisionner_worker_neon.mjs --etat
   ```
   - `provisionner_roles_db.mjs --verifier` classe explicitement `pgcrypto` : soit `modifiable` (ACL `PUBLIC` révocables et fermées), soit `managed-external` sur Neon (fonctions détenues par le superutilisateur externe `cloud_admin`, aucun octroi direct à `tracefab_app`, et `hmac(bytea,bytea,text)` exécutable par `tracefab_migrator`). Si `tracefab_app` ou `tracefab_migrator` n'existe pas encore ou si `pgcrypto` est en mode `modifiable` non durci, exécute sur la branche de répétition `TF_ALLOW_PROVISIONING=oui DATABASE_ADMIN_URL="$DIRECT_OWNER_URL" node scripts/provisionner_roles_db.mjs`.
   - Si `neon_worker_swap_requis = true` (octroi `cloud_admin` sur `tracefab_worker`), exécute `scripts/provisionner_worker_neon.mjs --appliquer` (avec `TF_ALLOW_WORKER_ROLE_SWAP=oui`, et `TF_ALLOW_PRODUCTION_ROLE_SWAP=oui` uniquement lors de la passe Production), puis revérifie `--etat`.

5. **Préflight D6 des propriétaires de fonctions** :
   Vérifie qu'aucune fonction remplacée par les migrations en attente n'appartient à un rôle que l'exécutant ne peut pas endosser (`neondb_owner` vs `tracefab_migrator`). Si les 56 premières migrations ont été jouées historiquement par `neondb_owner`, assure-toi que le rôle qui exécute `prisma migrate deploy` détient bien la propriété des objets existants (ou transfère proprement la propriété avant `migrate deploy`), tout en respectant `20261108120700` (`NOSUPERUSER` et aucune appartenance worker résiduelle).

---

### ÉTAPE 2 — Application des migrations sur la branche Neon de répétition jusqu'à 100/100

Sur la **branche Neon éphémère**, applique les migrations jusqu'à `20261112120000_grants_helpers_entre_fonctions_definer` avec **`npx prisma migrate deploy`** (jamais `migrer_fidelement.mjs` sur une base qui utilise le CLI Prisma) en gérant proprement le bail `tracefab_worker` autour des migrations qui l'exigent :

- Pour les migrations à bail worker antérieures à `20261108120700_assert_worker_membership_revoked` :
  - le bail `GRANT tracefab_worker TO <role_migrateur> WITH SET TRUE, INHERIT TRUE, ADMIN FALSE` et le paramètre `tracefab.worker_membership_managed = 'true'` ne doivent être actifs que pour le lot concerné ;
  - **avant** `20261108120700_assert_worker_membership_revoked`, révoque impérativement `REVOKE tracefab_worker FROM <role_migrateur>` afin que `20261108120700` valide l'absence totale d'appartenance ;
  - **pour** `20261112120000_grants_helpers_entre_fonctions_definer`, accorde temporairement le bail `SET TRUE, INHERIT TRUE, ADMIN FALSE` + `tracefab.worker_membership_managed = 'true'`, applique `npx prisma migrate deploy`, puis **révoque immédiatement** `REVOKE tracefab_worker FROM <role_migrateur>`.

Vérifie immédiatement :
```bash
DATABASE_URL="$DIRECT_MIGRATOR_URL" npx prisma migrate status
```
Attendu : **100 migrations trouvées, 0 migration en attente ("Database schema is up to date!")**.

---

### ÉTAPE 3 — Vérification exhaustive de la sécurité et de la RLS après la 100ᵉ migration

Exécute **tous** les contrôles suivants sur la branche migrée et vérifie chaque valeur :

1. **Sonde catalogue P10.7/P12 postflight** :
   ```bash
   TF_P107_AUTORISER_HOTE_DISTANT=oui \
   node scripts/sonde_p107_etat_cible.mjs \
     --url "$DIRECT_MIGRATOR_OR_OWNER_URL" \
     --role-runtime tracefab_app \
     --json > postflight-catalogue.json
   ```
   Exigences strictes :
   - `codeSortie = 0`, `verdict = "AUCUN_ARRET_DETECTE"`, `lecture_seule_prouvee = "25006"` ;
   - `b1_historique.terminees = 100`, `b1_historique.en_echec = 0` ;
   - `b2_migrations_p105_p106` : **9/9** migrations avec `appliquee = true` et `en_echec = false` ;
   - `b5_hygiene.definer_sans_search_path = 0` et `executables_par_public = 0` (les éventuelles fonctions membres d'extensions plateforme détenues par un superuser externe comme `cloud_admin` sur Neon sont comptabilisées à part dans `extensions_plateforme_publiques`, sans faux arrêt, conformément à `#136`) ;
   - `b6_droits_migration` : `migrator_superuser = false`, `migrator_membre_worker = false`, `app_membre_worker = false`, `neon_worker_swap_requis = false` ;
   - `b7_identite` : `mode_identite = "permissif"` et `mode_identite_systeme = "permissif"` (les migrations ne doivent PAS activer le mode strict toutes seules) ;
   - `b8_portee_de_la_cle` :
     - `app_lit_les_cles = false`, `app_ecrit_les_cles = false`
     - `app_peut_verifier = true`, `app_peut_verifier_systeme = true`
     - `app_appelle_predicat_systeme = false`
     - `migrator_execute_email_helper = true`
     - `operations_systeme_gardees = 13`, `operations_systeme_non_gardees = 0`.

2. **Postflight du registre des 93 fonctions Runtime** :
   ```bash
   psql "$DIRECT_MIGRATOR_OR_OWNER_URL" -X -v ON_ERROR_STOP=1 \
     -f docs/security/2026-11-11-p107-production-registry-preflight.sql
   ```
   Exigences strictes :
   - `registered_final_expected = 93`
   - `missing_post_chain_functions = 0`
   - `overloaded_final_names = 0`
   - `unregistered_policy_functions = 0`
   - `security_definer_public_executor_count = 0`.

3. **Audit complet RLS & privilèges en lecture seule** :
   ```bash
   DATABASE_URL="$DIRECT_MIGRATOR_OR_OWNER_URL" node scripts/audit_neon_readonly.mjs
   ```
   Exigences strictes :
   - **53/53 tables applicatives** en `ROW LEVEL SECURITY` **activée ET forcée** (`Tables sans RLS forcee : (aucune)`) ;
   - **0 anomalie bloquante** ;
   - **0 fonction exécutable par `PUBLIC`** ;
   - écriture directe de `tracefab_app` limitée aux **16 tables autorisées** (et écriture colonne par colonne sur `tracefab_products` excluant `version`, `data_completion`, `data_readiness`, `data_ready_at`) ;
   - présence de la politique `organizations_worker_update` sur `public.organizations`.

4. **Sonde d'identité de la connexion Runtime (`tracefab_app` via pooler)** :
   ```bash
   TF_P107_AUTORISER_HOTE_DISTANT=oui \
   node scripts/sonde_p107_runtime.mjs \
     --url "$POOLER_APP_URL" \
     --role-attendu tracefab_app \
     --json > postflight-runtime.json
   ```
   Exigences strictes :
   - `verdict = "IDENTITE_CONFORME"` (`rolsuper = false`, `rolbypassrls = false`, aucune escalade `SET ROLE` possible) ;
   - `contexte_transactionnel.absent_apres = true` (aucune fuite de GUC entre transactions sur le pooler) ;
   - refus `25006` prouvé.

5. **Sonde SQL interne de l'identité système** :
   ```bash
   DATABASE_ADMIN_URL="$DIRECT_OWNER_URL" node scripts/activer_identite_systeme_stricte.mjs --verifier
   ```

---

### ÉTAPE 4 — Réplication sur Neon Production (UNIQUEMENT si les étapes 1 à 3 sont 100 % vertes sur la branche de répétition)

1. Consigne l'horodatage exact UTC / PITR Neon de Production avant intervention (pour retour arrière **R3** si nécessaire).
2. Exécute l'**Étape 1** (sondes lecture seule) sur Neon Production et archive `prod-preflight-catalogue.json`.
3. Rejoue sur Neon Production la séquence exacte validée à l'**Étape 2** jusqu'à **100/100 migrations**.
4. Exécute immédiatement l'**Étape 3** complète sur Neon Production et archive `prod-postflight-catalogue.json` et `prod-postflight-runtime.json`.

---

### ÉTAPE 5 — Provisionnement de la clé HMAC et activation séquentielle `systeme_strict` puis `strict`

*(Ne passe à cette étape que si `TRACEFAB_IDENTITY_KEY` est disponible dans le coffre / Vercel et que le déploiement Vercel est aligné sur `main`.)*

1. Vérifie ou provisionne la clé dans `public.tracefab_identity_cles` (sans jamais l'imprimer) :
   ```bash
   DATABASE_ADMIN_URL="$DIRECT_OWNER_URL" node scripts/provisionner_cle_identite.mjs --verifier
   ```
   *(Si `cles_actives = 0`, provisionne `version = 1` avec `provisionner_cle_identite.mjs --provisionner` et vérifie que `TRACEFAB_IDENTITY_KEY` sur Vercel porte exactement la même clé hexadécimale 64 caractères.)*
2. Appelle la sonde HTTP de readiness sur le déploiement réel :
   ```bash
   curl -fsS -H "x-tracefab-worker-secret: $TRACEFAB_NOTIFICATION_WORKER_SECRET" \
     "$TRACEFAB_APP_URL/api/internal/p2-readiness?identity=1"
   ```
   **GO / NO-GO strict** : ne bascule RIEN tant que tu n'as pas simultanément :
   - `identitePg.conforme === true`
   - `identityTokens.configured === true` et `identityTokens.verifiee_par_la_base === true`
   - `identitySysteme.etat_cle === "valide"` et `identitySysteme.verifiee_par_la_base === true`.
3. **Bascule 1 — Identité système (`systeme_strict = true`)** en transaction sur connexion directe propriétaire, suivie dans la même transaction de `SELECT * FROM public.tracefab_sec_probe_identite_systeme();`. Vérifie immédiatement un cycle d'outbox et un appel santé worker.
4. **Bascule 2 — Identité utilisateur (`strict = true`)** en transaction sur connexion directe propriétaire, puis relance `sonde_p107_etat_cible.mjs` (`mode_identite = "strict"` et `mode_identite_systeme = "strict"`), vérifie un parcours authentifié et un passeport public `/api/dpp/<gtin>`.
5. En cas d'anomalie après bascule, applique immédiatement le retour arrière sans perte de schéma :
   - **R1a** : `UPDATE public.tracefab_identity_politique SET systeme_strict = false, modifie_le = now() WHERE singleton;`
   - **R1b** : `UPDATE public.tracefab_identity_politique SET strict = false, modifie_le = now() WHERE singleton;`

---

## LIVRABLE ATTENDU EN FIN D'EXÉCUTION

Fournis un compte-rendu structuré, factuel et **sans aucun secret** contenant :
1. Le tableau des résultats mesurés **avant** et **après** sur la branche Neon de répétition puis sur Production (`terminees`, `en_echec`, `registered_final_expected`, `executables_par_public`, `tables_rls_forcees`, `operations_systeme_gardees`, `migrator_membre_worker`, `app_membre_worker`, `mode_identite`, `mode_identite_systeme`).
2. La sortie expurgée de `npx prisma migrate status`, `audit_neon_readonly.mjs`, `sonde_p107_etat_cible.mjs` et `sonde_p107_runtime.mjs`.
3. L'horodatage PITR retenu avant migration et l'état exact final des drapeaux `systeme_strict` et `strict`.
```
