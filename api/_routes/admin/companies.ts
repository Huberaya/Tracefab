import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { isUnauthorized } from '../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { COMPANY_TYPES, MATURITIES, PIPELINE_STAGES, PRIORITIES, parseCompanyInput } from '../../_lib/crm.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';

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

    const where: Record<string, unknown> = { platform_organization_id: admin.platformOrganizationId };

    const stage = first(req.query.stage);
    if (typeof stage === 'string' && stage) {
      if (![...PIPELINE_STAGES, 'lost'].includes(stage)) return json(res, 400, { error: 'stage_unknown' });
      where.stage = stage;
    }

    const priority = first(req.query.priority);
    if (typeof priority === 'string' && priority) {
      if (!PRIORITIES.includes(priority as (typeof PRIORITIES)[number])) {
        return json(res, 400, { error: 'priority_unknown' });
      }
      where.priority = priority;
    }

    const companyType = first(req.query.company_type);
    if (typeof companyType === 'string' && companyType) {
      if (!COMPANY_TYPES.includes(companyType as (typeof COMPANY_TYPES)[number])) {
        return json(res, 400, { error: 'company_type_unknown' });
      }
      where.company_type = companyType;
    }

    const maturity = first(req.query.maturity);
    if (typeof maturity === 'string' && maturity) {
      if (!MATURITIES.includes(maturity as (typeof MATURITIES)[number])) {
        return json(res, 400, { error: 'maturity_unknown' });
      }
      where.maturity = maturity;
    }

    const country = first(req.query.country);
    if (typeof country === 'string' && country) where.country_code = country.toUpperCase();

    const search = first(req.query.q);
    if (typeof search === 'string' && search.trim()) {
      const term = search.trim();
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { website: { contains: term, mode: 'insensitive' } },
        { city: { contains: term, mode: 'insensitive' } },
        { industry: { contains: term, mode: 'insensitive' } },
      ];
    }

    const due = first(req.query.due);
    if (due === 'today') {
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      where.next_contact_at = { lte: end };
      where.stage = { notIn: ['customer', 'lost'] };
    }

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
