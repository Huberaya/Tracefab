import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabTenantContext } from '../../_lib/context.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';


export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, ['GET']);
  }

  try {
    const { user } = await requireClerkUser(req);

    return await withTracefabTenantContext(
      req,
      user,
      { types: ['brand'] },
      async (tx, tenant) => {
        const jobs = await tx.plm_erp_sync_jobs.findMany({
          where: { brand_organization_id: tenant.organizationId },
          orderBy: { created_at: 'desc' },
          take: 50,
        });
        return json(res, 200, { jobs });
      },
    );
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
