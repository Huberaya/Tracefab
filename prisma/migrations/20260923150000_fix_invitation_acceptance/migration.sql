-- Qualify suppliers.organization_id because the RETURNS TABLE output column has the same name.

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

  IF EXISTS (
    SELECT 1 FROM organization_memberships m
    WHERE m.organization_id = v_invitation.organization_id
      AND m.user_id = tracefab_current_user_id()
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
    tracefab_current_user_id(),
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
