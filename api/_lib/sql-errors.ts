type SqlErrorDefinition = {
  status: number;
  message?: string;
};

const DEFINITIONS: Record<string, SqlErrorDefinition> = {
  authentication_required: { status: 401 },
  brand_admin_role_required: { status: 403 },
  brand_organization_required: { status: 400 },
  valid_supplier_email_required: { status: 400 },
  supplier_legal_name_required: { status: 400 },
  hashed_invitation_token_required: { status: 400 },
  active_supplier_invitation_exists: { status: 409 },
  invalid_or_expired_invitation: { status: 400 },
  invitation_email_mismatch: { status: 403 },
  user_already_member: { status: 409 },
  supplier_not_found: { status: 404 },
  supplier_profile_role_required: { status: 403 },
  supplier_profile_status_does_not_allow_submission: { status: 409 },
  brand_product_role_required: { status: 403 },
  brand_product_manager_role_required: { status: 403 },
  product_not_found: { status: 404 },
  product_identifier_not_found: { status: 404 },
  product_material_not_found: { status: 404 },
  material_not_found: { status: 404 },
  material_owner_role_required: { status: 403 },
  material_not_shared_with_product_brand: { status: 403 },
  invalid_material: { status: 400 },
  invalid_product_identifier: { status: 400 },
  invalid_material_percentage: { status: 400 },
  invalid_product_material: { status: 400 },
  product_material_version_must_match_current_product_version: { status: 409 },
  brand_data_request_role_required: { status: 403 },
  active_brand_supplier_relationship_required: { status: 409 },
  request_product_brand_mismatch: { status: 400 },
  data_request_not_found: { status: 404 },
  data_request_item_not_found: { status: 404 },
  data_response_not_found: { status: 404 },
  data_request_items_locked_after_send: { status: 409 },
  data_request_not_draft: { status: 409 },
  data_request_requires_items: { status: 422 },
  data_request_not_accepting_responses: { status: 409 },
  supplier_response_role_required: { status: 403 },
  response_value_required: { status: 400 },
  required_data_request_items_incomplete: { status: 422 },
  data_request_not_submittable: { status: 409 },
  unsupported_review_status: { status: 400 },
  only_current_response_can_be_reviewed: { status: 409 },
  data_request_not_reviewable: { status: 409 },
  reviewer_role_required: { status: 403 },
  quality_calculation_version_required: { status: 400 },
  supplier_quality_access_denied: { status: 403 },
  product_quality_access_denied: { status: 403 },
  quality_issue_not_found: { status: 404 },
  quality_issue_review_role_required: { status: 403 },
  quality_issue_waive_role_required: { status: 403 },
  quality_issue_waiver_reason_required: { status: 422 },
};

/**
 * Convert a deliberately small, stable set of PostgreSQL business exceptions
 * into API responses. Raw database error messages are never returned because
 * they can contain implementation details or values from a failed query.
 */
export function sqlBusinessError(error: unknown): { status: number; error: string } | null {
  const message = error instanceof Error ? error.message : String(error);
  const code = Object.keys(DEFINITIONS).find((candidate) => message.includes(candidate));
  if (code) return { status: DEFINITIONS[code].status, error: code };

  if (message.includes('supplier_profile_incomplete')) {
    return { status: 422, error: 'supplier_profile_incomplete' };
  }

  return null;
}
