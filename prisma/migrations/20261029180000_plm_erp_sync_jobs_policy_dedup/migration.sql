-- TRACEFAB — normalisation des politiques RLS PLM/ERP.
--
-- Constat de production (lecture seule, 2026-10-29) :
--   * plm_erp_sync_jobs_insert_brand autorisait aussi contributor ;
--   * plm_erp_sync_jobs_select_brand doublonnait la politique de lecture ;
--   * les politiques permissives se combinent par OR : le doublon INSERT
--     élargissait donc effectivement les droits malgré la politique stricte.
--
-- On conserve une seule politique INSERT (owner/admin/manager) et une seule
-- politique SELECT (membre de l'organisation). Aucun GRANT n'est modifié.
-- Migration idempotente ; aucune donnée métier n'est modifiée.

DO $guard$
BEGIN
  IF to_regclass('public.plm_erp_sync_jobs') IS NULL THEN
    RAISE EXCEPTION 'plm_erp_sync_jobs_missing: table required before policy hardening';
  END IF;
END
$guard$;

DROP POLICY IF EXISTS plm_erp_sync_jobs_insert_brand ON public.plm_erp_sync_jobs;
DROP POLICY IF EXISTS plm_erp_sync_jobs_select_brand ON public.plm_erp_sync_jobs;

-- Recréer les politiques canoniques garantit que leur définition ne dépend
-- pas d'un état antérieur ou d'une création partielle hors bande.
DROP POLICY IF EXISTS plm_sync_jobs_insert_brand ON public.plm_erp_sync_jobs;
CREATE POLICY plm_sync_jobs_insert_brand
  ON public.plm_erp_sync_jobs
  FOR INSERT TO PUBLIC
  WITH CHECK (
    tracefab_has_org_role(
      brand_organization_id,
      ARRAY['owner', 'admin', 'manager']::membership_role[]
    )
  );

DROP POLICY IF EXISTS plm_sync_jobs_select_org ON public.plm_erp_sync_jobs;
CREATE POLICY plm_sync_jobs_select_org
  ON public.plm_erp_sync_jobs
  FOR SELECT TO PUBLIC
  USING (tracefab_is_org_member(brand_organization_id));
