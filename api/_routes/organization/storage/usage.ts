import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { activeBrandOrganizationIds, isUuid } from '../../../_lib/products.js';
import { getOrganizationStorageUsage } from '../../../_lib/cloud-storage/quota-manager.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const { user } = await requireClerkUser(req);
    const queryOrgId = req.query.organizationId;
    const requestedId = Array.isArray(queryOrgId) ? queryOrgId[0] : queryOrgId;

    const usage = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const brandIds = await activeBrandOrganizationIds(tx, user.id);
      let targetOrgId: string | undefined;

      if (requestedId && isUuid(requestedId) && brandIds.includes(requestedId)) {
        targetOrgId = requestedId;
      } else if (brandIds.length > 0) {
        targetOrgId = brandIds[0];
      }

      if (!targetOrgId) return null;
      return getOrganizationStorageUsage(tx, targetOrgId);
    });

    if (!usage) return json(res, 404, { error: 'organization_not_found' });
    return json(res, 200, { storage: usage });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('GET /api/organization/storage/usage failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
