import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../../_lib/http.js';
import { isUnauthorized } from '../../../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../../../_lib/context.js';
import { ACTIVITY_TYPES } from '../../../../_lib/crm.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';

/**
 * GET  /api/admin/companies/:companyId/activities — timeline
 * POST /api/admin/companies/:companyId/activities — note manuelle
 *
 * La table est en `REVOKE UPDATE, DELETE` : une activité écrite ne peut plus être
 * modifiée ni effacée. C'est ce qui fait de la timeline une preuve et non un
 * brouillon.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') return list(req, res);
  if (req.method === 'POST') return add(req, res);
  return methodNotAllowed(res, ['GET', 'POST']);
}

async function list(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const companyId = String(req.query.companyId);

    const items = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const company = await tx.crm_companies.findFirst({
        where: { id: companyId, platform_organization_id: admin.platformOrganizationId },
        select: { id: true },
      });
      if (!company) return null;
      return tx.crm_activities.findMany({
        where: { company_id: companyId, platform_organization_id: admin.platformOrganizationId },
        orderBy: { occurred_at: 'desc' },
        take: 200,
      });
    })) as unknown;

    if (items === null) return json(res, 404, { error: 'crm_company_not_found' });
    return json(res, 200, { items });
  } catch (error) {
    return fail(res, error, 'GET /api/admin/companies/:id/activities');
  }
}

async function add(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const companyId = String(req.query.companyId);
    const body = (req.body || {}) as Record<string, unknown>;

    const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
    if (!summary) return json(res, 422, { error: 'summary_required' });

    const type = typeof body.type === 'string' && (ACTIVITY_TYPES as readonly string[]).includes(body.type)
      ? body.type
      : 'note';
    // Un changement d'état ne s'écrit pas à la main : il passe par /stage, qui
    // met l'entreprise à jour dans la même transaction.
    if (type === 'status_change' || type === 'conversion') {
      return json(res, 422, { error: 'use_stage_endpoint_for_pipeline_changes' });
    }

    const created = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const company = await tx.crm_companies.findFirst({
        where: { id: companyId, platform_organization_id: admin.platformOrganizationId },
        select: { id: true },
      });
      if (!company) return null;
      return tx.crm_activities.create({
        data: {
          company_id: companyId,
          platform_organization_id: admin.platformOrganizationId,
          type: type as never,
          summary: summary.slice(0, 300),
          detail: typeof body.detail === 'string' ? body.detail.slice(0, 4000) : null,
          actor_user_id: admin.userId,
          actor_name: admin.fullName,
        } as never,
      });
    })) as unknown;

    if (!created) return json(res, 404, { error: 'crm_company_not_found' });
    return json(res, 201, { activity: created });
  } catch (error) {
    return fail(res, error, 'POST /api/admin/companies/:id/activities');
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
