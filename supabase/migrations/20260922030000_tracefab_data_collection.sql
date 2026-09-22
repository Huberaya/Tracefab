-- Tracefab Chantier 4 — Data Collection
--
-- Implements the first request / response workflow on top of the core model.
-- A response may be declared or documented before it is reviewed. Review status
-- is deliberately separate from the existence of a value or document.

-- -----------------------------------------------------------------------------
-- 1. Request, item and response metadata
-- -----------------------------------------------------------------------------

ALTER TABLE data_requests
  ADD COLUMN IF NOT EXISTS relationship_id UUID REFERENCES brand_supplier_relationships(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS completion_percentage NUMERIC(5,2) NOT NULL DEFAULT 0
    CHECK (completion_percentage BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE data_request_items
  ADD COLUMN IF NOT EXISTS help_text TEXT,
  ADD COLUMN IF NOT EXISTS validation_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS evidence_kinds TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE data_responses
  ADD COLUMN IF NOT EXISTS response_version INTEGER NOT NULL DEFAULT 1
    CHECK (response_version > 0),
  ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS review_comment TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_brand_idempotency
  ON data_requests(brand_organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_requests_relationship_status
  ON data_requests(relationship_id, status, last_activity_at DESC);

CREATE INDEX IF NOT EXISTS idx_request_items_required_status
  ON data_request_items(data_request_id, required, status);

-- Normalize legacy response rows before adding the current-response invariant.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY data_request_item_id
      ORDER BY submitted_at ASC, id ASC
    ) AS response_version,
    row_number() OVER (
      PARTITION BY data_request_item_id
      ORDER BY submitted_at DESC, id DESC
    ) AS reverse_rank
  FROM data_responses
)
UPDATE data_responses r
SET response_version = ranked.response_version,
    is_current = (ranked.reverse_rank = 1)
FROM ranked
WHERE r.id = ranked.id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_responses_current_item
  ON data_responses(data_request_item_id)
  WHERE is_current = true;

CREATE INDEX IF NOT EXISTS idx_responses_item_version
  ON data_responses(data_request_item_id, response_version DESC);

-- -----------------------------------------------------------------------------
-- 2. Request integrity and progress computation
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_validate_data_request_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_brand_type organization_type;
  v_supplier_type organization_type;
  v_product_brand UUID;
BEGIN
  SELECT type INTO v_brand_type
  FROM organizations
  WHERE id = NEW.brand_organization_id;

  SELECT type INTO v_supplier_type
  FROM organizations
  WHERE id = NEW.supplier_organization_id;

  IF v_brand_type IS DISTINCT FROM 'brand'::organization_type
     OR v_supplier_type IS DISTINCT FROM 'supplier'::organization_type THEN
    RAISE EXCEPTION 'data_request_requires_brand_and_supplier';
  END IF;

  IF NEW.relationship_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM brand_supplier_relationships r
    WHERE r.id = NEW.relationship_id
      AND r.brand_organization_id = NEW.brand_organization_id
      AND r.supplier_organization_id = NEW.supplier_organization_id
  ) THEN
    RAISE EXCEPTION 'data_request_relationship_mismatch';
  END IF;

  IF NEW.product_id IS NOT NULL THEN
    SELECT p.brand_organization_id INTO v_product_brand
    FROM tracefab_products p
    WHERE p.id = NEW.product_id;

    IF v_product_brand IS NULL OR v_product_brand <> NEW.brand_organization_id THEN
      RAISE EXCEPTION 'data_request_product_brand_mismatch';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND (
    OLD.brand_organization_id IS DISTINCT FROM NEW.brand_organization_id
    OR OLD.supplier_organization_id IS DISTINCT FROM NEW.supplier_organization_id
    OR OLD.relationship_id IS DISTINCT FROM NEW.relationship_id
  ) THEN
    RAISE EXCEPTION 'data_request_participants_are_immutable';
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER data_requests_validate_integrity
    BEFORE INSERT OR UPDATE ON data_requests
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_data_request_integrity();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION tracefab_validate_data_request_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       OLD.status IS DISTINCT FROM NEW.status
       OR OLD.completion_percentage IS DISTINCT FROM NEW.completion_percentage
       OR OLD.submitted_at IS DISTINCT FROM NEW.submitted_at
       OR OLD.closed_at IS DISTINCT FROM NEW.closed_at
       OR OLD.reviewed_at IS DISTINCT FROM NEW.reviewed_at
       OR OLD.reviewed_by IS DISTINCT FROM NEW.reviewed_by
       OR OLD.last_activity_at IS DISTINCT FROM NEW.last_activity_at
     )
     AND COALESCE(current_setting('tracefab.internal_data_collection_update', true), 'false') <> 'true' THEN
    RAISE EXCEPTION 'workflow_request_fields_are_not_client_writable';
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER data_requests_validate_mutation
    BEFORE UPDATE ON data_requests
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_data_request_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION tracefab_validate_data_response_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item data_request_items;
  v_supplier_organization_id UUID;
  v_document_owner UUID;
