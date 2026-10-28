-- TRACEFAB — suppression des politiques RLS PLM/ERP hors referentiel.
--
-- Constat de lecture seule en production (2026-10-28) :
--   plm_erp_sync_jobs_insert_brand : autorise aussi contributor ;
--   plm_erp_sync_jobs_select_brand : politique SELECT redondante.
-- Les politiques permissives PostgreSQL sont combinees par OR : la premiere
-- elargit effectivement les droits d'insertion au-dela du contrat du depot.
--
-- On conserve les politiques canoniques creees par
-- 20261006210000_plm_erp_gs1_interoperability :
--   plm_sync_jobs_insert_brand (owner/admin/manager)
--   plm_sync_jobs_select_org (membre de l'organisation)
--
-- Cette migration ne change ni les GRANT/REVOKE, ni les donnees, ni les autres
-- tables. Elle est idempotente et ne doit etre appliquee qu'apres verification
-- de la cible et selon la procedure de livraison TraceFab.

BEGIN;

DO $$
DECLARE
  v_table regclass := to_regclass('public.plm_erp_sync_jobs');
BEGIN
  IF v_table IS NULL THEN
    RAISE EXCEPTION 'plm_erp_sync_jobs_absente';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy p
    WHERE p.polrelid = v_table
      AND p.polname = 'plm_sync_jobs_insert_brand'
      AND p.polcmd = 'a'
  ) THEN
    RAISE EXCEPTION 'politique_canonique_insert_absente';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy p
    WHERE p.polrelid = v_table
      AND p.polname = 'plm_sync_jobs_select_org'
      AND p.polcmd = 'r'
  ) THEN
    RAISE EXCEPTION 'politique_canonique_select_absente';
  END IF;
END
$$;

DROP POLICY IF EXISTS plm_erp_sync_jobs_insert_brand ON public.plm_erp_sync_jobs;
DROP POLICY IF EXISTS plm_erp_sync_jobs_select_brand ON public.plm_erp_sync_jobs;

COMMIT;
