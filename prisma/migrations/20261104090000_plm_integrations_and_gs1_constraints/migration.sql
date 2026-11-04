-- Réconciliation forward-only du catalogue PLM/ERP et des identifiants GS1.
-- La migration historique 20261006210000 est checksum-divergente ; la lecture
-- Neon du 04/11 a montré que les quatre CHECK de plm_erp_integrations manquent
-- et que product_identifiers n'accepte pas encore GPC. Ne pas réécrire l'ancien SQL.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  v_count integer;
  v_invalid bigint;
  v_definition text;
  v_old_identifier_check constant text :=
    'CHECK ((identifier_type = ANY (ARRAY[''gtin''::text, ''ean''::text, ''upc''::text, ''internal''::text, ''gs1_digital_link''::text, ''gln''::text])))';
  v_new_identifier_check constant text :=
    'CHECK ((identifier_type = ANY (ARRAY[''gtin''::text, ''ean''::text, ''upc''::text, ''internal''::text, ''gs1_digital_link''::text, ''gln''::text, ''gpc''::text])))';
BEGIN
  IF to_regclass('public.plm_erp_integrations') IS NULL THEN
    RAISE EXCEPTION 'plm_integrations_table_missing';
  END IF;

  IF to_regclass('public.product_identifiers') IS NULL THEN
    RAISE EXCEPTION 'product_identifiers_table_missing';
  END IF;

  -- Précondition : les valeurs existantes doivent satisfaire le contrat cible.
  SELECT count(*) INTO v_invalid
  FROM public.plm_erp_integrations
  WHERE system_type IS NULL
     OR system_type NOT IN ('centric_plm', 'lectra_kubix', 'sap_s4hana', 'infor_fashion', 'gs1_epcis', 'generic_csv')
     OR name IS NULL
     OR length(trim(name)) = 0
     OR auth_type IS NULL
     OR auth_type NOT IN ('api_key', 'bearer_token', 'oauth2', 'webhook', 'manual_import')
     OR status IS NULL
     OR status NOT IN ('active', 'inactive', 'syncing', 'error');

  IF v_invalid > 0 THEN
    RAISE EXCEPTION 'plm_integrations_invalid_existing_rows: %', v_invalid;
  END IF;

  SELECT count(*) INTO v_invalid
  FROM public.product_identifiers
  WHERE identifier_type IS NULL
     OR identifier_type NOT IN ('gtin', 'ean', 'upc', 'internal', 'gs1_digital_link', 'gln', 'gpc');

  IF v_invalid > 0 THEN
    RAISE EXCEPTION 'product_identifiers_invalid_existing_rows: %', v_invalid;
  END IF;

  -- Les quatre contraintes PLM sont soit toutes absentes (état Neon mesuré),
  -- soit toutes présentes et conformes. Un état partiel est refusé.
  SELECT count(*) INTO v_count
  FROM pg_constraint
  WHERE conrelid = 'public.plm_erp_integrations'::regclass
    AND conname IN (
      'plm_erp_integrations_system_type_check',
      'plm_erp_integrations_name_check',
      'plm_erp_integrations_auth_type_check',
      'plm_erp_integrations_status_check'
    );

  IF v_count = 0 THEN
    ALTER TABLE public.plm_erp_integrations
      ADD CONSTRAINT plm_erp_integrations_system_type_check
      CHECK (system_type IN ('centric_plm', 'lectra_kubix', 'sap_s4hana', 'infor_fashion', 'gs1_epcis', 'generic_csv')) NOT VALID;
    ALTER TABLE public.plm_erp_integrations
      VALIDATE CONSTRAINT plm_erp_integrations_system_type_check;

    ALTER TABLE public.plm_erp_integrations
      ADD CONSTRAINT plm_erp_integrations_name_check
      CHECK (length(trim(name)) > 0) NOT VALID;
    ALTER TABLE public.plm_erp_integrations
      VALIDATE CONSTRAINT plm_erp_integrations_name_check;

    ALTER TABLE public.plm_erp_integrations
      ADD CONSTRAINT plm_erp_integrations_auth_type_check
      CHECK (auth_type IN ('api_key', 'bearer_token', 'oauth2', 'webhook', 'manual_import')) NOT VALID;
    ALTER TABLE public.plm_erp_integrations
      VALIDATE CONSTRAINT plm_erp_integrations_auth_type_check;

    ALTER TABLE public.plm_erp_integrations
      ADD CONSTRAINT plm_erp_integrations_status_check
      CHECK (status IN ('active', 'inactive', 'syncing', 'error')) NOT VALID;
    ALTER TABLE public.plm_erp_integrations
      VALIDATE CONSTRAINT plm_erp_integrations_status_check;
  ELSIF v_count = 4 THEN
    SELECT pg_get_constraintdef(oid) INTO v_definition
    FROM pg_constraint
    WHERE conrelid = 'public.plm_erp_integrations'::regclass
      AND conname = 'plm_erp_integrations_system_type_check';
    IF v_definition IS NULL OR v_definition NOT LIKE '%centric_plm%'
       OR v_definition NOT LIKE '%lectra_kubix%' OR v_definition NOT LIKE '%sap_s4hana%'
       OR v_definition NOT LIKE '%infor_fashion%' OR v_definition NOT LIKE '%gs1_epcis%'
       OR v_definition NOT LIKE '%generic_csv%' THEN
      RAISE EXCEPTION 'plm_integrations_system_type_check_unexpected: %', v_definition;
    END IF;

    SELECT pg_get_constraintdef(oid) INTO v_definition
    FROM pg_constraint
    WHERE conrelid = 'public.plm_erp_integrations'::regclass
      AND conname = 'plm_erp_integrations_name_check';
    IF v_definition IS NULL OR v_definition NOT LIKE '%length%'
       OR v_definition NOT LIKE '%name%' OR v_definition NOT LIKE '%> 0%' THEN
      RAISE EXCEPTION 'plm_integrations_name_check_unexpected: %', v_definition;
    END IF;

    SELECT pg_get_constraintdef(oid) INTO v_definition
    FROM pg_constraint
    WHERE conrelid = 'public.plm_erp_integrations'::regclass
      AND conname = 'plm_erp_integrations_auth_type_check';
    IF v_definition IS NULL OR v_definition NOT LIKE '%api_key%'
       OR v_definition NOT LIKE '%bearer_token%' OR v_definition NOT LIKE '%oauth2%'
       OR v_definition NOT LIKE '%webhook%' OR v_definition NOT LIKE '%manual_import%' THEN
      RAISE EXCEPTION 'plm_integrations_auth_type_check_unexpected: %', v_definition;
    END IF;

    SELECT pg_get_constraintdef(oid) INTO v_definition
    FROM pg_constraint
    WHERE conrelid = 'public.plm_erp_integrations'::regclass
      AND conname = 'plm_erp_integrations_status_check';
    IF v_definition IS NULL OR v_definition NOT LIKE '%active%'
       OR v_definition NOT LIKE '%inactive%' OR v_definition NOT LIKE '%syncing%'
       OR v_definition NOT LIKE '%error%' THEN
      RAISE EXCEPTION 'plm_integrations_status_check_unexpected: %', v_definition;
    END IF;
  ELSE
    RAISE EXCEPTION 'plm_integrations_partial_check_constraints: %/4', v_count;
  END IF;

  -- Le catalogue mesuré porte l'ancienne contrainte exacte sans GPC. On
  -- accepte aussi la version cible pour rendre cette migration idempotente ;
  -- toute autre définition est un refus explicite.
  SELECT pg_get_constraintdef(oid) INTO v_definition
  FROM pg_constraint
  WHERE conrelid = 'public.product_identifiers'::regclass
    AND conname = 'product_identifiers_identifier_type_check';

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'product_identifier_type_check_missing';
  ELSIF v_definition = v_old_identifier_check THEN
    ALTER TABLE public.product_identifiers
      DROP CONSTRAINT product_identifiers_identifier_type_check;
    ALTER TABLE public.product_identifiers
      ADD CONSTRAINT product_identifiers_identifier_type_check
      CHECK (identifier_type IN ('gtin', 'ean', 'upc', 'internal', 'gs1_digital_link', 'gln', 'gpc')) NOT VALID;
    ALTER TABLE public.product_identifiers
      VALIDATE CONSTRAINT product_identifiers_identifier_type_check;
  ELSIF v_definition <> v_new_identifier_check THEN
    RAISE EXCEPTION 'product_identifier_type_check_unexpected: %', v_definition;
  END IF;
