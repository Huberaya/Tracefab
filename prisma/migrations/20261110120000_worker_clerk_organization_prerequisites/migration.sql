-- 20261110120000_worker_clerk_organization_prerequisites
--
-- P10.8 a transfere tracefab_sync_clerk_organization au role NOLOGIN
-- tracefab_worker, mais n'a pas transpose les droits et politiques RLS
-- necessaires a son corps (SELECT FOR UPDATE / UPDATE / INSERT organizations).
-- La CI PostgreSQL 17.11 reproduit le defaut : proowner=tracefab_worker,
-- SECURITY DEFINER=true, SELECT=true, UPDATE=true, INSERT=false ; appel
-- webhook echoue 42501 permission denied for table organizations.
--
-- Correction minimale : INSERT table privilege + politiques INSERT et UPDATE
-- reservees a CURRENT_USER=tracefab_worker. Aucun droit pour tracefab_app,
-- aucune appartenance de role, aucun BYPASSRLS, aucune donnee modifiee.

BEGIN;

DO $preconditions$
DECLARE
  v_worker oid;
  v_app oid;
  v_function oid;
BEGIN
  SELECT oid INTO v_worker FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker';
  SELECT oid INTO v_app FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app';
  v_function := pg_catalog.to_regprocedure(
    'public.tracefab_sync_clerk_organization(text,text,text,organization_type)'
  );

  IF v_worker IS NULL OR v_app IS NULL OR v_function IS NULL THEN
    RAISE EXCEPTION 'worker_clerk_organization_prerequisite_missing_role_or_function';
  END IF;
  IF (SELECT rolsuper OR rolbypassrls OR rolcanlogin FROM pg_catalog.pg_roles WHERE oid = v_worker) THEN
    RAISE EXCEPTION 'tracefab_worker_must_remain_nologin_nosuperuser_nobypassrls';
  END IF;
  IF pg_catalog.pg_has_role(v_app, v_worker, 'MEMBER') THEN
    RAISE EXCEPTION 'tracefab_app_must_not_be_member_of_tracefab_worker';
  END IF;
  IF (SELECT proowner FROM pg_catalog.pg_proc WHERE oid = v_function) <> v_worker
     OR NOT (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid = v_function) THEN
    RAISE EXCEPTION 'tracefab_sync_clerk_organization_owner_or_security_definer_unexpected';
  END IF;
END
$preconditions$;

GRANT INSERT ON TABLE public.organizations TO tracefab_worker;

DO $policies$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public' AND tablename = 'organizations'
      AND policyname = 'organizations_insert_worker'
  ) THEN
    CREATE POLICY organizations_insert_worker ON public.organizations
      FOR INSERT TO PUBLIC
      WITH CHECK (CURRENT_USER = 'tracefab_worker'::name);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public' AND tablename = 'organizations'
      AND policyname = 'organizations_update_worker'
  ) THEN
    CREATE POLICY organizations_update_worker ON public.organizations
      FOR UPDATE TO PUBLIC
      USING (CURRENT_USER = 'tracefab_worker'::name)
      WITH CHECK (CURRENT_USER = 'tracefab_worker'::name);
  END IF;
END
$policies$;

DO $postconditions$
DECLARE
  v_insert_check text;
  v_update_using text;
  v_update_check text;
BEGIN
  IF NOT pg_catalog.has_table_privilege('tracefab_worker', 'public.organizations', 'SELECT')
     OR NOT pg_catalog.has_table_privilege('tracefab_worker', 'public.organizations', 'INSERT')
     OR NOT pg_catalog.has_table_privilege('tracefab_worker', 'public.organizations', 'UPDATE') THEN
    RAISE EXCEPTION 'worker_organizations_table_privileges_incomplete';
  END IF;

  SELECT with_check INTO v_insert_check
    FROM pg_catalog.pg_policies
   WHERE schemaname = 'public' AND tablename = 'organizations'
     AND policyname = 'organizations_insert_worker';
  IF v_insert_check IS NULL
     OR v_insert_check NOT ILIKE '%CURRENT_USER%'
     OR v_insert_check NOT ILIKE '%tracefab_worker%' THEN
    RAISE EXCEPTION 'worker_organizations_insert_policy_missing_or_unbounded';
  END IF;

  SELECT qual, with_check INTO v_update_using, v_update_check
    FROM pg_catalog.pg_policies
   WHERE schemaname = 'public' AND tablename = 'organizations'
     AND policyname = 'organizations_update_worker';
  IF v_update_using IS NULL OR v_update_check IS NULL
     OR v_update_using NOT ILIKE '%CURRENT_USER%'
     OR v_update_using NOT ILIKE '%tracefab_worker%'
     OR v_update_check NOT ILIKE '%CURRENT_USER%'
     OR v_update_check NOT ILIKE '%tracefab_worker%' THEN
    RAISE EXCEPTION 'worker_organizations_update_policy_missing_or_unbounded';
  END IF;

  IF pg_catalog.pg_has_role('tracefab_app', 'tracefab_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'tracefab_app_worker_membership_regression';
  END IF;
END
$postconditions$;

COMMIT;
