-- Structured product membership for supply-chain nodes.
-- Replaces the transitional metadata.graphProductId lookup while preserving it
-- as compatibility metadata. No node is inferred from an unrelated product.

ALTER TABLE supply_chain_nodes
  ADD COLUMN IF NOT EXISTS graph_product_id UUID REFERENCES tracefab_products(id) ON DELETE CASCADE;

-- New API-created nodes already carry this reserved metadata key.
UPDATE supply_chain_nodes n
SET graph_product_id = (n.metadata ->> 'graphProductId')::uuid
WHERE n.graph_product_id IS NULL
  AND COALESCE(n.metadata ->> 'graphProductId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND EXISTS (
    SELECT 1 FROM tracefab_products p
    WHERE p.id = (n.metadata ->> 'graphProductId')::uuid
  );

-- Historical linked nodes can be assigned only when all of their links agree
-- on one product. Ambiguous historical nodes intentionally remain unassigned.
WITH unambiguous AS (
  SELECT node_id, min(product_id::text)::uuid AS product_id
  FROM (
    SELECT source_node_id AS node_id, product_id FROM supply_chain_links
    UNION ALL
    SELECT target_node_id AS node_id, product_id FROM supply_chain_links
  ) memberships
  GROUP BY node_id
  HAVING count(DISTINCT product_id) = 1
)
UPDATE supply_chain_nodes n
SET graph_product_id = u.product_id,
    metadata = jsonb_set(COALESCE(n.metadata, '{}'::jsonb), '{graphProductId}', to_jsonb(u.product_id::text), true)
FROM unambiguous u
WHERE n.id = u.node_id
  AND n.graph_product_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_supply_chain_nodes_graph_product
  ON supply_chain_nodes(graph_product_id, created_at);

CREATE OR REPLACE FUNCTION tracefab_validate_supply_chain_node()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reference_count INTEGER;
BEGIN
  v_reference_count :=
    (CASE WHEN NEW.organization_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN NEW.supplier_site_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN NEW.product_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN NEW.material_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN NEW.process_code IS NOT NULL THEN 1 ELSE 0 END);

  IF v_reference_count <> 1 THEN RAISE EXCEPTION 'traceability_node_reference_required'; END IF;
  IF NEW.node_type = 'organization' AND NEW.organization_id IS NULL THEN RAISE EXCEPTION 'organization_node_reference_required'; END IF;
  IF NEW.node_type = 'site' AND NEW.supplier_site_id IS NULL THEN RAISE EXCEPTION 'site_node_reference_required'; END IF;
  IF NEW.node_type = 'product' AND NEW.product_id IS NULL THEN RAISE EXCEPTION 'product_node_reference_required'; END IF;
  IF NEW.node_type = 'material' AND NEW.material_id IS NULL THEN RAISE EXCEPTION 'material_node_reference_required'; END IF;
  IF NEW.node_type = 'process' AND NEW.process_code IS NULL THEN RAISE EXCEPTION 'process_node_reference_required'; END IF;
  IF NEW.graph_product_id IS NULL THEN RAISE EXCEPTION 'traceability_graph_product_required'; END IF;

  IF TG_OP = 'UPDATE' AND OLD.graph_product_id IS DISTINCT FROM NEW.graph_product_id THEN
    RAISE EXCEPTION 'traceability_node_graph_product_is_immutable';
  END IF;

  NEW.metadata := jsonb_set(COALESCE(NEW.metadata, '{}'::jsonb), '{graphProductId}', to_jsonb(NEW.graph_product_id::text), true);
  IF NEW.declared_by IS NULL THEN NEW.declared_by := tracefab_current_user_id(); END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_validate_supply_chain_link()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product_owner UUID;
  v_source_product UUID;
  v_target_product UUID;
