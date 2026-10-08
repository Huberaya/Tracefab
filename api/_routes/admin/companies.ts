import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { isUnauthorized } from '../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { COMPANY_TYPES, MATURITIES, PIPELINE_STAGES, PRIORITIES, parseCompanyInput } from '../../_lib/crm.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';
import { auditAdmin } from '../../_lib/crm-audit-write.js';
import { buildCompanyFilters } from '../../_lib/crm-filters.js';

const COMPANY_FIELDS = {
  id: true,
  name: true,
  website: true,
  country_code: true,
  city: true,
  industry: true,
  company_type: true,
  employee_band: true,
  revenue_band: true,
  product_count: true,
  supplier_count: true,
  maturity: true,
  priority: true,
  stage: true,
  lost_reason: true,
  source: true,
  source_detail: true,
  collected_at: true,
  owner_name: true,
  notes: true,
  estimated_value_eur: true,
  last_contact_at: true,
  next_contact_at: true,
  created_at: true,
  updated_at: true,
} as const;

const first = (value: unknown) => (Array.isArray(value) ? value[0] : value);

/**
 * GET  /api/admin/companies  — liste filtrable et paginée
 * POST /api/admin/companies  — création
 *
 * Les filtres acceptés sont déclarés explicitement : une liste blanche, pas un
 * objet de requête recopié dans un `where`. Sans cela, un paramètre inattendu
 * deviendrait un filtre Prisma non voulu.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') return list(req, res);
  if (req.method === 'POST') return create(req, res);
  return methodNotAllowed(res, ['GET', 'POST']);
}

async function list(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);

    const limitRaw = Number(first(req.query.limit) ?? 50);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? limitRaw : 50;
    const offsetRaw = Number(first(req.query.offset) ?? 0);
    const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

    /*
     * Le même module construit les filtres de la liste ET ceux de l'export CSV.
     * Deux implémentations séparées finiraient par diverger, et un export qui ne
     * correspond pas à l'écran a l'air fiable alors qu'il ne l'est pas.
     */
    const filters = buildCompanyFilters(
      req.query as Record<string, string | string[] | undefined>,
      admin.platformOrganizationId,
    );
    if (filters.error) return json(res, 400, { error: filters.error });
    const where = filters.where;

    const [items, total] = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => [
      await tx.crm_companies.findMany({
        where,
        select: COMPANY_FIELDS,
        orderBy: [{ priority: 'asc' }, { updated_at: 'desc' }],
        take: limit,
        skip: offset,
      }),
      await tx.crm_companies.count({ where }),
    ])) as unknown as [Record<string, unknown>[], number];

    return json(res, 200, { items, total, limit, offset });
  } catch (error) {
    return fail(res, error, 'GET /api/admin/companies');
  }
}

async function create(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const parsed = parseCompanyInput((req.body || {}) as Record<string, unknown>);
    if (parsed.errors.length) return json(res, 422, { error: 'invalid_company', details: parsed.errors });

    const created = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const company = await tx.crm_companies.create({
        data: {
          ...(parsed.data as Record<string, unknown>),
          platform_organization_id: admin.platformOrganizationId,
          owner_name: (parsed.data.owner_name as string) || admin.fullName,
        } as never,
        select: COMPANY_FIELDS,
      });
      await tx.crm_activities.create({
        data: {
          company_id: company.id,
          platform_organization_id: admin.platformOrganizationId,
          type: 'created',
          summary: `Prospect créé : ${company.name}`,
          actor_user_id: admin.userId,
          actor_name: admin.fullName,
          to_stage: (company.stage as never) ?? 'new',
        } as never,
      });
      await auditAdmin(tx as never, {
        admin, entity: 'crm_company', action: 'created', entityId: company.id,
        before: null, after: company as unknown as Record<string, unknown>,
      });
      return company;
    })) as unknown as Record<string, unknown>;

    return json(res, 201, { company: created });
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2002') {
      return json(res, 409, { error: 'crm_company_duplicate' });
    }
    return fail(res, error, 'POST /api/admin/companies');
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
