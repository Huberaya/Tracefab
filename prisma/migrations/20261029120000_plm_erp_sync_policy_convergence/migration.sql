-- TRACEFAB — convergence des politiques PLM/ERP/GS1 observées en production.
--
-- Constat de lecture seule du 2026-10-29 :
-- plm_erp_sync_jobs porte quatre politiques alors que la migration canonique
-- 20261006210000 n'en définit que deux. Les deux politiques surnuméraires
-- (préfixe plm_erp_sync_jobs_) élargissent la politique INSERT aux contributors
-- et dupliquent SELECT. Les politiques canoniques plm_sync_jobs_* restent
-- inchangées : owner/admin/manager pour INSERT, membre de l'organisation pour
-- SELECT. Cette migration ne touche ni aux données, ni aux GRANT/REVOKE.
--
-- Idempotente : DROP POLICY IF EXISTS, sans réécriture de l'historique Prisma.

BEGIN;

DROP POLICY IF EXISTS plm_erp_sync_jobs_insert_brand ON public.plm_erp_sync_jobs;
DROP POLICY IF EXISTS plm_erp_sync_jobs_select_brand ON public.plm_erp_sync_jobs;

DO $verify$
DECLARE
  v_count integer;
  v_bad_insert integer;
  v_bad_select integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'plm_erp_sync_jobs';

  IF v_count <> 2 THEN
    RAISE EXCEPTION 'plm_erp_sync_jobs_policy_count_expected_2_got_%', v_count;
  END IF;

  SELECT count(*) INTO v_bad_insert
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'plm_erp_sync_jobs'
    AND policyname = 'plm_sync_jobs_insert_brand'
    AND cmd = 'INSERT'
    AND with_check LIKE '%owner%'
    AND with_check LIKE '%admin%'
    AND with_check LIKE '%manager%'
    AND with_check NOT LIKE '%contributor%';

  IF v_bad_insert <> 1 THEN
    RAISE EXCEPTION 'plm_erp_sync_jobs_insert_policy_not_canonical';
  END IF;

  SELECT count(*) INTO v_bad_select
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'plm_erp_sync_jobs'
    AND policyname = 'plm_sync_jobs_select_org'
    AND cmd = 'SELECT'
    AND qual LIKE '%tracefab_is_org_member(brand_organization_id)%';

  IF v_bad_select <> 1 THEN
    RAISE EXCEPTION 'plm_erp_sync_jobs_select_policy_not_canonical';
  END IF;
END
$verify$;

COMMIT;
