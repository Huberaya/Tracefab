-- ============================================================================
-- TRACEFAB — P10.7 — SONDE DE LECTURE SEULE : IDENTITÉ DU RUNTIME ET ÉTAT CIBLE
--
-- À EXÉCUTER TEL QUEL, PAR UN OPÉRATEUR AUTORISÉ, SUR LA BASE À MESURER,
-- AVEC UNE CONNEXION DE LECTURE. Chaque instruction commence par SELECT ou
-- WITH : aucune écriture, aucun DDL, aucun GRANT/REVOKE, aucun SET ROLE n'est
-- possible par construction. `scripts/sonde_p107_etat_cible.mjs` le prouve par
-- exécution (transaction READ ONLY + tentative d'écriture refusée en 25006).
--
-- CE QUE CETTE SONDE NE PEUT PAS DIRE
--   Le rôle RÉELLEMENT utilisé par l'application ne se lit pas d'ici : cette
--   session est celle de l'opérateur. Il se mesure DEPUIS le runtime, avec
--   `GET /api/internal/p2-readiness?identity=1` (derrière le secret worker) ou
--   `node scripts/sonde_p107_runtime.mjs` lancé dans l'environnement du
--   runtime. Le nom de la variable `DATABASE_URL` ne prouve rien.
--
-- MODE D'EMPLOI
--   node scripts/sonde_p107_etat_cible.mjs --url "$TRACEFAB_LECTURE_URL"
--   Conserver la sortie AVEC sa date : sans date, ce n'est pas une mesure.
--   Le lanceur conditionne B1/B2/B3 et B7 à la présence mesurée en B0 : un
--   `CASE` ne met pas à l'abri de l'analyse d'une relation absente (42P01).
--   Une exécution psql directe n'est donc valide que si toutes les relations
--   lues existent déjà. Aucun secret ne doit être recopié dans un journal.
-- ============================================================================


-- ============================================================================
-- A1. CONTEXTE DE LA MESURE
--     Qualifie la mesure : qui lit, sur quelle base, avec quel serveur.
-- ============================================================================
SELECT current_user                     AS role_executant,
       session_user                     AS role_session,
       current_database()               AS base,
       pg_catalog.version()             AS version_postgresql,
       current_setting('server_version_num')::int AS version_num,
       inet_server_addr()               AS adresse_serveur,
       inet_server_port()               AS port_serveur,
       pg_catalog.pg_backend_pid()      AS backend_pid,
       now()                            AS mesuree_le;


-- ============================================================================
-- A2. LES RÔLES QUI PEUVENT SE CONNECTER, ET LEURS ATTRIBUTS
--     ATTENDU pour le rôle du runtime : rolsuper = false, rolbypassrls = false.
-- ============================================================================
SELECT r.rolname,
       r.rolsuper,
       r.rolbypassrls,
       r.rolcreaterole,
       r.rolcreatedb,
       r.rolcanlogin,
       r.rolinherit,
       r.rolreplication,
       r.rolconnlimit
  FROM pg_catalog.pg_roles r
 WHERE r.rolname NOT LIKE 'pg\_%'
   AND r.rolcanlogin
 ORDER BY r.rolsuper DESC, r.rolbypassrls DESC, r.rolname;


-- ============================================================================
-- A3. APPARTENANCES DIRECTES, ET TRANSITIVES VERS UN RÔLE PRIVILÉGIÉ
--     Un rôle sans attribut privilégié qui ATTEINT un rôle privilégié le
--     redevient par SET ROLE : les attributs seuls ne concluent pas.
--     ATTENDU : aucune ligne (profondeur >= 1) pour le rôle du runtime.
-- ============================================================================
WITH RECURSIVE depart AS (
  SELECT r.oid, r.rolname, 0 AS profondeur
    FROM pg_catalog.pg_roles r
   WHERE r.rolcanlogin AND r.rolname NOT LIKE 'pg\_%'
  UNION ALL
  SELECT m.roleid, d.rolname, d.profondeur + 1
    FROM depart d
    JOIN pg_catalog.pg_auth_members m ON m.member = d.oid
   WHERE d.profondeur < 8
)
SELECT d.rolname                                   AS role_de_depart,
       cible.rolname                               AS role_atteint,
       min(d.profondeur)                           AS profondeur,
       bool_or(cible.rolsuper OR cible.rolbypassrls) AS atteint_un_role_privilegie
  FROM depart d
  JOIN pg_catalog.pg_roles cible ON cible.oid = d.oid
 WHERE d.profondeur > 0
 GROUP BY 1, 2
 ORDER BY 1, 3, 2;


-- ============================================================================
-- A4. CAPACITÉ EFFECTIVE DE PRENDRE UN RÔLE (SET ROLE), POUR CHAQUE RÔLE DE
--     CONNEXION, VERS CHAQUE RÔLE PRIVILÉGIÉ
--     Mesuré par `pg_has_role(..., 'SET')` : c'est la capacité réelle, pas une
--     déduction depuis les attributs.
-- ============================================================================
SELECT m.rolname                                AS role_de_connexion,
       p.rolname                                AS role_privilegie,
       pg_catalog.pg_has_role(m.rolname, p.oid, 'SET')  AS peut_prendre_ce_role,
       pg_catalog.pg_has_role(m.rolname, p.oid, 'USAGE') AS herite_de_ses_droits
  FROM pg_catalog.pg_roles m
  CROSS JOIN pg_catalog.pg_roles p
 WHERE m.rolcanlogin AND m.rolname NOT LIKE 'pg\_%'
   AND (p.rolsuper OR p.rolbypassrls)
   AND p.rolname <> m.rolname
 ORDER BY 1, 2;


-- ============================================================================
-- B0. EXISTENCE DES RELATIONS ET DES FONCTIONS D'IDENTITÉ (UTILISATEUR + SYSTÈME)
--     Ce bloc ne lit que le catalogue. Le lanceur s'en sert pour NE PAS
--     analyser les requêtes dépendantes lorsqu'une relation ou colonne est absente.
-- ============================================================================
SELECT to_regclass('public._prisma_migrations')                    IS NOT NULL AS migrations_presentes,
       to_regclass('public.tracefab_identity_cles')                IS NOT NULL AS cles_presentes,
       to_regclass('public.tracefab_identity_politique')           IS NOT NULL AS politique_presente,
       EXISTS (
         SELECT 1
           FROM information_schema.columns c
          WHERE c.table_schema = 'public'
            AND c.table_name = 'tracefab_identity_politique'
            AND c.column_name = 'systeme_strict'
       )                                                                       AS colonne_systeme_strict_presente,
       to_regclass('public.tracefab_runtime_function_registry')    IS NOT NULL AS registre_fonctions_present,
       to_regprocedure('public.tracefab_identity_jeton_utilisateur(text)') IS NOT NULL AS fonction_verification_presente,
       to_regprocedure('public.tracefab_identite_systeme_jeton_valide(text)') IS NOT NULL AS fonction_verification_systeme_presente,
       to_regprocedure('public.tracefab_sec_probe_identite_systeme()') IS NOT NULL AS sonde_identite_systeme_presente,
       to_regrole('tracefab_app')                                  IS NOT NULL AS app_present;


-- ============================================================================
-- B1. L'HISTORIQUE DES MIGRATIONS
--     Exécuté par le lanceur seulement si B0.migrations_presentes = true.
--     ATTENDU : terminees = migrations sur disque (100 sur `main`), aucun
--     echec en attente de resolution.
-- ============================================================================
SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS terminees,
       count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)     AS en_echec,
       count(*) FILTER (WHERE rolled_back_at IS NOT NULL)                        AS annulees,
       max(finished_at)                                                          AS derniere_appliquee
  FROM public._prisma_migrations;