END $$;

-- Le CHECK historique acceptait déjà GS1/GPC, mais le helper SQL conservait
-- l'ancienne liste de quatre types. CREATE OR REPLACE conserve l'OID, le
-- propriétaire et les ACL EXECUTE du registre runtime.
CREATE OR REPLACE FUNCTION tracefab_add_product_identifier(
  p_product_id UUID,
  p_identifier_type TEXT,
  p_identifier_value TEXT,
  p_is_primary BOOLEAN DEFAULT false
)
RETURNS product_identifiers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $tf_gs1$
DECLARE
  v_identifier product_identifiers;
  v_brand_organization_id UUID;
  v_type TEXT;
  v_value TEXT;
BEGIN
  SELECT brand_organization_id INTO v_brand_organization_id
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'brand_product_role_required';
  END IF;

  v_type := lower(trim(COALESCE(p_identifier_type, '')));
  v_value := trim(COALESCE(p_identifier_value, ''));
  IF v_type NOT IN ('gtin', 'ean', 'upc', 'internal', 'gs1_digital_link', 'gln', 'gpc') OR v_value = '' THEN
    RAISE EXCEPTION 'invalid_product_identifier';
  END IF;

  INSERT INTO product_identifiers (
    product_id,
    identifier_type,
    identifier_value,
    is_primary,
    created_by
  )
  VALUES (
    p_product_id,
    v_type,
    v_value,
    COALESCE(p_is_primary, false),
    tracefab_current_user_id()
  )
  RETURNING * INTO v_identifier;

  RETURN v_identifier;
