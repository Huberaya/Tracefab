-- Keep the workflow mutation guard visible to SECURITY DEFINER trigger functions.

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

  PERFORM set_config('tracefab.internal_data_collection_update', 'true', false);

  UPDATE data_requests
  SET status = 'sent',
      last_activity_at = now()
  WHERE id = p_data_request_id
  RETURNING * INTO v_request;

  PERFORM set_config('tracefab.internal_data_collection_update', 'false', false);

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
    tracefab_current_user_id(),
    v_previous_response.id,
    v_next_version,
    true,
    now()
  )
  RETURNING * INTO v_response;

  PERFORM set_config('tracefab.internal_data_collection_update', 'true', false);

  UPDATE data_request_items
  SET status = 'answered'
  WHERE id = p_data_request_item_id;

  UPDATE data_requests
  SET status = 'in_progress',
      last_activity_at = now()
  WHERE id = v_request.id
    AND status IN ('sent', 'changes_requested');

  PERFORM set_config('tracefab.internal_data_collection_update', 'false', false);
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

  PERFORM set_config('tracefab.internal_data_collection_update', 'true', false);

  UPDATE data_requests
  SET status = 'submitted',
      submitted_at = now(),
      last_activity_at = now()
  WHERE id = p_data_request_id
  RETURNING * INTO v_request;

  PERFORM set_config('tracefab.internal_data_collection_update', 'false', false);
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
    SELECT
      COUNT(*) FILTER (WHERE i.required),
      COUNT(*) FILTER (WHERE i.required AND i.status = 'accepted')
    INTO v_required_count, v_accepted_count
    FROM data_request_items i
    WHERE i.data_request_id = v_request.id;

    PERFORM set_config('tracefab.internal_data_collection_update', 'true', false);

    UPDATE data_requests
    SET status = CASE
          WHEN v_required_count > 0 AND v_required_count = v_accepted_count THEN 'approved'::data_request_status
          ELSE status
        END,
        reviewed_at = now(),
        reviewed_by = tracefab_current_user_id(),
        closed_at = CASE
          WHEN v_required_count > 0 AND v_required_count = v_accepted_count THEN now()
          ELSE closed_at
        END,
        last_activity_at = now()
    WHERE id = v_request.id;

    PERFORM set_config('tracefab.internal_data_collection_update', 'false', false);
  END IF;

  RETURN v_response;
END;
$$;
