import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { isTenantError, resolveActiveTenant } from '../../../_lib/tenant.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { currentSupplier, requestedOrganizationId } from '../../../_lib/supplier-profile.js';
import { getOrganizationStorageUsage } from '../../../_lib/cloud-storage/quota-manager.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const { user } = await requireClerkUser(req);
    const requestedOrgId = requestedOrganizationId(req);
    const usage = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const tenant = await resolveActiveTenant(tx, user.id, requestedOrgId, { types: ['supplier'] });
      const supplier = await currentSupplier(tx, user.id, tenant.organizationId);
      if (!supplier) return null;
      return getOrganizationStorageUsage(tx, supplier.organization_id);
    });

    if (!usage) return json(res, 404, { error: 'supplier_profile_not_found' });
    return json(res, 200, { storage: usage });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isTenantError(error)) return json(res, error.status, { error: error.message });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('GET /api/supplier/storage/usage failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
