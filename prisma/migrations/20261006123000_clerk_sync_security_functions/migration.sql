-- Keep Clerk directory synchronization server-side and compatible with the
-- private-by-default RLS policies. Webhook handlers call these SECURITY DEFINER
-- functions rather than obtaining direct mutation policies on tenant tables.

CREATE OR REPLACE FUNCTION tracefab_sync_clerk_organization(
  p_clerk_organization_id TEXT,
  p_legal_name TEXT,
  p_display_name TEXT,
  p_type organization_type
)
RETURNS organizations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_organization organizations;
BEGIN
  SELECT * INTO v_organization
  FROM organizations
  WHERE clerk_organization_id = p_clerk_organization_id
  FOR UPDATE;

  IF FOUND THEN
    UPDATE organizations
    SET legal_name = p_legal_name,
        display_name = p_display_name,
        type = p_type,
        status = 'active',
        updated_at = now()
    WHERE id = v_organization.id
    RETURNING * INTO v_organization;
  ELSE
    INSERT INTO organizations(clerk_organization_id, type, legal_name, display_name, status)
    VALUES (p_clerk_organization_id, p_type, p_legal_name, p_display_name, 'active')
    RETURNING * INTO v_organization;
  END IF;

  RETURN v_organization;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_sync_clerk_membership(
  p_clerk_membership_id TEXT,
  p_organization_id UUID,
  p_user_id UUID,
  p_role membership_role
)
RETURNS organization_memberships
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_membership organization_memberships;
BEGIN
  SELECT * INTO v_membership
  FROM organization_memberships
  WHERE clerk_membership_id = p_clerk_membership_id
  FOR UPDATE;

  IF FOUND THEN
    UPDATE organization_memberships
    SET organization_id = p_organization_id,
        user_id = p_user_id,
        status = 'active',
        joined_at = COALESCE(joined_at, now())
    WHERE id = v_membership.id
    RETURNING * INTO v_membership;
  ELSE
    SELECT * INTO v_membership
    FROM organization_memberships
    WHERE organization_id = p_organization_id AND user_id = p_user_id
    FOR UPDATE;

    IF FOUND THEN
      UPDATE organization_memberships
      SET clerk_membership_id = p_clerk_membership_id,
          status = 'active',
          joined_at = COALESCE(joined_at, now())
      WHERE id = v_membership.id
      RETURNING * INTO v_membership;
    ELSE
      INSERT INTO organization_memberships(clerk_membership_id, organization_id, user_id, role, status, joined_at)
      VALUES (p_clerk_membership_id, p_organization_id, p_user_id, p_role, 'active', now())
      RETURNING * INTO v_membership;
    END IF;
  END IF;

  INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    p_organization_id, p_user_id, 'clerk.membership.sync', 'clerk_directory', v_membership.id,
    jsonb_build_object('source', 'clerk_webhook', 'clerkMembershipId', p_clerk_membership_id)
  );
  RETURN v_membership;
END;
$$;

CREATE OR REPLACE FUNCTION tracefab_revoke_clerk_membership(p_clerk_membership_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_membership organization_memberships;
BEGIN
  SELECT * INTO v_membership
  FROM organization_memberships
  WHERE clerk_membership_id = p_clerk_membership_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE organization_memberships SET status = 'revoked' WHERE id = v_membership.id;
  INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_membership.organization_id, v_membership.user_id, 'clerk.membership.revoked', 'clerk_directory', v_membership.id,
    jsonb_build_object('source', 'clerk_webhook', 'clerkMembershipId', p_clerk_membership_id)
  );
END;
$$;

REVOKE ALL ON FUNCTION tracefab_sync_clerk_organization(TEXT, TEXT, TEXT, organization_type) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_sync_clerk_membership(TEXT, UUID, UUID, membership_role) FROM PUBLIC;
REVOKE ALL ON FUNCTION tracefab_revoke_clerk_membership(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_sync_clerk_organization(TEXT, TEXT, TEXT, organization_type) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_sync_clerk_membership(TEXT, UUID, UUID, membership_role) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_revoke_clerk_membership(TEXT) TO PUBLIC;
