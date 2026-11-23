import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { isTenantError, requireActiveTenant, requestedTenantId } from '../../../_lib/tenant.js';
import { getOrganizationStorageUsage } from '../../../_lib/cloud-storage/quota-manager.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const { user } = await requireClerkUser(req);

    const usage = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const tenant = await requireActiveTenant(tx, req, user.id, { types: ['brand'] });
      return getOrganizationStorageUsage(tx, tenant.organizationId);
    }, requestedTenantId(req));

    if (!usage) return json(res, 404, { error: 'organization_not_found' });
    return json(res, 200, { storage: usage });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isTenantError(error)) return json(res, error.status, { error: error.message });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('GET /api/organization/storage/usage failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
