-- TraceFab: align PLM/ERP sync-job RLS policies with the repository contract.
--
-- Production read-only evidence (2026-10-29) found two additional permissive
-- policies on public.plm_erp_sync_jobs:
--   * plm_erp_sync_jobs_insert_brand: grants INSERT to contributor as well as
--     owner/admin/manager;
--   * plm_erp_sync_jobs_select_brand: duplicates the repository's member SELECT.
--
-- PostgreSQL permissive policies combine with OR. The extra INSERT policy
-- therefore broadens authorization even though the canonical policy is stricter.
-- Remove only these two known drift policies. Preserve the canonical policies
-- created by 20261006210000_plm_erp_gs1_interoperability:
--   * plm_sync_jobs_insert_brand
--   * plm_sync_jobs_select_org
--
-- No GRANT/REVOKE, data, function, or other policy is changed. Idempotent.
BEGIN;

DROP POLICY IF EXISTS plm_erp_sync_jobs_insert_brand ON public.plm_erp_sync_jobs;
DROP POLICY IF EXISTS plm_erp_sync_jobs_select_brand ON public.plm_erp_sync_jobs;

DO $verify$
DECLARE
  v_insert_count integer;
  v_select_count integer;
BEGIN
  SELECT count(*) INTO v_insert_count
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'plm_erp_sync_jobs'
    AND policyname = 'plm_sync_jobs_insert_brand'
    AND cmd = 'INSERT'
    AND roles = ARRAY['public']::name[]
    AND with_check LIKE '%owner%'
    AND with_check LIKE '%admin%'
    AND with_check LIKE '%manager%'
    AND with_check NOT LIKE '%contributor%';

  SELECT count(*) INTO v_select_count
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'plm_erp_sync_jobs'
    AND policyname = 'plm_sync_jobs_select_org'
    AND cmd = 'SELECT'
    AND roles = ARRAY['public']::name[]
    AND qual LIKE '%tracefab_is_org_member(brand_organization_id)%';

  IF v_insert_count <> 1 OR v_select_count <> 1 THEN
    RAISE EXCEPTION 'PLM sync-job policy alignment failed: canonical INSERT %, SELECT %',
      v_insert_count, v_select_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'plm_erp_sync_jobs'
      AND policyname IN ('plm_erp_sync_jobs_insert_brand', 'plm_erp_sync_jobs_select_brand')
  ) THEN
    RAISE EXCEPTION 'Unexpected extra PLM sync-job policy remains';
  END IF;
END
$verify$;

COMMIT;
