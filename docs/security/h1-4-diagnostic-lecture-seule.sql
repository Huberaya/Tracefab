-- TRACEFAB H1.4 — diagnostic lecture seule, requetes distinctes Q1..Q6
--
-- CE FICHIER N'ECRIT RIEN. Pas de GRANT, REVOKE, CREATE, ALTER, DROP,
-- INSERT, UPDATE, DELETE, ni d'ecriture _prisma_migrations.
--
-- DEUX MODES (voir docs/security/h1-4-MODE-OPERATOIRE.md) :
--   jetable  : wrapper scripts/run_h1_4_diagnostic_readonly.sh uniquement,
--              cible locale explicite. \gset / \if sont des commandes psql.
--   neon-manuel : coller UNIQUEMENT les blocs -- >>>H14:Qn ... -- <<<H14:Qn
--              dans l'editeur. \gset et \if ne sont PAS du SQL serveur.
--              Chaque collage = une session. PAS une transaction unique.
--              Ne pas coller Q1_GATE. Q5.A/B seulement si Q1 =
--              prisma_migrations_etat lecture_ok. objet_absent,
--              refus_privilege ou erreur catalogue : ne pas coller Q5.A/B
--              et ne pas lire « 5 migrations absentes ».
--
-- NE PAS lancer par `psql -f` seul. SET SESSION CHARACTERISTICS /
-- default_transaction_read_only NE SONT PAS une barriere inviolable
-- (superutilisateur, SET TRANSACTION READ WRITE). BEGIN READ ONLY porte
-- sur CETTE transaction. ON_ERROR_STOP : si -f echoue, le -c ROLLBACK
-- du wrapper n'est pas envoye ; abort a la deconnexion.
--
-- PUBLIC EXECUTE = aclexplode(COALESCE(proacl, acldefault('f', proowner))),
-- grantee = 0, privilege_type = 'EXECUTE'. Jamais has_function_privilege('public', ...).
--
-- current_user / session_user = session de diagnostic.
-- proprietaire d'objet = Q6.
-- migrateur Prisma = confirmation operateur + concordance historique ; sinon inconnu.
--
-- Masquer avant partage : URL, mot de passe, hote, identifiant de projet.

-- >>>H14:Q1
SELECT
  current_user::text                              AS current_user,
  session_user::text                              AS session_user,
  current_database()::text                        AS base,
  current_setting('server_version')               AS version_postgresql,
  (SELECT r.rolsuper FROM pg_roles r
    WHERE r.rolname = current_user)               AS role_session_est_superutilisateur,
  (SELECT r.rolbypassrls FROM pg_roles r
    WHERE r.rolname = current_user)               AS role_session_bypassrls,
  has_table_privilege(current_user, 'pg_catalog.pg_proc', 'SELECT')
                                                  AS pg_proc_select,
  has_table_privilege(current_user, 'pg_catalog.pg_class', 'SELECT')
                                                  AS pg_class_select,
  CASE
    WHEN to_regclass('public._prisma_migrations') IS NULL THEN 'objet_absent'
    WHEN has_table_privilege('public._prisma_migrations', 'SELECT') THEN 'lecture_ok'
    ELSE 'refus_privilege'
  END                                             AS prisma_migrations_etat,
  has_schema_privilege(current_user, 'public', 'CREATE')
                                                  AS public_create,
  EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app')
                                                  AS tracefab_app_existe,
  'inconnu'::text                                 AS migrateur_prisma,
  'Q1 = session de diagnostic. Owner = Q6. Migrateur Prisma = mot operateur, jamais current_user. objet_absent ≠ refus_privilege ≠ lecture_ok. Une erreur catalogue n est pas une absence d objet.'::text AS note
;
-- <<<H14:Q1

-- >>>H14:Q1_GATE
-- Porte psql uniquement. Meme ordre de WHEN que Q1.prisma_migrations_etat.
SELECT
  CASE
    WHEN to_regclass('public._prisma_migrations') IS NULL THEN 0
    WHEN has_table_privilege('public._prisma_migrations', 'SELECT') THEN 1
    ELSE 0
  END AS tf_h14_mig_lecture_ok,
  CASE
    WHEN to_regclass('public._prisma_migrations') IS NULL THEN 'objet_absent'
    WHEN has_table_privilege('public._prisma_migrations', 'SELECT') THEN 'lecture_ok'
    ELSE 'refus_privilege'
  END AS tf_h14_mig_etat
