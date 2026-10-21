-- Least-privilege EXECUTE grants for the TraceFab application runtime.
--
-- The bootstrap previously granted EXECUTE on every function in public and
-- added the same grant to default privileges. This left all 117 current
-- SECURITY DEFINER functions callable by tracefab_app, including trigger-only
-- and nested helpers. PUBLIC was already denied EXECUTE on SECURITY DEFINER
-- functions; this migration narrows the named runtime role as well.
--
-- Allowlist source: direct SQL calls in api/ plus all functions referenced by
-- RLS policy expressions. Keep synchronized with
-- scripts/lib/tracefab_runtime_functions.mjs. New runtime calls must update
-- both lists and pass CI. Never grant EXECUTE globally.

BEGIN;
SET LOCAL search_path = pg_catalog;

DO $runtime_function_acl$
DECLARE
  runtime_names text[] := ARRAY[
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
    'tracefab_create_data_request',
    'tracefab_create_dpp_identity',
    'tracefab_create_material',
    'tracefab_create_organization',
    'tracefab_create_product',
    'tracefab_create_quality_cap',
    'tracefab_create_supply_chain_node',
    'tracefab_current_user_email',
    'tracefab_current_user_id',
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
    'tracefab_is_org_member',
    'tracefab_link_dpp_claim_evidence',
    'tracefab_mark_dpp_ready_to_publish',
    'tracefab_material_is_public',
    'tracefab_material_visible_via_product',
    'tracefab_product_is_public',
    'tracefab_public_brand',
    'tracefab_public_context',
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
    'tracefab_supplier_site_is_public',
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
    'tracefab_waive_quality_issue'
  ]::text[];
  owner_oid oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user);
  app_oid oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app');
  invalid_names text;
  missing_policy_names text;
  f record;
  extra_grants text;
  missing_grants text;
  public_secdef_count integer;
BEGIN
  IF app_oid IS NULL THEN
    RAISE EXCEPTION 'Runtime EXECUTE hardening refused: role tracefab_app is absent'
      USING ERRCODE = '42704';
  END IF;

  -- Every allowlisted name must resolve to exactly one function owned by the
  -- migration owner. Ambiguity or drift stops the migration before revocation.
  SELECT string_agg(w.name, ', ' ORDER BY w.name)
    INTO invalid_names
    FROM unnest(runtime_names) AS w(name)
    LEFT JOIN pg_catalog.pg_proc p
      ON p.proname = w.name AND p.prokind = 'f'
    LEFT JOIN pg_catalog.pg_namespace n
      ON n.oid = p.pronamespace AND n.nspname = 'public'
   GROUP BY w.name
  HAVING count(p.oid) FILTER (WHERE n.oid IS NOT NULL) <> 1
      OR bool_or(p.proowner <> owner_oid) FILTER (WHERE n.oid IS NOT NULL);

  IF invalid_names IS NOT NULL THEN
    RAISE EXCEPTION 'Runtime EXECUTE allowlist has missing, overloaded or foreign-owned functions: %', invalid_names
      USING ERRCODE = '42883';
  END IF;

  -- The RLS catalogue is an independent source of truth. Every TraceFab
  -- function called by USING/WITH CHECK must be explicitly allowlisted.
  WITH policy_bodies AS (
    SELECT pg_catalog.coalesce(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' ||
           pg_catalog.coalesce(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), '') AS body
      FROM pg_catalog.pg_policy pol
      JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
  ), policy_functions AS (
    SELECT DISTINCT (m.matches)[1] AS name
      FROM policy_bodies b
      CROSS JOIN LATERAL pg_catalog.regexp_matches(b.body, '(tracefab_[a-z0-9_]+)[[:space:]]*\\(', 'g') AS m(matches)
  )
  SELECT string_agg(name, ', ' ORDER BY name)
    INTO missing_policy_names
    FROM policy_functions
   WHERE NOT (name = ANY(runtime_names));

  IF missing_policy_names IS NOT NULL THEN
    RAISE EXCEPTION 'Runtime EXECUTE allowlist omits RLS policy functions: %', missing_policy_names
      USING ERRCODE = '42501';
  END IF;

  -- Remove direct grants from all application-owned functions. Extension-owned
  -- functions are deliberately untouched: this migration cannot alter objects
  -- owned by cloud_admin and their PUBLIC grants are outside TraceFab RLS.
  FOR f IN
    SELECT p.oid::pg_catalog.regprocedure AS signature
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND p.proowner = owner_oid
  LOOP
    EXECUTE pg_catalog.format('REVOKE EXECUTE ON FUNCTION %s FROM tracefab_app', f.signature);
  END LOOP;

  -- Close the schema-level default EXECUTE grant so future functions do not
  -- silently become callable by the runtime.
  EXECUTE pg_catalog.format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM tracefab_app',
    current_user
  );

  -- Grant only the direct runtime/RLS allowlist.
  FOR f IN
    SELECT p.oid::pg_catalog.regprocedure AS signature
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND p.proowner = owner_oid
       AND p.proname = ANY(runtime_names)
  LOOP
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO tracefab_app', f.signature);
  END LOOP;

  -- Verify no direct grant remains on an application-owned function outside
  -- the allowlist, and every allowlisted function is executable by the role.
  SELECT string_agg(p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')', ', ' ORDER BY p.proname)
    INTO extra_grants
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
   WHERE n.nspname = 'public'
     AND p.prokind = 'f'
     AND p.proowner = owner_oid
     AND acl.grantee = app_oid
     AND acl.privilege_type = 'EXECUTE'
     AND NOT (p.proname = ANY(runtime_names));

  IF extra_grants IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected direct EXECUTE grants remain for tracefab_app: %', extra_grants
      USING ERRCODE = '42501';
  END IF;

  SELECT string_agg(w.name, ', ' ORDER BY w.name)
    INTO missing_grants
    FROM unnest(runtime_names) AS w(name)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.prokind = 'f'
        AND p.proowner = owner_oid
        AND p.proname = w.name
        AND pg_catalog.has_function_privilege('tracefab_app', p.oid, 'EXECUTE')
   );

  IF missing_grants IS NOT NULL THEN
    RAISE EXCEPTION 'Runtime EXECUTE grants missing after hardening: %', missing_grants
      USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::integer
    INTO public_secdef_count
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
   WHERE n.nspname = 'public'
     AND p.prosecdef
     AND p.proowner = owner_oid
     AND acl.grantee = 0
     AND acl.privilege_type = 'EXECUTE';

  IF public_secdef_count <> 0 THEN
    RAISE EXCEPTION 'SECURITY DEFINER functions still executable by PUBLIC: %', public_secdef_count
      USING ERRCODE = '42501';
  END IF;
END
$runtime_function_acl$;

COMMIT;
