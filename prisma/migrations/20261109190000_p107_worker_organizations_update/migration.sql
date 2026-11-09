-- P10.7: les fonctions systeme sont SECURITY DEFINER sous tracefab_worker.
-- Le role n'a pas BYPASSRLS; il lui faut donc une politique UPDATE explicite.
-- L'acces reste borne au role fonctionnel, et toutes ses fonctions d'ecriture
-- SECURITY DEFINER (hors helper email strictement lecteur) doivent porter
-- la garde HMAC tracefab_identite_systeme().
DO $migration$
DECLARE
  v_unguarded text;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname)
    INTO v_unguarded
    FROM pg_proc p
   WHERE p.proowner = 'tracefab_worker'::regrole
     AND p.prosecdef
     AND p.pronamespace = 'public'::regnamespace
     AND p.proname <> 'tracefab_current_user_email'
     AND position('tracefab_identite_systeme()' in pg_get_functiondef(p.oid)) = 0;

  IF v_unguarded IS NOT NULL THEN
    RAISE EXCEPTION 'P10.7 refuse organizations_worker_update: fonctions worker SECURITY DEFINER non gardees: %', v_unguarded;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'organizations'
       AND policyname = 'organizations_worker_update'
  ) THEN
    EXECUTE 'CREATE POLICY organizations_worker_update ON public.organizations FOR UPDATE USING (CURRENT_USER = ''tracefab_worker''::name) WITH CHECK (CURRENT_USER = ''tracefab_worker''::name)';
  END IF;
END
$migration$;