\gset
-- <<<H14:Q1_GATE

-- >>>H14:Q2
WITH cible(ord, sig, secdef_attendu) AS (
  VALUES
    (1, 'public.tracefab_material_visible_via_product(uuid)', true),
    (2, 'public.tracefab_product_is_public(uuid)',            true),
    (3, 'public.tracefab_material_is_public(uuid)',           true),
    (4, 'public.tracefab_supplier_site_is_public(uuid)',      true),
    (5, 'public.tracefab_public_brand(uuid)',                 true),
    (6, 'public.tracefab_public_context()',                   false)
)
SELECT
  c.ord,
  c.sig,
  (p.oid IS NOT NULL) AS presente,
  CASE WHEN p.oid IS NOT NULL THEN pg_get_userbyid(p.proowner)::text ELSE NULL END
    AS proprietaire,
  CASE WHEN p.oid IS NOT NULL THEN p.prosecdef ELSE NULL END
    AS security_definer,
  c.secdef_attendu,
  CASE WHEN p.oid IS NOT NULL THEN (p.proacl IS NULL) ELSE NULL END
    AS proacl_null,
  CASE WHEN p.oid IS NOT NULL THEN pg_get_function_identity_arguments(p.oid) ELSE NULL END
    AS args_catalogue
FROM cible c
LEFT JOIN pg_proc p ON p.oid = to_regprocedure(c.sig)
ORDER BY c.ord
;
-- <<<H14:Q2

-- >>>H14:Q3
WITH cible(ord, sig) AS (
  VALUES
    (1, 'public.tracefab_material_visible_via_product(uuid)'),
    (2, 'public.tracefab_product_is_public(uuid)'),
    (3, 'public.tracefab_material_is_public(uuid)'),
    (4, 'public.tracefab_supplier_site_is_public(uuid)'),
    (5, 'public.tracefab_public_brand(uuid)'),
    (6, 'public.tracefab_public_context()')
),
existantes AS (
  SELECT
    c.ord,
    c.sig,
    p.oid,
    p.proowner,
    p.proacl,
    (p.oid IS NOT NULL) AS presente
  FROM cible c
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(c.sig)
)
SELECT
  e.ord,
  e.sig,
  e.presente,
  CASE
    WHEN NOT e.presente THEN NULL
    ELSE EXISTS (
      SELECT 1
      FROM aclexplode(COALESCE(e.proacl, acldefault('f', e.proowner))) a
      WHERE a.grantee = 0
        AND a.privilege_type = 'EXECUTE'
    )
  END AS public_execute_acl,
  CASE
    WHEN NOT e.presente THEN NULL
    ELSE COALESCE((
      SELECT string_agg(
               CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                    ELSE pg_get_userbyid(a.grantee)::text END,
               ', ' ORDER BY 1)
      FROM aclexplode(COALESCE(e.proacl, acldefault('f', e.proowner))) a
      WHERE a.privilege_type = 'EXECUTE'
    ), 'aucun')
  END AS porteurs_acl_direct,
  CASE
    WHEN NOT e.presente THEN NULL
    WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN NULL
    ELSE has_function_privilege('tracefab_app', e.oid, 'EXECUTE')
  END AS app_execute_effectif,
  'public_execute_acl = grantee 0 (ACL, defaut moteur compris). porteurs_acl_direct = grantees DIRECTS, pas l heritage. app_execute_effectif = has_function_privilege(role nomme), heritage compris. Une liste directe vide n est PAS une preuve de fermeture (PUBLIC defaut ou INHERIT). NULL si fonction ou role absent.'::text AS note
FROM existantes e
ORDER BY e.ord
;
-- <<<H14:Q3

-- >>>H14:Q4
WITH lignes AS (
  SELECT
    r.rolname AS role_createur,
    CASE WHEN d.defaclnamespace = 0 THEN NULL ELSE n.nspname END AS schema,
    d.defaclacl::text AS acl_brute,
    EXISTS (
      SELECT 1
      FROM aclexplode(d.defaclacl) a
      WHERE a.grantee = 0
        AND a.privilege_type = 'EXECUTE'
    ) AS defaut_execute_public,
    (r.rolname = current_user) AS createur_est_la_session
  FROM pg_default_acl d
  JOIN pg_roles r ON r.oid = d.defaclrole
  LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
  WHERE d.defaclobjtype = 'f'
)
SELECT
  role_createur,
  schema,
  acl_brute,
  defaut_execute_public,
  createur_est_la_session,
  'ligne'::text AS nature
