-- Re-arm the workflow guard after the item progress trigger runs.

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

  -- The item AFTER trigger recalculates progress and resets the guard.
  PERFORM set_config('tracefab.internal_data_collection_update', 'true', false);

  UPDATE data_requests
  SET status = 'in_progress',
      last_activity_at = now()
  WHERE id = v_request.id
    AND status IN ('sent', 'changes_requested');

  PERFORM set_config('tracefab.internal_data_collection_update', 'false', false);
  RETURN v_response;
END;
$$;
