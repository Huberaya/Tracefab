-- Tracefab Chantier 6 — Data Quality
--
-- Adds explainable quality issues, versioned score snapshots and controlled
-- acknowledgement/waiver actions. A quality score is not a verification or
-- certification claim.

-- -----------------------------------------------------------------------------
-- 1. Quality issue model
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE quality_issue_severity AS ENUM ('info', 'warning', 'blocking');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE quality_issue_status AS ENUM ('open', 'acknowledged', 'resolved', 'waived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS data_quality_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  supplier_id UUID REFERENCES suppliers(id) ON DELETE CASCADE,
  product_id UUID REFERENCES tracefab_products(id) ON DELETE CASCADE,
  subject_id UUID GENERATED ALWAYS AS (COALESCE(supplier_id, product_id)) STORED,
  rule_key TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  severity quality_issue_severity NOT NULL,
  status quality_issue_status NOT NULL DEFAULT 'open',
  field_key TEXT,
  message TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(supplier_id, product_id) = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_quality_issues_identity
  ON data_quality_issues(owner_organization_id, subject_id, rule_key, rule_version);

CREATE INDEX IF NOT EXISTS idx_quality_issues_supplier_status
  ON data_quality_issues(supplier_id, status, severity);

CREATE INDEX IF NOT EXISTS idx_quality_issues_product_status
  ON data_quality_issues(product_id, status, severity);

CREATE INDEX IF NOT EXISTS idx_quality_issues_owner_detected
  ON data_quality_issues(owner_organization_id, detected_at DESC);

CREATE OR REPLACE FUNCTION tracefab_validate_quality_issue_subject()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier_owner UUID;
  v_product_owner UUID;
BEGIN
  IF NEW.supplier_id IS NOT NULL THEN
    SELECT organization_id INTO v_supplier_owner
    FROM suppliers
    WHERE id = NEW.supplier_id;
    IF v_supplier_owner IS NULL OR v_supplier_owner <> NEW.owner_organization_id THEN
      RAISE EXCEPTION 'quality_issue_supplier_owner_mismatch';
    END IF;
  END IF;

  IF NEW.product_id IS NOT NULL THEN
    SELECT brand_organization_id INTO v_product_owner
    FROM tracefab_products
    WHERE id = NEW.product_id;
    IF v_product_owner IS NULL OR v_product_owner <> NEW.owner_organization_id THEN
      RAISE EXCEPTION 'quality_issue_product_owner_mismatch';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER quality_issues_validate_subject
    BEFORE INSERT OR UPDATE ON data_quality_issues
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_quality_issue_subject();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION tracefab_quality_issues_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER quality_issues_set_updated_at
    BEFORE UPDATE ON data_quality_issues
    FOR EACH ROW EXECUTE FUNCTION tracefab_quality_issues_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION tracefab_upsert_quality_issue(
  p_owner_organization_id UUID,
  p_supplier_id UUID,
  p_product_id UUID,
  p_rule_key TEXT,
  p_rule_version TEXT,
  p_severity quality_issue_severity,
  p_field_key TEXT,
  p_message TEXT,
  p_details JSONB DEFAULT '{}'::jsonb
)
RETURNS data_quality_issues
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_issue data_quality_issues;
BEGIN
  INSERT INTO data_quality_issues (
    owner_organization_id,
    supplier_id,
    product_id,
    rule_key,
    rule_version,
    severity,
    status,
    field_key,
    message,
    details,
    detected_at,
    acknowledged_at,
    acknowledged_by,
    resolved_at,
    resolved_by
  )
  VALUES (
    p_owner_organization_id,
    p_supplier_id,
    p_product_id,
    p_rule_key,
    p_rule_version,
    p_severity,
    'open',
    p_field_key,
    p_message,
    COALESCE(p_details, '{}'::jsonb),
    now(),
    NULL,
    NULL,
    NULL,
    NULL
  )
  ON CONFLICT (owner_organization_id, subject_id, rule_key, rule_version)
  DO UPDATE SET
    severity = EXCLUDED.severity,
    status = CASE
      WHEN data_quality_issues.status = 'waived' THEN 'waived'::quality_issue_status
      ELSE 'open'::quality_issue_status
    END,
    field_key = EXCLUDED.field_key,
    message = EXCLUDED.message,
    details = EXCLUDED.details,
    detected_at = EXCLUDED.detected_at,
    acknowledged_at = CASE
      WHEN data_quality_issues.status = 'waived' THEN data_quality_issues.acknowledged_at
      ELSE NULL
    END,
    acknowledged_by = CASE
      WHEN data_quality_issues.status = 'waived' THEN data_quality_issues.acknowledged_by
      ELSE NULL
    END,
    resolved_at = NULL,
    resolved_by = NULL,
    updated_at = now()
  RETURNING * INTO v_issue;

  RETURN v_issue;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. Supplier quality computation
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_compute_supplier_quality(
  p_supplier_id UUID,
  p_calculation_version TEXT DEFAULT 'supplier_quality_v1'
)
RETURNS data_quality_scores
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier suppliers;
  v_owner_organization_id UUID;
  v_profile_completion NUMERIC(5,2);
  v_data_point_count INTEGER;
  v_fresh_data_point_count INTEGER;
  v_documented_data_point_count INTEGER;
  v_certification_count INTEGER;
  v_documented_certification_count INTEGER;
  v_expired_certification_count INTEGER;
  v_active_site_count INTEGER;
  v_blocking_count INTEGER;
  v_warning_count INTEGER;
  v_freshness NUMERIC(5,2);
  v_documentation NUMERIC(5,2);
  v_consistency NUMERIC(5,2);
  v_missing_fields JSONB := '[]'::jsonb;
  v_score data_quality_scores;
BEGIN
  IF length(trim(COALESCE(p_calculation_version, ''))) = 0 THEN
    RAISE EXCEPTION 'quality_calculation_version_required';
  END IF;

  SELECT * INTO v_supplier
  FROM suppliers
  WHERE id = p_supplier_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'supplier_not_found';
  END IF;

  v_owner_organization_id := v_supplier.organization_id;

  IF NOT (
    tracefab_has_org_role(
      v_owner_organization_id,
      ARRAY['owner', 'admin', 'manager', 'auditor']::membership_role[]
    )
    OR tracefab_can_access_shared_subject(v_owner_organization_id, 'supplier', p_supplier_id)
  ) THEN
    RAISE EXCEPTION 'supplier_quality_access_denied';
  END IF;

  UPDATE data_quality_issues
  SET status = 'resolved',
      resolved_at = now(),
      resolved_by = auth.uid()
  WHERE owner_organization_id = v_owner_organization_id
    AND subject_id = p_supplier_id
    AND rule_version = p_calculation_version
    AND status IN ('open', 'acknowledged');

  v_profile_completion := COALESCE(v_supplier.profile_completion, 0);

  IF v_profile_completion < 100 THEN
    v_missing_fields := v_missing_fields || to_jsonb('supplier_profile'::TEXT);
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      p_supplier_id,
      NULL,
      'supplier_profile_incomplete',
      p_calculation_version,
      'blocking',
      'profile_completion',
      'Supplier profile is not complete.',
      jsonb_build_object('completion', v_profile_completion)
    );
  END IF;

  SELECT COUNT(*) INTO v_active_site_count
  FROM supplier_sites
  WHERE supplier_id = p_supplier_id AND is_active = true;

  IF v_active_site_count = 0 THEN
    v_missing_fields := v_missing_fields || to_jsonb('active_site'::TEXT);
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      p_supplier_id,
      NULL,
      'supplier_no_active_site',
      p_calculation_version,
      'blocking',
      'supplier_sites',
      'Supplier has no active site.',
      '{}'::jsonb
    );
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE valid_until IS NULL OR valid_until >= CURRENT_DATE),
    COUNT(*) FILTER (
      WHERE source_document_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM documents d
          WHERE d.id = data_points.source_document_id
            AND d.status = 'available'
        )
    )
  INTO v_data_point_count, v_fresh_data_point_count, v_documented_data_point_count
  FROM data_points
  WHERE supplier_id = p_supplier_id;

  IF v_data_point_count = 0 THEN
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      p_supplier_id,
      NULL,
      'supplier_no_data_points',
      p_calculation_version,
      'warning',
      'data_points',
      'Supplier has no structured data points.',
      '{}'::jsonb
    );
  END IF;

  IF v_data_point_count > 0 THEN
    v_freshness := round((v_fresh_data_point_count::NUMERIC / v_data_point_count) * 100, 2);
    v_documentation := round((v_documented_data_point_count::NUMERIC / v_data_point_count) * 100, 2);
  ELSE
    v_freshness := 0;
    v_documentation := 0;
  END IF;

  IF v_data_point_count > v_fresh_data_point_count THEN
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      p_supplier_id,
      NULL,
      'supplier_expired_data_points',
      p_calculation_version,
      'warning',
      'data_points',
      'Supplier has expired data points.',
      jsonb_build_object('expired_count', v_data_point_count - v_fresh_data_point_count)
    );
  END IF;

  IF v_data_point_count > v_documented_data_point_count THEN
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      p_supplier_id,
      NULL,
      'supplier_missing_evidence',
      p_calculation_version,
      'warning',
      'source_document_id',
      'Some supplier data points have no source document.',
      jsonb_build_object('missing_document_count', v_data_point_count - v_documented_data_point_count)
    );
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (
      WHERE document_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM documents d
          WHERE d.id = certifications.document_id
            AND d.status = 'available'
        )
    ),
    COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at < CURRENT_DATE)
  INTO v_certification_count, v_documented_certification_count, v_expired_certification_count
  FROM certifications
  WHERE supplier_id = p_supplier_id OR supplier_site_id IN (
    SELECT id FROM supplier_sites WHERE supplier_id = p_supplier_id
  );

  IF v_certification_count > 0 AND v_expired_certification_count > 0 THEN
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      p_supplier_id,
      NULL,
      'supplier_expired_certification',
      p_calculation_version,
      'blocking',
      'certifications.expires_at',
      'Supplier has one or more expired certifications.',
      jsonb_build_object('expired_count', v_expired_certification_count)
    );
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE severity = 'blocking'),
    COUNT(*) FILTER (WHERE severity = 'warning')
  INTO v_blocking_count, v_warning_count
  FROM data_quality_issues
  WHERE owner_organization_id = v_owner_organization_id
    AND subject_id = p_supplier_id
    AND status IN ('open', 'acknowledged');

  v_consistency := GREATEST(0, 100 - (v_blocking_count * 30) - (v_warning_count * 10));

  INSERT INTO data_quality_scores (
    owner_organization_id,
    supplier_id,
    completeness,
    freshness,
    documentation_coverage,
    consistency,
    missing_fields,
    blocking_issues,
    calculation_version,
    computed_at
  )
  SELECT
    v_owner_organization_id,
    p_supplier_id,
    v_profile_completion,
    v_freshness,
    CASE
      WHEN v_certification_count + v_data_point_count = 0 THEN 0
      ELSE round(((v_documented_data_point_count + v_documented_certification_count)::NUMERIC / (v_certification_count + v_data_point_count)) * 100, 2)
    END,
    v_consistency,
    v_missing_fields,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object('rule_key', rule_key, 'severity', severity, 'message', message))
      FROM data_quality_issues
      WHERE owner_organization_id = v_owner_organization_id
        AND subject_id = p_supplier_id
        AND severity = 'blocking'
        AND status IN ('open', 'acknowledged')
    ), '[]'::jsonb),
    p_calculation_version,
    now()
  RETURNING * INTO v_score;

  RETURN v_score;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Product quality computation
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_compute_product_quality(
  p_product_id UUID,
  p_calculation_version TEXT DEFAULT 'product_quality_v1'
)
RETURNS data_quality_scores
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product tracefab_products;
  v_owner_organization_id UUID;
  v_data_point_count INTEGER;
  v_fresh_data_point_count INTEGER;
  v_documented_data_point_count INTEGER;
  v_certification_count INTEGER;
  v_documented_certification_count INTEGER;
  v_expired_certification_count INTEGER;
  v_material_count INTEGER;
  v_material_percentage_count INTEGER;
  v_material_percentage_total NUMERIC;
  v_blocking_count INTEGER;
  v_warning_count INTEGER;
  v_freshness NUMERIC(5,2);
  v_documentation NUMERIC(5,2);
  v_consistency NUMERIC(5,2);
  v_missing_fields JSONB := '[]'::jsonb;
  v_score data_quality_scores;
