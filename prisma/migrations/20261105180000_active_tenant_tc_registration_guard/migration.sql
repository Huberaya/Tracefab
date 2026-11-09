-- TraceFab — l'enregistrement direct d'un TC doit être borné au tenant actif.
--
-- La route HTTP vérifie que le tenant actif est le vendeur ou l'acheteur.
-- La fonction SECURITY DEFINER était appelable directement par tracefab_app et
-- ne répétait pas cette vérification : un membre multi-organisation pouvait
-- donc enregistrer un certificat entre deux organisations tierces par SQL.
-- Le remplacement dynamique préserve l'OID, le propriétaire et les ACL.

BEGIN;

DO $guard_tc_registration$
DECLARE
  v_oid oid;
  v_owner oid;
  v_acl aclitem[];
  v_after_oid oid;
  v_after_owner oid;
  v_after_acl aclitem[];
  v_count integer;
  v_definition text;
  v_begin integer;
  v_guard text := 'IF NOT (public.tracefab_in_active_tenant(p_seller_organization_id) OR public.tracefab_in_active_tenant(p_buyer_organization_id)) THEN RAISE EXCEPTION ''active_tenant_mismatch''; END IF;';
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'tracefab_register_transaction_certificate';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'active_tenant_tc_registration_expected_one_function: found %', v_count;
  END IF;

  SELECT p.oid, p.proowner, p.proacl
    INTO v_oid, v_owner, v_acl
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'tracefab_register_transaction_certificate'
     AND p.prosecdef;

  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'active_tenant_tc_registration_target_not_security_definer';
  END IF;

  v_definition := pg_catalog.pg_get_functiondef(v_oid);
  IF pg_catalog.strpos(v_definition, 'tracefab_in_active_tenant(p_seller_organization_id)') = 0 THEN
    IF pg_catalog.strpos(v_definition, 'p_seller_organization_id') = 0
       OR pg_catalog.strpos(v_definition, 'p_buyer_organization_id') = 0 THEN
      RAISE EXCEPTION 'active_tenant_tc_registration_expected_parameters_missing';
    END IF;

    v_begin := pg_catalog.strpos(v_definition, 'BEGIN');
    IF v_begin = 0 THEN
      RAISE EXCEPTION 'active_tenant_tc_registration_cannot_find_plpgsql_body';
    END IF;

    v_definition :=
      pg_catalog.substr(v_definition, 1, v_begin - 1)
      || 'BEGIN' || E'\n  ' || v_guard || E'\n'
      || pg_catalog.substr(v_definition, v_begin + 5);

    EXECUTE v_definition;
  END IF;

  SELECT p.oid, p.proowner, p.proacl
    INTO v_after_oid, v_after_owner, v_after_acl
    FROM pg_catalog.pg_proc p
   WHERE p.oid = v_oid;

  IF v_after_oid IS DISTINCT FROM v_oid
     OR v_after_owner IS DISTINCT FROM v_owner
     OR v_after_acl IS DISTINCT FROM v_acl THEN
    RAISE EXCEPTION 'active_tenant_tc_registration_changed_oid_owner_or_acl';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'tracefab_register_transaction_certificate'
       AND p.prosecdef
       AND pg_catalog.strpos(
         pg_catalog.pg_get_functiondef(p.oid),
         'tracefab_in_active_tenant(p_seller_organization_id)'
       ) > 0
  ) THEN
    RAISE EXCEPTION 'active_tenant_tc_registration_postcondition_failed';
  END IF;
END;
$guard_tc_registration$;

COMMIT;
