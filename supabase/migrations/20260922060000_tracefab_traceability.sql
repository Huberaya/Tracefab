-- Tracefab Chantier 7 — Traceability
--
-- Hardens the PostgreSQL adjacency graph for product traceability. Every node
-- and link keeps an explicit data status; a graph is not proof that a physical
-- supply-chain event was independently verified.

-- -----------------------------------------------------------------------------
-- 1. Traceability record metadata
-- -----------------------------------------------------------------------------

ALTER TABLE supply_chain_nodes
  ADD COLUMN IF NOT EXISTS status data_value_status NOT NULL DEFAULT 'declared',
  ADD COLUMN IF NOT EXISTS source_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS declared_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS observed_at DATE,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE supply_chain_links
  ADD COLUMN IF NOT EXISTS status data_value_status NOT NULL DEFAULT 'declared',
  ADD COLUMN IF NOT EXISTS declared_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_traceability_nodes_status
  ON supply_chain_nodes(product_id, node_type, status);

CREATE INDEX IF NOT EXISTS idx_traceability_links_status
  ON supply_chain_links(product_id, status, sequence_number);

CREATE INDEX IF NOT EXISTS idx_traceability_links_nodes
  ON supply_chain_links(source_node_id, target_node_id);

CREATE OR REPLACE FUNCTION tracefab_traceability_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER traceability_nodes_set_updated_at
    BEFORE UPDATE ON supply_chain_nodes
    FOR EACH ROW EXECUTE FUNCTION tracefab_traceability_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER traceability_links_set_updated_at
    BEFORE UPDATE ON supply_chain_links
    FOR EACH ROW EXECUTE FUNCTION tracefab_traceability_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- 2. Graph integrity
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_validate_supply_chain_node()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reference_count INTEGER;
  v_material_owner UUID;
  v_site_owner UUID;
  v_product_owner UUID;
BEGIN
  v_reference_count := num_nonnulls(
    NEW.organization_id,
    NEW.supplier_site_id,
    NEW.product_id,
    NEW.material_id,
    NEW.process_code
  );

  IF v_reference_count <> 1 THEN
    RAISE EXCEPTION 'traceability_node_requires_exactly_one_reference';
  END IF;

  IF NEW.node_type = 'organization' AND NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_node_reference_required';
  ELSIF NEW.node_type = 'site' AND NEW.supplier_site_id IS NULL THEN
    RAISE EXCEPTION 'site_node_reference_required';
  ELSIF NEW.node_type = 'product' AND NEW.product_id IS NULL THEN
    RAISE EXCEPTION 'product_node_reference_required';
  ELSIF NEW.node_type = 'material' AND NEW.material_id IS NULL THEN
    RAISE EXCEPTION 'material_node_reference_required';
  ELSIF NEW.node_type = 'process' AND NEW.process_code IS NULL THEN
    RAISE EXCEPTION 'process_node_reference_required';
  END IF;

  IF NEW.node_type = 'material' THEN
    SELECT owner_organization_id INTO v_material_owner
    FROM materials
    WHERE id = NEW.material_id;
    IF v_material_owner IS NULL THEN
      RAISE EXCEPTION 'material_node_target_not_found';
    END IF;
  ELSIF NEW.node_type = 'site' THEN
    SELECT s.organization_id INTO v_site_owner
    FROM supplier_sites ss
    JOIN suppliers s ON s.id = ss.supplier_id
    WHERE ss.id = NEW.supplier_site_id;
    IF v_site_owner IS NULL THEN
      RAISE EXCEPTION 'site_node_target_not_found';
    END IF;
  ELSIF NEW.node_type = 'product' THEN
    SELECT brand_organization_id INTO v_product_owner
    FROM tracefab_products
    WHERE id = NEW.product_id;
    IF v_product_owner IS NULL THEN
      RAISE EXCEPTION 'product_node_target_not_found';
    END IF;
  END IF;

  IF NEW.source_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM documents d
    WHERE d.id = NEW.source_document_id
      AND (
        tracefab_can_access_org(d.owner_organization_id)
        OR tracefab_can_access_shared_subject(d.owner_organization_id, 'document', d.id)
      )
  ) THEN
    RAISE EXCEPTION 'traceability_source_document_not_accessible';
  END IF;

  IF NEW.declared_by IS NULL THEN
    NEW.declared_by := auth.uid();
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER traceability_nodes_validate
    BEFORE INSERT OR UPDATE ON supply_chain_nodes
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_supply_chain_node();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION tracefab_validate_supply_chain_link()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product_owner UUID;
  v_source_exists BOOLEAN;
  v_target_exists BOOLEAN;