BEGIN
  SELECT brand_organization_id INTO v_product_owner FROM tracefab_products WHERE id = NEW.product_id;
  IF v_product_owner IS NULL THEN RAISE EXCEPTION 'traceability_product_not_found'; END IF;

  SELECT graph_product_id INTO v_source_product FROM supply_chain_nodes WHERE id = NEW.source_node_id;
  SELECT graph_product_id INTO v_target_product FROM supply_chain_nodes WHERE id = NEW.target_node_id;
  IF v_source_product IS NULL OR v_target_product IS NULL THEN RAISE EXCEPTION 'traceability_link_node_not_found'; END IF;
  IF v_source_product IS DISTINCT FROM NEW.product_id OR v_target_product IS DISTINCT FROM NEW.product_id THEN
    RAISE EXCEPTION 'traceability_link_node_product_mismatch';
  END IF;
  IF NEW.source_node_id = NEW.target_node_id THEN RAISE EXCEPTION 'traceability_link_cannot_self_reference'; END IF;

  IF NEW.evidence_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM documents d
    WHERE d.id = NEW.evidence_document_id
      AND (tracefab_can_access_org(d.owner_organization_id)
        OR tracefab_can_access_shared_subject(d.owner_organization_id, 'document', d.id))
  ) THEN RAISE EXCEPTION 'traceability_evidence_document_not_accessible'; END IF;

  IF TG_OP = 'UPDATE' AND OLD.product_id IS DISTINCT FROM NEW.product_id THEN
    RAISE EXCEPTION 'traceability_link_product_is_immutable';
  END IF;
  IF NEW.declared_by IS NULL THEN NEW.declared_by := tracefab_current_user_id(); END IF;
  RETURN NEW;
END;
$$;

