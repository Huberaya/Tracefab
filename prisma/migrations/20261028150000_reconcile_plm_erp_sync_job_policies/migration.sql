-- TRACEFAB — réconcilier les politiques PLM/ERP surnuméraires observées en production.
--
-- Mesure de lecture seule sur Primary (2026-10-28) :
--   plm_erp_sync_jobs_insert_brand : INSERT autorisé à owner/admin/manager/contributor
--   plm_erp_sync_jobs_select_brand : SELECT en doublon de plm_sync_jobs_select_org
-- Les politiques permissives s'additionnent par OR : la première élargit réellement
-- le droit d'insertion au-delà du contrat du dépôt.
--
-- Préconditions fail-closed : la table et les deux politiques canoniques doivent
-- exister, et la politique canonique INSERT ne doit pas mentionner contributor.
-- Sinon, la migration échoue sans supprimer les politiques observées.
--
-- On retire uniquement les deux politiques hors référentiel. Aucun GRANT/REVOKE,
-- aucune donnée ni définition de table n'est modifié. Idempotente après la première
-- exécution : les politiques surnuméraires peuvent déjà être absentes.
--
-- Migration de dépôt uniquement. Ne pas l'appliquer en production sans autorisation
-- explicite et après validation du plan de déploiement.

BEGIN;

DO $$
DECLARE
  v_table regclass := to_regclass('public.plm_erp_sync_jobs');
  v_insert_check text;
  v_policy_count integer;
  v_unexpected_count integer;
BEGIN
  IF v_table IS NULL THEN
    RAISE EXCEPTION 'plm_erp_sync_jobs_absente';
  END IF;

  -- Le catalogue mesuré comporte soit les quatre politiques connues (état
  -- avant correction), soit les deux canoniques (rejeu idempotent). Toute
  -- cinquième politique — ou tout état partiel inattendu — doit bloquer avant
  -- les DROP : ne jamais supprimer à l'aveugle une configuration inconnue.
  SELECT count(*) INTO v_policy_count
    FROM pg_catalog.pg_policy WHERE polrelid = v_table;
  SELECT count(*) INTO v_unexpected_count
    FROM pg_catalog.pg_policy
   WHERE polrelid = v_table
     AND polname NOT IN (
       'plm_sync_jobs_insert_brand',
       'plm_sync_jobs_select_org',
       'plm_erp_sync_jobs_insert_brand',
       'plm_erp_sync_jobs_select_brand'
     );
  IF v_policy_count NOT IN (2, 4) OR v_unexpected_count <> 0 THEN
    RAISE EXCEPTION 'nombre_ou_identite_politiques_inattendu: total=%, inattendues=%',
      v_policy_count, v_unexpected_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy
    WHERE polrelid = v_table AND polname = 'plm_sync_jobs_insert_brand' AND polcmd = 'a'
  ) THEN
    RAISE EXCEPTION 'politique_canonique_insert_absente';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy
    WHERE polrelid = v_table AND polname = 'plm_sync_jobs_select_org' AND polcmd = 'r'
  ) THEN
    RAISE EXCEPTION 'politique_canonique_select_absente';
  END IF;

  SELECT pg_catalog.pg_get_expr(polwithcheck, polrelid)
    INTO v_insert_check
    FROM pg_catalog.pg_policy
   WHERE polrelid = v_table AND polname = 'plm_sync_jobs_insert_brand' AND polcmd = 'a';

  IF v_insert_check IS NULL
     OR v_insert_check ILIKE '%contributor%'
     OR v_insert_check NOT ILIKE '%owner%'
     OR v_insert_check NOT ILIKE '%admin%'
     OR v_insert_check NOT ILIKE '%manager%' THEN
    RAISE EXCEPTION 'politique_canonique_insert_inattendue';
  END IF;
END
$$;

DROP POLICY IF EXISTS plm_erp_sync_jobs_insert_brand ON public.plm_erp_sync_jobs;
DROP POLICY IF EXISTS plm_erp_sync_jobs_select_brand ON public.plm_erp_sync_jobs;

COMMIT;
