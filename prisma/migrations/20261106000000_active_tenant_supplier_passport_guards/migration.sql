-- TraceFab — fermer l'accès direct inter-tenant aux passeports fournisseurs.
--
-- Migration additive : certaines bases de validation possèdent déjà la
-- migration 20261105210000 avec les gardes de profil fournisseur, mais sans
-- les deux gardes passeport. Ne pas modifier l'historique : compléter ici les
-- fonctions existantes, de façon idempotente et sans changer OID, propriétaire
-- ni ACL.
--
-- Les identifiants d'organisation sont des paramètres disponibles dès l'entrée
-- de ces deux fonctions. La garde est donc placée immédiatement après BEGIN,
-- avant toute lecture, branche ou mutation métier.

BEGIN;

DO $supplier_passport_active_tenant_guards$
DECLARE
  v_target record;
  v_oid oid;
  v_owner oid;
  v_acl aclitem[];
  v_after_oid oid;
  v_after_owner oid;
  v_after_acl aclitem[];
  v_definition text;
  v_guard text := 'PERFORM public.tracefab_require_active_tenant_for_organization(p_supplier_organization_id);';
  v_begin integer;
  v_guard_position integer;
  v_role_position integer;
  v_owner_name text;
BEGIN
  FOR v_target IN
    SELECT * FROM (VALUES
      ('tracefab_get_or_create_supplier_passport'),
      ('tracefab_update_supplier_passport')
    ) AS t(function_name)
  LOOP
    SELECT p.oid, p.proowner, p.proacl
      INTO v_oid, v_owner, v_acl
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = v_target.function_name
       AND p.prosecdef;

    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'supplier_passport_guard_target_not_security_definer: %',
        v_target.function_name;
    END IF;

    v_definition := pg_catalog.pg_get_functiondef(v_oid);
    v_guard_position := pg_catalog.strpos(v_definition, v_guard);
    v_role_position := pg_catalog.strpos(v_definition, 'IF NOT tracefab_has_org_role(');

    -- Si la garde est absente ou placée après le contrôle métier, la replacer
    -- au début du corps PL/pgSQL. Le remplacement retire toute occurrence
    -- antérieure pour éviter les doubles gardes.
    IF v_guard_position = 0
       OR (v_role_position > 0 AND v_guard_position > v_role_position) THEN
      v_definition := pg_catalog.replace(v_definition, v_guard, '');
      v_begin := pg_catalog.strpos(v_definition, 'BEGIN');
      IF v_begin = 0 THEN
        RAISE EXCEPTION 'supplier_passport_guard_cannot_find_begin: %',
          v_target.function_name;
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
      RAISE EXCEPTION 'supplier_passport_guard_changed_oid_owner_or_acl: %',
        v_target.function_name;
    END IF;

    SELECT r.rolname INTO v_owner_name
      FROM pg_catalog.pg_roles r
     WHERE r.oid = v_owner;

    IF v_owner_name IS NULL OR v_owner_name = 'tracefab_app' THEN
      RAISE EXCEPTION 'supplier_passport_guard_invalid_function_owner: %',
        v_target.function_name;
    END IF;

    -- Les helpers sont INVOKER et inaccessibles directement au rôle HTTP.
    -- Seul le propriétaire SECURITY DEFINER de la fonction appelante peut
    -- les exécuter.
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.tracefab_require_active_tenant_for_organization(uuid) TO %I',
      v_owner_name
    );

    v_definition := pg_catalog.pg_get_functiondef(v_oid);
    v_begin := pg_catalog.strpos(v_definition, 'BEGIN');
    v_guard_position := pg_catalog.strpos(v_definition, v_guard);
    v_role_position := pg_catalog.strpos(v_definition, 'IF NOT tracefab_has_org_role(');

    IF v_begin = 0
       OR v_guard_position <= v_begin
       OR (v_role_position > 0 AND v_guard_position > v_role_position) THEN
      RAISE EXCEPTION 'supplier_passport_guard_postcondition_failed: % (begin %, guard %, role %)',
        v_target.function_name, v_begin, v_guard_position, v_role_position;
    END IF;
  END LOOP;

  IF pg_catalog.has_function_privilege(
    'tracefab_app',
    'public.tracefab_require_active_tenant_for_organization(uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'supplier_passport_guard_helper_executable_by_runtime';
  END IF;
END
$supplier_passport_active_tenant_guards$;

COMMIT;
