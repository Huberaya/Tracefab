-- Harden the only path that can make a private document available.
--
-- Quota totals must include rejected and soft-deleted objects, but the user-facing
-- documents SELECT policy intentionally hides deleted rows. This narrowly scoped
-- aggregate runs as the privileged migration owner, refuses to run if RLS would
-- filter its query, and checks the active tenant role before returning totals.
-- Fail at migration time rather than install an aggregate that would later
-- silently undercount when invoked by tracefab_app.
DO $require_document_quota_owner$
DECLARE
  owner_can_bypass_rls BOOLEAN;
BEGIN
  SELECT rolsuper OR rolbypassrls INTO owner_can_bypass_rls
  FROM pg_roles
  WHERE rolname = current_user;

  IF NOT COALESCE(owner_can_bypass_rls, false) THEN
    RAISE EXCEPTION 'document_storage_usage_requires_bypassrls_migration_owner';
  END IF;
END
$require_document_quota_owner$;

CREATE OR REPLACE FUNCTION tracefab_get_document_storage_usage(p_organization_id UUID)
RETURNS TABLE(used_bytes BIGINT, doc_count BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF tracefab_current_user_id() IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;

  IF NOT tracefab_has_org_role(
    p_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'document_upload_role_required';
  END IF;

  RETURN QUERY
  SELECT COALESCE(SUM(d.byte_size), 0)::BIGINT, COUNT(*)::BIGINT
  FROM documents AS d
  WHERE d.owner_organization_id = p_organization_id;
END;
$$;

REVOKE ALL ON FUNCTION tracefab_get_document_storage_usage(UUID) FROM PUBLIC;
DO $grant_document_quota$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app') THEN
    GRANT EXECUTE ON FUNCTION tracefab_get_document_storage_usage(UUID) TO tracefab_app;
  END IF;
END
$grant_document_quota$;

COMMENT ON FUNCTION tracefab_get_document_storage_usage(UUID) IS
  'Returns only aggregate storage totals, including rejected and soft-deleted objects, after checking the current tenant membership.';

-- The finalizer replaces the existing SECURITY DEFINER function. CREATE OR
-- REPLACE preserves its ACL, which was transferred to tracefab_app and revoked
-- from PUBLIC by 20261014130000_revoke_public_schema_privileges.
CREATE OR REPLACE FUNCTION tracefab_finalize_document_upload(
  p_document_id UUID,
  p_sha256 TEXT,
  p_scan_passed BOOLEAN,
  p_actual_byte_size BIGINT
)
RETURNS documents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_document documents;
BEGIN
  IF tracefab_current_user_id() IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;

  SELECT * INTO v_document
  FROM documents
  WHERE id = p_document_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_document.owner_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'document_finalize_role_required';
  END IF;

  IF v_document.status NOT IN ('uploaded', 'scanning') THEN
    RAISE EXCEPTION 'document_not_in_scannable_state';
  END IF;

  IF p_scan_passed IS NULL THEN
    RAISE EXCEPTION 'document_scan_result_required';
  END IF;

  IF p_actual_byte_size IS NULL OR p_actual_byte_size < 0 THEN
    RAISE EXCEPTION 'document_size_limit_exceeded';
  END IF;

  IF p_scan_passed AND p_actual_byte_size > 52428800 THEN
    RAISE EXCEPTION 'document_size_limit_exceeded';
  END IF;

  IF p_scan_passed AND p_actual_byte_size <> v_document.byte_size THEN
    RAISE EXCEPTION 'document_size_mismatch';
  END IF;

  IF p_scan_passed AND COALESCE(p_sha256, '') !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'sha256_required_for_available_document';
  END IF;

  PERFORM set_config('tracefab.internal_document_update', 'true', true);

  UPDATE documents
  SET sha256 = NULLIF(trim(p_sha256), ''),
      byte_size = p_actual_byte_size,
      status = CASE WHEN p_scan_passed THEN 'available'::document_status ELSE 'rejected'::document_status END,
      available_at = CASE WHEN p_scan_passed THEN now() ELSE NULL END,
      metadata = (COALESCE(metadata, '{}'::jsonb) - ARRAY['security_scan', 'scan_passed', 'sha256', 'antivirus', 'isEncryptedAtRest']::text[])
                 || jsonb_build_object('scan_passed', p_scan_passed)
  WHERE id = p_document_id
  RETURNING * INTO v_document;

  PERFORM set_config('tracefab.internal_document_update', 'false', true);
  RETURN v_document;
END;
$$;

-- Owners must be able to list/retry their own uploaded and rejected records.
-- Cross-tenant shares remain limited to available documents through
-- tracefab_can_access_document; soft-deleted rows stay hidden.
DROP POLICY IF EXISTS documents_select_authorized ON documents;
CREATE POLICY documents_select_authorized ON documents
  FOR SELECT TO PUBLIC USING (
    status <> 'deleted'
    AND (
      tracefab_can_access_org(owner_organization_id)
      OR tracefab_can_access_document(id)
    )
  );
