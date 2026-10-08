import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { isUnauthorized } from '../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { MEETING_MODES, parseMeetingInput } from '../../_lib/crm.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';
import { auditAdmin } from '../../_lib/crm-audit-write.js';

const first = (value: unknown) => (Array.isArray(value) ? value[0] : value);

/**
 * GET  /api/admin/meetings — à venir par défaut (une liste de RDV passés n'aide personne)
 * POST /api/admin/meetings — écrit aussi une activité `meeting` sur l'entreprise
 *
 * Planifier un rendez-vous et déplacer l'étape du pipeline sont deux faits
 * distincts : le premier est un engagement d'agenda, le second un avancement
 * commercial. Les deux laissent leur trace, sous deux types d'activité différents.
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

    const companyId = first(req.query.company_id);
    if (typeof companyId === 'string' && companyId) where.company_id = companyId;

    const mode = first(req.query.mode);
    if (typeof mode === 'string' && mode) {
      if (!MEETING_MODES.includes(mode as (typeof MEETING_MODES)[number])) {
        return json(res, 400, { error: 'meeting_mode_unknown' });
      }
      where.mode = mode;
    }

    const scope = first(req.query.scope) || 'upcoming';
    const now = new Date();
    if (scope === 'upcoming') where.starts_at = { gte: now };
    else if (scope === 'past') where.starts_at = { lt: now };
    else if (scope !== 'all') return json(res, 400, { error: 'scope_unknown' });

    const limitRaw = Number(first(req.query.limit) ?? 100);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 100;

    const items = (await withTracefabUserContext(admin.userId, admin.userEmail, (tx) =>
      tx.crm_meetings.findMany({
        where,
        orderBy: { starts_at: scope === 'past' ? 'desc' : 'asc' },
        take: limit,
        include: { crm_companies: { select: { id: true, name: true, stage: true, priority: true } } },
      }),
    )) as unknown;

    return json(res, 200, { items, scope, limit });
  } catch (error) {
    return fail(res, error, 'GET /api/admin/meetings');
  }
}

async function create(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const parsed = parseMeetingInput((req.body || {}) as Record<string, unknown>);
    if (parsed.errors.length) return json(res, 422, { error: 'invalid_meeting', details: parsed.errors });
    const data = parsed.data as Record<string, unknown>;

    const created = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const companyId = data.company_id as string | undefined;
      if (companyId) {
        const company = await tx.crm_companies.findFirst({
          where: { id: companyId, platform_organization_id: admin.platformOrganizationId },
          select: { id: true, name: true },
        });
        if (!company) return null;

        const meeting = await tx.crm_meetings.create({
          data: {
            ...data,
            company_id: companyId,
            platform_organization_id: admin.platformOrganizationId,
          } as never,
        });

        await tx.crm_activities.create({
          data: {
            company_id: companyId,
            platform_organization_id: admin.platformOrganizationId,
            type: 'meeting',
            summary: data.subject as string,
            detail: (data.location as string) || null,
            actor_user_id: admin.userId,
            actor_name: admin.fullName,
            occurred_at: new Date(),
          } as never,
        });

        await auditAdmin(tx as never, {
          admin, entity: 'crm_meeting', action: 'meeting_scheduled', entityId: meeting.id,
          before: null, after: meeting as unknown as Record<string, unknown>,
        });

        return meeting;
      }

      const loose = await tx.crm_meetings.create({
        data: { ...data, platform_organization_id: admin.platformOrganizationId } as never,
      });
      await auditAdmin(tx as never, {
        admin, entity: 'crm_meeting', action: 'meeting_scheduled', entityId: loose.id,
        before: null, after: loose as unknown as Record<string, unknown>,
      });
      return loose;
    })) as unknown;

    if (!created) return json(res, 404, { error: 'crm_company_not_found' });
    return json(res, 201, { meeting: created });
  } catch (error) {
    return fail(res, error, 'POST /api/admin/meetings');
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
