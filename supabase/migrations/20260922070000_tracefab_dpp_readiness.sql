-- Tracefab Chantier 8 — DPP Readiness
--
-- Implements versioned readiness profiles and product-level readiness
-- computations. This is a readiness projection, not a final regulatory
-- compliance declaration and not a public DPP publication flow.

-- -----------------------------------------------------------------------------
-- 1. Requirement profiles and DPP record metadata
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE dpp_profile_status AS ENUM ('draft', 'active', 'retired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS dpp_requirement_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_key TEXT NOT NULL,
  profile_version TEXT NOT NULL,
  name TEXT NOT NULL,
  status dpp_profile_status NOT NULL DEFAULT 'draft',
  definition JSONB NOT NULL CHECK (
    COALESCE(jsonb_typeof(definition -> 'requirements') = 'array', false)
    AND COALESCE(jsonb_array_length(definition -> 'requirements'), 0) > 0
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (profile_key, profile_version)
);

CREATE INDEX IF NOT EXISTS idx_dpp_profiles_active
  ON dpp_requirement_profiles(profile_key, profile_version, status);

ALTER TABLE dpp_records
  ADD COLUMN IF NOT EXISTS requirement_profile_id UUID REFERENCES dpp_requirement_profiles(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS input_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS source_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_dpp_records_profile
  ON dpp_records(requirement_profile_id, product_id, product_version, computed_at DESC);

CREATE OR REPLACE FUNCTION tracefab_dpp_profiles_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER dpp_profiles_set_updated_at
    BEFORE UPDATE ON dpp_requirement_profiles
    FOR EACH ROW EXECUTE FUNCTION tracefab_dpp_profiles_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Initial profile is a Tracefab readiness profile, deliberately not labelled as
-- a legal or final regulatory profile.
INSERT INTO dpp_requirement_profiles (
  profile_key,
  profile_version,
  name,
  status,
  definition
)
VALUES (
  'textile_readiness_mvp',
  '1.0',
  'Tracefab textile readiness MVP',
  'active',
  '{
    "scope": "product_readiness",
    "notice": "Operational readiness profile, not a final regulatory compliance declaration.",
    "requirements": [
      {"key": "product.reference", "label": "Product reference", "blocking": true},
      {"key": "product.name", "label": "Product name", "blocking": true},
      {"key": "product.description", "label": "Product description", "blocking": true},
      {"key": "product.category", "label": "Product category", "blocking": true},
      {"key": "product.country_of_manufacture", "label": "Country of manufacture", "blocking": true},
      {"key": "product.data_ready", "label": "Core product data ready", "blocking": true},
      {"key": "composition.complete", "label": "Complete material composition", "blocking": true},
      {"key": "traceability.graph", "label": "Traceability graph present", "blocking": true},
      {"key": "quality.no_blocking_issues", "label": "No open blocking quality issue", "blocking": true}
    ]
  }'::jsonb
)
ON CONFLICT (profile_key, profile_version) DO UPDATE
SET name = EXCLUDED.name,
    status = EXCLUDED.status,
    definition = EXCLUDED.definition;

-- -----------------------------------------------------------------------------
-- 2. Requirement evaluation
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_dpp_requirement_met(
  p_requirement_key TEXT,
  p_product_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_material_count INTEGER;
  v_material_percentage_count INTEGER;
  v_percentage_total NUMERIC;
  v_met BOOLEAN := false;
BEGIN
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  CASE p_requirement_key
    WHEN 'product.reference' THEN
      v_met := length(trim(COALESCE(v_product.reference, ''))) > 0;
    WHEN 'product.name' THEN
      v_met := length(trim(COALESCE(v_product.name, ''))) > 0;
    WHEN 'product.description' THEN
      v_met := length(trim(COALESCE(v_product.description, ''))) >= 30;
    WHEN 'product.category' THEN
      v_met := length(trim(COALESCE(v_product.category, ''))) > 0;
    WHEN 'product.country_of_manufacture' THEN
      v_met := v_product.country_of_manufacture IS NOT NULL
        AND length(trim(v_product.country_of_manufacture)) = 2;
    WHEN 'product.data_ready' THEN
      v_met := v_product.data_readiness = 'data_ready';
    WHEN 'composition.complete' THEN
      SELECT
        COUNT(*),
        COUNT(*) FILTER (WHERE percentage IS NOT NULL),
        COALESCE(SUM(percentage), 0)
      INTO v_material_count, v_material_percentage_count, v_percentage_total
      FROM product_materials
      WHERE product_id = p_product_id
        AND product_version = v_product.version;
      v_met := v_material_count > 0
        AND v_material_percentage_count = v_material_count
        AND abs(v_percentage_total - 100) < 0.01;
    WHEN 'traceability.graph' THEN
      v_met := EXISTS (
        SELECT 1 FROM supply_chain_links
        WHERE product_id = p_product_id
      );
    WHEN 'quality.no_blocking_issues' THEN
      SELECT s.blocking_issues = '[]'::jsonb
      INTO v_met
      FROM data_quality_scores s
      WHERE s.product_id = p_product_id
      ORDER BY s.computed_at DESC
      LIMIT 1;
      v_met := COALESCE(v_met, false);
    WHEN 'evidence.product_data' THEN
      v_met := EXISTS (
        SELECT 1
        FROM data_points dp
        JOIN documents d ON d.id = dp.source_document_id
        WHERE dp.product_id = p_product_id
          AND d.status = 'available'
      );
    ELSE
      v_met := false;
  END CASE;

  RETURN v_met;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_compute_dpp_readiness(
  p_product_id UUID,
  p_profile_key TEXT DEFAULT 'textile_readiness_mvp',
  p_profile_version TEXT DEFAULT '1.0'
)
RETURNS dpp_records
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_profile dpp_requirement_profiles;
  v_requirement JSONB;
  v_requirement_key TEXT;
  v_met BOOLEAN;
  v_missing_fields JSONB := '[]'::jsonb;
  v_blocking_issues JSONB := '[]'::jsonb;
  v_readiness dpp_readiness_status;
  v_source_snapshot JSONB;
  v_fingerprint TEXT;
  v_record dpp_records;
  v_has_review_required BOOLEAN := false;
  v_requirement_results JSONB := '[]'::jsonb;
  v_composition_snapshot JSONB := '[]'::jsonb;
  v_traceability_snapshot JSONB := '[]'::jsonb;
  v_quality_snapshot JSONB := '{}'::jsonb;
BEGIN
  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_product.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'auditor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'dpp_readiness_role_required';
  END IF;

  SELECT * INTO v_profile
  FROM dpp_requirement_profiles
  WHERE profile_key = p_profile_key
    AND profile_version = p_profile_version
    AND status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_dpp_requirement_profile_not_found';
  END IF;

  FOR v_requirement IN
    SELECT value FROM jsonb_array_elements(v_profile.definition -> 'requirements')
  LOOP
    v_requirement_key := v_requirement ->> 'key';
    v_met := tracefab_dpp_requirement_met(v_requirement_key, p_product_id);
    v_requirement_results := v_requirement_results || jsonb_build_array(
      jsonb_build_object(
        'key', v_requirement_key,
        'met', v_met
      )
    );

    IF NOT v_met THEN
      v_missing_fields := v_missing_fields || jsonb_build_array(
        jsonb_build_object(
          'key', v_requirement_key,
          'label', v_requirement ->> 'label',
          'blocking', COALESCE((v_requirement ->> 'blocking')::boolean, true)
        )
      );

      IF COALESCE((v_requirement ->> 'blocking')::boolean, true) THEN
        v_blocking_issues := v_blocking_issues || jsonb_build_array(
          jsonb_build_object(
            'key', v_requirement_key,
            'label', v_requirement ->> 'label',
            'reason', 'requirement_not_met'
          )
        );
      END IF;
    END IF;
  END LOOP;

  IF v_product.data_readiness = 'needs_review'
     OR EXISTS (
       SELECT 1
       FROM (
         SELECT s.blocking_issues
         FROM data_quality_scores s
         WHERE s.product_id = p_product_id
         ORDER BY s.computed_at DESC
         LIMIT 1
       ) latest_score
       WHERE latest_score.blocking_issues <> '[]'::jsonb
     ) THEN
    v_has_review_required := true;
  END IF;

  v_readiness := CASE
    WHEN jsonb_array_length(v_blocking_issues) > 0 AND v_has_review_required
      THEN 'review_required'::dpp_readiness_status
    WHEN jsonb_array_length(v_blocking_issues) > 0
      THEN 'in_progress'::dpp_readiness_status
    WHEN v_has_review_required
      THEN 'review_required'::dpp_readiness_status
    ELSE 'data_ready'::dpp_readiness_status
  END;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'material_id', pm.material_id,
        'material_role', pm.material_role,
        'percentage', pm.percentage,
        'unit', pm.unit,
        'product_version', pm.product_version
      ) ORDER BY pm.material_id, pm.material_role, pm.product_version
    ),
    '[]'::jsonb
  )
  INTO v_composition_snapshot
  FROM product_materials pm
  WHERE pm.product_id = p_product_id
    AND pm.product_version = v_product.version;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'link_id', scl.id,
        'source_node_id', scl.source_node_id,
        'target_node_id', scl.target_node_id,
        'link_type', scl.link_type,
        'sequence_number', scl.sequence_number
      ) ORDER BY scl.sequence_number NULLS LAST, scl.id
    ),
    '[]'::jsonb
  )
  INTO v_traceability_snapshot
  FROM supply_chain_links scl
  WHERE scl.product_id = p_product_id;

  SELECT COALESCE(
    (
      SELECT jsonb_build_object(
        'score_id', s.id,
        'computed_at', s.computed_at,
        'completeness', s.completeness,
        'freshness', s.freshness,
        'documentation_coverage', s.documentation_coverage,
        'consistency', s.consistency,
        'missing_fields', s.missing_fields,
        'blocking_issues', s.blocking_issues
      )
      FROM data_quality_scores s
      WHERE s.product_id = p_product_id
      ORDER BY s.computed_at DESC
      LIMIT 1
    ),
    '{}'::jsonb
  )
  INTO v_quality_snapshot;

  v_source_snapshot := jsonb_build_object(
    'product', jsonb_build_object(
      'id', v_product.id,
      'version', v_product.version,
      'reference', v_product.reference,
      'name', v_product.name,
      'description', v_product.description,
      'category', v_product.category,
      'country_of_manufacture', v_product.country_of_manufacture,
      'data_readiness', v_product.data_readiness,
      'data_completion', v_product.data_completion,
      'updated_at', v_product.updated_at
    ),
    'profile', jsonb_build_object(
      'id', v_profile.id,
      'key', v_profile.profile_key,
      'version', v_profile.profile_version,
      'definition', v_profile.definition
    ),
    'composition', v_composition_snapshot,
    'traceability_links', v_traceability_snapshot,
    'latest_quality_score', v_quality_snapshot,
    'requirement_results', v_requirement_results,
    'captured_at', now()
  );
  v_fingerprint := md5((v_source_snapshot - 'captured_at')::TEXT);

  INSERT INTO dpp_records (
    product_id,
    product_version,
    requirement_profile_key,
    requirement_profile_version,
    requirement_profile_id,
    readiness_status,
    missing_fields,
    blocking_issues,
    public_projection,
    computed_at,
    computed_by,
    input_fingerprint,
    source_snapshot,
    reviewed_at,
    reviewed_by
  )
  VALUES (
    p_product_id,
    v_product.version,
    v_profile.profile_key,
    v_profile.profile_version,
    v_profile.id,
    v_readiness,
    v_missing_fields,
    v_blocking_issues,
    '{}'::jsonb,
    now(),
    auth.uid(),
    v_fingerprint,
    v_source_snapshot,
    NULL,
    NULL
  )
  ON CONFLICT (product_id, product_version, requirement_profile_key, requirement_profile_version)
  DO UPDATE SET
    requirement_profile_id = EXCLUDED.requirement_profile_id,
    readiness_status = EXCLUDED.readiness_status,
    missing_fields = EXCLUDED.missing_fields,
    blocking_issues = EXCLUDED.blocking_issues,
    computed_at = EXCLUDED.computed_at,
    computed_by = EXCLUDED.computed_by,
    input_fingerprint = EXCLUDED.input_fingerprint,
    source_snapshot = EXCLUDED.source_snapshot,
    reviewed_at = NULL,
    reviewed_by = NULL
  RETURNING * INTO v_record;

  RETURN v_record;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_mark_dpp_ready_to_publish(p_dpp_record_id UUID)