-- ============================================================================
-- B2. LES MIGRATIONS JALONS P10.5 → P12 : APPLIQUÉES OU EN ATTENTE ?
--     Suit nommément les jalons de la chaîne de 100 migrations : identité HMAC
--     utilisateur, rotation, fermeture tenant actif, identité système signée,
--     isolation worker Neon, borne temporelle HMAC et octroi helper DEFINER.
-- ============================================================================
WITH attendues(nom) AS (
  VALUES ('20261031120000_identite_hmac_liee_au_contexte'),
         ('20261102120000_identite_stricte_email_et_rotation'),
         ('20261105235900_active_tenant_policy_and_worker_closure'),
         ('20261106130000_identite_systeme_signee'),
         ('20261108119900_assert_neon_worker_preflight'),
         ('20261108120700_assert_worker_membership_revoked'),
         ('20261109170000_p107_expiration_floor'),
         ('20261109190000_p107_worker_organizations_update'),
         ('20261112120000_grants_helpers_entre_fonctions_definer')
)
SELECT a.nom,
       EXISTS (SELECT 1 FROM public._prisma_migrations m
                WHERE m.migration_name = a.nom
                  AND m.finished_at IS NOT NULL AND m.rolled_back_at IS NULL) AS appliquee,
       EXISTS (SELECT 1 FROM public._prisma_migrations m
                WHERE m.migration_name = a.nom AND m.finished_at IS NULL)      AS en_echec
  FROM attendues a
 ORDER BY a.nom;


