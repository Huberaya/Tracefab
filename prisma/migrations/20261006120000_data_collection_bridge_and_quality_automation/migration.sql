-- Migration: 20261006120000_data_collection_bridge_and_quality_automation
--
-- Chantier 2: Data Collection Bridge to Data Points & Quality Automation
--
-- 1. Update tracefab_validate_subject_ownership to allow authorized brand-supplier
--    partnerships and accessible documents on data points and certifications.
-- 2. Update tracefab_review_data_response to:
--    a) Automatically bridge verified responses into data_points with product_id,
--       version increment and supersedes_id lineage.
--    b) Automatically recalculate product quality (tracefab_compute_product_quality)
--       when a data request is approved.

CREATE OR REPLACE FUNCTION tracefab_validate_subject_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'data_points' THEN
    -- Supplier validation: owner must match or have active brand-supplier relationship
    IF NEW.supplier_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM suppliers s
      WHERE s.id = NEW.supplier_id
        AND (
          s.organization_id = NEW.owner_organization_id
          OR EXISTS (
            SELECT 1 FROM brand_supplier_relationships r
            WHERE r.supplier_organization_id = s.organization_id
              AND r.brand_organization_id = NEW.owner_organization_id
              AND r.status = 'active'
          )
        )
    ) THEN
      RAISE EXCEPTION 'supplier_owner_mismatch';
    END IF;

    -- Supplier site validation: owner must match or have active brand-supplier relationship
    IF NEW.supplier_site_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM supplier_sites ss
      JOIN suppliers s ON s.id = ss.supplier_id
      WHERE ss.id = NEW.supplier_site_id
        AND (
          s.organization_id = NEW.owner_organization_id
          OR EXISTS (
            SELECT 1 FROM brand_supplier_relationships r
            WHERE r.supplier_organization_id = s.organization_id
              AND r.brand_organization_id = NEW.owner_organization_id
              AND r.status = 'active'
          )
        )
    ) THEN
      RAISE EXCEPTION 'supplier_site_owner_mismatch';
    END IF;

    -- Product validation: owner must be the brand owning the product
    IF NEW.product_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM tracefab_products p
      WHERE p.id = NEW.product_id AND p.brand_organization_id = NEW.owner_organization_id
    ) THEN
      RAISE EXCEPTION 'product_owner_mismatch';
    END IF;

    -- Material validation: owner must match or belong to an active supplier partner
    IF NEW.material_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM materials m
      WHERE m.id = NEW.material_id
        AND (
          m.owner_organization_id = NEW.owner_organization_id
          OR EXISTS (
            SELECT 1 FROM brand_supplier_relationships r
            WHERE r.supplier_organization_id = m.owner_organization_id
              AND r.brand_organization_id = NEW.owner_organization_id
              AND r.status = 'active'
          )
        )
    ) THEN
      RAISE EXCEPTION 'material_owner_mismatch';
    END IF;

    -- Source document validation: either same owner or document authorized for tenant
    IF NEW.source_document_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = NEW.source_document_id
        AND (
          d.owner_organization_id = NEW.owner_organization_id
          OR tracefab_can_access_document(d.id)
        )
    ) THEN
      RAISE EXCEPTION 'source_document_owner_mismatch';
    END IF;
  ELSE
    -- Certifications validation
    IF NEW.supplier_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM suppliers s
      WHERE s.id = NEW.supplier_id
        AND (
          s.organization_id = NEW.owner_organization_id
          OR EXISTS (
            SELECT 1 FROM brand_supplier_relationships r
            WHERE r.supplier_organization_id = s.organization_id
              AND r.brand_organization_id = NEW.owner_organization_id
              AND r.status = 'active'
          )
        )
    ) THEN
      RAISE EXCEPTION 'supplier_owner_mismatch';
    END IF;

    IF NEW.supplier_site_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM supplier_sites ss
      JOIN suppliers s ON s.id = ss.supplier_id
      WHERE ss.id = NEW.supplier_site_id
        AND (
          s.organization_id = NEW.owner_organization_id
          OR EXISTS (
            SELECT 1 FROM brand_supplier_relationships r
            WHERE r.supplier_organization_id = s.organization_id
              AND r.brand_organization_id = NEW.owner_organization_id
              AND r.status = 'active'
          )
        )
    ) THEN
      RAISE EXCEPTION 'supplier_site_owner_mismatch';
    END IF;

    IF NEW.product_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM tracefab_products p
      WHERE p.id = NEW.product_id AND p.brand_organization_id = NEW.owner_organization_id
    ) THEN
      RAISE EXCEPTION 'product_owner_mismatch';
    END IF;

    IF NEW.document_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = NEW.document_id
        AND (
          d.owner_organization_id = NEW.owner_organization_id
          OR tracefab_can_access_document(d.id)
        )
    ) THEN
      RAISE EXCEPTION 'document_owner_mismatch';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- 2. Enhanced review function bridging responses to data_points and triggering quality
