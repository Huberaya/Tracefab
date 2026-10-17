import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { isTenantError, requireActiveTenant, requestedTenantId } from '../../_lib/tenant.js';
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
      // Locataire actif obligatoire. Les plans d'action corrective ont une
      // marque ET un fournisseur : l'union de toutes les organisations du
      // compte affichait les plans de l'autre tenant.
      const tenant = await requireActiveTenant(tx, req, user.id);
      const orgIds = [tenant.organizationId];

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
    }, requestedTenantId(req));

    return json(res, 200, {
      caps: result,
      count: result.length,
    });
  } catch (err: unknown) {
    if (isUnauthorized(err)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    if (isTenantError(err)) {
      return json(res, err.status, { error: err.message });
    }
    const sqlError = sqlBusinessError(err);
    if (sqlError) {
      return json(res, sqlError.status, { error: sqlError.error });
    }
    console.error('CAPs list error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
