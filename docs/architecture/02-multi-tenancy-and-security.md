# 2. Multi-tenancy and security

## Tenancy model

Tracefab uses organization-based tenancy:

```text
User
 └── Organization membership
      └── Organization
           ├── Supplier / brand profile
           ├── Products / materials / sites
           ├── Requests / responses
           └── Documents / audit events
```

A user may belong to several organizations. The role is attached to the membership, not globally to the user.

## Roles

| Role | Main responsibility |
|---|---|
| `owner` | Full organization administration |
| `admin` | Members, settings and operational data |
| `manager` | Day-to-day supply-chain operations |
| `contributor` | Data entry and document submission |
| `viewer` | Read-only access to authorized data |
| `auditor` | Read-only evidence review within an assigned scope |

## RLS strategy

The migration defines security-definer helper functions:

- `tracefab_is_org_member(org_id)`;
- `tracefab_has_org_role(org_id, roles[])`;
- `tracefab_can_access_org(org_id)`.

These helpers centralize access checks and avoid copying different role logic into every policy. They are security-definer functions with execution revoked from `PUBLIC` and granted only to the authenticated application role. `tracefab_create_organization(...)` is the controlled bootstrap path for the first owner membership.

## Sharing strategy

The initial schema includes `data_shares` so that a supplier can authorize a brand to view a defined object scope. Owner-organization access is always allowed. Cross-organization access requires an active, non-expired share whose `scope` explicitly contains the object identifier, or explicitly sets `{"all": true}` for the relationship.

The scope is currently JSONB for delivery speed. A later iteration should replace it with explicit scope rows if customers require field-level authorization, delegated access or more complex policies.

## Document security

Documents are modeled with private storage metadata. The database stores the bucket and path, not public URLs. Signed URL generation must happen through an authenticated server-side function after an access check.

No migration creates public buckets or public read policies.

## Audit log

`audit_logs` is append-only by policy: members may insert events for their organization, administrators can read them, and there are no update/delete policies. A later hardening step should move critical audit inserts into trusted database functions or triggers.

## Operational requirements still pending

- signed URL Edge Function using the private Storage policies delivered in chantier 5;
- invitation token hashing and acceptance flow;
- rate limits and abuse protection;
- malware scanning;
- database backup/restore procedure;
- integration tests executed against a real Supabase project.