BEGIN
  SELECT brand_organization_id INTO v_product_owner
  FROM tracefab_products
  WHERE id = NEW.product_id;

  IF v_product_owner IS NULL THEN
    RAISE EXCEPTION 'traceability_product_not_found';
  END IF;

  SELECT EXISTS (SELECT 1 FROM supply_chain_nodes WHERE id = NEW.source_node_id),
         EXISTS (SELECT 1 FROM supply_chain_nodes WHERE id = NEW.target_node_id)
  INTO v_source_exists, v_target_exists;

  IF NOT v_source_exists OR NOT v_target_exists THEN
    RAISE EXCEPTION 'traceability_link_node_not_found';
  END IF;

  IF EXISTS (
    SELECT 1 FROM supply_chain_nodes n
    WHERE n.id IN (NEW.source_node_id, NEW.target_node_id)
      AND n.node_type = 'product'
      AND n.product_id <> NEW.product_id
  ) THEN
    RAISE EXCEPTION 'traceability_product_node_mismatch';
  END IF;

  IF NEW.source_node_id = NEW.target_node_id THEN
    RAISE EXCEPTION 'traceability_link_cannot_self_reference';
  END IF;

  IF NEW.evidence_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM documents d
    WHERE d.id = NEW.evidence_document_id
      AND (
        tracefab_can_access_org(d.owner_organization_id)
        OR tracefab_can_access_shared_subject(d.owner_organization_id, 'document', d.id)
      )
  ) THEN
    RAISE EXCEPTION 'traceability_evidence_document_not_accessible';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.product_id IS DISTINCT FROM NEW.product_id THEN
    RAISE EXCEPTION 'traceability_link_product_is_immutable';
  END IF;

  IF NEW.declared_by IS NULL THEN
    NEW.declared_by := auth.uid();
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER traceability_links_validate
    BEFORE INSERT OR UPDATE ON supply_chain_links
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_supply_chain_link();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- 3. Controlled graph mutations
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_create_supply_chain_node(
  p_graph_product_id UUID,
  p_node_type node_type,
  p_label TEXT,
  p_organization_id UUID DEFAULT NULL,
  p_supplier_site_id UUID DEFAULT NULL,
  p_product_id UUID DEFAULT NULL,
  p_material_id UUID DEFAULT NULL,
  p_process_code TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb,
  p_source_document_id UUID DEFAULT NULL,
  p_observed_at DATE DEFAULT NULL
)
RETURNS supply_chain_nodes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_node supply_chain_nodes;
  v_site_owner UUID;
  v_material_owner UUID;
