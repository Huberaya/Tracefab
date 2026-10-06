-- Migration: 20261006200000_document_ai_automated_verification
-- Chantier 1: IA Documentaire — Extraction forensique & vérification automatisée des preuves

CREATE OR REPLACE FUNCTION tracefab_apply_document_ai_verification(
  p_document_id UUID,
  p_status verification_status,
  p_method TEXT,
  p_notes TEXT,
  p_standard_key TEXT,
  p_standard_name TEXT,
  p_standard_code TEXT,
  p_certificate_number TEXT,
  p_issuer_name TEXT,
  p_issued_at DATE,
  p_expires_at DATE,
  p_confidence NUMERIC,
  p_extraction_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_doc documents%ROWTYPE;
  v_cert_id UUID;
  v_verification_id UUID;
  v_certs_updated INTEGER := 0;
  v_supplier_id UUID;
  v_cert_status data_value_status;
  v_payload JSONB;
BEGIN
  v_user_id := tracefab_current_user_id();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;

  SELECT * INTO v_doc
  FROM documents
  WHERE id = p_document_id AND status <> 'deleted';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found';
  END IF;

  -- Validate caller has access to document
  IF NOT tracefab_can_access_document(p_document_id) THEN
    RAISE EXCEPTION 'document_access_denied';
  END IF;

  -- 1. Determine certification status based on AI verification decision
  IF p_status = 'passed' THEN
    v_cert_status := 'verified_by_reviewer'::data_value_status;
  ELSIF p_status = 'expired' THEN
    v_cert_status := 'expired'::data_value_status;
  ELSE
    v_cert_status := 'needs_review'::data_value_status;
  END IF;

  -- 2. Update documents metadata and expires_at
  PERFORM set_config('tracefab.internal_document_update', 'true', true);

  UPDATE documents
  SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'ai_verification', p_extraction_payload,
        'ai_verified_at', now(),
        'ai_verified_by', v_user_id,
        'ai_status', p_status::text,
        'ai_confidence', p_confidence
      ),
      expires_at = COALESCE(p_expires_at, expires_at),
      updated_at = now()
  WHERE id = p_document_id;

  PERFORM set_config('tracefab.internal_document_update', 'false', true);

  -- 3. Check if there is an associated certification
  SELECT id INTO v_cert_id
  FROM certifications
  WHERE document_id = p_document_id
  LIMIT 1;

  -- 4. Insert into verification_records
  INSERT INTO verification_records (
    owner_organization_id,
    document_id,
    certification_id,
    method,
    status,
    notes,
    verified_by,
    verified_at,
    created_at
  )
  VALUES (
    v_doc.owner_organization_id,
    p_document_id,
    v_cert_id,
    trim(COALESCE(p_method, 'ai_document_forensics_v1')),
    p_status,
    p_notes,
    v_user_id,
    now(),
    now()
  )
  RETURNING id INTO v_verification_id;

  -- 5. If associated certifications exist, update their status and extracted metadata
  PERFORM set_config('tracefab.internal_certification_update', 'true', true);

  UPDATE certifications
  SET standard_name = COALESCE(NULLIF(trim(p_standard_name), ''), standard_name),
      standard_code = COALESCE(NULLIF(trim(p_standard_code), ''), standard_code),
      issuer_name = COALESCE(NULLIF(trim(p_issuer_name), ''), issuer_name),
      certificate_number = COALESCE(NULLIF(trim(p_certificate_number), ''), certificate_number),
      issued_at = COALESCE(p_issued_at, issued_at),
      expires_at = COALESCE(p_expires_at, expires_at),
      status = v_cert_status,
      last_verified_at = now(),
      last_verified_by = v_user_id,
      updated_at = now()
  WHERE document_id = p_document_id;

  GET DIAGNOSTICS v_certs_updated = ROW_COUNT;

  PERFORM set_config('tracefab.internal_certification_update', 'false', true);

  -- 6. Quality issues synchronization
  SELECT id INTO v_supplier_id
  FROM suppliers
  WHERE organization_id = v_doc.owner_organization_id
  LIMIT 1;

  IF p_status IN ('expired', 'failed') AND v_supplier_id IS NOT NULL THEN
    INSERT INTO data_quality_issues (
      owner_organization_id,
      supplier_id,
      rule_key,
      rule_version,
      severity,
      status,
      message,
      details,
      detected_at
    )
    VALUES (
      v_doc.owner_organization_id,
      v_supplier_id,
      CASE WHEN p_status = 'expired' THEN 'document_ai_certificate_expired' ELSE 'document_ai_verification_failed' END,
      'document_ai_v1',
      'blocking',
      'open',
      COALESCE(p_notes, 'Preuve documentaire rejetée par l''IA.'),
      p_extraction_payload,
      now()
    );
  ELSIF p_status = 'passed' AND v_supplier_id IS NOT NULL THEN
    UPDATE data_quality_issues
    SET status = 'resolved',
        resolved_at = now(),
        resolved_by = v_user_id
    WHERE owner_organization_id = v_doc.owner_organization_id
      AND supplier_id = v_supplier_id
      AND rule_key IN ('document_ai_certificate_expired', 'document_ai_verification_failed')
      AND status = 'open';
  END IF;

  v_payload := jsonb_build_object(
    'document_id', p_document_id,
    'verification_record_id', v_verification_id,
    'status', p_status::text,
    'certifications_updated', v_certs_updated,
    'confidence', p_confidence,
    'verified_at', now()
  );

  RETURN v_payload;
END;
$$;

REVOKE EXECUTE ON FUNCTION tracefab_apply_document_ai_verification(UUID, verification_status, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DATE, DATE, NUMERIC, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_apply_document_ai_verification(UUID, verification_status, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DATE, DATE, NUMERIC, JSONB) TO PUBLIC;

COMMENT ON FUNCTION tracefab_apply_document_ai_verification(UUID, verification_status, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DATE, DATE, NUMERIC, JSONB) IS 'Applies AI document extraction, creates an immutable verification record, synchronizes linked certifications and resolves or flags quality issues.';
