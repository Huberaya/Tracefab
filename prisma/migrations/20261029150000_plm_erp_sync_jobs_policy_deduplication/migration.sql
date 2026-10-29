-- TRACEFAB — supprimer les politiques PLM/ERP surnuméraires constatées en production.
--
-- Constat de la confrontation catalogue du 2026-10-29 :
--   plm_erp_sync_jobs_insert_brand : autorisait aussi contributor, contrairement
--     à la politique canonique plm_sync_jobs_insert_brand (owner/admin/manager).
--   plm_erp_sync_jobs_select_brand : doublonnait plm_sync_jobs_select_org.
--
-- Les politiques permissives sont combinées par OR : conserver la première
-- politique INSERT élargissait donc effectivement les droits. On supprime
-- uniquement ces deux noms surnuméraires ; les politiques canoniques restent
-- inchangées. Aucun GRANT/REVOKE, aucune donnée, aucune fonction, aucune autre
-- table n'est modifiée.
--
-- Idempotent : DROP POLICY IF EXISTS peut être rejoué sans effet supplémentaire.

BEGIN;

DROP POLICY IF EXISTS plm_erp_sync_jobs_insert_brand ON public.plm_erp_sync_jobs;
DROP POLICY IF EXISTS plm_erp_sync_jobs_select_brand ON public.plm_erp_sync_jobs;

-- Garde-fous : les deux politiques canoniques doivent toujours exister avec
-- les rôles autorisés attendus. Une erreur annule toute la transaction.
DO $$
DECLARE
  v_insert text;
  v_select text;
BEGIN
  SELECT pg_get_expr(polwithcheck, polrelid)
    INTO v_insert
    FROM pg_policy
   WHERE polrelid = 'public.plm_erp_sync_jobs'::regclass
     AND polname = 'plm_sync_jobs_insert_brand'
     AND polcmd = 'a';

  SELECT pg_get_expr(polqual, polrelid)
    INTO v_select
    FROM pg_policy
   WHERE polrelid = 'public.plm_erp_sync_jobs'::regclass
     AND polname = 'plm_sync_jobs_select_org'
     AND polcmd = 'r';

  IF v_insert IS NULL OR v_insert NOT LIKE '%owner%' OR
     v_insert NOT LIKE '%admin%' OR v_insert NOT LIKE '%manager%' OR
     v_insert LIKE '%contributor%' THEN
    RAISE EXCEPTION 'Garde-fou PLM/ERP : politique INSERT canonique absente ou inattendue';
  END IF;

  IF v_select IS NULL OR v_select NOT LIKE '%tracefab_is_org_member%' THEN
    RAISE EXCEPTION 'Garde-fou PLM/ERP : politique SELECT canonique absente ou inattendue';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'public.plm_erp_sync_jobs'::regclass
       AND polname IN ('plm_erp_sync_jobs_insert_brand', 'plm_erp_sync_jobs_select_brand')
  ) THEN
    RAISE EXCEPTION 'Garde-fou PLM/ERP : une politique surnuméraire subsiste';
  END IF;
END;
$;

COMMIT;
