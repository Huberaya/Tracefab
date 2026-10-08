import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { isUnauthorized } from '../../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { parseCompanyInput } from '../../../_lib/crm.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';

/**
 * GET   /api/admin/companies/:companyId — fiche complète (entreprise, contacts, activité)
 * PATCH /api/admin/companies/:companyId — mise à jour
 *
 * `stage` n'est pas modifiable ici : passer par /stage garantit qu'un mouvement
 * de pipeline est toujours journalisé. Un PATCH silencieux sur `stage` rendrait
 * l'historique commercial faux.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') return read(req, res);
  if (req.method === 'PATCH') return update(req, res);
  return methodNotAllowed(res, ['GET', 'PATCH']);
}

async function read(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const companyId = String(req.query.companyId);

    const result = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const company = await tx.crm_companies.findFirst({
        where: { id: companyId, platform_organization_id: admin.platformOrganizationId },
        include: {
          crm_contacts: { orderBy: { created_at: 'asc' } },
          crm_activities: { orderBy: { occurred_at: 'desc' }, take: 100 },
        },
      });
      return company;
    })) as unknown;

    if (!result) return json(res, 404, { error: 'crm_company_not_found' });

    const company = result as Record<string, unknown> & {
      crm_contacts: unknown[];
      crm_activities: unknown[];
    };
    return json(res, 200, {
      company,
      contacts: company.crm_contacts,
      activities: company.crm_activities,
    });
  } catch (error) {
    return fail(res, error, 'GET /api/admin/companies/:id');
  }
}

async function update(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const companyId = String(req.query.companyId);
    const body = { ...((req.body || {}) as Record<string, unknown>) };

    // Le pipeline a sa propre route : la journalisation n'est pas optionnelle.
    delete body.stage;
    delete body.lost_reason;

    const parsed = parseCompanyInput(body);
    if (parsed.errors.length) return json(res, 422, { error: 'invalid_company', details: parsed.errors });
    if (!parsed.data || Object.keys(parsed.data).length === 0) {
      return json(res, 422, { error: 'no_updatable_field' });
    }

    const updated = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const existing = await tx.crm_companies.findFirst({
        where: { id: companyId, platform_organization_id: admin.platformOrganizationId },
        select: { id: true },
      });
      if (!existing) return null;
      return tx.crm_companies.update({
        where: { id: companyId },
        data: parsed.data as never,
      });
    })) as unknown;

    if (!updated) return json(res, 404, { error: 'crm_company_not_found' });
    return json(res, 200, { company: updated });
  } catch (error) {
    return fail(res, error, 'PATCH /api/admin/companies/:id');
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