END;
$tf_gs1$;


-- Correctif runtime PLM/ERP : l'ingestion appelle les fonctions du graphe.
-- La colonne supply_chain_nodes.status est data_value_status ; un CASE texte
-- échouait en 42804 sur PostgreSQL 17. Les deux branches sont typées explicitement.
-- CREATE OR REPLACE conserve l'OID, le propriétaire et les ACL déjà enregistrées.
CREATE OR REPLACE FUNCTION tracefab_create_supply_chain_node(
  p_graph_product_id UUID, p_node_type node_type, p_label TEXT,
  p_organization_id UUID DEFAULT NULL, p_supplier_site_id UUID DEFAULT NULL,
  p_product_id UUID DEFAULT NULL, p_material_id UUID DEFAULT NULL,
  p_process_code TEXT DEFAULT NULL, p_metadata JSONB DEFAULT '{}'::jsonb,
  p_source_document_id UUID DEFAULT NULL, p_observed_at DATE DEFAULT NULL
)
RETURNS supply_chain_nodes
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $
DECLARE
  v_product tracefab_products; v_node supply_chain_nodes;
  v_site_owner UUID; v_material_owner UUID;
BEGIN
  SELECT * INTO v_product FROM tracefab_products WHERE id = p_graph_product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'traceability_product_not_found'; END IF;
  IF NOT tracefab_has_org_role(v_product.brand_organization_id, ARRAY['owner','admin','manager','contributor']::membership_role[])
    THEN RAISE EXCEPTION 'traceability_brand_role_required'; END IF;
  IF length(trim(COALESCE(p_label, ''))) = 0 THEN RAISE EXCEPTION 'traceability_node_label_required'; END IF;
  IF p_node_type = 'product' AND p_product_id IS DISTINCT FROM p_graph_product_id
    THEN RAISE EXCEPTION 'traceability_product_node_must_match_graph_product'; END IF;

  IF p_node_type = 'material' THEN
    SELECT owner_organization_id INTO v_material_owner FROM materials WHERE id = p_material_id;
    IF v_material_owner IS NULL OR NOT (tracefab_can_access_org(v_material_owner)
      OR tracefab_can_access_shared_subject(v_material_owner, 'material', p_material_id))
      THEN RAISE EXCEPTION 'traceability_material_access_denied'; END IF;
  END IF;
  IF p_node_type = 'site' THEN
    SELECT s.organization_id INTO v_site_owner FROM supplier_sites ss JOIN suppliers s ON s.id = ss.supplier_id WHERE ss.id = p_supplier_site_id;
    IF v_site_owner IS NULL OR NOT (tracefab_can_access_org(v_site_owner)
      OR tracefab_can_access_shared_subject(v_site_owner, 'supplier_site', p_supplier_site_id))
      THEN RAISE EXCEPTION 'traceability_site_access_denied'; END IF;
  END IF;
  IF p_node_type = 'organization' AND p_organization_id IS DISTINCT FROM v_product.brand_organization_id
    AND NOT EXISTS (SELECT 1 FROM brand_supplier_relationships r WHERE r.brand_organization_id = v_product.brand_organization_id
      AND r.supplier_organization_id = p_organization_id AND r.status = 'active')
    THEN RAISE EXCEPTION 'traceability_organization_not_in_active_relationship'; END IF;

  INSERT INTO supply_chain_nodes (
    graph_product_id, node_type, organization_id, supplier_site_id, product_id,
    material_id, process_code, label, metadata, status, source_document_id,
    declared_by, observed_at
  ) VALUES (
    p_graph_product_id, p_node_type, p_organization_id, p_supplier_site_id, p_product_id,
    p_material_id, p_process_code, trim(p_label),
    jsonb_set(COALESCE(p_metadata, '{}'::jsonb), '{graphProductId}', to_jsonb(p_graph_product_id::text), true),
    CASE WHEN p_source_document_id IS NULL THEN 'declared'::public.data_value_status ELSE 'documented'::public.data_value_status END,
    p_source_document_id, tracefab_current_user_id(), p_observed_at
  ) RETURNING * INTO v_node;
  RETURN v_node;
