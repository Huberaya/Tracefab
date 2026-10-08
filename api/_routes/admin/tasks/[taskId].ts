import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { isUnauthorized } from '../../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { parseTaskInput } from '../../../_lib/crm.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { auditAdmin } from '../../../_lib/crm-audit-write.js';

/**
 * GET    /api/admin/tasks/:taskId
 * PATCH  /api/admin/tasks/:taskId  — dont le passage à `done` / `open`
 * DELETE /api/admin/tasks/:taskId
 *
 * La date de fin est posée par le serveur, jamais par le client : une tâche
 * « faite hier » saisie aujourd'hui fausserait la journée commerciale.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') return read(req, res);
  if (req.method === 'PATCH') return update(req, res);
  if (req.method === 'DELETE') return remove(req, res);
  return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
}

async function read(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const task = (await withTracefabUserContext(admin.userId, admin.userEmail, (tx) =>
      tx.crm_tasks.findFirst({
        where: { id: String(req.query.taskId), platform_organization_id: admin.platformOrganizationId },
      }),
    )) as unknown;
    if (!task) return json(res, 404, { error: 'crm_task_not_found' });
    return json(res, 200, { task });
  } catch (error) {
    return fail(res, error, 'GET /api/admin/tasks/:id');
  }
}

async function update(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const taskId = String(req.query.taskId);
    const body = { ...((req.body || {}) as Record<string, unknown>) };

    const parsed = parseTaskInput(body);
    if (parsed.errors.length) return json(res, 422, { error: 'invalid_task', details: parsed.errors });
    const data = { ...(parsed.data as Record<string, unknown>) };
    delete data.company_id;
    delete data.contact_id;

    const updated = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const existing = await tx.crm_tasks.findFirst({
        where: { id: taskId, platform_organization_id: admin.platformOrganizationId },
        select: { id: true, status: true },
      });
      if (!existing) return null;

      const target = (data.status as string) || existing.status;
      if (target === 'done' && existing.status !== 'done') data.completed_at = new Date().toISOString();
      if (target !== 'done') data.completed_at = null;

      const task = await tx.crm_tasks.update({ where: { id: taskId }, data: data as never });
      await auditAdmin(tx as never, {
        admin,
        entity: 'crm_task',
        action: target === 'done' ? 'task_completed'
          : existing.status === 'done' ? 'task_reopened' : 'updated',
        entityId: taskId,
        before: { status: existing.status },
        after: task as unknown as Record<string, unknown>,
      });
      return task;
    })) as unknown;

    if (!updated) return json(res, 404, { error: 'crm_task_not_found' });
    return json(res, 200, { task: updated });
  } catch (error) {
    return fail(res, error, 'PATCH /api/admin/tasks/:id');
  }
}

async function remove(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const taskId = String(req.query.taskId);
    const removed = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const existing = await tx.crm_tasks.findFirst({
        where: { id: taskId, platform_organization_id: admin.platformOrganizationId },
        select: { id: true },
      });
      if (!existing) return null;
      const removed = await tx.crm_tasks.delete({ where: { id: taskId } });
      await auditAdmin(tx as never, {
        admin, entity: 'crm_task', action: 'deleted', entityId: taskId,
        before: removed as unknown as Record<string, unknown>, after: null,
      });
      return removed;
    })) as unknown;
    if (!removed) return json(res, 404, { error: 'crm_task_not_found' });
    return json(res, 200, { deleted: true });
  } catch (error) {
    return fail(res, error, 'DELETE /api/admin/tasks/:id');
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