BEGIN
  SELECT i.*
  INTO v_item
  FROM data_request_items i
  WHERE i.id = NEW.data_request_item_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'data_request_item_not_found';
  END IF;

  SELECT r.supplier_organization_id
  INTO v_supplier_organization_id
  FROM data_requests r
  WHERE r.id = v_item.data_request_id;

  IF v_supplier_organization_id IS NULL THEN
    RAISE EXCEPTION 'data_request_not_found';
  END IF;

  IF NEW.data_type <> v_item.data_type THEN
    RAISE EXCEPTION 'response_data_type_mismatch';
  END IF;

  IF NEW.source_document_id IS NOT NULL THEN
    SELECT d.owner_organization_id INTO v_document_owner
    FROM documents d
    WHERE d.id = NEW.source_document_id;

    IF v_document_owner IS NULL OR v_document_owner <> v_supplier_organization_id THEN
      RAISE EXCEPTION 'response_document_supplier_mismatch';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER data_responses_validate_integrity
    BEFORE INSERT OR UPDATE ON data_responses
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_data_response_integrity();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION tracefab_validate_data_request_item_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.data_request_id IS DISTINCT FROM NEW.data_request_id THEN
    RAISE EXCEPTION 'request_item_request_is_immutable';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status IS DISTINCT FROM NEW.status
     AND COALESCE(current_setting('tracefab.internal_data_collection_update', true), 'false') <> 'true' THEN
    RAISE EXCEPTION 'request_item_workflow_status_is_not_client_writable';
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER request_items_validate_mutation
    BEFORE UPDATE ON data_request_items
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_data_request_item_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION tracefab_refresh_data_request_progress(p_request_id UUID)
RETURNS NUMERIC(5,2)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_required_count INTEGER;
  v_answered_count INTEGER;
  v_completion NUMERIC(5,2);
