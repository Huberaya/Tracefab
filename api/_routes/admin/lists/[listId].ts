import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { isUnauthorized } from '../../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { sanitizeSavedFilters } from '../../../_lib/crm-import.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { auditAdmin } from '../../../_lib/crm-audit-write.js';

/**
 * GET    /api/admin/lists/:listId
 * PATCH  /api/admin/lists/:listId — renomme, met à jour les filtres
 * DELETE /api/admin/lists/:listId
 *
 * Supprimer une liste ne touche aucune entreprise : une liste est une vue, pas
 * un sous-ensemble de données.
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
    const list = (await withTracefabUserContext(admin.userId, admin.userEmail, (tx) =>
      tx.crm_saved_views.findFirst({
        where: { id: String(req.query.listId), platform_organization_id: admin.platformOrganizationId },
      }),
    )) as unknown;
    if (!list) return json(res, 404, { error: 'crm_saved_view_not_found' });
    return json(res, 200, { list });
  } catch (error) {
    return fail(res, error, 'GET /api/admin/lists/:id');
  }
}

async function update(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const listId = String(req.query.listId);
    const body = { ...((req.body || {}) as Record<string, unknown>) };

    const data: Record<string, unknown> = {};
    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim().slice(0, 120);
    if (body.filters !== undefined) {
      const filters = sanitizeSavedFilters(body.filters);
      if (!Object.keys(filters).length) return json(res, 422, { error: 'no_known_filter' });
      data.filters = filters;
    }
    if (!Object.keys(data).length) return json(res, 422, { error: 'nothing_to_update' });

    const updated = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const existing = await tx.crm_saved_views.findFirst({
        where: { id: listId, platform_organization_id: admin.platformOrganizationId },
        select: { id: true },
      });
      if (!existing) return null;
      const updated = await tx.crm_saved_views.update({ where: { id: listId }, data: data as never });
      await auditAdmin(tx as never, {
        admin, entity: 'crm_saved_view', action: 'updated', entityId: listId,
        after: { name: data.name } as Record<string, unknown>,
      });
      return updated;
    })) as unknown;

    if (!updated) return json(res, 404, { error: 'crm_saved_view_not_found' });
    return json(res, 200, { list: updated });
  } catch (error) {
    return fail(res, error, 'PATCH /api/admin/lists/:id');
  }
}

async function remove(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const listId = String(req.query.listId);
    const removed = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const existing = await tx.crm_saved_views.findFirst({
        where: { id: listId, platform_organization_id: admin.platformOrganizationId },
        select: { id: true },
      });
      if (!existing) return null;
      const removed = await tx.crm_saved_views.delete({ where: { id: listId } });
      await auditAdmin(tx as never, {
        admin, entity: 'crm_saved_view', action: 'list_deleted', entityId: listId,
        before: removed as unknown as Record<string, unknown>, after: null,
      });
      return removed;
    })) as unknown;
    if (!removed) return json(res, 404, { error: 'crm_saved_view_not_found' });
    return json(res, 200, { deleted: true });
  } catch (error) {
    return fail(res, error, 'DELETE /api/admin/lists/:id');
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