-- ============================================================================
-- B3. LA QUEUE DE L'HISTORIQUE : NOMS RÉELLEMENT PRÉSENTS APRÈS LA 66e
-- ============================================================================
SELECT migration_name, finished_at IS NOT NULL AS terminee, rolled_back_at
  FROM public._prisma_migrations
 WHERE migration_name >= '20261030'
 ORDER BY migration_name;


-- ============================================================================
-- B4. LES PROPRIÉTAIRES DES FONCTIONS VISÉES PAR 20261102120000
--     `CREATE OR REPLACE FUNCTION` exige d'être PROPRIÉTAIRE (mesuré P10.6 :
--     42501 « must be owner of function »). Le préflight D6 refuse AVANT la
--     chaîne si l'exécutant ne peut pas endosser ces propriétaires.
--     Ce bloc MESURE ; il ne répare rien.
-- ============================================================================
SELECT p.proname                                        AS fonction,
       p.oid::pg_catalog.regprocedure::text             AS signature,
       pg_catalog.pg_get_userbyid(p.proowner)           AS proprietaire,
       p.prosecdef                                      AS security_definer,
       pg_catalog.array_to_string(p.proconfig, ',')     AS configuration
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('tracefab_current_user_id',
                     'tracefab_current_user_email',
                     'tracefab_identity_jeton_utilisateur',
                     'tracefab_register_transaction_certificate',
                     'tracefab_allocate_tc_quantity',
                     'tracefab_reconcile_mass_balance')
 ORDER BY 1;