END;
$;

CREATE OR REPLACE FUNCTION tracefab_update_supply_chain_node(
  p_graph_product_id UUID, p_node_id UUID, p_label TEXT, p_metadata JSONB,
  p_source_document_id UUID DEFAULT NULL, p_observed_at DATE DEFAULT NULL
)
RETURNS supply_chain_nodes LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $
DECLARE v_product tracefab_products; v_node supply_chain_nodes;
BEGIN
  SELECT * INTO v_product FROM tracefab_products WHERE id = p_graph_product_id;
  IF NOT FOUND OR NOT tracefab_has_org_role(v_product.brand_organization_id,
    ARRAY['owner','admin','manager','contributor']::membership_role[])
    THEN RAISE EXCEPTION 'traceability_brand_role_required'; END IF;
  IF length(trim(COALESCE(p_label, ''))) = 0 THEN RAISE EXCEPTION 'traceability_node_label_required'; END IF;
  UPDATE supply_chain_nodes SET label = trim(p_label), metadata = COALESCE(p_metadata, '{}'::jsonb),
    source_document_id = p_source_document_id,
    status = CASE WHEN p_source_document_id IS NULL THEN 'declared'::public.data_value_status ELSE 'documented'::public.data_value_status END,
    declared_by = tracefab_current_user_id(), observed_at = p_observed_at
  WHERE id = p_node_id AND graph_product_id = p_graph_product_id RETURNING * INTO v_node;
  IF NOT FOUND THEN RAISE EXCEPTION 'traceability_node_not_in_product_graph'; END IF;
  RETURN v_node;
END;
$;

COMMIT;
