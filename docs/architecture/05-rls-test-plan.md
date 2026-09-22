# 5. RLS test plan

The migration cannot be declared production-ready until these scenarios run against a real Supabase project with two users and at least three organizations.

## Fixtures

- User A: brand owner of Brand A.
- User B: supplier owner of Supplier B.
- User C: member of Brand C, unrelated to Supplier B.
- Brand A ↔ Supplier B: active relationship.
- Brand C ↔ Supplier B: no relationship.
- One private document owned by Supplier B.
- One active data share from Supplier B to Brand A.

## Required assertions

1. Anonymous users cannot select Tracefab tables.
2. User A can read its own organization and products.
3. User B can read and update its own supplier profile and sites.
4. User C cannot read Brand A products.
5. User C cannot read Supplier B documents.
6. Brand A cannot read Supplier B private data before a share exists.
7. Brand A can read only the supplier data permitted by an active share.
8. A revoked or expired share immediately removes cross-organization access.
9. User B cannot insert a data response for a request belonging to another supplier.
10. User C cannot insert a product under Brand A by changing `brand_organization_id` in the payload.
11. A non-admin member cannot insert or update organization memberships.
12. Audit logs cannot be updated or deleted through the authenticated client role.
13. The bootstrap function creates exactly one owner membership for the caller.
14. The bootstrap function rejects `platform` organizations for normal users.
15. A document path owned by Supplier B cannot be replaced by Brand A through Storage policies.

## Test status in chantier 1

**Not executed yet.** The repository environment does not contain the Supabase CLI or a database connection. Execution belongs to the integration-hardening step before the first production deployment.
