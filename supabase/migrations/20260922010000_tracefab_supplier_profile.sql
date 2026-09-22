-- Tracefab Chantier 2 — Supplier Profile and invitation onboarding
--
-- This migration adds the first supplier-facing onboarding flow to the core
-- model. Invitation tokens are expected to be generated and hashed by a trusted
-- backend before calling tracefab_invite_supplier. Raw tokens never enter SQL.

-- -----------------------------------------------------------------------------
-- 1. Supplier profile fields and invitation relationship
-- -----------------------------------------------------------------------------

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS profile_summary TEXT,
  ADD COLUMN IF NOT EXISTS contact_name TEXT,
  ADD COLUMN IF NOT EXISTS contact_email TEXT,
  ADD COLUMN IF NOT EXISTS contact_phone TEXT,
  ADD COLUMN IF NOT EXISTS employee_count_range TEXT
    CHECK (employee_count_range IS NULL OR employee_count_range IN ('1_10', '11_50', '51_250', '251_1000', '1001_plus')),
  ADD COLUMN IF NOT EXISTS year_established INTEGER
    CHECK (year_established IS NULL OR year_established BETWEEN 1800 AND 2100),
  ADD COLUMN IF NOT EXISTS profile_completion NUMERIC(5,2) NOT NULL DEFAULT 0
    CHECK (profile_completion BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS last_profile_updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE organization_invitations
  ADD COLUMN IF NOT EXISTS relationship_id UUID REFERENCES brand_supplier_relationships(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_invitations_relationship
  ON organization_invitations(relationship_id, accepted_at, expires_at);

CREATE INDEX IF NOT EXISTS idx_suppliers_onboarding
  ON suppliers(onboarding_status, profile_completion);

-- -----------------------------------------------------------------------------
-- 2. Relationship integrity
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_validate_relationship_organizations()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_brand_type organization_type;
  v_supplier_type organization_type;
BEGIN
  SELECT type INTO v_brand_type
  FROM organizations
  WHERE id = NEW.brand_organization_id;

  SELECT type INTO v_supplier_type
  FROM organizations
  WHERE id = NEW.supplier_organization_id;

  IF v_brand_type IS DISTINCT FROM 'brand'::organization_type
     OR v_supplier_type IS DISTINCT FROM 'supplier'::organization_type THEN
    RAISE EXCEPTION 'relationship_requires_brand_and_supplier_organizations';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_validate_share_relationship()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM brand_supplier_relationships r
    WHERE r.id = NEW.relationship_id
      AND r.supplier_organization_id = NEW.supplier_organization_id
      AND r.brand_organization_id = NEW.grantee_organization_id
  ) THEN
    RAISE EXCEPTION 'share_relationship_mismatch';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_validate_invitation_relationship()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.relationship_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM brand_supplier_relationships r
    WHERE r.id = NEW.relationship_id
      AND r.supplier_organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'invitation_relationship_mismatch';
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER relationships_validate_organizations
    BEFORE INSERT OR UPDATE ON brand_supplier_relationships
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_relationship_organizations();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER shares_validate_relationship
    BEFORE INSERT OR UPDATE ON data_shares
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_share_relationship();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER invitations_validate_relationship
    BEFORE INSERT OR UPDATE ON organization_invitations
    FOR EACH ROW EXECUTE FUNCTION tracefab_validate_invitation_relationship();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- 3. Profile completeness
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_calculate_supplier_profile_completion(p_supplier_id UUID)
RETURNS NUMERIC(5,2)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_organization_id UUID;
  v_legal_name TEXT;
  v_country_code VARCHAR(2);
  v_profile_summary TEXT;
  v_contact_name TEXT;
  v_contact_email TEXT;
  v_activity_types TEXT[];
  v_has_active_site BOOLEAN;
  v_completed INTEGER := 0;
BEGIN
  SELECT
    s.organization_id,
    s.profile_summary,
    s.contact_name,
    s.contact_email,
    s.activity_types,
    EXISTS (
      SELECT 1 FROM supplier_sites ss
      WHERE ss.supplier_id = s.id AND ss.is_active = true
    )
  INTO
    v_organization_id,
    v_profile_summary,
    v_contact_name,
    v_contact_email,
    v_activity_types,
    v_has_active_site
  FROM suppliers s
  WHERE s.id = p_supplier_id;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  SELECT o.legal_name, o.country_code
  INTO v_legal_name, v_country_code
  FROM organizations o
  WHERE o.id = v_organization_id;

  IF length(trim(COALESCE(v_legal_name, ''))) > 0 THEN
    v_completed := v_completed + 1;
  END IF;
  IF v_country_code IS NOT NULL AND length(trim(v_country_code)) = 2 THEN
    v_completed := v_completed + 1;
  END IF;
  IF length(trim(COALESCE(v_profile_summary, ''))) >= 30 THEN
    v_completed := v_completed + 1;
  END IF;
  IF length(trim(COALESCE(v_contact_name, ''))) > 0 THEN
    v_completed := v_completed + 1;
  END IF;
  IF position('@' IN COALESCE(v_contact_email, '')) > 1 THEN
    v_completed := v_completed + 1;
  END IF;
  IF COALESCE(cardinality(v_activity_types), 0) > 0 THEN
    v_completed := v_completed + 1;
  END IF;
  IF v_has_active_site THEN
    v_completed := v_completed + 1;
  END IF;

  RETURN round((v_completed::NUMERIC / 7) * 100, 2);
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_refresh_supplier_profile_completeness(p_supplier_id UUID)
RETURNS NUMERIC(5,2)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_completion NUMERIC(5,2);
BEGIN
  v_completion := tracefab_calculate_supplier_profile_completion(p_supplier_id);

  UPDATE suppliers
  SET profile_completion = v_completion
  WHERE id = p_supplier_id;

  RETURN v_completion;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_refresh_supplier_profile_from_supplier()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM tracefab_refresh_supplier_profile_completeness(NEW.id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_refresh_supplier_profile_from_site()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM tracefab_refresh_supplier_profile_completeness(OLD.supplier_id);
    RETURN OLD;
  END IF;

  PERFORM tracefab_refresh_supplier_profile_completeness(NEW.supplier_id);
  IF TG_OP = 'UPDATE' AND OLD.supplier_id IS DISTINCT FROM NEW.supplier_id THEN
    PERFORM tracefab_refresh_supplier_profile_completeness(OLD.supplier_id);
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_refresh_supplier_profile_from_organization()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier_id UUID;
BEGIN
  SELECT s.id INTO v_supplier_id
  FROM suppliers s
  WHERE s.organization_id = NEW.id;

  IF v_supplier_id IS NOT NULL THEN
    PERFORM tracefab_refresh_supplier_profile_completeness(v_supplier_id);
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER suppliers_profile_completeness_after_change
    AFTER INSERT OR UPDATE OF profile_summary, contact_name, contact_email, activity_types
    ON suppliers
    FOR EACH ROW EXECUTE FUNCTION tracefab_refresh_supplier_profile_from_supplier();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER supplier_sites_refresh_profile
    AFTER INSERT OR UPDATE OR DELETE ON supplier_sites
    FOR EACH ROW EXECUTE FUNCTION tracefab_refresh_supplier_profile_from_site();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER organizations_refresh_supplier_profile
    AFTER UPDATE OF legal_name, display_name, country_code ON organizations
    FOR EACH ROW EXECUTE FUNCTION tracefab_refresh_supplier_profile_from_organization();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- 3. Trusted invitation creation and acceptance
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tracefab_invite_supplier(
  p_brand_organization_id UUID,
  p_email TEXT,
  p_legal_name TEXT,
  p_display_name TEXT,
  p_country_code VARCHAR(2),
  p_token_hash TEXT
)
RETURNS TABLE (
  relationship_id UUID,
  supplier_organization_id UUID,
  supplier_id UUID,
  invitation_id UUID,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier_organization_id UUID;
  v_supplier_id UUID;
  v_relationship_id UUID;
  v_invitation_id UUID;
  v_expires_at TIMESTAMPTZ;
  v_brand_type organization_type;
  v_email TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;

  IF NOT tracefab_has_org_role(
    p_brand_organization_id,
    ARRAY['owner', 'admin', 'manager']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'brand_admin_role_required';
  END IF;

  SELECT type INTO v_brand_type
  FROM organizations
  WHERE id = p_brand_organization_id;

  IF v_brand_type IS DISTINCT FROM 'brand'::organization_type THEN
    RAISE EXCEPTION 'brand_organization_required';
  END IF;

  v_email := lower(trim(COALESCE(p_email, '')));
  IF position('@' IN v_email) <= 1 OR length(v_email) < 5 THEN
    RAISE EXCEPTION 'valid_supplier_email_required';
  END IF;

  IF length(trim(COALESCE(p_legal_name, ''))) = 0 THEN
    RAISE EXCEPTION 'supplier_legal_name_required';
  END IF;

  IF length(trim(COALESCE(p_token_hash, ''))) < 32 THEN
    RAISE EXCEPTION 'hashed_invitation_token_required';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM organization_invitations i
    JOIN brand_supplier_relationships r ON r.id = i.relationship_id
    WHERE r.brand_organization_id = p_brand_organization_id
      AND lower(i.email) = v_email
      AND i.accepted_at IS NULL
      AND i.expires_at > now()
  ) THEN
    RAISE EXCEPTION 'active_supplier_invitation_exists';
  END IF;

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
    'invited',
    auth.uid()
  )
  RETURNING id INTO v_supplier_organization_id;

  INSERT INTO suppliers (
    organization_id,
    onboarding_status,
    last_profile_updated_by
  )
  VALUES (
    v_supplier_organization_id,
    'invited',
    auth.uid()
  )
  RETURNING id INTO v_supplier_id;

  INSERT INTO brand_supplier_relationships (
    brand_organization_id,
    supplier_organization_id,
    status,
    requested_by
  )
  VALUES (
    p_brand_organization_id,
    v_supplier_organization_id,
    'invited',
    auth.uid()
  )
  RETURNING id INTO v_relationship_id;

  v_expires_at := now() + interval '7 days';

  INSERT INTO organization_invitations (
    organization_id,
    relationship_id,
    email,
    target_role,
    token_hash,
    invited_by,
    expires_at
  )
  VALUES (
    v_supplier_organization_id,
    v_relationship_id,
    v_email,
    'owner',
    p_token_hash,
    auth.uid(),
    v_expires_at
  )
  RETURNING id INTO v_invitation_id;

  RETURN QUERY SELECT
    v_relationship_id,
    v_supplier_organization_id,
    v_supplier_id,
    v_invitation_id,
    v_expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_accept_organization_invitation(p_token_hash TEXT)
RETURNS TABLE (
  organization_id UUID,
  membership_id UUID,
  relationship_id UUID,
  supplier_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invitation organization_invitations;
  v_membership_id UUID;
  v_supplier_id UUID;
  v_auth_email TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;

  SELECT * INTO v_invitation
  FROM organization_invitations i
  WHERE i.token_hash = p_token_hash
    AND i.accepted_at IS NULL
    AND i.expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_or_expired_invitation';
  END IF;

  v_auth_email := lower(trim(COALESCE(auth.jwt() ->> 'email', '')));
  IF v_auth_email = '' OR v_auth_email <> lower(v_invitation.email) THEN
    RAISE EXCEPTION 'invitation_email_mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM organization_memberships m
    WHERE m.organization_id = v_invitation.organization_id
      AND m.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'user_already_member';
  END IF;

  INSERT INTO organization_memberships (
    organization_id,
    user_id,
    role,
    status,
    invited_by,
    joined_at
  )
  VALUES (
    v_invitation.organization_id,
    auth.uid(),
    v_invitation.target_role,
    'active',
    v_invitation.invited_by,
    now()
  )
  RETURNING id INTO v_membership_id;

  UPDATE organization_invitations
  SET accepted_at = now()
  WHERE id = v_invitation.id;

  UPDATE organizations
  SET status = 'active'
  WHERE id = v_invitation.organization_id
    AND status = 'invited';

  IF v_invitation.relationship_id IS NOT NULL THEN
    UPDATE brand_supplier_relationships
    SET status = 'active',
        accepted_at = COALESCE(accepted_at, now())
    WHERE id = v_invitation.relationship_id;

    UPDATE suppliers
    SET onboarding_status = 'in_progress',
        last_profile_updated_by = auth.uid()
    WHERE organization_id = v_invitation.organization_id
    RETURNING id INTO v_supplier_id;
  END IF;

  RETURN QUERY SELECT
    v_invitation.organization_id,
    v_membership_id,
    v_invitation.relationship_id,
    v_supplier_id;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_update_supplier_profile(
  p_supplier_id UUID,
  p_profile_summary TEXT,
  p_contact_name TEXT,
  p_contact_email TEXT,
  p_contact_phone TEXT,
  p_employee_count_range TEXT,
  p_year_established INTEGER,
  p_activity_types TEXT[]
)
RETURNS suppliers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier suppliers;
BEGIN
  SELECT * INTO v_supplier
  FROM suppliers
  WHERE id = p_supplier_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'supplier_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_supplier.organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'supplier_profile_role_required';
  END IF;

  UPDATE suppliers
  SET profile_summary = NULLIF(trim(p_profile_summary), ''),
      contact_name = NULLIF(trim(p_contact_name), ''),
      contact_email = lower(NULLIF(trim(p_contact_email), '')),
      contact_phone = NULLIF(trim(p_contact_phone), ''),
      employee_count_range = NULLIF(trim(p_employee_count_range), ''),
      year_established = p_year_established,
      activity_types = COALESCE(p_activity_types, '{}'::TEXT[]),
      onboarding_status = CASE
        WHEN onboarding_status IN ('invited', 'submitted', 'approved', 'rejected') THEN 'in_progress'
        ELSE onboarding_status
      END,
      last_profile_updated_by = auth.uid()
  WHERE id = p_supplier_id;

  PERFORM tracefab_refresh_supplier_profile_completeness(p_supplier_id);

  SELECT * INTO v_supplier
  FROM suppliers
  WHERE id = p_supplier_id;

  RETURN v_supplier;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_submit_supplier_profile(p_supplier_id UUID)
RETURNS suppliers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supplier suppliers;
  v_completion NUMERIC(5,2);
BEGIN
  SELECT * INTO v_supplier
  FROM suppliers
  WHERE id = p_supplier_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'supplier_not_found';
  END IF;

  IF NOT tracefab_has_org_role(
    v_supplier.organization_id,
    ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[]
  ) THEN
    RAISE EXCEPTION 'supplier_profile_role_required';
  END IF;

  v_completion := tracefab_refresh_supplier_profile_completeness(p_supplier_id);

  IF v_completion < 100 THEN
    RAISE EXCEPTION 'supplier_profile_incomplete: %', v_completion;
  END IF;

  IF v_supplier.onboarding_status NOT IN ('invited', 'in_progress', 'rejected') THEN
    RAISE EXCEPTION 'supplier_profile_status_does_not_allow_submission';
  END IF;

  UPDATE suppliers
  SET onboarding_status = 'submitted',
      last_submitted_at = now(),
      last_profile_updated_by = auth.uid(),
      profile_completion = v_completion
  WHERE id = p_supplier_id
  RETURNING * INTO v_supplier;

  RETURN v_supplier;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Participant visibility for invitation tracking
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS invitations_select_admin ON organization_invitations;
CREATE POLICY invitations_select_participant ON organization_invitations
  FOR SELECT TO authenticated USING (
    tracefab_has_org_role(organization_id, ARRAY['owner', 'admin']::membership_role[])
    OR EXISTS (
      SELECT 1
      FROM brand_supplier_relationships r
      WHERE r.id = organization_invitations.relationship_id
        AND tracefab_has_org_role(r.brand_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
    )
  );

DROP POLICY IF EXISTS invitations_update_admin ON organization_invitations;
CREATE POLICY invitations_update_participant ON organization_invitations
  FOR UPDATE TO authenticated USING (
    tracefab_has_org_role(organization_id, ARRAY['owner', 'admin']::membership_role[])
    OR EXISTS (
      SELECT 1
      FROM brand_supplier_relationships r
      WHERE r.id = organization_invitations.relationship_id
        AND tracefab_has_org_role(r.brand_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
    )
  ) WITH CHECK (
    tracefab_has_org_role(organization_id, ARRAY['owner', 'admin']::membership_role[])
    OR EXISTS (
      SELECT 1
      FROM brand_supplier_relationships r
      WHERE r.id = organization_invitations.relationship_id
        AND tracefab_has_org_role(r.brand_organization_id, ARRAY['owner', 'admin', 'manager']::membership_role[])
    )
  );

-- -----------------------------------------------------------------------------
-- 5. Function privileges
-- -----------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION tracefab_validate_relationship_organizations() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_validate_share_relationship() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_validate_invitation_relationship() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_calculate_supplier_profile_completion(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_refresh_supplier_profile_completeness(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_refresh_supplier_profile_from_supplier() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_refresh_supplier_profile_from_site() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_refresh_supplier_profile_from_organization() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_invite_supplier(UUID, TEXT, TEXT, TEXT, VARCHAR, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_accept_organization_invitation(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_update_supplier_profile(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tracefab_submit_supplier_profile(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION tracefab_invite_supplier(UUID, TEXT, TEXT, TEXT, VARCHAR, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION tracefab_accept_organization_invitation(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION tracefab_update_supplier_profile(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION tracefab_submit_supplier_profile(UUID) TO authenticated;

COMMENT ON COLUMN suppliers.profile_completion IS 'Computed completeness percentage for the current supplier profile; not a verification score.';
COMMENT ON COLUMN organization_invitations.relationship_id IS 'Optional brand-supplier context for participant visibility and onboarding.';
COMMENT ON FUNCTION tracefab_invite_supplier(UUID, TEXT, TEXT, TEXT, VARCHAR, TEXT) IS 'Creates an invited supplier organization, relationship and hashed-token invitation. Raw tokens are handled outside SQL.';
COMMENT ON FUNCTION tracefab_accept_organization_invitation(TEXT) IS 'Accepts a hashed invitation token only when the authenticated email matches the invitation email.';
COMMENT ON FUNCTION tracefab_update_supplier_profile(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT[]) IS 'Updates editable supplier profile fields through a tenant-checked function and recalculates completeness.';
COMMENT ON FUNCTION tracefab_submit_supplier_profile(UUID) IS 'Moves a complete supplier profile to submitted. Completeness is not verification or certification.';
