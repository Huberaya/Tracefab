-- TraceFab — réconciliation ciblée des politiques PLM/ERP.
--
-- INCIDENT MESURÉ EN PRODUCTION (lecture seule, 2026-10-29) :
-- plm_erp_sync_jobs portait quatre politiques au lieu des deux de référence.
-- Deux politiques hors chaîne accordaient des droits supplémentaires :
--   - plm_erp_sync_jobs_insert_brand autorisait aussi contributor ;
--   - plm_erp_sync_jobs_select_brand doublonnait la politique SELECT canonique.
--
-- PostgreSQL combine les politiques permissives par OR. Une politique
-- supplémentaire n'est donc pas neutralisée par une politique plus stricte.
-- Cette migration retire uniquement les deux politiques surnuméraires puis
-- réaffirme les deux politiques canoniques. Aucun GRANT/REVOKE ni aucune donnée
-- métier n'est modifié ici.
--
-- Idempotente : les DROP sont conditionnels et les politiques canoniques sont
-- recréées avec leurs expressions attendues.

BEGIN;

ALTER TABLE public.plm_erp_sync_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plm_erp_sync_jobs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plm_erp_sync_jobs_insert_brand
  ON public.plm_erp_sync_jobs;
DROP POLICY IF EXISTS plm_erp_sync_jobs_select_brand
  ON public.plm_erp_sync_jobs;

DROP POLICY IF EXISTS plm_sync_jobs_select_org
  ON public.plm_erp_sync_jobs;
CREATE POLICY plm_sync_jobs_select_org
  ON public.plm_erp_sync_jobs
  FOR SELECT TO PUBLIC
  USING (tracefab_is_org_member(brand_organization_id));

DROP POLICY IF EXISTS plm_sync_jobs_insert_brand
  ON public.plm_erp_sync_jobs;
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
