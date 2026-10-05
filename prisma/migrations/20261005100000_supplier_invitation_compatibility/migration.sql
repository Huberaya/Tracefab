-- Preserve the pre-existing brand-to-supplier onboarding invitation contract:
-- its first supplier member is intentionally invited as owner. The advanced
-- member-management API still cannot issue owner invitations because those rows
-- have no relationship_id.
CREATE OR REPLACE FUNCTION tracefab_validate_member_invitation_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.target_role = 'owner' AND NEW.relationship_id IS NULL THEN
    RAISE EXCEPTION 'owner_role_not_invitable';
  END IF;
  RETURN NEW;
END;
$$;
