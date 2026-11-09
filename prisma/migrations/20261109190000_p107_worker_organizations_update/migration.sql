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
END
$migration$;

CREATE POLICY organizations_worker_update
  ON public.organizations
  FOR UPDATE
  USING (CURRENT_USER = 'tracefab_worker'::name)
  WITH CHECK (CURRENT_USER = 'tracefab_worker'::name);

CREATE OR REPLACE FUNCTION public.tracefab_archive_clerk_organization(p_clerk_organization_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id UUID;
  v_lignes INTEGER;
BEGIN
  IF NOT public.tracefab_identite_systeme() THEN
    RAISE EXCEPTION 'authentication_required'
      USING ERRCODE = '42501',
            HINT = 'P10.7 : cette operation systeme exige une identite systeme signee (TRACEFAB_IDENTITY_KEY cote application).';
  END IF;

  IF p_clerk_organization_id IS NULL OR btrim(p_clerk_organization_id) = '' THEN
    RAISE EXCEPTION 'clerk_organization_id_required' USING ERRCODE = '22023';
  END IF;

  SELECT o.id INTO v_id
    FROM public.organizations o
   WHERE o.clerk_organization_id = p_clerk_organization_id;

  IF v_id IS NULL THEN
    RETURN FALSE;
  END IF;

  UPDATE public.organizations
     SET status = 'archived',
         updated_at = now()
   WHERE id = v_id;
  GET DIAGNOSTICS v_lignes = ROW_COUNT;

  IF v_lignes <> 1 THEN
    RAISE EXCEPTION 'organization_archive_update_not_applied'
      USING ERRCODE = '42501',
            HINT = 'P10.7 : verifier la politique organizations_worker_update et le proprietaire tracefab_worker.';
  END IF;

  UPDATE public.organization_memberships
     SET status = 'revoked'
   WHERE organization_id = v_id
     AND status <> 'revoked';

  RETURN TRUE;
END
$function$;
