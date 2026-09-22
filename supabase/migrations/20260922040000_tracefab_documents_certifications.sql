-- Tracefab Chantier 5 — Documents and Certifications
--
-- Adds private Storage registration, controlled document lifecycle and a
-- certification / verification workflow. A document is evidence metadata; its
-- presence never proves that the underlying claim is true.

-- -----------------------------------------------------------------------------
-- 1. Private document storage and metadata
-- -----------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('tracefab-private', 'tracefab-private', false, 52428800)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = 52428800;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_documents_storage_lookup
  ON documents(storage_bucket, storage_path, status);

CREATE INDEX IF NOT EXISTS idx_documents_owner_kind
  ON documents(owner_organization_id, kind, status);

CREATE OR REPLACE FUNCTION tracefab_validate_document_location()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.storage_bucket <> 'tracefab-private' THEN
    RAISE EXCEPTION 'tracefab_private_bucket_required';
  END IF;

  IF NEW.storage_path !~ ('^' || NEW.owner_organization_id::TEXT || '/[^/].*$')
     OR NEW.storage_path ~ '(^|/)\.\.(/|$)' THEN
    RAISE EXCEPTION 'document_path_must_be_tenant_scoped';
  END IF;

  IF NEW.visibility <> 'private' THEN
    RAISE EXCEPTION 'documents_are_private_in_chantier_5';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.status <> 'uploaded' THEN
    RAISE EXCEPTION 'new_documents_must_start_uploaded';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.owner_organization_id IS DISTINCT FROM NEW.owner_organization_id
       OR OLD.storage_bucket IS DISTINCT FROM NEW.storage_bucket
       OR OLD.storage_path IS DISTINCT FROM NEW.storage_path THEN
      RAISE EXCEPTION 'document_storage_identity_is_immutable';
    END IF;

    IF (
      OLD.status IS DISTINCT FROM NEW.status
      OR OLD.byte_size IS DISTINCT FROM NEW.byte_size
      OR OLD.sha256 IS DISTINCT FROM NEW.sha256
      OR OLD.uploaded_by IS DISTINCT FROM NEW.uploaded_by
      OR OLD.available_at IS DISTINCT FROM NEW.available_at
      OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
      OR OLD.deleted_by IS DISTINCT FROM NEW.deleted_by
    )
    AND COALESCE(current_setting('tracefab.internal_document_update', true), 'false') <> 'true' THEN
      RAISE EXCEPTION 'managed_document_fields_are_not_client_writable';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER documents_validate_location
    BEFORE INSERT OR UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_document_location();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION tracefab_documents_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER documents_set_updated_at
    BEFORE UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION tracefab_documents_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION tracefab_register_document(
  p_owner_organization_id UUID,
  p_storage_path TEXT,
  p_original_filename TEXT,
  p_content_type TEXT,
  p_byte_size BIGINT,
  p_sha256 TEXT,
  p_kind document_kind,
  p_expires_at DATE DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS documents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_document documents;
  v_path TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;

  IF NOT tracefab_has_org_role(
    p_owner_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'document_upload_role_required';
  END IF;

  v_path := trim(p_storage_path);
  IF v_path = '' OR v_path !~ ('^' || p_owner_organization_id::TEXT || '/[^/].*$')
     OR v_path ~ '(^|/)\.\.(/|$)' THEN
    RAISE EXCEPTION 'document_path_must_be_tenant_scoped';
  END IF;

  IF p_byte_size < 0 OR p_byte_size > 52428800 THEN
    RAISE EXCEPTION 'document_size_limit_exceeded';
  END IF;

  IF length(trim(COALESCE(p_original_filename, ''))) = 0
     OR length(trim(COALESCE(p_content_type, ''))) = 0 THEN
    RAISE EXCEPTION 'document_metadata_required';
  END IF;

  SELECT * INTO v_document
  FROM documents d
  WHERE d.storage_bucket = 'tracefab-private'
    AND d.storage_path = v_path;

  IF FOUND THEN
    IF v_document.owner_organization_id <> p_owner_organization_id
       OR v_document.uploaded_by <> auth.uid()
       OR v_document.status = 'deleted' THEN
      RAISE EXCEPTION 'document_path_already_registered';
    END IF;
    RETURN v_document;
  END IF;

  INSERT INTO documents (
    owner_organization_id,
    storage_bucket,
    storage_path,
    original_filename,
    content_type,
    byte_size,
    sha256,
    kind,
    status,
    visibility,
    expires_at,
    uploaded_by,
    metadata
  )
  VALUES (
    p_owner_organization_id,
    'tracefab-private',
    v_path,
    trim(p_original_filename),
    trim(p_content_type),
    p_byte_size,
    NULLIF(trim(p_sha256), ''),
    p_kind,
    'uploaded',
    'private',
    p_expires_at,
    auth.uid(),
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING * INTO v_document;

  RETURN v_document;
END;
$$;

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
  SELECT * INTO v_document
  FROM documents
  WHERE id = p_document_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;

  IF v_document.status NOT IN ('uploaded', 'scanning') THEN
    RAISE EXCEPTION 'document_not_in_scannable_state';
  END IF;

  IF p_actual_byte_size < 0 OR p_actual_byte_size > 52428800 THEN
    RAISE EXCEPTION 'document_size_limit_exceeded';
  END IF;

  IF p_scan_passed AND length(trim(COALESCE(p_sha256, ''))) <> 64 THEN
    RAISE EXCEPTION 'sha256_required_for_available_document';
  END IF;

  PERFORM set_config('tracefab.internal_document_update', 'true', true);

  UPDATE documents
  SET sha256 = NULLIF(trim(p_sha256), ''),
      byte_size = p_actual_byte_size,
      status = CASE WHEN p_scan_passed THEN 'available'::document_status ELSE 'rejected'::document_status END,
      available_at = CASE WHEN p_scan_passed THEN now() ELSE NULL END,
      metadata = metadata || jsonb_build_object('scan_passed', p_scan_passed)
  WHERE id = p_document_id
  RETURNING * INTO v_document;

  PERFORM set_config('tracefab.internal_document_update', 'false', true);
  RETURN v_document;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_soft_delete_document(p_document_id UUID)
RETURNS documents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_document documents;
BEGIN
  SELECT * INTO v_document
  FROM documents
  WHERE id = p_document_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_document.owner_organization_id,
    ARRAY['owner', 'admin', 'manager']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'document_delete_role_required';
  END IF;

  PERFORM set_config('tracefab.internal_document_update', 'true', true);

  UPDATE documents
  SET status = 'deleted',
      deleted_at = now(),
      deleted_by = auth.uid()
  WHERE id = p_document_id
  RETURNING * INTO v_document;

  PERFORM set_config('tracefab.internal_document_update', 'false', true);
  RETURN v_document;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. Certification and verification lifecycle
-- -----------------------------------------------------------------------------

ALTER TABLE certifications
  ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION tracefab_validate_certification_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.status IS DISTINCT FROM NEW.status
     AND COALESCE(current_setting('tracefab.internal_certification_update', true), 'false') <> 'true' THEN
    RAISE EXCEPTION 'certification_status_is_not_client_writable';
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER certifications_validate_mutation
    BEFORE UPDATE ON certifications
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_certification_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION tracefab_register_certification(
  p_owner_organization_id UUID,
  p_supplier_id UUID,
  p_supplier_site_id UUID,
  p_product_id UUID,
  p_standard_name TEXT,
  p_standard_code TEXT,
  p_issuer_name TEXT,
  p_certificate_number TEXT,
  p_issued_at DATE,
  p_expires_at DATE,
  p_document_id UUID
)
RETURNS certifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_certification certifications;
  v_status data_value_status;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;

  IF NOT tracefab_has_org_role(
    p_owner_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'certification_role_required';
  END IF;

  IF length(trim(COALESCE(p_standard_name, ''))) = 0 THEN
    RAISE EXCEPTION 'certification_standard_required';
  END IF;

  IF p_document_id IS NULL THEN
    v_status := 'declared';
  ELSE
    v_status := 'documented';
  END IF;

  INSERT INTO certifications (
    owner_organization_id,
    supplier_id,
    supplier_site_id,
    product_id,
    standard_name,
    standard_code,
    issuer_name,
    certificate_number,
    issued_at,
    expires_at,
    document_id,
    status,
    created_by
  )
  VALUES (
    p_owner_organization_id,
    p_supplier_id,
    p_supplier_site_id,
    p_product_id,
    trim(p_standard_name),
    NULLIF(trim(p_standard_code), ''),
    NULLIF(trim(p_issuer_name), ''),
    NULLIF(trim(p_certificate_number), ''),
    p_issued_at,
    p_expires_at,
    p_document_id,
    v_status,
    auth.uid()
  )
  RETURNING * INTO v_certification;

  RETURN v_certification;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_update_certification(
  p_certification_id UUID,
  p_standard_name TEXT,
  p_standard_code TEXT,
  p_issuer_name TEXT,
  p_certificate_number TEXT,
  p_issued_at DATE,
  p_expires_at DATE,
  p_document_id UUID
)
RETURNS certifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_certification certifications;
BEGIN
  SELECT * INTO v_certification
  FROM certifications
  WHERE id = p_certification_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'certification_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_certification.owner_organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'certification_role_required';
  END IF;

  IF length(trim(COALESCE(p_standard_name, ''))) = 0 THEN
    RAISE EXCEPTION 'certification_standard_required';
  END IF;

  PERFORM set_config('tracefab.internal_certification_update', 'true', true);

  UPDATE certifications
  SET standard_name = trim(p_standard_name),
      standard_code = NULLIF(trim(p_standard_code), ''),
      issuer_name = NULLIF(trim(p_issuer_name), ''),
      certificate_number = NULLIF(trim(p_certificate_number), ''),
      issued_at = p_issued_at,
      expires_at = p_expires_at,
      document_id = p_document_id,
      status = CASE
        WHEN p_document_id IS NULL THEN 'declared'::data_value_status
        ELSE 'documented'::data_value_status
      END,
      last_verified_at = NULL,
      last_verified_by = NULL
  WHERE id = p_certification_id
  RETURNING * INTO v_certification;

  PERFORM set_config('tracefab.internal_certification_update', 'false', true);
  RETURN v_certification;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_review_certification(
  p_certification_id UUID,
  p_verification_status verification_status,
  p_method TEXT,
  p_notes TEXT,
  p_verifier_organization_id UUID DEFAULT NULL
)
RETURNS certifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_certification certifications;
  v_verifier_type organization_type;
  v_certification_status data_value_status;
BEGIN
  IF p_verification_status NOT IN ('passed', 'failed', 'needs_review', 'expired') THEN
    RAISE EXCEPTION 'unsupported_certification_verification_status';
  END IF;

  IF length(trim(COALESCE(p_method, ''))) = 0 THEN
    RAISE EXCEPTION 'verification_method_required';
  END IF;

  SELECT * INTO v_certification
  FROM certifications
  WHERE id = p_certification_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'certification_not_found';
  END IF;

  IF p_verifier_organization_id IS NULL THEN
    IF NOT tracefab_has_org_role(
      v_certification.owner_organization_id,
      ARRAY['owner', 'admin', 'manager', 'auditor']::membership_role[]
    ) THEN
      RAISE EXCEPTION 'certification_reviewer_role_required';
    END IF;
  ELSE
    SELECT type INTO v_verifier_type
    FROM organizations
    WHERE id = p_verifier_organization_id;

    IF v_verifier_type IS DISTINCT FROM 'verifier'::organization_type
       OR NOT tracefab_has_org_role(
         p_verifier_organization_id,
         ARRAY['owner', 'admin', 'manager', 'auditor']::membership_role[]
       ) THEN
      RAISE EXCEPTION 'third_party_verifier_role_required';
    END IF;
  END IF;

  v_certification_status := CASE
    WHEN p_verification_status = 'passed' AND v_verifier_type = 'verifier'::organization_type
      THEN 'certified_by_third_party'::data_value_status
    WHEN p_verification_status = 'passed'
      THEN 'verified_by_reviewer'::data_value_status
    WHEN p_verification_status = 'expired'
      THEN 'expired'::data_value_status
    ELSE 'needs_review'::data_value_status
  END;

  INSERT INTO verification_records (
    owner_organization_id,
    certification_id,
    verifier_organization_id,
    method,
    status,
    notes,
    verified_by,
    verified_at
  )
  VALUES (
    v_certification.owner_organization_id,
    p_certification_id,
    p_verifier_organization_id,
    trim(p_method),
    p_verification_status,
    p_notes,
    auth.uid(),
    now()
  );

  PERFORM set_config('tracefab.internal_certification_update', 'true', true);

  UPDATE certifications
  SET status = v_certification_status,
      last_verified_at = now(),
      last_verified_by = auth.uid()
  WHERE id = p_certification_id
  RETURNING * INTO v_certification;

  PERFORM set_config('tracefab.internal_certification_update', 'false', true);
  RETURN v_certification;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. RLS and Storage policies
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS documents_select_authorized ON documents;
CREATE POLICY documents_select_authorized ON documents
  FOR SELECT TO authenticated USING (
    status <> 'deleted'
    AND (
      tracefab_can_access_org(owner_organization_id)
      OR (
        status = 'available'
        AND tracefab_can_access_shared_subject(owner_organization_id, 'document', id)
      )
    )
  );

DROP POLICY IF EXISTS documents_insert_owner ON documents;
-- Document rows are registered through tracefab_register_document(...), which
-- enforces the private bucket and tenant-scoped path before object upload.

DROP POLICY IF EXISTS documents_update_owner ON documents;
CREATE POLICY documents_update_metadata_owner ON documents
  FOR UPDATE TO authenticated USING (
    tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
  ) WITH CHECK (
    tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
  );

DROP POLICY IF EXISTS certifications_insert_owner ON certifications;
DROP POLICY IF EXISTS certifications_update_owner ON certifications;
-- Certification creation, edits and review are workflow functions so that
-- status cannot be forged as verified or certified by a client write.

DROP POLICY IF EXISTS verifications_select_authorized ON verification_records;
CREATE POLICY verifications_select_authorized ON verification_records
  FOR SELECT TO authenticated USING (
    tracefab_can_access_org(owner_organization_id)
    OR (verifier_organization_id IS NOT NULL AND tracefab_is_org_member(verifier_organization_id))
    OR (
      certification_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM certifications c
        WHERE c.id = verification_records.certification_id
          AND tracefab_can_access_shared_subject(c.owner_organization_id, 'certification', c.id)
      )
    )
  );

DROP POLICY IF EXISTS verifications_insert_authorized ON verification_records;
DROP POLICY IF EXISTS verifications_update_authorized ON verification_records;
-- Verification records are inserted by tracefab_review_certification(...).

DROP POLICY IF EXISTS storage_tracefab_select ON storage.objects;
CREATE POLICY storage_tracefab_select ON storage.objects
  FOR SELECT TO authenticated USING (
    bucket_id = 'tracefab-private'
    AND EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.storage_bucket = bucket_id
        AND d.storage_path = name
        AND (
          tracefab_can_access_org(d.owner_organization_id)
          OR (
            d.status = 'available'
            AND tracefab_can_access_shared_subject(d.owner_organization_id, 'document', d.id)
          )
        )
    )
  );

DROP POLICY IF EXISTS storage_tracefab_insert ON storage.objects;
CREATE POLICY storage_tracefab_insert ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'tracefab-private'
    AND EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.storage_bucket = bucket_id
        AND d.storage_path = name
        AND d.status = 'uploaded'
        AND d.uploaded_by = auth.uid()
        AND tracefab_has_org_role(d.owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    )
  );

DROP POLICY IF EXISTS storage_tracefab_update ON storage.objects;
CREATE POLICY storage_tracefab_update ON storage.objects
  FOR UPDATE TO authenticated USING (
    bucket_id = 'tracefab-private'
    AND EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.storage_bucket = bucket_id
        AND d.storage_path = name
        AND d.status IN ('uploaded', 'scanning')
        AND d.uploaded_by = auth.uid()
    )
  ) WITH CHECK (
    bucket_id = 'tracefab-private'
    AND EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.storage_bucket = bucket_id
        AND d.storage_path = name
        AND d.status IN ('uploaded', 'scanning')
        AND d.uploaded_by = auth.uid()
    )
  );