-- ============================================================================
-- B5. HYGIÈNE DES FONCTIONS SECURITY DEFINER ET DES ACL PUBLIC
--     ATTENDU : 0 sans `search_path` figé, 0 exécutable par PUBLIC hors
--     fonctions membres d'extension détenues par un superutilisateur externe
--     non endossable (ex. `pgcrypto` / `uuid-ossp` sous `cloud_admin` sur Neon,
--     mode `managed-external` classé par `provisionner_roles_db.mjs` — PR #136).
--     PUBLIC est le grantee OID 0, pas un rôle à inventer. proacl = NULL ne
--     signifie pas « aucun droit » : il faut alors développer acldefault, qui
--     donne notamment EXECUTE à PUBLIC pour une fonction nouvellement créée.
-- ============================================================================
SELECT count(*) FILTER (WHERE p.prosecdef)                                              AS definer_total,
       count(*) FILTER (WHERE p.prosecdef AND (p.proconfig IS NULL
                         OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c
                                         WHERE c LIKE 'search_path=%')))                AS definer_sans_search_path,
       count(*) FILTER (WHERE p.prokind = 'f'
                         AND EXISTS (
                           SELECT 1
                             FROM pg_catalog.aclexplode(
                               COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
                             ) AS acl
                            WHERE acl.grantee = 0
                              AND acl.privilege_type = 'EXECUTE'
                         )
                         AND (
                           p.prosecdef
                           OR NOT EXISTS (
                             SELECT 1
                               FROM pg_catalog.pg_depend d
                               JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
                              WHERE d.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
                                AND d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
                                AND d.deptype = 'e'
                                AND d.objid = p.oid
                                AND e.extname IN ('pgcrypto', 'uuid-ossp')
                                AND r.rolsuper = true
                                AND NOT (
                                  p.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
                                  OR (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user)
                                  OR pg_catalog.pg_has_role(current_user, p.proowner, 'SET')
                                )
                           )
                         ))                                                             AS executables_par_public,
       count(*) FILTER (WHERE p.prokind = 'f'
                         AND NOT p.prosecdef
                         AND EXISTS (
                           SELECT 1
                             FROM pg_catalog.aclexplode(
                               COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
                             ) AS acl
                            WHERE acl.grantee = 0
                              AND acl.privilege_type = 'EXECUTE'
                         )
                         AND EXISTS (
                           SELECT 1
                             FROM pg_catalog.pg_depend d
                             JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
                            WHERE d.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
                              AND d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
                              AND d.deptype = 'e'
                              AND d.objid = p.oid
                              AND e.extname IN ('pgcrypto', 'uuid-ossp')
                              AND r.rolsuper = true
                              AND NOT (
                                p.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
                                OR (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user)
                                OR pg_catalog.pg_has_role(current_user, p.proowner, 'SET')
                              )
                         ))                                                             AS extensions_plateforme_publiques,
       count(*) FILTER (WHERE p.prokind = 'f')                                          AS fonctions_publiques
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
 WHERE n.nspname = 'public';