FROM lignes
UNION ALL
SELECT
  NULL::name,
  NULL::name,
  NULL::text,
  NULL::boolean,
  NULL::boolean,
  ('synthese: ' || (SELECT count(*)::text FROM lignes)
    || ' ligne(s). 0 = defaut integre PUBLIC EXECUTE pour tout createur sans ligne pg_default_acl. current_user n est pas le migrateur Prisma. H3 se juge sur le createur Q6, pas sur la session.')
ORDER BY nature, role_createur NULLS LAST, schema NULLS FIRST
;
-- <<<H14:Q4

-- >>>H14:Q5C
SELECT
  to_regprocedure('public.tracefab_material_visible_via_product(uuid)') IS NOT NULL
    AS material_visible,
  to_regprocedure('public.tracefab_product_is_public(uuid)') IS NOT NULL
    AS product_is_public,
  to_regprocedure('public.tracefab_material_is_public(uuid)') IS NOT NULL
    AS material_is_public,
  to_regprocedure('public.tracefab_supplier_site_is_public(uuid)') IS NOT NULL
    AS site_is_public,
  to_regprocedure('public.tracefab_public_brand(uuid)') IS NOT NULL
    AS public_brand,
  to_regprocedure('public.tracefab_public_context()') IS NOT NULL
    AS public_context,
  CASE
    WHEN NOT has_table_privilege(current_user, 'pg_catalog.pg_proc', 'SELECT')
      THEN 'refus_privilege'
    ELSE 'lecture_ok'
  END AS statut_lecture,
  'false + lecture_ok = fonction non resolue. false + refus_privilege = non determinable. Ne pas fusionner absence et refus.'::text AS note
;
-- <<<H14:Q5C

-- >>>H14:Q6
WITH cible(ord, objet, kind) AS (
  VALUES
    (1, 'table public._prisma_migrations',                              'table'),
    (2, 'fonction public.tracefab_material_visible_via_product(uuid)',  'fn0912'),
    (3, 'fonction public.tracefab_public_context()',                    'fn0918'),
    (4, 'schema public',                                                'schema')
)
SELECT
  c.ord,
  c.objet,
  CASE c.kind
    WHEN 'table' THEN
      CASE
        WHEN NOT has_table_privilege(current_user, 'pg_catalog.pg_class', 'SELECT')
          THEN 'refus_privilege'
        WHEN to_regclass('public._prisma_migrations') IS NULL
          THEN 'objet_absent'
        ELSE 'presente'
      END
    WHEN 'fn0912' THEN
      CASE
        WHEN NOT has_table_privilege(current_user, 'pg_catalog.pg_proc', 'SELECT')
          THEN 'refus_privilege'
        WHEN to_regprocedure('public.tracefab_material_visible_via_product(uuid)') IS NULL
          THEN 'objet_absent'
        ELSE 'presente'
      END
    WHEN 'fn0918' THEN
      CASE
        WHEN NOT has_table_privilege(current_user, 'pg_catalog.pg_proc', 'SELECT')
          THEN 'refus_privilege'
        WHEN to_regprocedure('public.tracefab_public_context()') IS NULL
          THEN 'objet_absent'
        ELSE 'presente'
      END
    WHEN 'schema' THEN
      CASE
        WHEN NOT has_table_privilege(current_user, 'pg_catalog.pg_namespace', 'SELECT')
          THEN 'refus_privilege'
        WHEN to_regnamespace('public') IS NULL
          THEN 'objet_absent'
        ELSE 'presente'
      END
  END AS etat_objet,
  CASE c.kind
    WHEN 'table' THEN
      CASE
        WHEN NOT has_table_privilege(current_user, 'pg_catalog.pg_class', 'SELECT') THEN NULL
        WHEN to_regclass('public._prisma_migrations') IS NULL THEN NULL
        ELSE (SELECT pg_get_userbyid(relowner)::text
              FROM pg_class
              WHERE oid = to_regclass('public._prisma_migrations'))
      END
    WHEN 'fn0912' THEN
      CASE
        WHEN NOT has_table_privilege(current_user, 'pg_catalog.pg_proc', 'SELECT') THEN NULL
        WHEN to_regprocedure('public.tracefab_material_visible_via_product(uuid)') IS NULL THEN NULL
        ELSE (SELECT pg_get_userbyid(proowner)::text
              FROM pg_proc
              WHERE oid = to_regprocedure('public.tracefab_material_visible_via_product(uuid)'))
      END
    WHEN 'fn0918' THEN
      CASE
        WHEN NOT has_table_privilege(current_user, 'pg_catalog.pg_proc', 'SELECT') THEN NULL
        WHEN to_regprocedure('public.tracefab_public_context()') IS NULL THEN NULL
        ELSE (SELECT pg_get_userbyid(proowner)::text
              FROM pg_proc
              WHERE oid = to_regprocedure('public.tracefab_public_context()'))
      END
    WHEN 'schema' THEN
      CASE
        WHEN NOT has_table_privilege(current_user, 'pg_catalog.pg_namespace', 'SELECT') THEN NULL
        WHEN to_regnamespace('public') IS NULL THEN NULL
        ELSE (SELECT pg_get_userbyid(nspowner)::text
              FROM pg_namespace
              WHERE oid = to_regnamespace('public'))
      END
  END AS proprietaire,
  'inconnu'::text AS migrateur_prisma,
  'migrateur_prisma reste inconnu tant que les proprietaires historiques concordent ET que l operateur nomme le role de prisma migrate deploy (un mot, zero URL). Q1.current_user n est pas une preuve. objet_absent ≠ refus_privilege.'::text AS note
