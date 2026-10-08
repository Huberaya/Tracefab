import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { isUnauthorized } from '../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { PRIORITIES, TASK_STATUSES, TASK_TYPES, parseTaskInput } from '../../_lib/crm.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';

const first = (value: unknown) => (Array.isArray(value) ? value[0] : value);

/**
 * GET  /api/admin/tasks — vue TODAY et filtres (due, statut, priorité, type)
 * POST /api/admin/tasks
 *
 * `due=today` renvoie l'échéance du jour ET le retard. Séparer les deux dans la
 * réponse aurait laissé croire qu'un commercial en retard est à l'heure ; les
 * deux sont regroupés sous `actionable` côté client, mais la base les distingue.
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
      if (!TASK_STATUSES.includes(status as (typeof TASK_STATUSES)[number])) {
        return json(res, 400, { error: 'task_status_unknown' });
      }
      where.status = status;
    } else if (status === undefined) {
      /* Par défaut, la journée commerciale : pas l'archive. */
      where.status = 'open';
    }

    const priority = first(req.query.priority);
    if (typeof priority === 'string' && priority) {
      if (!PRIORITIES.includes(priority as (typeof PRIORITIES)[number])) {
        return json(res, 400, { error: 'priority_unknown' });
      }
      where.priority = priority;
    }

    const type = first(req.query.type);
    if (typeof type === 'string' && type) {
      if (!TASK_TYPES.includes(type as (typeof TASK_TYPES)[number])) {
        return json(res, 400, { error: 'task_type_unknown' });
      }
      where.type = type;
    }

    const companyId = first(req.query.company_id);
    if (typeof companyId === 'string' && companyId) where.company_id = companyId;

    const due = first(req.query.due);
    if (due === 'today') {
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      where.due_at = { lte: end };
    } else if (due === 'overdue') {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      where.due_at = { lt: start };
    } else if (due === 'undated') {
      where.due_at = null;
    }

    const limitRaw = Number(first(req.query.limit) ?? 200);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 200;

    const items = (await withTracefabUserContext(admin.userId, admin.userEmail, (tx) =>
      tx.crm_tasks.findMany({
        where,
        orderBy: [{ due_at: 'asc' }, { priority: 'asc' }, { created_at: 'desc' }],
        take: limit,
      }),
    )) as unknown;

    return json(res, 200, { items, limit });
  } catch (error) {
    return fail(res, error, 'GET /api/admin/tasks');
  }
}

async function create(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const parsed = parseTaskInput((req.body || {}) as Record<string, unknown>);
    if (parsed.errors.length) return json(res, 422, { error: 'invalid_task', details: parsed.errors });

    const created = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const data = { ...(parsed.data as Record<string, unknown>) };
      /* Une tâche marquée « faite » à la création porte sa date de fin : la
         contrainte en base l'exige, autant la satisfaire ici. */
      if (data.status === 'done' && !data.completed_at) data.completed_at = new Date().toISOString();
      return tx.crm_tasks.create({
        data: {
          ...data,
          platform_organization_id: admin.platformOrganizationId,
          assignee_name: (data.assignee_name as string) || admin.fullName,
          assignee_user_id: admin.userId,
        } as never,
      });
    })) as unknown;

    return json(res, 201, { task: created });
  } catch (error) {
    return fail(res, error, 'POST /api/admin/tasks');
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
