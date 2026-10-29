-- TRACEFAB — correction de dérive RLS PLM/ERP (production observée le 2026-10-29).
--
-- Constat : deux politiques permissives hors chaîne existaient sur
-- plm_erp_sync_jobs :
--   plm_erp_sync_jobs_insert_brand : INSERT incluant contributor
--   plm_erp_sync_jobs_select_brand : SELECT redondant
--
-- PostgreSQL combine les politiques permissives avec OR. La première
-- élargissait donc effectivement l'insertion au rôle contributor malgré la
-- politique canonique plm_sync_jobs_insert_brand.
--
-- Ne pas réécrire 20261006210000 : elle est déjà présente dans l'historique
-- d'exécution sous une empreinte différente. Cette migration corrective est
-- additive et idempotente.

BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.plm_erp_sync_jobs') IS NULL THEN
    RAISE EXCEPTION 'plm_erp_sync_jobs_missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'plm_erp_sync_jobs'
      AND policyname = 'plm_sync_jobs_insert_brand'
      AND cmd = 'INSERT'
  ) THEN
    RAISE EXCEPTION 'canonical_plm_sync_insert_policy_missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'plm_erp_sync_jobs'
      AND policyname = 'plm_sync_jobs_select_org'
      AND cmd = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'canonical_plm_sync_select_policy_missing';
  END IF;
END
$guard$;

DROP POLICY IF EXISTS plm_erp_sync_jobs_insert_brand ON public.plm_erp_sync_jobs;
DROP POLICY IF EXISTS plm_erp_sync_jobs_select_brand ON public.plm_erp_sync_jobs;

DO $verify$
DECLARE
  v_check text;
  v_roles text[];
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'plm_erp_sync_jobs'
      AND policyname IN (
        'plm_erp_sync_jobs_insert_brand',
        'plm_erp_sync_jobs_select_brand'
      )
  ) THEN
    RAISE EXCEPTION 'legacy_plm_sync_policies_still_present';
  END IF;

  SELECT with_check, roles
    INTO v_check, v_roles
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'plm_erp_sync_jobs'
    AND policyname = 'plm_sync_jobs_insert_brand'
    AND cmd = 'INSERT';

  IF v_check IS NULL
     OR v_check NOT LIKE '%owner%'
     OR v_check NOT LIKE '%admin%'
     OR v_check NOT LIKE '%manager%'
     OR v_check LIKE '%contributor%'
     OR NOT ('public' = ANY(v_roles)) THEN
    RAISE EXCEPTION 'canonical_plm_sync_insert_policy_unexpected: % / %',
      v_check, v_roles;
  END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'plm_erp_sync_jobs'
        AND cmd = 'INSERT') <> 1 THEN
    RAISE EXCEPTION 'unexpected_plm_sync_insert_policy_count';
  END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'plm_erp_sync_jobs'
        AND cmd = 'SELECT') <> 1 THEN
    RAISE EXCEPTION 'unexpected_plm_sync_select_policy_count';
  END IF;
END
$verify$;

COMMIT;