BEGIN
  IF length(trim(COALESCE(p_calculation_version, ''))) = 0 THEN
    RAISE EXCEPTION 'quality_calculation_version_required';
  END IF;

  SELECT * INTO v_product
  FROM tracefab_products
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found';
  END IF;

  v_owner_organization_id := v_product.brand_organization_id;

  IF NOT tracefab_has_org_role(
    v_owner_organization_id,
    ARRAY['owner', 'admin', 'manager', 'auditor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'product_quality_access_denied';
  END IF;

  UPDATE data_quality_issues
  SET status = 'resolved',
      resolved_at = now(),
      resolved_by = auth.uid()
  WHERE owner_organization_id = v_owner_organization_id
    AND subject_id = p_product_id
    AND rule_version = p_calculation_version
    AND status IN ('open', 'acknowledged');

  IF COALESCE(v_product.data_completion, 0) < 100 THEN
    v_missing_fields := v_missing_fields || to_jsonb('product_data'::TEXT);
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      NULL,
      p_product_id,
      'product_data_incomplete',
      p_calculation_version,
      'blocking',
      'data_completion',
      'Product data is not complete.',
      jsonb_build_object('completion', COALESCE(v_product.data_completion, 0))
    );
  END IF;

  IF v_product.data_readiness = 'needs_review' THEN
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      NULL,
      p_product_id,
      'product_data_needs_review',
      p_calculation_version,
      'blocking',
      'data_readiness',
      'Product data contains an item requiring review.',
      '{}'::jsonb
    );
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE valid_until IS NULL OR valid_until >= CURRENT_DATE),
    COUNT(*) FILTER (
      WHERE source_document_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM documents d
          WHERE d.id = data_points.source_document_id
            AND d.status = 'available'
        )
    )
  INTO v_data_point_count, v_fresh_data_point_count, v_documented_data_point_count
  FROM data_points
  WHERE product_id = p_product_id;

  IF v_data_point_count = 0 THEN
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      NULL,
      p_product_id,
      'product_no_data_points',
      p_calculation_version,
      'blocking',
      'data_points',
      'Product has no structured data points.',
      '{}'::jsonb
    );
  END IF;

  IF v_data_point_count > 0 THEN
    v_freshness := round((v_fresh_data_point_count::NUMERIC / v_data_point_count) * 100, 2);
    v_documentation := round((v_documented_data_point_count::NUMERIC / v_data_point_count) * 100, 2);
  ELSE
    v_freshness := 0;
    v_documentation := 0;
  END IF;

  IF v_data_point_count > v_fresh_data_point_count THEN
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      NULL,
      p_product_id,
      'product_expired_data_points',
      p_calculation_version,
      'warning',
      'data_points',
      'Product has expired data points.',
      jsonb_build_object('expired_count', v_data_point_count - v_fresh_data_point_count)
    );
  END IF;

  IF v_data_point_count > v_documented_data_point_count THEN
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      NULL,
      p_product_id,
      'product_missing_evidence',
      p_calculation_version,
      'warning',
      'source_document_id',
      'Some product data points have no source document.',
      jsonb_build_object('missing_document_count', v_data_point_count - v_documented_data_point_count)
    );
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE percentage IS NOT NULL),
    COALESCE(SUM(percentage), 0)
  INTO v_material_count, v_material_percentage_count, v_material_percentage_total
  FROM product_materials
  WHERE product_id = p_product_id
    AND product_version = v_product.version;

  IF v_material_count = 0
     OR v_material_percentage_count <> v_material_count
     OR abs(v_material_percentage_total - 100) >= 0.01 THEN
    v_missing_fields := v_missing_fields || to_jsonb('product_material_composition'::TEXT);
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      NULL,
      p_product_id,
      'product_composition_incomplete',
      p_calculation_version,
      'blocking',
      'product_materials',
      'Current product composition is missing or does not total 100 percent.',
      jsonb_build_object('material_count', v_material_count, 'percentage_total', v_material_percentage_total)
    );
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (
      WHERE document_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM documents d
          WHERE d.id = certifications.document_id
            AND d.status = 'available'
        )
    ),
    COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at < CURRENT_DATE)
  INTO v_certification_count, v_documented_certification_count, v_expired_certification_count
  FROM certifications
  WHERE product_id = p_product_id;

  IF v_expired_certification_count > 0 THEN
    PERFORM tracefab_upsert_quality_issue(
      v_owner_organization_id,
      NULL,
      p_product_id,
      'product_expired_certification',
      p_calculation_version,
      'warning',
      'certifications.expires_at',
      'Product has an expired certification.',
      jsonb_build_object('expired_count', v_expired_certification_count)
    );
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE severity = 'blocking'),
    COUNT(*) FILTER (WHERE severity = 'warning')
  INTO v_blocking_count, v_warning_count
  FROM data_quality_issues
  WHERE owner_organization_id = v_owner_organization_id
    AND subject_id = p_product_id
    AND status IN ('open', 'acknowledged');

  v_consistency := GREATEST(0, 100 - (v_blocking_count * 30) - (v_warning_count * 10));

  INSERT INTO data_quality_scores (
    owner_organization_id,
    product_id,
    completeness,
    freshness,
    documentation_coverage,
    consistency,
    missing_fields,
    blocking_issues,
    calculation_version,
    computed_at
  )
  SELECT
    v_owner_organization_id,
    p_product_id,
    COALESCE(v_product.data_completion, 0),
    v_freshness,
    CASE
      WHEN v_certification_count + v_data_point_count = 0 THEN 0
      ELSE round(((v_documented_data_point_count + v_documented_certification_count)::NUMERIC / (v_certification_count + v_data_point_count)) * 100, 2)
    END,
    v_consistency,
    v_missing_fields,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object('rule_key', rule_key, 'severity', severity, 'message', message))
      FROM data_quality_issues
      WHERE owner_organization_id = v_owner_organization_id
        AND subject_id = p_product_id
        AND severity = 'blocking'
        AND status IN ('open', 'acknowledged')
    ), '[]'::jsonb),
    p_calculation_version,
    now()
  RETURNING * INTO v_score;

  RETURN v_score;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Issue acknowledgement and waiver
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_acknowledge_quality_issue(p_issue_id UUID)
RETURNS data_quality_issues
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_issue data_quality_issues;
BEGIN
  SELECT * INTO v_issue
  FROM data_quality_issues
  WHERE id = p_issue_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'quality_issue_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_issue.owner_organization_id,
    ARRAY['owner', 'admin', 'manager', 'auditor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'quality_issue_review_role_required';
  END IF;

  UPDATE data_quality_issues
  SET status = 'acknowledged',
      acknowledged_at = now(),
      acknowledged_by = auth.uid()
  WHERE id = p_issue_id
  RETURNING * INTO v_issue;

  RETURN v_issue;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_waive_quality_issue(
  p_issue_id UUID,
  p_reason TEXT
)
RETURNS data_quality_issues
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_issue data_quality_issues;
BEGIN
  IF length(trim(COALESCE(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'quality_issue_waiver_reason_required';
  END IF;

  SELECT * INTO v_issue
  FROM data_quality_issues
  WHERE id = p_issue_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'quality_issue_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_issue.owner_organization_id,
    ARRAY['owner', 'admin']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'quality_issue_waive_role_required';
  END IF;

  UPDATE data_quality_issues
  SET status = 'waived',
      details = details || jsonb_build_object('waiver_reason', trim(p_reason), 'waived_by', auth.uid(), 'waived_at', now()),
      resolved_at = NULL,
      resolved_by = NULL
  WHERE id = p_issue_id
  RETURNING * INTO v_issue;

  RETURN v_issue;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. RLS and privileges
-- -----------------------------------------------------------------------------

ALTER TABLE data_quality_issues ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS quality_insert_owner ON data_quality_scores;
DROP POLICY IF EXISTS quality_select_authorized ON data_quality_scores;
CREATE POLICY quality_select_authorized ON data_quality_scores
  FOR SELECT TO authenticated USING (
    tracefab_can_access_org(owner_organization_id)
    OR (
      supplier_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM suppliers s
        WHERE s.id = data_quality_scores.supplier_id
          AND tracefab_can_access_shared_subject(s.organization_id, 'supplier', s.id)
      )
    )
  );

CREATE POLICY quality_issues_select_owner ON data_quality_issues
  FOR SELECT TO authenticated USING (tracefab_can_access_org(owner_organization_id));

-- No direct INSERT/UPDATE policy: issue creation is computed and issue actions
-- go through acknowledgement/waiver functions.

REVOKE EXECUTE ON FUNCTION tracefab_validate_quality_issue_subject() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_quality_issues_set_updated_at() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_upsert_quality_issue(UUID, UUID, UUID, TEXT, TEXT, quality_issue_severity, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_compute_supplier_quality(UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_compute_product_quality(UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_acknowledge_quality_issue(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_waive_quality_issue(UUID, TEXT) FROM PUBLIC;

GRANT SELECT ON data_quality_issues TO authenticated;
GRANT EXECUTE ON FUNCTION tracefab_compute_supplier_quality(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION tracefab_compute_product_quality(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION tracefab_acknowledge_quality_issue(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION tracefab_waive_quality_issue(UUID, TEXT) TO authenticated;

COMMENT ON TABLE data_quality_issues IS 'Explainable, versioned quality findings. An issue is not a certification result.';
COMMENT ON TABLE data_quality_scores IS 'Append-only quality score snapshots. Scores describe data readiness and quality dimensions, not truth or compliance.';
COMMENT ON COLUMN data_quality_scores.consistency IS 'Rule-based consistency score; it does not mean an external verifier confirmed the data.';
COMMENT ON FUNCTION tracefab_compute_supplier_quality(UUID, TEXT) IS 'Computes an explainable supplier score and current quality issues.';
COMMENT ON FUNCTION tracefab_compute_product_quality(UUID, TEXT) IS 'Computes an explainable product score and current quality issues.';
