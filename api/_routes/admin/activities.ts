import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { isUnauthorized } from '../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { ACTIVITY_TYPES } from '../../_lib/crm.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';

const first = (value: unknown) => (Array.isArray(value) ? value[0] : value);

/**
 * GET /api/admin/activities — timeline globale, toutes entreprises confondues.
 *
 * Lecture seule : la création d'une activité passe par l'entreprise concernée
 * (/api/admin/companies/:id/activities), parce qu'une activité sans entreprise
 * n'existe pas en base. POST est refusé ici plutôt que silencieusement ignoré.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') return list(req, res);
  return methodNotAllowed(res, ['GET']);
}

async function list(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const where: Record<string, unknown> = { platform_organization_id: admin.platformOrganizationId };

    const type = first(req.query.type);
    if (typeof type === 'string' && type) {
      if (!(ACTIVITY_TYPES as readonly string[]).includes(type)) {
        return json(res, 400, { error: 'activity_type_unknown' });
      }
      where.type = type;
    }

    const limitRaw = Number(first(req.query.limit) ?? 100);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 100;

    const items = (await withTracefabUserContext(admin.userId, admin.userEmail, (tx) =>
      tx.crm_activities.findMany({
        where,
        orderBy: { occurred_at: 'desc' },
        take: limit,
        include: { crm_companies: { select: { id: true, name: true, stage: true } } },
      }),
    )) as unknown;

    return json(res, 200, { items, limit });
  } catch (error) {
    return fail(res, error, 'GET /api/admin/activities');
  }
}

function fail(res: VercelResponse, error: unknown, label: string) {
  if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
  if (isAdminAccessDenied(error)) return json(res, 403, { error: 'admin_access_denied' });
  const business = sqlBusinessError(error);
  if (business) return json(res, business.status, business);
  console.error(`${label} failed`, error);
  return json(res, 500, { error: 'internal_server_error' });
}
