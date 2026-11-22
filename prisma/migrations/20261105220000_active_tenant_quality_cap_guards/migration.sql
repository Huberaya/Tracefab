-- TraceFab — garde tenant des plans d'actions correctives qualité.
-- La marque crée/revoit le CAP ; le fournisseur soumet sa remédiation.

BEGIN;

DO $guard_quality_caps$
DECLARE
  v_target record;
  v_oid oid;
  v_owner oid;
  v_acl aclitem[];
  v_after_owner oid;
  v_after_acl aclitem[];
  v_definition text;
  v_anchor integer;
  v_role record;
BEGIN
  FOR v_role IN
    SELECT DISTINCT r.rolname
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
     WHERE n.nspname='public'
       AND p.prosecdef
       AND p.proname = ANY(ARRAY[
         'tracefab_create_quality_cap','tracefab_submit_quality_remediation',
         'tracefab_review_quality_remediation'
       ])
  LOOP
    IF v_role.rolname = 'tracefab_app' THEN
      RAISE EXCEPTION 'active_tenant_quality_cap_runtime_owns_definer_function';
    END IF;
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.tracefab_require_active_tenant_for_organization(uuid) TO %I',
      v_role.rolname
    );
  END LOOP;

  FOR v_target IN
    SELECT * FROM (VALUES
      ('tracefab_create_quality_cap', 'PERFORM public.tracefab_require_active_tenant_for_organization(v_issue.owner_organization_id);', 'IF NOT tracefab_has_org_role('),
      ('tracefab_submit_quality_remediation', 'PERFORM public.tracefab_require_active_tenant_for_organization(v_cap.supplier_organization_id);', 'IF NOT tracefab_is_org_member('),
      ('tracefab_review_quality_remediation', 'PERFORM public.tracefab_require_active_tenant_for_organization(v_cap.brand_organization_id);', 'IF NOT tracefab_has_org_role(')
    ) AS targets(function_name, guard_sql, role_anchor)
  LOOP
    SELECT p.oid, p.proowner, p.proacl
      INTO v_oid, v_owner, v_acl
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname=v_target.function_name AND p.prosecdef;

    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'active_tenant_quality_cap_target_missing_or_not_definer: %', v_target.function_name;
    END IF;

    v_definition := pg_catalog.pg_get_functiondef(v_oid);
    IF pg_catalog.strpos(v_definition, v_target.guard_sql) = 0 THEN
      v_anchor := pg_catalog.strpos(v_definition, v_target.role_anchor);
      IF v_anchor = 0 THEN
        RAISE EXCEPTION 'active_tenant_quality_cap_role_anchor_missing: %', v_target.function_name;
      END IF;

      v_definition :=
        pg_catalog.substr(v_definition, 1, v_anchor - 1)
        || v_target.guard_sql || E'\n  '
        || pg_catalog.substr(v_definition, v_anchor);

      EXECUTE v_definition;
    END IF;

    SELECT p.proowner, p.proacl
      INTO v_after_owner, v_after_acl
      FROM pg_catalog.pg_proc p
     WHERE p.oid=v_oid;

    IF v_after_owner IS DISTINCT FROM v_owner OR v_after_acl IS DISTINCT FROM v_acl THEN
      RAISE EXCEPTION 'active_tenant_quality_cap_changed_owner_or_acl: %', v_target.function_name;
    END IF;

    IF pg_catalog.strpos(pg_catalog.pg_get_functiondef(v_oid), v_target.guard_sql) = 0 THEN
      RAISE EXCEPTION 'active_tenant_quality_cap_postcondition_failed: %', v_target.function_name;
    END IF;
  END LOOP;

  IF has_function_privilege('tracefab_app', 'public.tracefab_require_active_tenant_for_organization(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'active_tenant_quality_cap_helper_executable_by_runtime';
  END IF;
END;
$guard_quality_caps$;

COMMIT;