-- Keep the existing public function signature to allow an app-first or
-- migration-first rollout without an availability gap.
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
    CASE WHEN p_source_document_id IS NULL THEN 'declared' ELSE 'documented' END,
    p_source_document_id, tracefab_current_user_id(), p_observed_at
  ) RETURNING * INTO v_node;
  RETURN v_node;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_get_product_traceability(p_product_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_brand_organization_id UUID; v_result JSONB;
BEGIN
  SELECT brand_organization_id INTO v_brand_organization_id FROM tracefab_products WHERE id = p_product_id;
  IF v_brand_organization_id IS NULL OR NOT tracefab_is_org_member(v_brand_organization_id)
    THEN RAISE EXCEPTION 'traceability_read_access_denied'; END IF;

  SELECT jsonb_build_object(
    'product_id', p_product_id,
    'nodes', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', n.id, 'node_type', n.node_type, 'label', n.label,
      'organization_id', n.organization_id, 'supplier_site_id', n.supplier_site_id,
      'product_id', n.product_id, 'material_id', n.material_id,
      'process_code', n.process_code, 'metadata', n.metadata, 'status', n.status,
      'observed_at', n.observed_at, 'created_at', n.created_at,
      'source_document_id', CASE WHEN n.source_document_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM documents d WHERE d.id = n.source_document_id
          AND (tracefab_can_access_org(d.owner_organization_id)
            OR tracefab_can_access_shared_subject(d.owner_organization_id, 'document', d.id))
      ) THEN n.source_document_id ELSE NULL END
    ) ORDER BY n.created_at) FROM supply_chain_nodes n
      WHERE n.graph_product_id = p_product_id), '[]'::jsonb),
    'links', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', l.id, 'source_node_id', l.source_node_id, 'target_node_id', l.target_node_id,
      'link_type', l.link_type, 'sequence_number', l.sequence_number,
      'valid_from', l.valid_from, 'valid_until', l.valid_until,
      'status', l.status, 'metadata', l.metadata, 'created_at', l.created_at,
      'evidence_document_id', CASE WHEN l.evidence_document_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM documents d WHERE d.id = l.evidence_document_id
          AND (tracefab_can_access_org(d.owner_organization_id)
            OR tracefab_can_access_shared_subject(d.owner_organization_id, 'document', d.id))
      ) THEN l.evidence_document_id ELSE NULL END
    ) ORDER BY l.sequence_number NULLS LAST, l.created_at)
      FROM supply_chain_links l WHERE l.product_id = p_product_id), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
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
    status = CASE WHEN p_source_document_id IS NULL THEN 'declared' ELSE 'documented' END,
    declared_by = tracefab_current_user_id(), observed_at = p_observed_at
  WHERE id = p_node_id AND graph_product_id = p_graph_product_id RETURNING * INTO v_node;
  IF NOT FOUND THEN RAISE EXCEPTION 'traceability_node_not_in_product_graph'; END IF;
  RETURN v_node;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_delete_supply_chain_node(p_graph_product_id UUID, p_node_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_owner UUID;
BEGIN
  SELECT brand_organization_id INTO v_owner FROM tracefab_products WHERE id = p_graph_product_id;
  IF v_owner IS NULL OR NOT tracefab_has_org_role(v_owner, ARRAY['owner','admin','manager','contributor']::membership_role[])
    THEN RAISE EXCEPTION 'traceability_brand_role_required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM supply_chain_nodes WHERE id = p_node_id AND graph_product_id = p_graph_product_id)
    THEN RAISE EXCEPTION 'traceability_node_not_in_product_graph'; END IF;
  DELETE FROM supply_chain_links WHERE product_id = p_graph_product_id
    AND (source_node_id = p_node_id OR target_node_id = p_node_id);
  DELETE FROM supply_chain_nodes WHERE id = p_node_id AND graph_product_id = p_graph_product_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_delete_supply_chain_link(p_product_id UUID, p_link_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_owner UUID;
BEGIN
  SELECT brand_organization_id INTO v_owner FROM tracefab_products WHERE id = p_product_id;
  IF v_owner IS NULL OR NOT tracefab_has_org_role(v_owner, ARRAY['owner','admin','manager','contributor']::membership_role[])
    THEN RAISE EXCEPTION 'traceability_brand_role_required'; END IF;
  DELETE FROM supply_chain_links WHERE id = p_link_id AND product_id = p_product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'traceability_link_not_found'; END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION tracefab_delete_supply_chain_node(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_delete_supply_chain_link(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_delete_supply_chain_node(UUID, UUID) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_delete_supply_chain_link(UUID, UUID) TO PUBLIC;

DROP POLICY IF EXISTS nodes_select_traceability_graph ON supply_chain_nodes;
CREATE POLICY nodes_select_traceability_graph ON supply_chain_nodes FOR SELECT TO PUBLIC USING (
  EXISTS (SELECT 1 FROM tracefab_products p WHERE p.id = supply_chain_nodes.graph_product_id
    AND tracefab_is_org_member(p.brand_organization_id))
  OR tracefab_can_access_org(organization_id)
  OR (supplier_site_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM supplier_sites ss JOIN suppliers s ON s.id = ss.supplier_id
    WHERE ss.id = supplier_site_id AND (tracefab_can_access_org(s.organization_id)
      OR tracefab_can_access_shared_subject(s.organization_id, 'supplier_site', ss.id))))
  OR (material_id IS NOT NULL AND EXISTS (SELECT 1 FROM materials m WHERE m.id = material_id
    AND (tracefab_can_access_org(m.owner_organization_id)
      OR tracefab_can_access_shared_subject(m.owner_organization_id, 'material', m.id))))
  OR EXISTS (SELECT 1 FROM supply_chain_links l JOIN tracefab_products p ON p.id = l.product_id
    WHERE (l.source_node_id = supply_chain_nodes.id OR l.target_node_id = supply_chain_nodes.id)
      AND tracefab_is_org_member(p.brand_organization_id))
);

REVOKE EXECUTE ON FUNCTION tracefab_validate_supply_chain_node() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_validate_supply_chain_link() FROM PUBLIC;

-- All graph writes now go through tenant-authorized SECURITY DEFINER functions.
-- Remove the obsolete direct DML capability from the restricted runtime role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
    REVOKE INSERT, UPDATE, DELETE ON supply_chain_nodes FROM tracefab_app;
    REVOKE INSERT, UPDATE, DELETE ON supply_chain_links FROM tracefab_app;
  END IF;
END;
$$;

COMMENT ON COLUMN supply_chain_nodes.graph_product_id IS
  'Canonical owning traceability graph. Immutable after creation; not evidence of provenance or verification.';