RETURNS dpp_records
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_record dpp_records;
  v_brand_organization_id UUID;
BEGIN
  SELECT r.* INTO v_record
  FROM dpp_records r
  WHERE r.id = p_dpp_record_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'dpp_record_not_found';
  END IF;

  SELECT p.brand_organization_id INTO v_brand_organization_id
  FROM tracefab_products p
  WHERE p.id = v_record.product_id;

  IF NOT tracefab_has_org_role(
    v_brand_organization_id,
    ARRAY['owner', 'admin', 'manager']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'dpp_publish_review_role_required';
  END IF;

  IF v_record.readiness_status <> 'data_ready' THEN
    RAISE EXCEPTION 'dpp_record_not_data_ready';
  END IF;

  UPDATE dpp_records
  SET readiness_status = 'ready_to_publish',
      reviewed_at = now(),
      reviewed_by = auth.uid()
  WHERE id = p_dpp_record_id
  RETURNING * INTO v_record;

  RETURN v_record;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. RLS and privileges
-- -----------------------------------------------------------------------------

ALTER TABLE dpp_requirement_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY dpp_profiles_select_authenticated ON dpp_requirement_profiles
  FOR SELECT TO authenticated USING (status = 'active');

DROP POLICY IF EXISTS dpp_insert_brand ON dpp_records;
-- DPP records are computed and reviewed through functions only. There is no
-- public SELECT policy and no public projection in this chantier.

REVOKE EXECUTE ON FUNCTION tracefab_dpp_profiles_set_updated_at() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_dpp_requirement_met(TEXT, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_compute_dpp_readiness(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_mark_dpp_ready_to_publish(UUID) FROM PUBLIC;

GRANT SELECT ON dpp_requirement_profiles TO authenticated;
REVOKE INSERT, UPDATE ON dpp_records FROM authenticated;
GRANT SELECT ON dpp_records TO authenticated;
GRANT EXECUTE ON FUNCTION tracefab_compute_dpp_readiness(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION tracefab_mark_dpp_ready_to_publish(UUID) TO authenticated;

COMMENT ON TABLE dpp_requirement_profiles IS 'Versioned operational readiness profiles. These are not final legal requirements.';
COMMENT ON TABLE dpp_records IS 'Versioned DPP readiness projections. This table does not constitute a final regulatory compliance declaration or public DPP.';
COMMENT ON COLUMN dpp_records.public_projection IS 'Reserved for a later public projection chantier; kept empty by the readiness workflow.';
COMMENT ON FUNCTION tracefab_compute_dpp_readiness(UUID, TEXT, TEXT) IS 'Computes an operational readiness projection from a versioned profile and current source data.';
COMMENT ON FUNCTION tracefab_mark_dpp_ready_to_publish(UUID) IS 'Marks a reviewed readiness record as ready_to_publish; it does not publish a public DPP.';
