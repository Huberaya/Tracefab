-- TRACEFAB — supprime les politiques PLM/ERP en doublon qui élargissent la RLS.
--
-- Constat production (lecture seule, 2026-10-28) :
--   plm_erp_sync_jobs_insert_brand autorisait aussi contributor ;
--   plm_erp_sync_jobs_select_brand doublonnait plm_sync_jobs_select_org.
-- Les politiques permissives PostgreSQL sont combinées par OR : conserver le
-- doublon INSERT élargissait réellement les rôles autorisés.
--
-- Ne réécrit aucun historique Prisma et ne modifie aucune donnée.
-- Idempotent : DROP IF EXISTS, puis recréation de l'unique politique attendue
-- pour chaque opération. À exécuter dans une transaction.

BEGIN;

DROP POLICY IF EXISTS plm_erp_sync_jobs_insert_brand ON public.plm_erp_sync_jobs;
DROP POLICY IF EXISTS plm_erp_sync_jobs_select_brand ON public.plm_erp_sync_jobs;
DROP POLICY IF EXISTS plm_sync_jobs_insert_brand ON public.plm_erp_sync_jobs;
DROP POLICY IF EXISTS plm_sync_jobs_select_org ON public.plm_erp_sync_jobs;

CREATE POLICY plm_sync_jobs_select_org
  ON public.plm_erp_sync_jobs
  FOR SELECT TO PUBLIC
  USING (tracefab_is_org_member(brand_organization_id));

CREATE POLICY plm_sync_jobs_insert_brand
  ON public.plm_erp_sync_jobs
  FOR INSERT TO PUBLIC
  WITH CHECK (
    tracefab_has_org_role(
      brand_organization_id,
      ARRAY['owner', 'admin', 'manager']::membership_role[]
    )
  );

COMMIT;