BEGIN
  SELECT
    COUNT(*) FILTER (WHERE i.required),
    COUNT(*) FILTER (
      WHERE i.required AND EXISTS (
        SELECT 1 FROM data_responses dr
        WHERE dr.data_request_item_id = i.id
          AND dr.is_current = true
      )
    )
  INTO v_required_count, v_answered_count
  FROM data_request_items i
  WHERE i.data_request_id = p_request_id;

  IF v_required_count = 0 THEN
    v_completion := 0;
  ELSE
    v_completion := round((v_answered_count::NUMERIC / v_required_count) * 100, 2);
  END IF;

  PERFORM set_config('tracefab.internal_data_collection_update', 'true', true);

  UPDATE data_requests
  SET completion_percentage = v_completion,
      last_activity_at = now()
  WHERE id = p_request_id;

  PERFORM set_config('tracefab.internal_data_collection_update', 'false', true);
  RETURN v_completion;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_refresh_request_progress_from_item()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM tracefab_refresh_data_request_progress(OLD.data_request_id);
    RETURN OLD;
  END IF;

  PERFORM tracefab_refresh_data_request_progress(NEW.data_request_id);
  IF TG_OP = 'UPDATE' AND OLD.data_request_id IS DISTINCT FROM NEW.data_request_id THEN
    PERFORM tracefab_refresh_data_request_progress(OLD.data_request_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_refresh_request_progress_from_response()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT i.data_request_id INTO v_request_id
    FROM data_request_items i
    WHERE i.id = OLD.data_request_item_id;
  ELSE
    SELECT i.data_request_id INTO v_request_id
    FROM data_request_items i
    WHERE i.id = NEW.data_request_item_id;
  END IF;

  IF v_request_id IS NOT NULL THEN
    PERFORM tracefab_refresh_data_request_progress(v_request_id);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER request_items_refresh_progress
    AFTER INSERT OR UPDATE OR DELETE ON data_request_items
    FOR EACH ROW EXECUTE FUNCTION tracefab_refresh_request_progress_from_item();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER data_responses_refresh_progress
    AFTER INSERT OR UPDATE OR DELETE ON data_responses
    FOR EACH ROW EXECUTE FUNCTION tracefab_refresh_request_progress_from_response();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- 3. Request and response workflow functions
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_create_data_request(
  p_brand_organization_id UUID,
  p_supplier_organization_id UUID,
  p_product_id UUID,
  p_title TEXT,
  p_questionnaire_key TEXT,
  p_questionnaire_version TEXT,
  p_due_at TIMESTAMPTZ DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS data_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request data_requests;
  v_relationship_id UUID;
  v_idempotency_key TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;

  IF NOT tracefab_has_org_role(
    p_brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'brand_data_request_role_required';
  END IF;

  v_idempotency_key := NULLIF(trim(COALESCE(p_idempotency_key, '')), '');

  IF v_idempotency_key IS NOT NULL THEN
    SELECT r.* INTO v_request
    FROM data_requests r
    WHERE r.brand_organization_id = p_brand_organization_id
      AND r.idempotency_key = v_idempotency_key;
    IF FOUND THEN
      RETURN v_request;
    END IF;
  END IF;

  SELECT r.id INTO v_relationship_id
  FROM brand_supplier_relationships r
  WHERE r.brand_organization_id = p_brand_organization_id
    AND r.supplier_organization_id = p_supplier_organization_id
    AND r.status = 'active';

  IF v_relationship_id IS NULL THEN
    RAISE EXCEPTION 'active_brand_supplier_relationship_required';
  END IF;

  IF p_product_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tracefab_products p
    WHERE p.id = p_product_id
      AND p.brand_organization_id = p_brand_organization_id
  ) THEN
    RAISE EXCEPTION 'request_product_brand_mismatch';
  END IF;

  INSERT INTO data_requests (
    brand_organization_id,
    supplier_organization_id,
    relationship_id,
    product_id,
    title,
    questionnaire_key,
    questionnaire_version,
    status,
    due_at,
    idempotency_key,
    created_by,
    last_activity_at
  )
  VALUES (
    p_brand_organization_id,
    p_supplier_organization_id,
    v_relationship_id,
    p_product_id,
    trim(p_title),
    trim(p_questionnaire_key),
    trim(p_questionnaire_version),
    'draft',
    p_due_at,
    v_idempotency_key,
    auth.uid(),
    now()
  )
  RETURNING * INTO v_request;

  RETURN v_request;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_add_data_request_item(
  p_data_request_id UUID,
  p_field_key TEXT,
  p_label TEXT,
  p_data_type data_type,
  p_required BOOLEAN DEFAULT false,
  p_evidence_required BOOLEAN DEFAULT false,
  p_help_text TEXT DEFAULT NULL,
  p_validation_rules JSONB DEFAULT '{}'::jsonb,
  p_evidence_kinds TEXT[] DEFAULT '{}'
)
RETURNS data_request_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request data_requests;
  v_item data_request_items;
BEGIN
  SELECT * INTO v_request
  FROM data_requests
  WHERE id = p_data_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'data_request_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_request.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'brand_data_request_role_required';
  END IF;

  IF v_request.status <> 'draft' THEN
    RAISE EXCEPTION 'data_request_items_locked_after_send';
  END IF;

  INSERT INTO data_request_items (
    data_request_id,
    field_key,
    label,
    data_type,
    required,
    evidence_required,
    help_text,
    validation_rules,
    evidence_kinds,
    sort_order
  )
  VALUES (
    p_data_request_id,
    trim(p_field_key),
    trim(p_label),
    p_data_type,
    p_required,
    p_evidence_required,
    NULLIF(trim(p_help_text), ''),
    COALESCE(p_validation_rules, '{}'::jsonb),
    COALESCE(p_evidence_kinds, '{}'::TEXT[]),
    (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM data_request_items WHERE data_request_id = p_data_request_id)
  )
  RETURNING * INTO v_item;

  RETURN v_item;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_send_data_request(p_data_request_id UUID)
RETURNS data_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request data_requests;
BEGIN
  SELECT * INTO v_request
  FROM data_requests
  WHERE id = p_data_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'data_request_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_request.brand_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'brand_data_request_role_required';
  END IF;

  IF v_request.status <> 'draft' THEN
    RAISE EXCEPTION 'data_request_not_draft';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM data_request_items i WHERE i.data_request_id = p_data_request_id) THEN
    RAISE EXCEPTION 'data_request_requires_items';
  END IF;

  PERFORM set_config('tracefab.internal_data_collection_update', 'true', true);

  UPDATE data_requests
  SET status = 'sent',
      last_activity_at = now()
  WHERE id = p_data_request_id
  RETURNING * INTO v_request;

  PERFORM set_config('tracefab.internal_data_collection_update', 'false', true);

  RETURN v_request;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_submit_data_response(
  p_data_request_item_id UUID,
  p_value JSONB,
  p_source_document_id UUID DEFAULT NULL
)
RETURNS data_responses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item data_request_items;
  v_request data_requests;
  v_previous_response data_responses;
  v_response data_responses;
  v_next_version INTEGER;
  v_status data_value_status;
BEGIN
  SELECT i.* INTO v_item
  FROM data_request_items i
  WHERE i.id = p_data_request_item_id
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

  IF NOT tracefab_has_org_role(
    v_request.supplier_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'supplier_response_role_required';
  END IF;

  IF v_request.status NOT IN ('sent', 'in_progress', 'changes_requested') THEN
    RAISE EXCEPTION 'data_request_not_accepting_responses';
  END IF;

  IF p_value IS NULL THEN
    RAISE EXCEPTION 'response_value_required';
  END IF;

  SELECT * INTO v_previous_response
  FROM data_responses
  WHERE data_request_item_id = p_data_request_item_id
    AND is_current = true
  FOR UPDATE;

  v_next_version := COALESCE(v_previous_response.response_version, 0) + 1;
  v_status := CASE
    WHEN p_source_document_id IS NULL THEN 'declared'::data_value_status
    ELSE 'documented'::data_value_status
  END;

  IF v_previous_response.id IS NOT NULL THEN
    UPDATE data_responses
    SET is_current = false
    WHERE id = v_previous_response.id;
  END IF;

  INSERT INTO data_responses (
    data_request_item_id,
    value,
    data_type,
    status,
    source_document_id,
    responded_by,
    supersedes_id,
    response_version,
    is_current,
    submitted_at
  )
  VALUES (
    p_data_request_item_id,
    p_value,
    v_item.data_type,
    v_status,
    p_source_document_id,
    auth.uid(),
    v_previous_response.id,
    v_next_version,
    true,
    now()
  )
  RETURNING * INTO v_response;

  PERFORM set_config('tracefab.internal_data_collection_update', 'true', true);

  UPDATE data_request_items
  SET status = 'answered'
  WHERE id = p_data_request_item_id;

  UPDATE data_requests
  SET status = 'in_progress',
      last_activity_at = now()
  WHERE id = v_request.id
    AND status IN ('sent', 'changes_requested');

  PERFORM set_config('tracefab.internal_data_collection_update', 'false', true);
  RETURN v_response;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_submit_data_request(p_data_request_id UUID)
RETURNS data_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request data_requests;
  v_required_count INTEGER;
  v_answered_count INTEGER;
BEGIN
  SELECT * INTO v_request
  FROM data_requests
  WHERE id = p_data_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'data_request_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_request.supplier_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'supplier_response_role_required';
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE i.required),
    COUNT(*) FILTER (
      WHERE i.required AND EXISTS (
        SELECT 1 FROM data_responses dr
        WHERE dr.data_request_item_id = i.id
          AND dr.is_current = true
          AND dr.status NOT IN ('needs_review', 'expired')
      )
    )
  INTO v_required_count, v_answered_count
  FROM data_request_items i
  WHERE i.data_request_id = p_data_request_id;

  IF v_required_count = 0 OR v_answered_count <> v_required_count THEN
    RAISE EXCEPTION 'required_data_request_items_incomplete';
  END IF;

  IF v_request.status NOT IN ('sent', 'in_progress', 'changes_requested') THEN
    RAISE EXCEPTION 'data_request_not_submittable';
  END IF;

  PERFORM set_config('tracefab.internal_data_collection_update', 'true', true);

  UPDATE data_requests
  SET status = 'submitted',
      submitted_at = now(),
      last_activity_at = now()
  WHERE id = p_data_request_id
  RETURNING * INTO v_request;

  PERFORM set_config('tracefab.internal_data_collection_update', 'false', true);
  RETURN v_request;
END;
$$;

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
      reviewed_by = auth.uid()
  WHERE id = p_data_response_id
  RETURNING * INTO v_response;

  PERFORM set_config('tracefab.internal_data_collection_update', 'true', true);

  UPDATE data_request_items
  SET status = CASE
    WHEN p_status = 'verified_by_reviewer' THEN 'accepted'::data_request_item_status
    ELSE 'needs_review'::data_request_item_status
  END
  WHERE id = v_item.id;

  IF p_status = 'needs_review' THEN
    PERFORM set_config('tracefab.internal_data_collection_update', 'true', true);

    UPDATE data_requests
    SET status = 'changes_requested',
        reviewed_at = now(),
        reviewed_by = auth.uid(),
        last_activity_at = now()
    WHERE id = v_request.id;

    PERFORM set_config('tracefab.internal_data_collection_update', 'false', true);
  ELSE
    SELECT
      COUNT(*) FILTER (WHERE i.required),
      COUNT(*) FILTER (WHERE i.required AND i.status = 'accepted')
    INTO v_required_count, v_accepted_count
    FROM data_request_items i
    WHERE i.data_request_id = v_request.id;

    PERFORM set_config('tracefab.internal_data_collection_update', 'true', true);

    UPDATE data_requests
    SET status = CASE
          WHEN v_required_count > 0 AND v_required_count = v_accepted_count THEN 'approved'::data_request_status
          ELSE status
        END,
        reviewed_at = now(),
        reviewed_by = auth.uid(),
        closed_at = CASE
          WHEN v_required_count > 0 AND v_required_count = v_accepted_count THEN now()
          ELSE closed_at
        END,
        last_activity_at = now()
    WHERE id = v_request.id;

    PERFORM set_config('tracefab.internal_data_collection_update', 'false', true);
  END IF;

  RETURN v_response;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. RLS hardening for the workflow
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS requests_select_participant ON data_requests;
CREATE POLICY requests_select_participant ON data_requests
  FOR SELECT TO authenticated USING (
    tracefab_is_org_member(brand_organization_id)
    OR (tracefab_is_org_member(supplier_organization_id) AND status <> 'draft')
  );

DROP POLICY IF EXISTS requests_insert_brand ON data_requests;
CREATE POLICY requests_insert_brand ON data_requests
  FOR INSERT TO authenticated WITH CHECK (
    status = 'draft'
    AND created_by = auth.uid()
    AND tracefab_has_org_role(brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    AND EXISTS (
      SELECT 1 FROM brand_supplier_relationships r
      WHERE r.id = data_requests.relationship_id
        AND r.brand_organization_id = data_requests.brand_organization_id
        AND r.supplier_organization_id = data_requests.supplier_organization_id
        AND r.status = 'active'
    )
    AND (product_id IS NULL OR EXISTS (
      SELECT 1 FROM tracefab_products p
      WHERE p.id = data_requests.product_id
        AND p.brand_organization_id = data_requests.brand_organization_id
    ))
  );

DROP POLICY IF EXISTS requests_update_participant ON data_requests;
CREATE POLICY requests_update_brand ON data_requests
  FOR UPDATE TO authenticated USING (
    status = 'draft'
    AND tracefab_has_org_role(brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
  ) WITH CHECK (
    status = 'draft'
    AND tracefab_has_org_role(brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
  );

DROP POLICY IF EXISTS request_items_select_participant ON data_request_items;
CREATE POLICY request_items_select_participant ON data_request_items
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM data_requests r
      WHERE r.id = data_request_items.data_request_id
        AND (
          tracefab_is_org_member(r.brand_organization_id)
          OR (tracefab_is_org_member(r.supplier_organization_id) AND r.status <> 'draft')
        )
    )
  );

DROP POLICY IF EXISTS request_items_insert_brand ON data_request_items;
CREATE POLICY request_items_insert_brand ON data_request_items
  FOR INSERT TO authenticated WITH CHECK (
    status = 'pending'
    AND EXISTS (
      SELECT 1 FROM data_requests r
      WHERE r.id = data_request_items.data_request_id
        AND r.status = 'draft'
        AND tracefab_has_org_role(r.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    )
  );

DROP POLICY IF EXISTS request_items_update_participant ON data_request_items;
CREATE POLICY request_items_update_brand ON data_request_items
  FOR UPDATE TO authenticated USING (
    EXISTS (
      SELECT 1 FROM data_requests r
      WHERE r.id = data_request_items.data_request_id
        AND r.status = 'draft'
        AND tracefab_has_org_role(r.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM data_requests r
      WHERE r.id = data_request_items.data_request_id
        AND r.status = 'draft'
        AND tracefab_has_org_role(r.brand_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    )
  );

DROP POLICY IF EXISTS responses_insert_supplier ON data_responses;
DROP POLICY IF EXISTS responses_update_supplier ON data_responses;

-- Responses are inserted and reviewed only through the workflow functions.
-- There is intentionally no authenticated INSERT or UPDATE policy here.

-- -----------------------------------------------------------------------------
-- 5. Function privileges and documentation
-- -----------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION tracefab_validate_data_request_integrity() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_validate_data_response_integrity() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_validate_data_request_item_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_refresh_data_request_progress(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_refresh_request_progress_from_item() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_refresh_request_progress_from_response() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_create_data_request(UUID, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_add_data_request_item(UUID, TEXT, TEXT, data_type, BOOLEAN, BOOLEAN, TEXT, JSONB, TEXT[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_send_data_request(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_submit_data_response(UUID, JSONB, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_submit_data_request(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_review_data_response(UUID, data_value_status, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION tracefab_create_data_request(UUID, UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION tracefab_add_data_request_item(UUID, TEXT, TEXT, data_type, BOOLEAN, BOOLEAN, TEXT, JSONB, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION tracefab_send_data_request(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION tracefab_submit_data_response(UUID, JSONB, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION tracefab_submit_data_request(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION tracefab_review_data_response(UUID, data_value_status, TEXT) TO authenticated;

COMMENT ON COLUMN data_requests.completion_percentage IS 'Required-item response completion. It measures collection progress, not data quality.';
COMMENT ON COLUMN data_responses.is_current IS 'Only one response revision per item may be current.';
COMMENT ON FUNCTION tracefab_submit_data_response(UUID, JSONB, UUID) IS 'Creates a new supplier response revision and supersedes the previous current response.';
COMMENT ON FUNCTION tracefab_review_data_response(UUID, data_value_status, TEXT) IS 'Brand-side review transition. Verified means reviewer-verified, not third-party certification.';
