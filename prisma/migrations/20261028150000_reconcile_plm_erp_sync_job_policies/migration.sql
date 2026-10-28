-- TRACEFAB — réconcilier les politiques PLM/ERP surnuméraires observées en production.
--
-- Mesure du 28/10/2026 sur Primary :
--   plm_erp_sync_jobs_insert_brand : INSERT autorisé à owner/admin/manager/contributor
--   plm_erp_sync_jobs_select_brand : SELECT en doublon de plm_sync_jobs_select_org
-- Les deux politiques sont permissives et s'additionnent aux politiques canoniques.
-- La politique INSERT canonique n'autorise que owner/admin/manager. La politique
-- SELECT canonique applique déjà tracefab_is_org_member(brand_organization_id).
--
-- Correction strictement additive à l'historique : on retire uniquement les deux
-- politiques hors référentiel. On ne change ni les GRANT/REVOKE, ni les données,
-- ni les politiques canoniques. Idempotent et sans effet si les doublons sont absents.
--
-- IMPORTANT : migration de dépôt uniquement. Ne pas l'appliquer en production sans
-- autorisation distincte et après vérification de la cible / plan de déploiement.

DROP POLICY IF EXISTS plm_erp_sync_jobs_insert_brand ON public.plm_erp_sync_jobs;
DROP POLICY IF EXISTS plm_erp_sync_jobs_select_brand ON public.plm_erp_sync_jobs;