BEGIN
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_graph_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'traceability_product_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_product.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'traceability_brand_role_required';
  END IF;

  IF length(trim(COALESCE(p_label, ''))) = 0 THEN
    RAISE EXCEPTION 'traceability_node_label_required';
  END IF;

  IF p_node_type = 'product' AND p_product_id IS DISTINCT FROM p_graph_product_id THEN
    RAISE EXCEPTION 'traceability_product_node_must_match_graph_product';
  END IF;

  IF p_node_type = 'material' THEN
    SELECT owner_organization_id INTO v_material_owner
    FROM materials
    WHERE id = p_material_id;
    IF v_material_owner IS NULL OR NOT (
      tracefab_can_access_org(v_material_owner)
      OR tracefab_can_access_shared_subject(v_material_owner, 'material', p_material_id)
    ) THEN
      RAISE EXCEPTION 'traceability_material_access_denied';
    END IF;
  END IF;

  IF p_node_type = 'site' THEN
    SELECT s.organization_id INTO v_site_owner
    FROM supplier_sites ss
    JOIN suppliers s ON s.id = ss.supplier_id
    WHERE ss.id = p_supplier_site_id;
    IF v_site_owner IS NULL OR NOT (
      tracefab_can_access_org(v_site_owner)
      OR tracefab_can_access_shared_subject(v_site_owner, 'supplier_site', p_supplier_site_id)
    ) THEN
      RAISE EXCEPTION 'traceability_site_access_denied';
    END IF;
  END IF;

  IF p_node_type = 'organization'
     AND p_organization_id IS DISTINCT FROM v_product.brand_organization_id
     AND NOT EXISTS (
       SELECT 1 FROM brand_supplier_relationships r
       WHERE r.brand_organization_id = v_product.brand_organization_id
         AND r.supplier_organization_id = p_organization_id
         AND r.status = 'active'
     ) THEN
    RAISE EXCEPTION 'traceability_organization_not_in_active_relationship';
  END IF;

  INSERT INTO supply_chain_nodes (
    node_type,
    organization_id,
    supplier_site_id,
    product_id,
    material_id,
    process_code,
    label,
    metadata,
    status,
    source_document_id,
    declared_by,
    observed_at
  )
  VALUES (
    p_node_type,
    p_organization_id,
    p_supplier_site_id,
    p_product_id,
    p_material_id,
    NULLIF(trim(p_process_code), ''),
    trim(p_label),
    COALESCE(p_metadata, '{}'::jsonb),
    CASE WHEN p_source_document_id IS NULL THEN 'declared' ELSE 'documented' END,
    p_source_document_id,
    auth.uid(),
    p_observed_at
  )
  RETURNING * INTO v_node;

  RETURN v_node;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_update_supply_chain_node(
  p_graph_product_id UUID,
  p_node_id UUID,
  p_label TEXT,
  p_metadata JSONB,
  p_source_document_id UUID DEFAULT NULL,
  p_observed_at DATE DEFAULT NULL
)
RETURNS supply_chain_nodes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_node supply_chain_nodes;
BEGIN
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_graph_product_id;

  IF NOT FOUND OR NOT tracefab_has_org_role(
    v_product.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'traceability_brand_role_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM supply_chain_links l
    WHERE l.product_id = p_graph_product_id
      AND (l.source_node_id = p_node_id OR l.target_node_id = p_node_id)
  ) THEN
    RAISE EXCEPTION 'traceability_node_not_in_product_graph';
  END IF;

  IF length(trim(COALESCE(p_label, ''))) = 0 THEN
    RAISE EXCEPTION 'traceability_node_label_required';
  END IF;

  UPDATE supply_chain_nodes
  SET label = trim(p_label),
      metadata = COALESCE(p_metadata, '{}'::jsonb),
      source_document_id = p_source_document_id,
      status = CASE WHEN p_source_document_id IS NULL THEN 'declared' ELSE 'documented' END,
      declared_by = auth.uid(),
      observed_at = p_observed_at
  WHERE id = p_node_id
  RETURNING * INTO v_node;

  RETURN v_node;
END;
$$;

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
AS $$
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
    CASE WHEN p_evidence_document_id IS NULL THEN 'declared' ELSE 'documented' END,
    auth.uid()
  )
  RETURNING * INTO v_link;

  RETURN v_link;
