import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { isUnauthorized } from '../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../_lib/admin-access.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';

/**
 * GET /api/admin/access
 *
 * Dit à la console Admin si l'appelant y a droit, et avec quel rôle. La console
 * appelle cette route avant de rendre quoi que ce soit : un non-Admin ne doit
 * jamais voir une interface vide qui ressemble à une panne.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const admin = await requirePlatformAdmin(req);
    return json(res, 200, {
      authorized: true,
      role: admin.role,
      userId: admin.userId,
      fullName: admin.fullName,
      email: admin.userEmail,
      platformOrganizationId: admin.platformOrganizationId,
      organizationName: admin.organizationName,
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isAdminAccessDenied(error)) {
      return json(res, 403, { authorized: false, error: 'admin_access_denied' });
    }
    const business = sqlBusinessError(error);
    if (business) return json(res, business.status, business);
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('GET /api/admin/access failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
