-- Supplier Portal advanced hardening
--
-- The API performs the user-facing checks, while this migration keeps the
-- high-impact membership and data-point invariants enforced in PostgreSQL as
-- well. It is intentionally additive and compatible with the existing Neon
-- migration model.

-- A viewer/auditor may read supplier data but may not write canonical facts.
DROP POLICY IF EXISTS data_points_insert_owner ON data_points;
CREATE POLICY data_points_insert_owner ON data_points
  FOR INSERT TO PUBLIC
  WITH CHECK (
    tracefab_has_org_role(owner_organization_id, ARRAY['owner', 'admin', 'manager', 'contributor']::membership_role[])
    AND declared_by = tracefab_current_user_id()
  );

-- Do not allow a direct RLS-authorized membership update to create a new owner,
-- move a membership across tenants, mutate its user identity, or remove the
-- last active owner. The trusted invitation acceptance function remains the
-- only path that can create a membership for a newly authenticated user.
CREATE OR REPLACE FUNCTION tracefab_validate_membership_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  active_owner_count INTEGER;
BEGIN
  IF NEW.organization_id <> OLD.organization_id OR NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'membership_identity_immutable';
  END IF;

  IF OLD.role <> 'owner' AND NEW.role = 'owner' THEN
    RAISE EXCEPTION 'owner_role_not_promotable';
  END IF;

  IF OLD.role = 'owner' AND (NEW.role <> 'owner' OR NEW.status <> 'active') THEN
    SELECT count(*) INTO active_owner_count
    FROM organization_memberships
    WHERE organization_id = OLD.organization_id
      AND role = 'owner'
      AND status = 'active'
      AND id <> OLD.id;
    IF active_owner_count < 1 THEN
      RAISE EXCEPTION 'last_owner_membership_required';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organization_memberships_validate_mutation ON organization_memberships;
CREATE TRIGGER organization_memberships_validate_mutation
  BEFORE UPDATE ON organization_memberships
  FOR EACH ROW EXECUTE FUNCTION tracefab_validate_membership_mutation();

CREATE OR REPLACE FUNCTION tracefab_validate_member_invitation_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.target_role = 'owner' THEN
    RAISE EXCEPTION 'owner_role_not_invitable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organization_invitations_validate_role ON organization_invitations;
CREATE TRIGGER organization_invitations_validate_role
  BEFORE INSERT OR UPDATE ON organization_invitations
  FOR EACH ROW EXECUTE FUNCTION tracefab_validate_member_invitation_role();

-- An invitation can reactivate a previously revoked membership for the same
-- email/user, but it cannot silently duplicate an active or suspended member.
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
  v_membership organization_memberships;
  v_membership_id UUID;
  v_supplier_id UUID;
  v_auth_email TEXT;
BEGIN
  IF tracefab_current_user_id() IS NULL THEN
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

  v_auth_email := lower(trim(COALESCE(tracefab_current_user_email(), '')));
  IF v_auth_email = '' OR v_auth_email <> lower(v_invitation.email) THEN
    RAISE EXCEPTION 'invitation_email_mismatch';
  END IF;

  SELECT * INTO v_membership
  FROM organization_memberships m
  WHERE m.organization_id = v_invitation.organization_id
    AND m.user_id = tracefab_current_user_id()
  FOR UPDATE;

  IF FOUND AND v_membership.status <> 'revoked' THEN
    RAISE EXCEPTION 'user_already_member';
  END IF;

  IF FOUND THEN
    UPDATE organization_memberships
    SET role = v_invitation.target_role,
        status = 'active',
        invited_by = v_invitation.invited_by,
        joined_at = now()
    WHERE id = v_membership.id
    RETURNING id INTO v_membership_id;
  ELSE
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
      tracefab_current_user_id(),
      v_invitation.target_role,
      'active',
      v_invitation.invited_by,
      now()
    )
    RETURNING id INTO v_membership_id;
  END IF;

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

    UPDATE suppliers AS s
    SET onboarding_status = 'in_progress',
        last_profile_updated_by = tracefab_current_user_id()
    WHERE s.organization_id = v_invitation.organization_id
    RETURNING s.id INTO v_supplier_id;
  END IF;

  RETURN QUERY SELECT
    v_invitation.organization_id,
    v_membership_id,
    v_invitation.relationship_id,
    v_supplier_id;
END;
$$;

COMMENT ON FUNCTION tracefab_validate_membership_mutation() IS 'Database guard for owner lifecycle and immutable membership identity.';
COMMENT ON FUNCTION tracefab_accept_organization_invitation(TEXT) IS 'Accepts a hashed invitation and reactivates only revoked memberships.';