-- No direct authenticated DELETE policy: deletion is a soft-delete workflow
-- followed by a trusted Storage cleanup job.
DROP POLICY IF EXISTS storage_tracefab_delete ON storage.objects;

-- -----------------------------------------------------------------------------
-- 4. Function privileges and documentation
-- -----------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION tracefab_validate_document_location() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_documents_set_updated_at() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_register_document(UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, document_kind, DATE, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_finalize_document_upload(UUID, TEXT, BOOLEAN, BIGINT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_soft_delete_document(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_validate_certification_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_register_certification(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, DATE, DATE, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_update_certification(UUID, TEXT, TEXT, TEXT, TEXT, DATE, DATE, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_review_certification(UUID, verification_status, TEXT, TEXT, UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION tracefab_register_document(UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, document_kind, DATE, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION tracefab_soft_delete_document(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION tracefab_finalize_document_upload(UUID, TEXT, BOOLEAN, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION tracefab_register_certification(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, DATE, DATE, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION tracefab_update_certification(UUID, TEXT, TEXT, TEXT, TEXT, DATE, DATE, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION tracefab_review_certification(UUID, verification_status, TEXT, TEXT, UUID) TO authenticated;

COMMENT ON TABLE documents IS 'Private evidence metadata. Storage objects are tenant-scoped and never public by this migration.';
COMMENT ON COLUMN documents.status IS 'Upload and scan lifecycle; available means the trusted scan flow accepted the object, not that its claims are true.';
COMMENT ON TABLE certifications IS 'Supplier/product certification claims with explicit evidence and separate verification records.';
COMMENT ON FUNCTION tracefab_review_certification(UUID, verification_status, TEXT, TEXT, UUID) IS 'Records a verification event and derives verified/certified status without treating document presence as proof.';