-- ============================================================================
-- B6. LES RÔLES ET L'ISOLATION DU WORKER (P10.5 → P12, 100 MIGRATIONS)
--     Sur Neon, `cloud_admin` accorde ADMIN OPTION au créateur d'un rôle : le
--     préflight `provisionner_worker_neon.mjs` isole l'ancien rôle sous
--     `tracefab_worker_legacy` et vérifie qu'aucune appartenance worker
--     permanente ne subsiste sur `tracefab_migrator` ni `tracefab_app`.
-- ============================================================================
SELECT to_regrole('tracefab_worker')                                         IS NOT NULL AS worker_present,
       to_regrole('tracefab_worker_legacy')                                  IS NOT NULL AS worker_legacy_present,
       to_regrole('cloud_admin')                                             IS NOT NULL AS cloud_admin_present,
       to_regrole('tracefab_app')                                            IS NOT NULL AS app_present,
       to_regrole('tracefab_migrator')                                       IS NOT NULL AS migrator_present,
       (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_migrator')      AS migrator_superuser,
       (SELECT rolcreaterole FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_migrator') AS migrator_createrole,
       (SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_migrator')  AS migrator_bypassrls,
       CASE WHEN to_regrole('tracefab_migrator') IS NULL OR to_regrole('tracefab_worker') IS NULL THEN false
            ELSE pg_catalog.pg_has_role('tracefab_migrator', 'tracefab_worker', 'MEMBER') END AS migrator_membre_worker,
       CASE WHEN to_regrole('tracefab_app') IS NULL OR to_regrole('tracefab_worker') IS NULL THEN false
            ELSE pg_catalog.pg_has_role('tracefab_app', 'tracefab_worker', 'MEMBER') END      AS app_membre_worker,
       CASE WHEN to_regrole('cloud_admin') IS NULL
               OR to_regrole('tracefab_migrator') IS NULL
               OR to_regrole('tracefab_worker') IS NULL
               OR to_regrole('tracefab_worker_legacy') IS NOT NULL THEN false
            ELSE EXISTS (
              SELECT 1 FROM pg_catalog.pg_auth_members x
               WHERE x.member = to_regrole('tracefab_migrator')
                 AND x.roleid = to_regrole('tracefab_worker')
                 AND x.grantor = to_regrole('cloud_admin')
                 AND x.admin_option IS TRUE
                 AND x.inherit_option IS FALSE
                 AND x.set_option IS FALSE
            ) END                                                                          AS neon_worker_swap_requis;


-- ============================================================================
-- B7. L'ÉTAT DE L'IDENTITÉ HMAC UTILISATEUR ET SYSTÈME (aucun secret lu)
--     Exécuté par le lanceur seulement si B0 confirme les DEUX relations.
--     Les `to_regclass` ci-dessous produisent le détail du résultat ; ils ne
--     rendent pas la requête autonome en cas d'absence : PostgreSQL analyse
--     aussi les relations des branches CASE non choisies et lèverait 42P01.
--     `mode_identite_systeme` est lu par sous-requête JSON sur la ligne entière
--     afin de rester exécutable sur une base antérieure à 20261106130000 où la
--     colonne `systeme_strict` n'existe pas encore (pas d'erreur 42703).
-- ============================================================================
SELECT to_regclass('public.tracefab_identity_cles')                 IS NOT NULL AS table_cles,
       to_regclass('public.tracefab_identity_politique')            IS NOT NULL AS table_politique,
       to_regprocedure('public.tracefab_identity_jeton_utilisateur(text)') IS NOT NULL AS fonction_verification,
       to_regprocedure('public.tracefab_identite_systeme_jeton_valide(text)') IS NOT NULL AS fonction_verification_systeme,
       CASE WHEN to_regclass('public.tracefab_identity_politique') IS NULL THEN 'ABSENTE'
            ELSE (SELECT CASE WHEN p.strict THEN 'strict' ELSE 'permissif' END
                    FROM public.tracefab_identity_politique p LIMIT 1) END AS mode_identite,
       CASE WHEN to_regclass('public.tracefab_identity_politique') IS NULL THEN 'ABSENTE'
            ELSE COALESCE(
              (SELECT CASE WHEN (to_jsonb(p) ->> 'systeme_strict')::boolean THEN 'strict'
                           WHEN (to_jsonb(p) ? 'systeme_strict') THEN 'permissif'
                           ELSE 'ABSENTE' END
                 FROM public.tracefab_identity_politique p LIMIT 1),
              'ABSENTE'
            ) END                                                               AS mode_identite_systeme,
       -- Compteurs seulement : aucune valeur de clé, aucun nom de clé. Deux
       -- clés actives = rotation en cours, ce qui est l'état attendu pendant un
       -- chevauchement ; zéro clé active = aucun jeton ne peut être vérifié.
       CASE WHEN to_regclass('public.tracefab_identity_cles') IS NULL THEN NULL
            ELSE (SELECT count(*) FROM public.tracefab_identity_cles) END        AS cles_total,
       CASE WHEN to_regclass('public.tracefab_identity_cles') IS NULL THEN NULL
            ELSE (SELECT count(*) FROM public.tracefab_identity_cles WHERE actif) END AS cles_actives;


-- ============================================================================
-- B8. LA CLÉ ET LE PRÉDICAT SYSTÈME SONT-ILS HORS DE PORTÉE DU RUNTIME ?
--     Mesure de catalogue ; la preuve par exécution (42501) est dans
--     `test:p105:hmac` (S7), `test:p106:identite-negative` (N14) et
--     `test:p107:identite-systeme`.
-- ============================================================================
SELECT to_regrole('tracefab_app') IS NOT NULL                                           AS app_present,
       to_regclass('public.tracefab_identity_cles') IS NOT NULL                          AS table_cles_presente,
       to_regprocedure('public.tracefab_identity_jeton_utilisateur(text)') IS NOT NULL   AS fonction_verification_presente,
       to_regprocedure('public.tracefab_identite_systeme_jeton_valide(text)') IS NOT NULL AS fonction_verification_systeme_presente,
       to_regprocedure('public.tracefab_identite_systeme()') IS NOT NULL                 AS predicat_systeme_present,
       CASE WHEN to_regrole('tracefab_app') IS NULL
               OR to_regclass('public.tracefab_identity_cles') IS NULL THEN NULL
            ELSE pg_catalog.has_table_privilege(
              'tracefab_app', 'public.tracefab_identity_cles', 'SELECT') END              AS app_lit_les_cles,
       CASE WHEN to_regrole('tracefab_app') IS NULL
               OR to_regclass('public.tracefab_identity_cles') IS NULL THEN NULL
            ELSE pg_catalog.has_table_privilege(
              'tracefab_app', 'public.tracefab_identity_cles', 'INSERT') END              AS app_ecrit_les_cles,
       CASE WHEN to_regrole('tracefab_app') IS NULL
               OR to_regprocedure('public.tracefab_identity_jeton_utilisateur(text)') IS NULL THEN NULL
            ELSE pg_catalog.has_function_privilege(
              'tracefab_app', 'public.tracefab_identity_jeton_utilisateur(text)', 'EXECUTE') END AS app_peut_verifier,
       CASE WHEN to_regrole('tracefab_app') IS NULL
               OR to_regprocedure('public.tracefab_identite_systeme_jeton_valide(text)') IS NULL THEN NULL
            ELSE pg_catalog.has_function_privilege(
              'tracefab_app', 'public.tracefab_identite_systeme_jeton_valide(text)', 'EXECUTE') END AS app_peut_verifier_systeme,
       CASE WHEN to_regrole('tracefab_app') IS NULL
               OR to_regprocedure('public.tracefab_identite_systeme()') IS NULL THEN NULL
            ELSE pg_catalog.has_function_privilege(
              'tracefab_app', 'public.tracefab_identite_systeme()', 'EXECUTE') END        AS app_appelle_predicat_systeme,
       CASE WHEN to_regrole('tracefab_migrator') IS NULL
               OR to_regprocedure('public.tracefab_current_user_email()') IS NULL THEN NULL
            ELSE pg_catalog.has_function_privilege(
              'tracefab_migrator', 'public.tracefab_current_user_email()', 'EXECUTE') END AS migrator_execute_email_helper,
       (SELECT count(*)::int
          FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prosecdef
           AND p.proname = ANY (ARRAY[
             'tracefab_sync_clerk_membership','tracefab_sync_clerk_organization',
             'tracefab_revoke_clerk_membership','tracefab_upsert_clerk_user',
             'tracefab_ensure_clerk_user','tracefab_soft_delete_clerk_user',
             'tracefab_archive_clerk_organization','tracefab_clerk_organization_uuid',
             'tracefab_notification_outbox_health','tracefab_claim_notification_outbox',
             'tracefab_complete_notification_outbox','tracefab_enqueue_due_data_request_reminders',
             'tracefab_enqueue_manual_data_request_reminder'])
           AND pg_catalog.pg_get_functiondef(p.oid) LIKE '%tracefab_identite_systeme()%') AS operations_systeme_gardees,
       (SELECT count(*)::int
          FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prosecdef
           AND p.proname = ANY (ARRAY[
             'tracefab_sync_clerk_membership','tracefab_sync_clerk_organization',
             'tracefab_revoke_clerk_membership','tracefab_upsert_clerk_user',
             'tracefab_ensure_clerk_user','tracefab_soft_delete_clerk_user',
             'tracefab_archive_clerk_organization','tracefab_clerk_organization_uuid',
             'tracefab_notification_outbox_health','tracefab_claim_notification_outbox',
             'tracefab_complete_notification_outbox','tracefab_enqueue_due_data_request_reminders',
             'tracefab_enqueue_manual_data_request_reminder'])
           AND pg_catalog.pg_get_functiondef(p.oid) NOT LIKE '%tracefab_identite_systeme()%') AS operations_systeme_non_gardees;
-- NULL signifie NON MESURABLE (rôle ou objet absent), jamais « privilège
-- refusé ». Le lanceur transforme notamment l'absence du rôle en ARRÊT B8.
