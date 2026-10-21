/**
 * Explicit SQL-function allowlist for the TraceFab HTTP runtime.
 *
 * API_RUNTIME_FUNCTION_NAMES is extracted from direct SQL calls in api/.
 * RLS_POLICY_FUNCTION_NAMES is the set referenced by pg_policies USING/WITH CHECK.
 * Keep RUNTIME_FUNCTION_NAMES synchronized with the SQL migration. New direct
 * calls or policy helpers must update this file and the migration, then pass CI.
 */
export const API_RUNTIME_FUNCTION_NAMES = Object.freeze([
  'tracefab_accept_organization_invitation',
  'tracefab_acknowledge_quality_issue',
  'tracefab_add_data_request_item',
  'tracefab_add_dpp_claim',
  'tracefab_add_dpp_event',
  'tracefab_add_product_identifier',
  'tracefab_add_product_material',
  'tracefab_add_supply_chain_link',
  'tracefab_allocate_tc_quantity',
  'tracefab_apply_document_ai_verification',
  'tracefab_audit_product_green_claims',
  'tracefab_bind_schema',
  'tracefab_calculate_product_pef',
  'tracefab_can_access_document',
  'tracefab_can_access_org',
  'tracefab_can_access_shared_subject',
  'tracefab_claim_notification_outbox',
  'tracefab_complete_notification_outbox',
  'tracefab_compute_dpp_readiness',
  'tracefab_compute_product_quality',
  'tracefab_compute_supplier_quality',
  'tracefab_create_data_request',
  'tracefab_create_dpp_identity',
  'tracefab_create_material',
  'tracefab_create_organization',
  'tracefab_create_product',
  'tracefab_create_quality_cap',
  'tracefab_create_supply_chain_node',
  'tracefab_delete_supply_chain_link',
  'tracefab_delete_supply_chain_node',
  'tracefab_enqueue_due_data_request_reminders',
  'tracefab_enqueue_manual_data_request_reminder',
  'tracefab_finalize_document_upload',
  'tracefab_get_or_create_supplier_passport',
  'tracefab_get_product_traceability',
  'tracefab_get_public_supplier_passport',
  'tracefab_has_org_role',
  'tracefab_in_active_tenant',
  'tracefab_ingest_plm_erp_payload',
  'tracefab_invite_supplier',
  'tracefab_link_dpp_claim_evidence',
  'tracefab_mark_dpp_ready_to_publish',
  'tracefab_public_brand',
  'tracefab_public_dpp_claims',
  'tracefab_reconcile_mass_balance',
  'tracefab_register_certification',
  'tracefab_register_document',
  'tracefab_register_supplier_organization',
  'tracefab_register_transaction_certificate',
  'tracefab_replace_dpp_identity',
  'tracefab_request_passport_access',
  'tracefab_review_data_response',
  'tracefab_review_passport_access',
  'tracefab_review_quality_remediation',
  'tracefab_revoke_clerk_membership',
  'tracefab_send_data_request',
  'tracefab_set_dpp_publication',
  'tracefab_start_product_revision',
  'tracefab_submit_data_request',
  'tracefab_submit_data_response',
  'tracefab_submit_quality_remediation',
  'tracefab_submit_supplier_profile',
  'tracefab_sync_clerk_membership',
  'tracefab_sync_clerk_organization',
  'tracefab_update_certification',
  'tracefab_update_material',
  'tracefab_update_product_data',
  'tracefab_update_product_identifier',
  'tracefab_update_product_material',
  'tracefab_update_supplier_passport',
  'tracefab_update_supplier_profile',
  'tracefab_update_supply_chain_link',
  'tracefab_update_supply_chain_node',
  'tracefab_waive_quality_issue',
]);

export const RLS_POLICY_FUNCTION_NAMES = Object.freeze([
  'tracefab_can_access_document',
  'tracefab_can_access_org',
  'tracefab_can_access_shared_subject',
  'tracefab_current_user_email',
  'tracefab_current_user_id',
  'tracefab_has_org_role',
  'tracefab_is_org_member',
  'tracefab_material_is_public',
  'tracefab_material_visible_via_product',
  'tracefab_product_is_public',
  'tracefab_public_context',
  'tracefab_supplier_site_is_public',
]);

export const RUNTIME_FUNCTION_DEPENDENCY_NAMES = Object.freeze([
  // tracefab_require_active_tenant is SECURITY INVOKER and calls this
  // context reader; the caller must retain EXECUTE on the transitive helper.
  'tracefab_active_organization_id',
  // Tenant predicate exercised by the active-tenant contract probe; it must
  // remain callable by the runtime but is not referenced by pg_policies.
  // Contract guard used by the active-tenant runtime probe; it returns only
  // the armed tenant UUID or fails closed with organization_id_required.
  'tracefab_require_active_tenant',
]);

export const RUNTIME_FUNCTION_NAMES = Object.freeze(
  [...new Set([
    ...API_RUNTIME_FUNCTION_NAMES,
    ...RLS_POLICY_FUNCTION_NAMES,
    ...RUNTIME_FUNCTION_DEPENDENCY_NAMES,
  ])].sort(),
);
