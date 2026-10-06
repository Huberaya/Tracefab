-- Migration: 20261006140000_supply_chain_traceability_api
--
-- Chantier 3: Supply Chain Graph & Traceability API
--
-- 1. Upgrade tracefab_get_product_traceability to:
--    a) Include standalone product nodes (n.product_id = p_product_id) even before links are created.
--    b) Return entity foreign keys (organization_id, supplier_site_id, material_id, process_code).
--    c) Enrich nodes with human-readable entity details (site_name, site_country, site_city, material_name, material_type, organization_name).
--    d) Use tracefab_can_access_document for document visibility checks.

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
        'organization_id', n.organization_id,
        'supplier_site_id', n.supplier_site_id,
        'product_id', n.product_id,
        'material_id', n.material_id,
        'process_code', n.process_code,
        'metadata', n.metadata,
        'status', n.status,
        'observed_at', n.observed_at,
        'created_at', n.created_at,
        'site_name', ss.name,
        'site_country', ss.country_code,
        'site_city', ss.city,
        'material_name', m.name,
        'material_type', m.material_type,
        'organization_name', COALESCE(o.display_name, o.legal_name),
        'source_document_id', CASE
          WHEN n.source_document_id IS NULL THEN NULL
          WHEN tracefab_can_access_document(n.source_document_id) THEN n.source_document_id
          ELSE NULL
        END
      ) ORDER BY n.node_type, n.label)
      FROM supply_chain_nodes n
      LEFT JOIN supplier_sites ss ON ss.id = n.supplier_site_id
      LEFT JOIN materials m ON m.id = n.material_id
      LEFT JOIN organizations o ON o.id = n.organization_id
      WHERE n.product_id = p_product_id
         OR EXISTS (
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
        'created_at', l.created_at,
        'evidence_document_id', CASE
          WHEN l.evidence_document_id IS NULL THEN NULL
          WHEN tracefab_can_access_document(l.evidence_document_id) THEN l.evidence_document_id
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

REVOKE EXECUTE ON FUNCTION tracefab_get_product_traceability(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_get_product_traceability(UUID) TO PUBLIC;

COMMENT ON FUNCTION tracefab_get_product_traceability(UUID) IS 'Returns the enriched supply chain traceability graph (nodes and links) for a product.';
