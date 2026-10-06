-- Migration: 20261006180000_supplier_self_onboarding
-- Chantier 6 (P1): Onboarding Fournisseur Autonome (Inscription directe sans crash)

CREATE OR REPLACE FUNCTION tracefab_register_supplier_organization(
  p_legal_name TEXT,
  p_display_name TEXT DEFAULT NULL,
  p_country_code TEXT DEFAULT NULL,
  p_profile_summary TEXT DEFAULT NULL,
  p_contact_name TEXT DEFAULT NULL,
  p_contact_phone TEXT DEFAULT NULL,
  p_activity_types TEXT[] DEFAULT '{}'::TEXT[]
)
RETURNS TABLE (
  organization_id UUID,
  supplier_id UUID,
  membership_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_email TEXT;
  v_org_id UUID;
  v_supplier_id UUID;
  v_membership_id UUID;
BEGIN
  v_user_id := tracefab_current_user_id();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;

  v_email := tracefab_current_user_email();

  IF length(trim(COALESCE(p_legal_name, ''))) = 0 THEN
    RAISE EXCEPTION 'supplier_legal_name_required';
  END IF;

  IF p_country_code IS NOT NULL AND length(trim(p_country_code)) <> 2 THEN
    RAISE EXCEPTION 'invalid_country_code';
  END IF;

  -- 1. Create supplier organization with active status
  INSERT INTO organizations (
    type,
    legal_name,
    display_name,
    country_code,
    status,
    created_by
  )
  VALUES (
    'supplier',
    trim(p_legal_name),
    NULLIF(trim(p_display_name), ''),
    upper(NULLIF(trim(p_country_code), '')),
    'active',
    v_user_id
  )
  RETURNING id INTO v_org_id;

  -- 2. Create organization membership with owner role
  INSERT INTO organization_memberships (
    organization_id,
    user_id,
    role,
    status,
    joined_at
  )
  VALUES (
    v_org_id,
    v_user_id,
    'owner',
    'active',
    now()
  )
  RETURNING id INTO v_membership_id;

  -- 3. Create initial supplier profile
  INSERT INTO suppliers (
    organization_id,
    onboarding_status,
    profile_summary,
    contact_name,
    contact_email,
    contact_phone,
    activity_types,
    last_profile_updated_by
  )
  VALUES (
    v_org_id,
    'in_progress',
    NULLIF(trim(p_profile_summary), ''),
    NULLIF(trim(p_contact_name), ''),
    v_email,
    NULLIF(trim(p_contact_phone), ''),
    COALESCE(p_activity_types, '{}'::TEXT[]),
    v_user_id
  )
  RETURNING id INTO v_supplier_id;

  RETURN QUERY SELECT v_org_id, v_supplier_id, v_membership_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION tracefab_register_supplier_organization(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_register_supplier_organization(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]) TO PUBLIC;

COMMENT ON FUNCTION tracefab_register_supplier_organization(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]) IS 'Allows an authenticated user to autonomously register their supplier organization, create their owner membership, and initialize their supplier profile.';
