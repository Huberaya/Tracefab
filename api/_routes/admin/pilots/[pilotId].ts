import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { isUnauthorized } from '../../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { parsePilotInput } from '../../../_lib/crm.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { auditAdmin } from '../../../_lib/crm-audit-write.js';

/**
 * GET   /api/admin/pilots/:pilotId
 * PATCH /api/admin/pilots/:pilotId — progression, problèmes, résultats
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') return read(req, res);
  if (req.method === 'PATCH') return update(req, res);
  return methodNotAllowed(res, ['GET', 'PATCH']);
}

async function read(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const pilot = (await withTracefabUserContext(admin.userId, admin.userEmail, (tx) =>
      tx.crm_pilots.findFirst({
        where: { id: String(req.query.pilotId), platform_organization_id: admin.platformOrganizationId },
      }),
    )) as unknown;
    if (!pilot) return json(res, 404, { error: 'crm_pilot_not_found' });
    return json(res, 200, { pilot, measurement: 'declared' });
  } catch (error) {
    return fail(res, error, 'GET /api/admin/pilots/:id');
  }
}

async function update(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const pilotId = String(req.query.pilotId);
    const body = { ...((req.body || {}) as Record<string, unknown>) };

    const parsed = parsePilotInput(body);
    if (parsed.errors.length) return json(res, 422, { error: 'invalid_pilot', details: parsed.errors });
    const data = { ...(parsed.data as Record<string, unknown>) };
    delete data.company_id;

    const updated = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const existing = await tx.crm_pilots.findFirst({
        where: { id: pilotId, platform_organization_id: admin.platformOrganizationId },
        select: { id: true },
      });
      if (!existing) return null;
      const pilot = await tx.crm_pilots.update({ where: { id: pilotId }, data: data as never });
      await auditAdmin(tx as never, {
        admin, entity: 'crm_pilot', action: 'pilot_updated', entityId: pilotId,
        after: pilot as unknown as Record<string, unknown>,
      });
      return pilot;
    })) as unknown;

    if (!updated) return json(res, 404, { error: 'crm_pilot_not_found' });
    return json(res, 200, { pilot: updated, measurement: 'declared' });
  } catch (error) {
    return fail(res, error, 'PATCH /api/admin/pilots/:id');
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
