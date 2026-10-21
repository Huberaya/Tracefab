-- Tighten the internal DPP readiness profile after the production customer
-- journey demonstrated that structural presence was being confused with
-- evidence, certification and publication readiness.

UPDATE dpp_requirement_profiles
SET name = 'Tracefab textile technical readiness',
    definition = '{
      "scope": "internal_technical_readiness",
      "notice": "Internal technical readiness only. Not certification, regulatory compliance or publication approval.",
      "requirements": [
        {"key":"product.reference","label":"Product reference","blocking":true},
        {"key":"product.name","label":"Product name","blocking":true},
        {"key":"product.description","label":"Product description","blocking":true},
        {"key":"product.category","label":"Product category","blocking":true},
        {"key":"product.country_of_manufacture","label":"Country of manufacture","blocking":true},
        {"key":"product.required_attributes","label":"Required product attributes","blocking":true},
        {"key":"composition.complete","label":"Material percentages total 100%","blocking":true},
        {"key":"materials.origin_documented","label":"Material origins documented","blocking":true},
        {"key":"traceability.graph","label":"Traceability graph present","blocking":true},
        {"key":"traceability.documented","label":"Traceability steps documented","blocking":true},
        {"key":"quality.no_open_issues","label":"No open quality issue","blocking":true},
        {"key":"evidence.product_data","label":"Product data has available source documents","blocking":true},
        {"key":"product.not_draft","label":"Product is no longer a draft","blocking":true}
      ]
    }'::jsonb,
    updated_at = now()
WHERE profile_key = 'textile_readiness_mvp' AND profile_version = '1.0';

CREATE OR REPLACE FUNCTION tracefab_dpp_requirement_met(
  p_requirement_key TEXT,
  p_product_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_material_count INTEGER;
  v_material_percentage_count INTEGER;
  v_percentage_total NUMERIC;
  v_met BOOLEAN := false;
BEGIN
  SELECT * INTO v_product FROM tracefab_products WHERE id = p_product_id;
  IF NOT FOUND THEN RETURN false; END IF;

  CASE p_requirement_key
    WHEN 'product.reference' THEN v_met := length(trim(COALESCE(v_product.reference, ''))) > 0;
    WHEN 'product.name' THEN v_met := length(trim(COALESCE(v_product.name, ''))) > 0;
    WHEN 'product.description' THEN v_met := length(trim(COALESCE(v_product.description, ''))) >= 30;
    WHEN 'product.category' THEN v_met := length(trim(COALESCE(v_product.category, ''))) > 0;
    WHEN 'product.country_of_manufacture' THEN v_met := v_product.country_of_manufacture IS NOT NULL AND length(trim(v_product.country_of_manufacture)) = 2;
    WHEN 'product.required_attributes' THEN
      v_met := length(trim(COALESCE(v_product.color_name, ''))) > 0
        AND COALESCE(array_length(v_product.size_range, 1), 0) > 0
        AND v_product.weight_grams IS NOT NULL AND v_product.weight_grams > 0;
    WHEN 'product.data_ready' THEN v_met := v_product.data_readiness = 'data_ready';
    WHEN 'product.not_draft' THEN v_met := v_product.status::text <> 'draft';
    WHEN 'composition.complete' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE percentage IS NOT NULL), COALESCE(SUM(percentage), 0)
      INTO v_material_count, v_material_percentage_count, v_percentage_total
      FROM product_materials WHERE product_id = p_product_id AND product_version = v_product.version;
      v_met := v_material_count > 0 AND v_material_percentage_count = v_material_count AND abs(v_percentage_total - 100) < 0.01;
    WHEN 'materials.origin_documented' THEN
      v_met := EXISTS (SELECT 1 FROM product_materials pm WHERE pm.product_id=p_product_id AND pm.product_version=v_product.version)
        AND NOT EXISTS (
          SELECT 1 FROM product_materials pm JOIN materials m ON m.id=pm.material_id
          WHERE pm.product_id=p_product_id AND pm.product_version=v_product.version
            AND (m.origin_country_code IS NULL OR length(trim(m.origin_country_code)) <> 2)
        );
    WHEN 'traceability.graph' THEN
      v_met := EXISTS (SELECT 1 FROM supply_chain_links WHERE product_id = p_product_id);
    WHEN 'traceability.documented' THEN
      v_met := EXISTS (SELECT 1 FROM supply_chain_nodes WHERE graph_product_id=p_product_id)
        AND NOT EXISTS (
          SELECT 1 FROM supply_chain_nodes
          WHERE graph_product_id=p_product_id
            AND (source_document_id IS NULL OR status::text NOT IN ('documented','checked_for_consistency','verified_by_reviewer','certified_by_third_party'))
        );
    WHEN 'quality.no_blocking_issues' THEN
      SELECT s.blocking_issues = '[]'::jsonb INTO v_met FROM data_quality_scores s
      WHERE s.product_id=p_product_id ORDER BY s.computed_at DESC LIMIT 1;
      v_met := COALESCE(v_met, false);
    WHEN 'quality.no_open_issues' THEN
      v_met := NOT EXISTS (
        SELECT 1 FROM data_quality_issues q
        WHERE q.product_id=p_product_id AND q.status::text IN ('open','acknowledged')
      );
    WHEN 'evidence.product_data' THEN
      v_met := EXISTS (
        SELECT 1 FROM data_points dp JOIN documents d ON d.id=dp.source_document_id
        WHERE dp.product_id=p_product_id AND d.status='available'
      );
    ELSE v_met := false;
  END CASE;
  RETURN COALESCE(v_met, false);
END;
$$;

REVOKE EXECUTE ON FUNCTION tracefab_dpp_requirement_met(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_dpp_requirement_met(TEXT, UUID) TO tracefab_app;
