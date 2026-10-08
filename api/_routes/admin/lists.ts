import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { isUnauthorized } from '../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { sanitizeSavedFilters } from '../../_lib/crm-import.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';
import { auditAdmin } from '../../_lib/crm-audit-write.js';

/**
 * GET  /api/admin/lists — listes de prospection de l'équipe (§7)
 * POST /api/admin/lists — enregistre le jeu de filtres courant sous un nom
 *
 * Une liste vit en base, pas en localStorage : « France – Marques de mode » doit
 * exister pour le fondateur comme pour le commercial qui le rejoint.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') return list(req, res);
  if (req.method === 'POST') return create(req, res);
  return methodNotAllowed(res, ['GET', 'POST']);
}

async function list(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const items = (await withTracefabUserContext(admin.userId, admin.userEmail, (tx) =>
      tx.crm_saved_views.findMany({
        where: { platform_organization_id: admin.platformOrganizationId },
        orderBy: { created_at: 'asc' },
        take: 100,
      }),
    )) as unknown;
    return json(res, 200, { items });
  } catch (error) {
    return fail(res, error, 'GET /api/admin/lists');
  }
}

async function create(req: VercelRequest, res: VercelResponse) {
  try {
    const admin = await requirePlatformAdmin(req);
    const body = { ...((req.body || {}) as Record<string, unknown>) };

    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
    if (!name) return json(res, 422, { error: 'name_required' });

    /* Seules les clés de filtre connues sont persistées. Un jsonb libre
       accepterait n'importe quoi, et rejouer un filtre inconnu produirait soit
       une erreur opaque, soit un filtre ignoré qui renverrait tout le
       portefeuille en le faisant passer pour filtré. */
    const filters = sanitizeSavedFilters(body.filters);
    if (!Object.keys(filters).length) return json(res, 422, { error: 'no_known_filter' });

    const created = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const existing = await tx.crm_saved_views.findFirst({
        where: { platform_organization_id: admin.platformOrganizationId, name },
        select: { id: true },
      });
      if (existing) return { conflict: true as const };
      const row = await tx.crm_saved_views.create({
        data: {
          platform_organization_id: admin.platformOrganizationId,
          name,
          filters,
          created_by: admin.userId,
          created_by_name: admin.fullName,
        } as never,
      });
      await auditAdmin(tx as never, {
        admin, entity: 'crm_saved_view', action: 'list_saved', entityId: row.id,
        before: null, after: { name } as Record<string, unknown>,
        metadata: { filters },
      });
      return { conflict: false as const, row };
    })) as unknown as { conflict: boolean; row?: unknown };

    if (created.conflict) return json(res, 409, { error: 'crm_saved_view_duplicate' });
    return json(res, 201, { list: created.row });
  } catch (error) {
    return fail(res, error, 'POST /api/admin/lists');
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
