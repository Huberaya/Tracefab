import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { isUnauthorized } from '../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { computeDashboard } from '../../_lib/crm.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';

/**
 * GET /api/admin/dashboard
 *
 * Chaque indicateur est compté depuis les lignes réelles de `crm_companies`.
 * Rien n'est estimé : quand rien n'est encore tranché, `conversionRate` vaut
 * `null` et l'interface affiche « non mesuré » plutôt qu'un 0 % inventé.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const admin = await requirePlatformAdmin(req);

    const rows = (await withTracefabUserContext(admin.userId, admin.userEmail, (tx) =>
      tx.crm_companies.findMany({
        where: { platform_organization_id: admin.platformOrganizationId },
        select: {
          stage: true,
          priority: true,
          country_code: true,
          company_type: true,
          estimated_value_eur: true,
          next_contact_at: true,
        },
      }),
    )) as unknown as {
      stage: string;
      priority: string;
      country_code: string | null;
      company_type: string | null;
      estimated_value_eur: number | null;
      next_contact_at: Date | null;
    }[];

    /*
     * `stage` sort de Prisma en `string` tant que le client n'est pas généré ;
     * `computeDashboard` attend `CrmStage`. Le cast est explicite et borné : une
     * valeur hors énumération est comptée dans `byStage` sans faire mentir les
     * compteurs du funnel, qui eux comparent à des littéraux.
     */
    const totals = computeDashboard(rows as unknown as Parameters<typeof computeDashboard>[0]);

    const byPriority = rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.priority] = (acc[row.priority] || 0) + 1;
      return acc;
    }, {});

    return json(res, 200, {
      role: admin.role,
      organizationName: admin.organizationName,
      measuredAt: new Date().toISOString(),
      sampleSize: rows.length,
      ...totals,
      byPriority,
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isAdminAccessDenied(error)) return json(res, 403, { error: 'admin_access_denied' });
    const business = sqlBusinessError(error);
    if (business) return json(res, business.status, business);
    console.error('GET /api/admin/dashboard failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
