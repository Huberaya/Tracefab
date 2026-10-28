-- Reconcile observed duplicate/overbroad PLM sync-job RLS policies.
DROP POLICY IF EXISTS plm_erp_sync_jobs_insert_brand ON public.plm_erp_sync_jobs;
DROP POLICY IF EXISTS plm_erp_sync_jobs_select_brand ON public.plm_erp_sync_jobs;
DROP POLICY IF EXISTS plm_sync_jobs_select_org ON public.plm_erp_sync_jobs;
CREATE POLICY plm_sync_jobs_select_org ON public.plm_erp_sync_jobs FOR SELECT TO PUBLIC USING (tracefab_is_org_member(brand_organization_id));
DROP POLICY IF EXISTS plm_sync_jobs_insert_brand ON public.plm_erp_sync_jobs;
CREATE POLICY plm_sync_jobs_insert_brand ON public.plm_erp_sync_jobs FOR INSERT TO PUBLIC WITH CHECK (tracefab_has_org_role(brand_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[]));