END;
$$;

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
AS $$
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
      status = CASE WHEN p_evidence_document_id IS NULL THEN 'declared' ELSE 'documented' END,
      declared_by = auth.uid()
  WHERE id = p_link_id
  RETURNING * INTO v_link;

  RETURN v_link;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_get_product_traceability(p_product_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_brand_organization_id UUID;
  v_result JSONB;
BEGIN
  SELECT brand_organization_id INTO v_brand_organization_id
  FROM tracefab_products
  WHERE id = p_product_id;

  IF v_brand_organization_id IS NULL OR NOT tracefab_is_org_member(v_brand_organization_id) THEN
    RAISE EXCEPTION 'traceability_read_access_denied';
  END IF;

  SELECT jsonb_build_object(
    'product_id', p_product_id,
    'nodes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', n.id,
        'node_type', n.node_type,
        'label', n.label,
        'metadata', n.metadata,
        'status', n.status,
        'observed_at', n.observed_at,
        'source_document_id', CASE
          WHEN n.source_document_id IS NULL THEN NULL
          WHEN EXISTS (
            SELECT 1 FROM documents d
            WHERE d.id = n.source_document_id
              AND (
                tracefab_can_access_org(d.owner_organization_id)
                OR tracefab_can_access_shared_subject(d.owner_organization_id, 'document', d.id)
              )
          ) THEN n.source_document_id
          ELSE NULL
        END
      ) ORDER BY n.node_type, n.label)
      FROM supply_chain_nodes n
      WHERE EXISTS (
        SELECT 1 FROM supply_chain_links l
        WHERE l.product_id = p_product_id
          AND (l.source_node_id = n.id OR l.target_node_id = n.id)
      )
    ), '[]'::jsonb),
    'links', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', l.id,
        'source_node_id', l.source_node_id,
        'target_node_id', l.target_node_id,
        'link_type', l.link_type,
        'sequence_number', l.sequence_number,
        'valid_from', l.valid_from,
        'valid_until', l.valid_until,
        'status', l.status,
        'metadata', l.metadata,
        'evidence_document_id', CASE
          WHEN l.evidence_document_id IS NULL THEN NULL
          WHEN EXISTS (
            SELECT 1 FROM documents d
            WHERE d.id = l.evidence_document_id
              AND (
                tracefab_can_access_org(d.owner_organization_id)
                OR tracefab_can_access_shared_subject(d.owner_organization_id, 'document', d.id)
              )
          ) THEN l.evidence_document_id
          ELSE NULL
        END
      ) ORDER BY l.sequence_number NULLS LAST, l.created_at)
      FROM supply_chain_links l
      WHERE l.product_id = p_product_id
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. RLS and function privileges
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS nodes_select_authorized ON supply_chain_nodes;
CREATE POLICY nodes_select_traceability_graph ON supply_chain_nodes
  FOR SELECT TO authenticated USING (
    tracefab_can_access_org(organization_id)
    OR (
      supplier_site_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM supplier_sites ss
        JOIN suppliers s ON s.id = ss.supplier_id
        WHERE ss.id = supply_chain_nodes.supplier_site_id
          AND (
            tracefab_can_access_org(s.organization_id)
            OR tracefab_can_access_shared_subject(s.organization_id, 'supplier_site', ss.id)
          )
      )
    )
    OR (
      material_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM materials m
        WHERE m.id = supply_chain_nodes.material_id
          AND (
            tracefab_can_access_org(m.owner_organization_id)
            OR tracefab_can_access_shared_subject(m.owner_organization_id, 'material', m.id)
          )
      )
    )
    OR EXISTS (
      SELECT 1
      FROM supply_chain_links l
      JOIN tracefab_products p ON p.id = l.product_id
      WHERE (l.source_node_id = supply_chain_nodes.id OR l.target_node_id = supply_chain_nodes.id)
        AND tracefab_is_org_member(p.brand_organization_id)
    )
  );

DROP POLICY IF EXISTS nodes_insert_authorized ON supply_chain_nodes;
-- Node creation and updates go through the graph functions.

DROP POLICY IF EXISTS links_select_brand ON supply_chain_links;
CREATE POLICY links_select_traceability_graph ON supply_chain_links
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM tracefab_products p
      WHERE p.id = supply_chain_links.product_id
        AND tracefab_is_org_member(p.brand_organization_id)
    )
  );

DROP POLICY IF EXISTS links_insert_brand ON supply_chain_links;
-- Link creation and updates go through the graph functions.

REVOKE EXECUTE ON FUNCTION tracefab_traceability_set_updated_at() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_validate_supply_chain_node() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_validate_supply_chain_link() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_create_supply_chain_node(UUID, node_type, TEXT, UUID, UUID, UUID, UUID, TEXT, JSONB, UUID, DATE) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_update_supply_chain_node(UUID, UUID, TEXT, JSONB, UUID, DATE) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_add_supply_chain_link(UUID, UUID, UUID, supply_chain_link_type, INTEGER, DATE, DATE, UUID, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_update_supply_chain_link(UUID, INTEGER, DATE, DATE, UUID, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_get_product_traceability(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION tracefab_create_supply_chain_node(UUID, node_type, TEXT, UUID, UUID, UUID, UUID, TEXT, JSONB, UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION tracefab_update_supply_chain_node(UUID, UUID, TEXT, JSONB, UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION tracefab_add_supply_chain_link(UUID, UUID, UUID, supply_chain_link_type, INTEGER, DATE, DATE, UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION tracefab_update_supply_chain_link(UUID, INTEGER, DATE, DATE, UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION tracefab_get_product_traceability(UUID) TO authenticated;

COMMENT ON TABLE supply_chain_nodes IS 'Product traceability graph nodes with provenance status; graph presence is not independent verification.';
COMMENT ON TABLE supply_chain_links IS 'Product traceability graph edges with explicit declared/documented status and optional evidence.';
COMMENT ON FUNCTION tracefab_get_product_traceability(UUID) IS 'Returns a tenant-authorized graph projection with evidence identifiers redacted when access is absent.';