FROM cible c
ORDER BY c.ord
;
-- <<<H14:Q6

\if :{?tf_h14_mig_lecture_ok}
\if :tf_h14_mig_lecture_ok
-- >>>H14:Q5A
WITH attendues(ord, migration_name) AS (
  VALUES
    (1, '20261010120000_publication_explicite'),
    (2, '20261012120000_close_public_execute_gap'),
    (3, '20261014120000_close_global_default_function_execute'),
    (4, '20261014130000_revoke_public_schema_privileges'),
    (5, '20261014140000_remove_public_supplier_passport_share_token')
),
hist AS (
  SELECT
    m.migration_name,
    m.checksum,
    m.applied_steps_count,
    m.finished_at,
    m.rolled_back_at
  FROM public._prisma_migrations m
  WHERE m.migration_name IN (SELECT a.migration_name FROM attendues a)
)
SELECT
  a.migration_name,
  CASE WHEN count(h.migration_name) = 1 THEN min(h.checksum) ELSE NULL END
    AS checksum,
  CASE WHEN count(h.migration_name) = 1 THEN min(h.applied_steps_count) ELSE NULL END
    AS applied_steps_count,
  CASE
    WHEN count(h.migration_name) = 0 THEN 'absente'
    WHEN count(*) FILTER (WHERE h.rolled_back_at IS NOT NULL) > 0 THEN 'annulee'
    WHEN count(*) FILTER (WHERE h.finished_at IS NULL) > 0 THEN 'incomplete'
    WHEN count(*) = 1
     AND bool_and(h.finished_at IS NOT NULL AND h.rolled_back_at IS NULL) THEN 'terminee'
    ELSE 'incomplete'
  END AS etat
FROM attendues a
LEFT JOIN hist h ON h.migration_name = a.migration_name
GROUP BY a.ord, a.migration_name
ORDER BY a.ord
;
-- <<<H14:Q5A
-- >>>H14:Q5B
SELECT
  m.migration_name,
  m.checksum,
  m.finished_at,
  m.applied_steps_count
FROM public._prisma_migrations m
WHERE m.finished_at IS NOT NULL
  AND m.rolled_back_at IS NULL
ORDER BY m.finished_at DESC
LIMIT 5
;
-- <<<H14:Q5B
\else
SELECT 'Q5.A NON EXECUTE'::text AS notice,
       :'tf_h14_mig_etat'::text AS prisma_migrations_etat,
       'cinq lignes promises seulement si lecture_ok ; ne pas interpreter ce saut comme 5 absentes'::text AS note;
SELECT 'Q5.B NON EXECUTE'::text AS notice,
       :'tf_h14_mig_etat'::text AS prisma_migrations_etat,
       'historique recent non lu'::text AS note;
\endif
\else
SELECT 'Q5.A/B NON EXECUTE — variables psql absentes'::text AS notice,
       'editeur Neon : coller Q5.A/Q5.B seulement si Q1.prisma_migrations_etat = lecture_ok. Pas une transaction unique.'::text AS note;
\endif
