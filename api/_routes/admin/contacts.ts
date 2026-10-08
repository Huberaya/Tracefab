import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { isUnauthorized } from '../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { CONTACT_STATUSES, parseContactInput } from '../../_lib/crm.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';

/**
 * GET  /api/admin/contacts          — liste (filtre par entreprise, statut, recherche)
 * POST /api/admin/contacts          — création, rattachée à une entreprise
 *
 * Un contact n'existe jamais sans entreprise : `company_id` est obligatoire. Un
 * carnet d'adresses orphelin ne peut pas être qualifié, et la contrainte de
 * cohérence d'organisation en base s'appuie sur ce rattachement.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') return list(req, res);
  if (req.method === 'POST') return create(req, res);
  return methodNotAllowed(res, ['GET', 'POST']);
}

const first = (value: unknown) => (Array.isArray(value) ? value[0] : value);

async function list(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);

    const where: Record<string, unknown> = { platform_organization_id: admin.platformOrganizationId };

    const companyId = first(req.query.company_id);
    if (typeof companyId === 'string' && companyId) where.company_id = companyId;

    const status = first(req.query.status);
    if (typeof status === 'string' && status) {
      if (!CONTACT_STATUSES.includes(status as (typeof CONTACT_STATUSES)[number])) {
        return json(res, 400, { error: 'status_unknown' });
      }
      where.status = status;
    }

    const decisionMaker = first(req.query.decision_maker);
    if (decisionMaker === 'true') where.is_decision_maker = true;

    const search = first(req.query.q);
    if (typeof search === 'string' && search.trim()) {
      const term = search.trim();
      where.OR = [
        { first_name: { contains: term, mode: 'insensitive' } },
        { last_name: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { job_title: { contains: term, mode: 'insensitive' } },
      ];
    }

    const limitRaw = Number(first(req.query.limit) ?? 100);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 100;

    const items = (await withTracefabUserContext(admin.userId, admin.userEmail, (tx) =>
      tx.crm_contacts.findMany({
        where,
        orderBy: [{ is_decision_maker: 'desc' }, { influence_level: 'desc' }, { created_at: 'asc' }],
        take: limit,
        include: { crm_companies: { select: { id: true, name: true, stage: true, priority: true } } },
      }),
    )) as unknown;

    return json(res, 200, { items, limit });
  } catch (error) {
    return fail(res, error, 'GET /api/admin/contacts');
  }
}

async function create(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const body = { ...((req.body || {}) as Record<string, unknown>) };
    const companyId = typeof body.company_id === 'string' ? body.company_id.trim() : '';
    if (!companyId) return json(res, 422, { error: 'company_id_required' });

    const parsed = parseContactInput(body);
    if (parsed.errors.length) return json(res, 422, { error: 'invalid_contact', details: parsed.errors });

    const created = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const company = await tx.crm_companies.findFirst({
        where: { id: companyId, platform_organization_id: admin.platformOrganizationId },
        select: { id: true },
      });
      if (!company) return null;
      return tx.crm_contacts.create({
        data: {
          ...(parsed.data as Record<string, unknown>),
          company_id: companyId,
          platform_organization_id: admin.platformOrganizationId,
        } as never,
      });
    })) as unknown;

    if (!created) return json(res, 404, { error: 'crm_company_not_found' });
    return json(res, 201, { contact: created });
  } catch (error) {
    return fail(res, error, 'POST /api/admin/contacts');
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