CREATE OR REPLACE FUNCTION tracefab_review_data_response(
  p_data_response_id UUID,
  p_status data_value_status,
  p_review_comment TEXT DEFAULT NULL
)
RETURNS data_responses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_response data_responses;
  v_item data_request_items;
  v_request data_requests;
  v_required_count INTEGER;
  v_accepted_count INTEGER;
  v_is_approved BOOLEAN := false;
  v_supplier_id UUID;
  v_point_id UUID;
  v_point_version INTEGER := 1;
  v_prior_point_id UUID := NULL;
  v_point_status data_value_status;
BEGIN
  IF p_status NOT IN ('verified_by_reviewer', 'needs_review') THEN
    RAISE EXCEPTION 'unsupported_review_status';
  END IF;

  SELECT dr.* INTO v_response
  FROM data_responses dr
  WHERE dr.id = p_data_response_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'data_response_not_found';
  END IF;

  SELECT i.* INTO v_item
  FROM data_request_items i
  WHERE i.id = v_response.data_request_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'data_request_item_not_found';
  END IF;

  SELECT r.* INTO v_request
  FROM data_requests r
  WHERE r.id = v_item.data_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'data_request_not_found';
  END IF;

  IF NOT v_response.is_current THEN
    RAISE EXCEPTION 'only_current_response_can_be_reviewed';
  END IF;

  IF v_request.status NOT IN ('in_progress', 'submitted', 'changes_requested') THEN
    RAISE EXCEPTION 'data_request_not_reviewable';
  END IF;

  IF NOT tracefab_has_org_role(
    v_request.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'auditor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'reviewer_role_required';
  END IF;

  UPDATE data_responses
  SET status = p_status,
      review_comment = NULLIF(trim(p_review_comment), ''),
      reviewed_at = now(),
      reviewed_by = tracefab_current_user_id()
  WHERE id = p_data_response_id
  RETURNING * INTO v_response;

  PERFORM set_config('tracefab.internal_data_collection_update', 'true', false);

  UPDATE data_request_items
  SET status = CASE
    WHEN p_status = 'verified_by_reviewer' THEN 'accepted'::data_request_item_status
    ELSE 'needs_review'::data_request_item_status
  END
  WHERE id = v_item.id;

  IF p_status = 'needs_review' THEN
    PERFORM set_config('tracefab.internal_data_collection_update', 'true', false);

    UPDATE data_requests
    SET status = 'changes_requested',
        reviewed_at = now(),
        reviewed_by = tracefab_current_user_id(),
        last_activity_at = now()
    WHERE id = v_request.id;

    PERFORM set_config('tracefab.internal_data_collection_update', 'false', false);
  ELSE
    -- -------------------------------------------------------------
    -- 1. BRIDGE COLLECTE -> DATA POINTS
    -- -------------------------------------------------------------
    SELECT s.id INTO v_supplier_id
    FROM suppliers s
    WHERE s.organization_id = v_request.supplier_organization_id
    LIMIT 1;

    v_point_status := 'verified_by_reviewer'::data_value_status;

    IF v_request.product_id IS NOT NULL THEN
      -- Look for existing data point for this product and key to maintain version chain
      SELECT dp.id, dp.version INTO v_prior_point_id, v_point_version
      FROM data_points dp
      WHERE dp.product_id = v_request.product_id
        AND dp.data_key = v_item.field_key
      ORDER BY dp.version DESC
      LIMIT 1;

      IF FOUND THEN
        v_point_version := v_point_version + 1;
      ELSE
        v_point_version := 1;
        v_prior_point_id := NULL;
      END IF;

      INSERT INTO data_points (
        owner_organization_id,
        supplier_id,
        product_id,
        data_key,
        value,
        data_type,
        status,
        source_document_id,
        declared_by,
        valid_from,
        valid_until,
        version,
        supersedes_id
      ) VALUES (
        v_request.brand_organization_id,
        v_supplier_id,
        v_request.product_id,
        v_item.field_key,
        v_response.value,
        v_response.data_type,
        v_point_status,
        v_response.source_document_id,
        COALESCE(v_response.responded_by, tracefab_current_user_id()),
        CURRENT_DATE,
        CURRENT_DATE + INTERVAL '1 year',
        v_point_version,
        v_prior_point_id
      )
      RETURNING id INTO v_point_id;

      PERFORM tracefab_refresh_product_data_readiness(v_request.product_id);
    ELSIF v_supplier_id IS NOT NULL THEN
      -- Supplier-level data point
      SELECT dp.id, dp.version INTO v_prior_point_id, v_point_version
      FROM data_points dp
      WHERE dp.supplier_id = v_supplier_id
        AND dp.product_id IS NULL
        AND dp.data_key = v_item.field_key
      ORDER BY dp.version DESC
      LIMIT 1;

      IF FOUND THEN
        v_point_version := v_point_version + 1;
      ELSE
        v_point_version := 1;
        v_prior_point_id := NULL;
      END IF;

      INSERT INTO data_points (
        owner_organization_id,
        supplier_id,
        product_id,
        data_key,
        value,
        data_type,
        status,
        source_document_id,
        declared_by,
        valid_from,
        valid_until,
        version,
        supersedes_id
      ) VALUES (
        v_request.supplier_organization_id,
        v_supplier_id,
        NULL,
        v_item.field_key,
        v_response.value,
        v_response.data_type,
        v_point_status,
        v_response.source_document_id,
        COALESCE(v_response.responded_by, tracefab_current_user_id()),
        CURRENT_DATE,
        CURRENT_DATE + INTERVAL '1 year',
        v_point_version,
        v_prior_point_id
      )
      RETURNING id INTO v_point_id;
    END IF;

    -- -------------------------------------------------------------
    -- 2. REQUEST APPROVAL CHECK & QUALITY AUTOMATION
    -- -------------------------------------------------------------
    SELECT
      COUNT(*) FILTER (WHERE i.required),
      COUNT(*) FILTER (WHERE i.required AND i.status = 'accepted')
    INTO v_required_count, v_accepted_count
    FROM data_request_items i
    WHERE i.data_request_id = v_request.id;

    v_is_approved := (
      (v_required_count > 0 AND v_required_count = v_accepted_count)
      OR (
        v_required_count = 0
        AND (SELECT COUNT(*) FROM data_request_items WHERE data_request_id = v_request.id) > 0
        AND (SELECT COUNT(*) FILTER (WHERE status <> 'accepted') FROM data_request_items WHERE data_request_id = v_request.id) = 0
      )
    );

    PERFORM set_config('tracefab.internal_data_collection_update', 'true', false);

    UPDATE data_requests
    SET status = CASE
          WHEN v_is_approved THEN 'approved'::data_request_status
          ELSE status
        END,
        reviewed_at = now(),
        reviewed_by = tracefab_current_user_id(),
        closed_at = CASE
          WHEN v_is_approved THEN now()
          ELSE closed_at
        END,
        last_activity_at = now()
    WHERE id = v_request.id;

    PERFORM set_config('tracefab.internal_data_collection_update', 'false', false);

    -- Automatic recomputation of product or supplier quality upon request approval
    IF v_is_approved THEN
      IF v_request.product_id IS NOT NULL THEN
        PERFORM tracefab_compute_product_quality(v_request.product_id, 'product_quality_v1');
      ELSIF v_supplier_id IS NOT NULL THEN
        PERFORM tracefab_compute_supplier_quality(v_supplier_id, 'supplier_quality_v1');
      END IF;
    END IF;
  END IF;

  RETURN v_response;
END;
$$;

REVOKE EXECUTE ON FUNCTION tracefab_review_data_response(UUID, data_value_status, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_review_data_response(UUID, data_value_status, TEXT) TO PUBLIC;

COMMENT ON FUNCTION tracefab_review_data_response(UUID, data_value_status, TEXT) IS 'Brand review transition with automatic data point creation and product quality recomputation upon approval.';
