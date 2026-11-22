-- ===========================================================================
-- P10.3 — SONDE DE LECTURE SEULE avant application de
--         20261030140000_ingest_payload_role_guard_and_acl
--
-- À exécuter par un opérateur, sur la base réelle, en LECTURE SEULE.
-- Aucune instruction de ce fichier ne modifie quoi que ce soit :
--   * pas de CREATE / ALTER / DROP / GRANT / REVOKE ;
--   * pas de SET / RESET (hors `SET LOCAL statement_timeout`, annulé au COMMIT) ;
--   * pas de SELECT ... FOR UPDATE, pas d'appel de fonction métier.
-- Le fichier est idempotent : on peut le rejouer avant ET après déploiement.
--
-- Exécution :
--   psql "$DATABASE_URL_LECTURE" -v ON_ERROR_STOP=1 \
--        -f docs/security/2026-10-30-p103-sonde-lecture-seule.sql
--
-- Rappel : `DATABASE_URL_LECTURE` doit être une URL de LECTURE fournie par
-- l'opérateur. Aucun secret ne doit être recopié dans un ticket, un journal ou
-- un fichier du dépôt.
-- ===========================================================================

\set ON_ERROR_STOP on
SET LOCAL statement_timeout = '15s';

\echo '=== 0. Contexte de la session (qui suis-je, sur quelle base) ==='
SELECT current_database()                                AS base,
       current_user                                      AS role_courant,
       session_user                                      AS role_session,
       (SELECT rolsuper   FROM pg_roles WHERE rolname = current_user) AS superuser,
       (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls,
       (SELECT rolcanlogin  FROM pg_roles WHERE rolname = current_user) AS peut_se_connecter,
       inet_server_addr()::text                          AS adresse,
       inet_server_port()                                AS port,
       current_setting('server_version')                 AS version_pg;

\echo '=== 1. Rôles cités par la chaîne de migrations (présence et attributs) ==='
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolinherit
  FROM pg_roles
 WHERE rolname IN ('tracefab_app', 'tracefab_worker', 'neondb_owner', 'postgres')
 ORDER BY rolname;

\echo '=== 2. La migration corrective est-elle déjà appliquée ? ==='
SELECT migration_name,
       finished_at,
       rolled_back_at,
       CASE
         WHEN rolled_back_at IS NOT NULL THEN 'ANNULEE'
         WHEN finished_at IS NULL        THEN 'INACHEVEE'
         ELSE 'APPLIQUEE'
       END AS etat
  FROM public._prisma_migrations
 WHERE migration_name LIKE '20261030140000%'
    OR migration_name LIKE '202610281%'
    OR migration_name LIKE '202610211%'
 ORDER BY migration_name;

\echo '=== 3. Nombre de migrations appliquées vs attendu (67) ==='
SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS appliquees,
       count(*) FILTER (WHERE rolled_back_at IS NOT NULL)                          AS annulees,
       count(*) FILTER (WHERE finished_at IS NULL)                                 AS inachevees,
       count(*)                                                                    AS total_connu
  FROM public._prisma_migrations;

\echo '=== 4. ACL EFFECTIVES de la fonction d ingestion ==='
SELECT p.oid::regprocedure                                    AS signature,
       pg_get_userbyid(p.proowner)                            AS proprietaire,
       p.prosecdef                                            AS security_definer,
       array_to_string(COALESCE(p.proconfig, '{}'), ' ; ')    AS configuration,
       COALESCE(p.proacl::text, '(defaut du proprietaire)')   AS acl
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname = 'tracefab_ingest_plm_erp_payload';

\echo '=== 4b. Qui détient EXECUTE, rôle par rôle (y compris PUBLIC) ==='
SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS beneficiaire,
       a.privilege_type,
       CASE WHEN a.is_grantable THEN 'avec grant option' ELSE '' END AS option
  FROM pg_proc p
  CROSS JOIN LATERAL aclexplode(p.proacl) a
 WHERE p.oid = 'public.tracefab_ingest_plm_erp_payload(uuid,text,jsonb,uuid)'::regprocedure
 ORDER BY 1, 2;

\echo '=== 4c. Test d appartenance : PUBLIC, app et propriétaire ==='
SELECT has_function_privilege('public',
         'public.tracefab_ingest_plm_erp_payload(uuid,text,jsonb,uuid)', 'EXECUTE')      AS public_peut_executer,
       has_function_privilege(
         COALESCE(pg_catalog.to_regrole('tracefab_app'), current_user::regrole),
         'public.tracefab_ingest_plm_erp_payload(uuid,text,jsonb,uuid)', 'EXECUTE')      AS app_peut_executer;

\echo '=== 5. Définition réelle : la garde est-elle présente ? ==='
SELECT (pg_get_functiondef(p.oid) LIKE '%ingest_role_not_allowed%')   AS garde_de_role_presente,
       (pg_get_functiondef(p.oid) LIKE '%session_user%')              AS session_user_utilise,
       (pg_get_functiondef(p.oid) LIKE '%tracefab.user_id%')          AS guc_identite_utilise,
       length(pg_get_functiondef(p.oid))                              AS longueur_definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname = 'tracefab_ingest_plm_erp_payload';

\echo '=== 5b. search_path épinglé sur les fonctions SECURITY DEFINER ==='
SELECT count(*)                                                                  AS sd_total,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig,'{}')) x
                                       WHERE x LIKE 'search_path=%'))                AS avec_search_path,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig,'{}')) x
                                           WHERE x LIKE 'search_path=%'))            AS sans_search_path
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosecdef AND p.prokind = 'f';

\echo '=== 6. Écarts entre le schéma attendu et la base : objets de la migration ==='
SELECT 'fonction presente' AS attendu,
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'tracefab_ingest_plm_erp_payload') AS constat
UNION ALL
SELECT 'registre runtime present',
       EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'tracefab_runtime_function_registry')
UNION ALL
SELECT 'fonction declaree au registre',
       EXISTS (SELECT 1 FROM public.tracefab_runtime_function_registry
                WHERE name = 'tracefab_ingest_plm_erp_payload')
UNION ALL
SELECT 'les 4 lanceurs obsoletes ne sont pas des objets de base',
       true;

\echo '=== 7. Rôles qui peuvent exécuter les fonctions d ingestion/utilitaires ==='
SELECT p.proname,
       CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS beneficiaire
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(p.proacl) a
 WHERE n.nspname = 'public'
   AND p.proname IN ('tracefab_current_user_id', 'tracefab_has_org_role', 'tracefab_is_org_member')
   AND a.privilege_type = 'EXECUTE'
 ORDER BY 1, 2;

-- ===========================================================================
-- CE QUE CETTE SONDE NE PROUVE PAS
--
--   * Elle lit le catalogue, pas le comportement : elle ne dit pas si l'appel
--     nominal aboutit. C'est l'objet de
--     `scripts/test_ingest_payload_acl.mjs` sur base jetable, et de la
--     vérification après déploiement (runbook, étape 6).
--   * Elle ne dit rien du rôle que le RUNTIME utilise réellement : la ligne 0
--     décrit la session de l'OPÉRATEUR. Le rôle du runtime se lit dans les
--     journaux de connexion Neon ou via la sonde d'activité, pas ici.
--   * Aucune de ces requêtes ne modifie l'état ; aucune ne doit être remplacée
--     par un `GRANT` « pour vérifier ».
-- ===========================================================================
