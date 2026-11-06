-- TraceFab — bornage tenant des matières et certifications.
-- Les routes correspondantes résolvent déjà le tenant ; la garde SQL empêche
-- qu'un appel direct SECURITY DEFINER utilise une autre organisation membre.

BEGIN;

DO $guard_material_certification$
DECLARE
  v_target record;
  v_oid oid;
  v_owner oid;
  v_acl aclitem[];
  v_after_owner oid;
  v_after_acl aclitem[];
  v_definition text;
  v_anchor integer;
  v_guard text;
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
         'tracefab_create_material','tracefab_update_material',
         'tracefab_register_certification','tracefab_update_certification'
       ])
  LOOP
    IF v_role.rolname = 'tracefab_app' THEN
      RAISE EXCEPTION 'active_tenant_material_certification_runtime_owns_definer_function';
    END IF;
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.tracefab_require_active_tenant_for_organization(uuid) TO %I',
      v_role.rolname
    );
  END LOOP;

  FOR v_target IN
    SELECT * FROM (VALUES
      ('tracefab_create_material', 'PERFORM public.tracefab_require_active_tenant_for_organization(p_owner_organization_id);'),
      ('tracefab_update_material', 'PERFORM public.tracefab_require_active_tenant_for_organization(v_material.owner_organization_id);'),
      ('tracefab_register_certification', 'PERFORM public.tracefab_require_active_tenant_for_organization(p_owner_organization_id);'),
      ('tracefab_update_certification', 'PERFORM public.tracefab_require_active_tenant_for_organization(v_certification.owner_organization_id);')
    ) AS targets(function_name, guard_sql)
  LOOP
    SELECT p.oid, p.proowner, p.proacl
      INTO v_oid, v_owner, v_acl
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname=v_target.function_name AND p.prosecdef;

    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'active_tenant_material_certification_target_missing_or_not_definer: %', v_target.function_name;
    END IF;

    v_definition := pg_catalog.pg_get_functiondef(v_oid);
    IF pg_catalog.strpos(v_definition, v_target.guard_sql) = 0 THEN
      v_anchor := pg_catalog.strpos(v_definition, 'IF NOT tracefab_has_org_role(');
      IF v_anchor = 0 THEN
        RAISE EXCEPTION 'active_tenant_material_certification_role_anchor_missing: %', v_target.function_name;
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
      RAISE EXCEPTION 'active_tenant_material_certification_changed_owner_or_acl: %', v_target.function_name;
    END IF;

    IF pg_catalog.strpos(pg_catalog.pg_get_functiondef(v_oid), v_target.guard_sql) = 0 THEN
      RAISE EXCEPTION 'active_tenant_material_certification_postcondition_failed: %', v_target.function_name;
    END IF;
  END LOOP;

  IF has_function_privilege('tracefab_app', 'public.tracefab_require_active_tenant_for_organization(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'active_tenant_material_certification_helper_executable_by_runtime';
  END IF;
END;
$guard_material_certification$;

COMMIT;
