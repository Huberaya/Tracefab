import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';
import { activeBrandOrganizationIds } from '../../_lib/products.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, ['GET']);
  }

  try {
    const { user } = await requireClerkUser(req);

    return await withTracefabUserContext(user.id, user.email, async (tx) => {
      const brandOrgIds = await activeBrandOrganizationIds(tx, user.id);
      const activeOrgId = (req.query.organizationId as string) || brandOrgIds[0];

      if (!activeOrgId || !brandOrgIds.includes(activeOrgId)) {
        return json(res, 403, { error: 'brand_product_role_required' });
      }

      const jobs = await tx.plm_erp_sync_jobs.findMany({
        where: { brand_organization_id: activeOrgId },
        orderBy: { created_at: 'desc' },
        take: 50,
      });

      return json(res, 200, { jobs });
    });
  } catch (error: unknown) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) {
      return json(res, businessError.status, { error: businessError.error });
    }
    console.error('GET /api/integrations/jobs failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
