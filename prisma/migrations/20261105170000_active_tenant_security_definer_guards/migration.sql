-- TraceFab — verrouiller les fonctions SECURITY DEFINER sur le tenant actif.
--
-- Les routes vérifient déjà le tenant avant l'appel, mais cela ne protège pas
-- un appel SQL direct effectué avec tracefab_app. Cette migration ajoute une
-- garde dans le corps des 19 fonctions exposées au runtime.
--
-- Les définitions sont relues via pg_get_functiondef puis remplacées par
-- CREATE OR REPLACE : OID, propriétaire et ACL doivent rester identiques.
-- Les helpers sont INVOKER, sans EXECUTE pour PUBLIC ni tracefab_app ; seuls
-- les propriétaires des fonctions appelantes peuvent les exécuter.
--
-- Le calcul interne tracefab_calculate_product_data_completion est exclu :
-- son trigger intervient pendant la création du produit, avant qu'un contexte
-- utilisateur puisse être requis dans ce chemin interne.

BEGIN;

CREATE OR REPLACE FUNCTION public.tracefab_require_active_tenant_for_organization(p_organization_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $guard$
BEGIN
  IF p_organization_id IS NULL OR NOT public.tracefab_in_active_tenant(p_organization_id) THEN
    RAISE EXCEPTION 'active_tenant_mismatch';
  END IF;
END;
$guard$;

CREATE OR REPLACE FUNCTION public.tracefab_require_active_tenant_for_product(p_product_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $guard$
DECLARE
  v_organization_id uuid;
BEGIN
  SELECT p.brand_organization_id
    INTO v_organization_id
    FROM public.tracefab_products p
   WHERE p.id = p_product_id;

  -- Laisser la fonction métier produire son erreur historique si le produit
  -- n'existe pas ; la garde ne change que le cas d'un produit d'un autre tenant.
  IF v_organization_id IS NOT NULL THEN
    PERFORM public.tracefab_require_active_tenant_for_organization(v_organization_id);
  END IF;
END;
$guard$;

CREATE OR REPLACE FUNCTION public.tracefab_require_active_tenant_for_dpp_record(p_dpp_record_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $guard$
DECLARE
  v_organization_id uuid;
BEGIN
  SELECT p.brand_organization_id
    INTO v_organization_id
    FROM public.dpp_records r
    JOIN public.tracefab_products p ON p.id = r.product_id
   WHERE r.id = p_dpp_record_id;

  IF v_organization_id IS NOT NULL THEN
    PERFORM public.tracefab_require_active_tenant_for_organization(v_organization_id);
  END IF;
END;
$guard$;

CREATE OR REPLACE FUNCTION public.tracefab_require_active_tenant_for_supply_chain_link(p_link_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $guard$
DECLARE
  v_organization_id uuid;
BEGIN
  SELECT p.brand_organization_id
    INTO v_organization_id
    FROM public.supply_chain_links l
    JOIN public.tracefab_products p ON p.id = l.product_id
   WHERE l.id = p_link_id;

  IF v_organization_id IS NOT NULL THEN
    PERFORM public.tracefab_require_active_tenant_for_organization(v_organization_id);
  END IF;
END;
$guard$;

CREATE OR REPLACE FUNCTION public.tracefab_require_active_tenant_for_tc_allocation(p_tc_id uuid, p_product_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $guard$
DECLARE
  v_brand_organization_id uuid;
  v_seller_organization_id uuid;
BEGIN
  SELECT p.brand_organization_id
    INTO v_brand_organization_id
    FROM public.tracefab_products p
   WHERE p.id = p_product_id;

  SELECT tc.seller_organization_id
    INTO v_seller_organization_id
    FROM public.transaction_certificates tc
   WHERE tc.id = p_tc_id;

  -- L'allocation peut être initiée par la marque destinataire ou par le
  -- fournisseur vendeur du certificat ; aucun autre tenant n'est admis.
  IF v_brand_organization_id IS NOT NULL AND v_seller_organization_id IS NOT NULL
     AND NOT (
       public.tracefab_in_active_tenant(v_brand_organization_id)
       OR public.tracefab_in_active_tenant(v_seller_organization_id)
     ) THEN
    RAISE EXCEPTION 'active_tenant_mismatch';
  END IF;
END;
$guard$;

CREATE OR REPLACE FUNCTION public.tracefab_require_active_tenant_for_schema_subject(p_subject_type text, p_subject_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $guard$
DECLARE
  v_organization_id uuid;
  v_supplier_organization_id uuid;
BEGIN
  CASE p_subject_type
    WHEN 'product' THEN
      SELECT p.brand_organization_id INTO v_organization_id
        FROM public.tracefab_products p WHERE p.id = p_subject_id;
    WHEN 'material' THEN
      SELECT m.owner_organization_id INTO v_organization_id
        FROM public.materials m WHERE m.id = p_subject_id;
    WHEN 'supplier' THEN
      SELECT s.organization_id INTO v_organization_id
        FROM public.suppliers s WHERE s.id = p_subject_id;
    WHEN 'data_request' THEN
      SELECT dr.brand_organization_id, dr.supplier_organization_id
        INTO v_organization_id, v_supplier_organization_id
        FROM public.data_requests dr WHERE dr.id = p_subject_id;
      IF v_organization_id IS NOT NULL OR v_supplier_organization_id IS NOT NULL THEN
        IF public.tracefab_in_active_tenant(v_organization_id)
           OR public.tracefab_in_active_tenant(v_supplier_organization_id) THEN
          RETURN;
        END IF;
        RAISE EXCEPTION 'active_tenant_mismatch';
      END IF;
    ELSE
      RETURN; -- la fonction métier conserve son erreur de type historique.
  END CASE;

  IF v_organization_id IS NOT NULL THEN
    PERFORM public.tracefab_require_active_tenant_for_organization(v_organization_id);
  END IF;
END;
$guard$;

-- Les helpers ne deviennent pas des fonctions publiques du runtime.
REVOKE ALL ON FUNCTION public.tracefab_require_active_tenant_for_organization(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tracefab_require_active_tenant_for_product(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tracefab_require_active_tenant_for_dpp_record(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tracefab_require_active_tenant_for_supply_chain_link(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tracefab_require_active_tenant_for_tc_allocation(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tracefab_require_active_tenant_for_schema_subject(text, uuid) FROM PUBLIC;

DO $guard_functions$
DECLARE
  v_target record;
  v_oid oid;
  v_owner oid;
  v_acl aclitem[];
  v_after_oid oid;
  v_after_owner oid;
  v_after_acl aclitem[];
  v_definition text;
  v_begin integer;
  v_count integer;
  v_role record;
  v_targets text[] := ARRAY[
    'tracefab_add_supply_chain_link',
    'tracefab_create_supply_chain_node',
    'tracefab_update_supply_chain_node',
    'tracefab_delete_supply_chain_node',
    'tracefab_update_supply_chain_link',
    'tracefab_delete_supply_chain_link',
    'tracefab_allocate_tc_quantity',
    'tracefab_calculate_product_pef',
    'tracefab_compute_dpp_readiness',
    'tracefab_compute_product_quality',
    'tracefab_create_data_request',
    'tracefab_create_product',
    'tracefab_reconcile_mass_balance',
    'tracefab_set_dpp_publication',
    'tracefab_start_product_revision',
    'tracefab_update_product_data',
    'tracefab_bind_schema',
    'tracefab_get_product_traceability',
    'tracefab_mark_dpp_ready_to_publish'
  ];
BEGIN
  FOR v_target IN
    SELECT * FROM (VALUES
      ('tracefab_add_supply_chain_link', 'PERFORM public.tracefab_require_active_tenant_for_product(p_product_id);'),
      ('tracefab_create_supply_chain_node', 'PERFORM public.tracefab_require_active_tenant_for_product(p_graph_product_id);'),
      ('tracefab_update_supply_chain_node', 'PERFORM public.tracefab_require_active_tenant_for_product(p_graph_product_id);'),
      ('tracefab_delete_supply_chain_node', 'PERFORM public.tracefab_require_active_tenant_for_product(p_graph_product_id);'),
      ('tracefab_update_supply_chain_link', 'PERFORM public.tracefab_require_active_tenant_for_supply_chain_link(p_link_id);'),
      ('tracefab_delete_supply_chain_link', 'PERFORM public.tracefab_require_active_tenant_for_product(p_product_id);'),
      ('tracefab_allocate_tc_quantity', 'PERFORM public.tracefab_require_active_tenant_for_tc_allocation(p_tc_id, p_product_id);'),
      ('tracefab_calculate_product_pef', 'PERFORM public.tracefab_require_active_tenant_for_product(p_product_id);'),
      ('tracefab_compute_dpp_readiness', 'PERFORM public.tracefab_require_active_tenant_for_product(p_product_id);'),
      ('tracefab_compute_product_quality', 'PERFORM public.tracefab_require_active_tenant_for_product(p_product_id);'),
      ('tracefab_create_data_request', 'PERFORM public.tracefab_require_active_tenant_for_organization(p_brand_organization_id);'),
      ('tracefab_create_product', 'PERFORM public.tracefab_require_active_tenant_for_organization(p_brand_organization_id);'),
      ('tracefab_reconcile_mass_balance', 'PERFORM public.tracefab_require_active_tenant_for_product(p_product_id);'),
      ('tracefab_set_dpp_publication', 'PERFORM public.tracefab_require_active_tenant_for_product(p_product_id);'),
      ('tracefab_start_product_revision', 'PERFORM public.tracefab_require_active_tenant_for_product(p_product_id);'),
      ('tracefab_update_product_data', 'PERFORM public.tracefab_require_active_tenant_for_product(p_product_id);'),
      ('tracefab_bind_schema', 'PERFORM public.tracefab_require_active_tenant_for_schema_subject(p_subject_type, p_subject_id);'),
      ('tracefab_get_product_traceability', 'PERFORM public.tracefab_require_active_tenant_for_product(p_product_id);'),
      ('tracefab_mark_dpp_ready_to_publish', 'PERFORM public.tracefab_require_active_tenant_for_dpp_record(p_dpp_record_id);')
    ) AS t(function_name, guard_sql)
  LOOP
    SELECT count(*) INTO v_count
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_target.function_name;

    IF v_count <> 1 THEN
      RAISE EXCEPTION 'active_tenant_guard_expected_one_function: %, found %',
        v_target.function_name, v_count;
    END IF;

    SELECT p.oid, p.proowner, p.proacl
      INTO v_oid, v_owner, v_acl
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_target.function_name
       AND p.prosecdef;

    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'active_tenant_guard_target_not_security_definer: %',
        v_target.function_name;
    END IF;

    v_definition := pg_catalog.pg_get_functiondef(v_oid);
    IF pg_catalog.position(v_target.guard_sql IN v_definition) > 0 THEN
      CONTINUE;
    END IF;

    v_begin := pg_catalog.strpos(v_definition, 'BEGIN');
    IF v_begin = 0 THEN
      RAISE EXCEPTION 'active_tenant_guard_cannot_find_plpgsql_body: %',
        v_target.function_name;
    END IF;

    v_definition :=
      pg_catalog.substring(v_definition FROM 1 FOR v_begin - 1)
      || 'BEGIN' || E'\n  ' || v_target.guard_sql || E'\n'
      || pg_catalog.substring(v_definition FROM v_begin + 5);

    EXECUTE v_definition;

    SELECT p.oid, p.proowner, p.proacl
      INTO v_after_oid, v_after_owner, v_after_acl
      FROM pg_catalog.pg_proc p
     WHERE p.oid = v_oid;

    IF v_after_oid IS DISTINCT FROM v_oid
       OR v_after_owner IS DISTINCT FROM v_owner
       OR v_after_acl IS DISTINCT FROM v_acl THEN
      RAISE EXCEPTION 'active_tenant_guard_changed_oid_owner_or_acl: %',
        v_target.function_name;
    END IF;
  END LOOP;

  -- Autoriser uniquement les propriétaires des fonctions appelantes à appeler
  -- les helpers. Le rôle HTTP tracefab_app n'est jamais ajouté ici.
  FOR v_role IN
    SELECT DISTINCT r.rolname
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
     WHERE n.nspname = 'public' AND p.proname = ANY(v_targets)
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.tracefab_require_active_tenant_for_organization(uuid) TO %I', v_role.rolname);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.tracefab_require_active_tenant_for_product(uuid) TO %I', v_role.rolname);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.tracefab_require_active_tenant_for_dpp_record(uuid) TO %I', v_role.rolname);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.tracefab_require_active_tenant_for_supply_chain_link(uuid) TO %I', v_role.rolname);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.tracefab_require_active_tenant_for_tc_allocation(uuid, uuid) TO %I', v_role.rolname);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.tracefab_require_active_tenant_for_schema_subject(text, uuid) TO %I', v_role.rolname);
  END LOOP;

  -- Postconditions : les 19 fonctions portent leur garde dans le corps SQL.
  FOR v_target IN
    SELECT * FROM (VALUES
      ('tracefab_add_supply_chain_link', 'tracefab_require_active_tenant_for_product'),
      ('tracefab_create_supply_chain_node', 'tracefab_require_active_tenant_for_product'),
      ('tracefab_update_supply_chain_node', 'tracefab_require_active_tenant_for_product'),
      ('tracefab_delete_supply_chain_node', 'tracefab_require_active_tenant_for_product'),
      ('tracefab_update_supply_chain_link', 'tracefab_require_active_tenant_for_supply_chain_link'),
      ('tracefab_delete_supply_chain_link', 'tracefab_require_active_tenant_for_product'),
      ('tracefab_allocate_tc_quantity', 'tracefab_require_active_tenant_for_tc_allocation'),
      ('tracefab_calculate_product_pef', 'tracefab_require_active_tenant_for_product'),
      ('tracefab_compute_dpp_readiness', 'tracefab_require_active_tenant_for_product'),
      ('tracefab_compute_product_quality', 'tracefab_require_active_tenant_for_product'),
      ('tracefab_create_data_request', 'tracefab_require_active_tenant_for_organization'),
      ('tracefab_create_product', 'tracefab_require_active_tenant_for_organization'),
      ('tracefab_reconcile_mass_balance', 'tracefab_require_active_tenant_for_product'),
      ('tracefab_set_dpp_publication', 'tracefab_require_active_tenant_for_product'),
      ('tracefab_start_product_revision', 'tracefab_require_active_tenant_for_product'),
      ('tracefab_update_product_data', 'tracefab_require_active_tenant_for_product'),
      ('tracefab_bind_schema', 'tracefab_require_active_tenant_for_schema_subject'),
      ('tracefab_get_product_traceability', 'tracefab_require_active_tenant_for_product'),
      ('tracefab_mark_dpp_ready_to_publish', 'tracefab_require_active_tenant_for_dpp_record')
    ) AS t(function_name, helper_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = v_target.function_name
         AND p.prosecdef
         AND pg_catalog.position(v_target.helper_name IN pg_catalog.pg_get_functiondef(p.oid)) > 0
    ) THEN
      RAISE EXCEPTION 'active_tenant_guard_postcondition_failed: %',
        v_target.function_name;
    END IF;
  END LOOP;
END;
$guard_functions$;

COMMIT;
