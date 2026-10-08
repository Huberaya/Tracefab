import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { isUnauthorized } from '../../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { parseMeetingInput } from '../../../_lib/crm.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';

/**
 * GET   /api/admin/meetings/:meetingId
 * PATCH /api/admin/meetings/:meetingId — reprogramme, consigne l'issue
 *
 * Le `company_id` n'est pas modifiable : déplacer un rendez-vous vers une autre
 * entreprise réécrirait l'histoire commerciale de deux comptes d'un coup.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') return read(req, res);
  if (req.method === 'PATCH') return update(req, res);
  return methodNotAllowed(res, ['GET', 'PATCH']);
}

async function read(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const meeting = (await withTracefabUserContext(admin.userId, admin.userEmail, (tx) =>
      tx.crm_meetings.findFirst({
        where: { id: String(req.query.meetingId), platform_organization_id: admin.platformOrganizationId },
      }),
    )) as unknown;
    if (!meeting) return json(res, 404, { error: 'crm_meeting_not_found' });
    return json(res, 200, { meeting });
  } catch (error) {
    return fail(res, error, 'GET /api/admin/meetings/:id');
  }
}

async function update(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const meetingId = String(req.query.meetingId);
    const body = { ...((req.body || {}) as Record<string, unknown>) };

    const parsed = parseMeetingInput(body);
    if (parsed.errors.length) return json(res, 422, { error: 'invalid_meeting', details: parsed.errors });
    const data = { ...(parsed.data as Record<string, unknown>) };
    delete data.company_id;
    delete data.contact_id;

    const updated = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const existing = await tx.crm_meetings.findFirst({
        where: { id: meetingId, platform_organization_id: admin.platformOrganizationId },
        select: { id: true },
      });
      if (!existing) return null;
      return tx.crm_meetings.update({ where: { id: meetingId }, data: data as never });
    })) as unknown;

    if (!updated) return json(res, 404, { error: 'crm_meeting_not_found' });
    return json(res, 200, { meeting: updated });
  } catch (error) {
    return fail(res, error, 'PATCH /api/admin/meetings/:id');
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
