import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { isUnauthorized } from '../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';

const first = (value: unknown) => (Array.isArray(value) ? value[0] : value);

/**
 * GET /api/admin/notes — §12, les notes de la console.
 *
 * Lecture seule, et le type est FIXÉ ici : ce n'est pas `activities?type=note`
 * déguisé. Une route dont le paramètre décide du contenu n'a pas de périmètre ;
 * celle-ci a le sien, et l'écriture reste à sa seule porte existante
 * (POST /api/admin/companies/:id/activities), déjà scellée dans le journal d'audit.
 *
 * Les notes vivent dans `crm_activities`, en REVOKE UPDATE, DELETE : une note
 * écrite ne peut être ni retouchée ni effacée. C'est ce qui en fait un historique
 * et non un brouillon.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const admin = await requirePlatformAdmin(req);
    const where: Record<string, unknown> = {
      platform_organization_id: admin.platformOrganizationId,
      type: 'note',
    };

    const companyId = first(req.query.company_id);
    if (typeof companyId === 'string' && companyId) where.company_id = companyId;

    const limitRaw = Number(first(req.query.limit) ?? 100);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 100;

    const result = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const items = await tx.crm_activities.findMany({
        where,
        orderBy: { occurred_at: 'desc' },
        take: limit,
        include: { crm_companies: { select: { id: true, name: true, stage: true } } },
      });
      const total = await tx.crm_activities.count({ where });
      return { items, total };
    })) as unknown as { items: unknown; total: number };

    return json(res, 200, { items: result.items, total: result.total, limit });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isAdminAccessDenied(error)) return json(res, 403, { error: 'admin_access_denied' });
    const business = sqlBusinessError(error);
    if (business) return json(res, business.status, business);
    console.error('GET /api/admin/notes failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
