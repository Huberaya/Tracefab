-- TRACEFAB — supprimer deux politiques RLS hors référentiel sur plm_erp_sync_jobs.
--
-- Constat de production en lecture seule (29/10/2026) :
--   plm_erp_sync_jobs_insert_brand : INSERT autorisé à owner/admin/manager/contributor
--   plm_erp_sync_jobs_select_brand : SELECT redondant
-- Les politiques sont PERMISSIVE : elles se combinent par OR. La politique INSERT
-- supplémentaire élargit donc réellement les rôles autorisés au-delà du référentiel.
-- Les politiques canoniques plm_sync_jobs_insert_brand et plm_sync_jobs_select_org
-- restent en place. Aucun GRANT/REVOKE ni aucune donnée ne sont modifiés.
--
-- Idempotent. Ne pas appliquer en production avant revue et autorisation distinctes.

BEGIN;

DROP POLICY IF EXISTS plm_erp_sync_jobs_insert_brand ON public.plm_erp_sync_jobs;
DROP POLICY IF EXISTS plm_erp_sync_jobs_select_brand ON public.plm_erp_sync_jobs;

COMMIT;
