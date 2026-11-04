-- Correction forward des casts enum du graphe de traçabilité.
-- Les fonctions sont appelées par l'ingestion PLM/ERP ; leurs CASE textuels
-- provoquaient 42804 car les statuts des noeuds et liens sont des enums.
-- CREATE OR REPLACE conserve OID, propriétaire et ACL déjà enregistrées.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION tracefab_create_supply_chain_node(
  p_graph_product_id UUID, p_node_type node_type, p_label TEXT,
  p_organization_id UUID DEFAULT NULL, p_supplier_site_id UUID DEFAULT NULL,
  p_product_id UUID DEFAULT NULL, p_material_id UUID DEFAULT NULL,
  p_process_code TEXT DEFAULT NULL, p_metadata JSONB DEFAULT '{}'::jsonb,
  p_source_document_id UUID DEFAULT NULL, p_observed_at DATE DEFAULT NULL
)
RETURNS supply_chain_nodes
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
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
$$;

CREATE OR REPLACE FUNCTION tracefab_update_supply_chain_node(
  p_graph_product_id UUID, p_node_id UUID, p_label TEXT, p_metadata JSONB,
  p_source_document_id UUID DEFAULT NULL, p_observed_at DATE DEFAULT NULL
)
RETURNS supply_chain_nodes LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
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
$$;



-- Les liens portent le même enum que les noeuds : les deux fonctions
-- historiques doivent caster explicitement leur CASE textuel.
CREATE OR REPLACE FUNCTION tracefab_add_supply_chain_link(
  p_product_id UUID,
  p_source_node_id UUID,
  p_target_node_id UUID,
  p_link_type supply_chain_link_type,
  p_sequence_number INTEGER DEFAULT NULL,
  p_valid_from DATE DEFAULT NULL,
  p_valid_until DATE DEFAULT NULL,
  p_evidence_document_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS supply_chain_links
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $
DECLARE
  v_product tracefab_products;
  v_link supply_chain_links;
BEGIN
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND OR NOT tracefab_has_org_role(
    v_product.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'traceability_brand_role_required';
  END IF;

  IF p_sequence_number IS NOT NULL AND p_sequence_number < 0 THEN
    RAISE EXCEPTION 'traceability_sequence_must_be_positive';
  END IF;

  INSERT INTO supply_chain_links (
    product_id,
    source_node_id,
    target_node_id,
    link_type,
    sequence_number,
    valid_from,
    valid_until,
    evidence_document_id,
    metadata,
    status,
    declared_by
  )
  VALUES (
    p_product_id,
    p_source_node_id,
    p_target_node_id,
    p_link_type,
    p_sequence_number,
    p_valid_from,
    p_valid_until,
    p_evidence_document_id,
    COALESCE(p_metadata, '{}'::jsonb),
    CASE WHEN p_evidence_document_id IS NULL THEN 'declared'::public.data_value_status ELSE 'documented'::public.data_value_status END,
    tracefab_current_user_id()
  )
  RETURNING * INTO v_link;

  RETURN v_link;
END;
$;

CREATE OR REPLACE FUNCTION tracefab_update_supply_chain_link(
  p_link_id UUID,
  p_sequence_number INTEGER,
  p_valid_from DATE,
  p_valid_until DATE,
  p_evidence_document_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS supply_chain_links
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $
DECLARE
  v_link supply_chain_links;
  v_brand_organization_id UUID;
BEGIN
  SELECT l.* INTO v_link
  FROM supply_chain_links l
  WHERE l.id = p_link_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'traceability_link_not_found';
  END IF;

  SELECT p.brand_organization_id INTO v_brand_organization_id
  FROM tracefab_products p
  WHERE p.id = v_link.product_id;

  IF NOT tracefab_has_org_role(
    v_brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'traceability_brand_role_required';
  END IF;

  IF p_sequence_number IS NOT NULL AND p_sequence_number < 0 THEN
    RAISE EXCEPTION 'traceability_sequence_must_be_positive';
  END IF;

  UPDATE supply_chain_links
  SET sequence_number = p_sequence_number,
      valid_from = p_valid_from,
      valid_until = p_valid_until,
      evidence_document_id = p_evidence_document_id,
      metadata = COALESCE(p_metadata, '{}'::jsonb),
      status = CASE WHEN p_evidence_document_id IS NULL THEN 'declared'::public.data_value_status ELSE 'documented'::public.data_value_status END,
      declared_by = tracefab_current_user_id()
  WHERE id = p_link_id
  RETURNING * INTO v_link;

  RETURN v_link;
END;
$;

COMMIT;
