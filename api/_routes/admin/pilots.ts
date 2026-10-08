import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { isUnauthorized } from '../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { PILOT_STATUSES, parsePilotInput } from '../../_lib/crm.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';
import { auditAdmin } from '../../_lib/crm-audit-write.js';

const first = (value: unknown) => (Array.isArray(value) ? value[0] : value);

/**
 * GET  /api/admin/pilots
 * POST /api/admin/pilots — un pilote par entreprise (contrainte UNIQUE en base)
 *
 * Les pourcentages d'un pilote sont DÉCLARÉS par l'équipe commerciale. Ils ne sont
 * pas mesurés par TRACEFAB, sauf quand `organization_id` relie un vrai espace
 * TRACEFAB. La route le signale dans `measurement` pour que l'interface ne puisse
 * pas les présenter comme une mesure produit.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') return list(req, res);
  if (req.method === 'POST') return create(req, res);
  return methodNotAllowed(res, ['GET', 'POST']);
}

async function list(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const where: Record<string, unknown> = { platform_organization_id: admin.platformOrganizationId };

    const status = first(req.query.status);
    if (typeof status === 'string' && status) {
      if (!PILOT_STATUSES.includes(status as (typeof PILOT_STATUSES)[number])) {
        return json(res, 400, { error: 'pilot_status_unknown' });
      }
      where.status = status;
    }

    const companyId = first(req.query.company_id);
    if (typeof companyId === 'string' && companyId) where.company_id = companyId;

    const items = (await withTracefabUserContext(admin.userId, admin.userEmail, (tx) =>
      tx.crm_pilots.findMany({
        where,
        orderBy: [{ status: 'asc' }, { starts_at: 'desc' }],
        take: 200,
        include: { crm_companies: { select: { id: true, name: true, stage: true, priority: true } } },
      }),
    )) as unknown;

    return json(res, 200, { items, measurement: 'declared' });
  } catch (error) {
    return fail(res, error, 'GET /api/admin/pilots');
  }
}

async function create(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const body = { ...((req.body || {}) as Record<string, unknown>) };
    const companyId = typeof body.company_id === 'string' ? body.company_id.trim() : '';
    if (!companyId) return json(res, 422, { error: 'company_id_required' });

    const parsed = parsePilotInput(body);
    if (parsed.errors.length) return json(res, 422, { error: 'invalid_pilot', details: parsed.errors });

    const created = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const company = await tx.crm_companies.findFirst({
        where: { id: companyId, platform_organization_id: admin.platformOrganizationId },
        select: { id: true, name: true },
      });
      if (!company) return null;

      const pilot = await tx.crm_pilots.create({
        data: {
          ...(parsed.data as Record<string, unknown>),
          company_id: companyId,
          platform_organization_id: admin.platformOrganizationId,
        } as never,
      });

      /* Un pilote est un fait commercial majeur : la timeline de l'entreprise
         doit le porter, sinon la conversion future n'aura pas d'antécédent. */
      await tx.crm_activities.create({
        data: {
          company_id: companyId,
          platform_organization_id: admin.platformOrganizationId,
          type: 'pilot',
          summary: `Pilot started — ${company.name}`,
          detail: (parsed.data as Record<string, unknown>).objectives as string || null,
          actor_user_id: admin.userId,
          actor_name: admin.fullName,
          occurred_at: new Date(),
        } as never,
      });

      await auditAdmin(tx as never, {
        admin, entity: 'crm_pilot', action: 'created', entityId: pilot.id,
        before: null, after: pilot as unknown as Record<string, unknown>,
      });
      return pilot;
    })) as unknown;

    if (!created) return json(res, 404, { error: 'crm_company_not_found' });
    return json(res, 201, { pilot: created, measurement: 'declared' });
  } catch (error) {
    return fail(res, error, 'POST /api/admin/pilots');
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
