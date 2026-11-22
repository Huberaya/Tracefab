-- TraceFab — le calcul de qualité fournisseur est lié au tenant actif.
-- L'accès par partage reste contrôlé par la relation métier, mais le contexte
-- actif doit être le tenant propriétaire du fournisseur pour muter ses scores/issues.

BEGIN;

DO $guard_supplier_quality$
DECLARE
  v_oid oid;
  v_owner oid;
  v_acl aclitem[];
  v_after_owner oid;
  v_after_acl aclitem[];
  v_definition text;
  v_anchor integer;
  v_role record;
  v_guard constant text := 'PERFORM public.tracefab_require_active_tenant_for_organization(v_owner_organization_id);';
BEGIN
  FOR v_role IN
    SELECT DISTINCT r.rolname
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
     WHERE n.nspname = 'public'
       AND p.prosecdef
       AND p.proname = 'tracefab_compute_supplier_quality'
  LOOP
    IF v_role.rolname = 'tracefab_app' THEN
      RAISE EXCEPTION 'active_tenant_supplier_quality_runtime_owns_definer_function';
    END IF;
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.tracefab_require_active_tenant_for_organization(uuid) TO %I',
      v_role.rolname
    );
  END LOOP;

  SELECT p.oid, p.proowner, p.proacl
    INTO v_oid, v_owner, v_acl
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'tracefab_compute_supplier_quality'
     AND p.prosecdef;

  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'active_tenant_supplier_quality_target_missing_or_not_definer';
  END IF;

  v_definition := pg_catalog.pg_get_functiondef(v_oid);
  IF pg_catalog.strpos(v_definition, v_guard) = 0 THEN
    v_anchor := pg_catalog.strpos(v_definition, 'IF NOT (');
    IF v_anchor = 0 THEN
      RAISE EXCEPTION 'active_tenant_supplier_quality_anchor_missing';
    END IF;
    v_definition :=
      pg_catalog.substr(v_definition, 1, v_anchor - 1)
      || v_guard || E'\n  '
      || pg_catalog.substr(v_definition, v_anchor);
    EXECUTE v_definition;
  END IF;

  SELECT p.proowner, p.proacl
    INTO v_after_owner, v_after_acl
    FROM pg_catalog.pg_proc p
   WHERE p.oid = v_oid;

  IF v_after_owner IS DISTINCT FROM v_owner OR v_after_acl IS DISTINCT FROM v_acl THEN
    RAISE EXCEPTION 'active_tenant_supplier_quality_changed_owner_or_acl';
  END IF;
  IF pg_catalog.strpos(pg_catalog.pg_get_functiondef(v_oid), v_guard) = 0 THEN
    RAISE EXCEPTION 'active_tenant_supplier_quality_postcondition_failed';
  END IF;
  IF has_function_privilege('tracefab_app', 'public.tracefab_require_active_tenant_for_organization(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'active_tenant_supplier_quality_helper_executable_by_runtime';
  END IF;
END;
$guard_supplier_quality$;

COMMIT;
