-- TRACEFAB — convergence des politiques PLM/ERP de sync jobs.
--
-- Confrontation du catalogue de production (2026-10-28) :
-- deux politiques supplémentaires, absentes du dépôt, coexistent avec les
-- politiques canoniques. PostgreSQL combine les politiques permissives par OR :
-- plm_erp_sync_jobs_insert_brand autorise donc contributor à insérer malgré
-- plm_sync_jobs_insert_brand, qui réserve cette action à owner/admin/manager.
--
-- On retire uniquement les deux anciennes politiques supplémentaires. La
-- migration canonique 20261006210000_plm_erp_gs1_interoperability conserve
-- plm_sync_jobs_select_org et plm_sync_jobs_insert_brand. Aucun GRANT/REVOKE,
-- aucune donnée métier modifiée.
DROP POLICY IF EXISTS plm_erp_sync_jobs_insert_brand ON public.plm_erp_sync_jobs;
DROP POLICY IF EXISTS plm_erp_sync_jobs_select_brand ON public.plm_erp_sync_jobs;
