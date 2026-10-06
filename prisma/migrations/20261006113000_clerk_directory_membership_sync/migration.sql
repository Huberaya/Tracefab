-- Clerk directory bridge. Clerk identifiers are integration references only;
-- Tracefab roles and RLS remain the authorization source of truth.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS clerk_organization_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_clerk_id
  ON organizations(clerk_organization_id)
  WHERE clerk_organization_id IS NOT NULL;

ALTER TABLE organization_memberships
  ADD COLUMN IF NOT EXISTS clerk_membership_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_clerk_id
  ON organization_memberships(clerk_membership_id)
  WHERE clerk_membership_id IS NOT NULL;
