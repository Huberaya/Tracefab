import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, ['GET']);
  }

  try {
    const { user } = await requireClerkUser(req);
    const statusFilter = typeof req.query.status === 'string' ? req.query.status : undefined;
    const roleFilter = typeof req.query.role === 'string' ? req.query.role : undefined; // 'brand' | 'supplier'

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      // Find organizations the user belongs to
      const memberships = await tx.organization_memberships.findMany({
        where: { user_id: user.id, status: 'active' },
        select: { organization_id: true, role: true },
      });

      const orgIds = memberships.map((m) => m.organization_id);
      if (orgIds.length === 0) return [];

      const whereClause: any = {
        OR: [
          { brand_organization_id: { in: orgIds } },
          { supplier_organization_id: { in: orgIds } },
        ],
      };

      if (statusFilter) {
        whereClause.status = statusFilter;
      }

      if (roleFilter === 'supplier') {
        whereClause.supplier_organization_id = { in: orgIds };
        delete whereClause.OR;
      } else if (roleFilter === 'brand') {
        whereClause.brand_organization_id = { in: orgIds };
        delete whereClause.OR;
      }

      const caps = await tx.quality_corrective_action_plans.findMany({
        where: whereClause,
        include: {
          organizations_quality_corrective_action_plans_brand_organization_idToorganizations: {
            select: { id: true, display_name: true, legal_name: true },
          },
          organizations_quality_corrective_action_plans_supplier_organization_idToorganizations: {
            select: { id: true, display_name: true, legal_name: true },
          },
          tracefab_products: {
            select: { id: true, name: true, reference: true },
          },
          data_quality_issues: {
            select: { id: true, rule_key: true, severity: true, message: true, status: true },
          },
        },
        orderBy: [{ due_date: 'asc' }, { created_at: 'desc' }],
      });

      return caps;
    });

    return json(res, 200, {
      caps: result,
      count: result.length,
    });
  } catch (err: unknown) {
    if (isUnauthorized(err)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    const sqlError = sqlBusinessError(err);
    if (sqlError) {
      return json(res, sqlError.status, { error: sqlError.error });
    }
    console.error('CAPs list error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
