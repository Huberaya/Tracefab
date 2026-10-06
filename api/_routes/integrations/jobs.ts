import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser } from '../../_lib/auth.js';
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
  } catch (error: any) {
    const err = sqlBusinessError(error);
    return json(res, err.status, { error: err.error });
  }
}
