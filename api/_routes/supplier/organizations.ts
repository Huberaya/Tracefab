import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { requestedOrganizationId } from '../../_lib/supplier-profile.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const { user } = await requireClerkUser(req);
    const selectedOrganizationId = requestedOrganizationId(req);
    const organizations = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const memberships = await tx.organization_memberships.findMany({
        where: {
          user_id: user.id,
          status: 'active',
          organizations: { type: 'supplier', status: { in: ['active', 'invited'] } },
        },
        select: {
          organization_id: true,
          role: true,
          status: true,
          created_at: true,
          organizations: {
            select: {
              id: true,
              type: true,
              legal_name: true,
              display_name: true,
              country_code: true,
              status: true,
              suppliers: { select: { id: true, onboarding_status: true, profile_completion: true } },
            },
          },
        },
        orderBy: { created_at: 'asc' },
      });
      if (selectedOrganizationId && !memberships.some((membership) => membership.organization_id === selectedOrganizationId)) return null;
      return memberships;
    });
    if (!organizations) return json(res, 403, { error: 'organization_access_denied' });
    return json(res, 200, {
      organizations: organizations.map((membership) => ({
        organizationId: membership.organization_id,
        role: membership.role,
        membershipStatus: membership.status,
        createdAt: membership.created_at,
        organization: membership.organizations,
        supplier: membership.organizations.suppliers
          ? { ...membership.organizations.suppliers, profileCompletion: String(membership.organizations.suppliers.profile_completion) }
          : null,
      })),
      selectedOrganizationId: selectedOrganizationId || organizations[0]?.organization_id || null,
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (error instanceof Error && error.message === 'invalid_organization_id') return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('GET /api/supplier/organizations failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
