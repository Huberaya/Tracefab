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
16. A brand manager can create one supplier invitation with only a token hash.
17. A supplier invitation cannot be duplicated while an active invitation exists for the same brand and email.
18. Invitation acceptance requires an authenticated email matching the invitation email.
19. Invitation acceptance creates one supplier owner membership and activates the relationship.
20. A supplier contributor can update profile fields only through the profile function.
21. A profile below 100 percent cannot be submitted.
22. A complete profile moves to `submitted`; a later edit reopens it as `in_progress`.
23. A supplier organization cannot create a product for a brand.
24. A viewer cannot create or update product data.
25. A brand cannot attach a private supplier material without an explicit share.
26. A shared material can be attached only when the share scope contains that material.
27. A product revision requires a new current-version composition; the previous composition is not copied automatically.
28. Product readiness changes when identifiers, materials or product data points change.
29. A product with an expired or `needs_review` data point cannot remain `data_ready`.
30. `data_ready` does not create public access or a regulatory compliance claim.
31. A brand cannot create a data request without an active brand-supplier relationship.
32. A supplier cannot see a request while it is still `draft`.
33. A brand cannot modify request items after the request is sent.
34. A supplier cannot modify request definitions or review statuses through direct client writes.
35. A response revision supersedes exactly one current response and preserves history.
36. A response document must belong to the supplier organization that responds.
37. A supplier cannot submit a request with missing required items.
38. A reviewer can mark a response `verified_by_reviewer` or `needs_review`, but not `certified_by_third_party`.
39. A negative review moves the request to `changes_requested`; all required accepted items can move it to `approved`.
40. Request idempotency returns the existing draft instead of creating a duplicate.

## Test status in chantier 1

**Not executed yet.** The repository environment does not contain the Supabase CLI or a database connection. Execution belongs to the integration-hardening step before the first production deployment.
