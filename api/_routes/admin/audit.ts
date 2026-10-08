import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { isUnauthorized } from '../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { AUDIT_ACTIONS, AUDIT_ENTITIES, sanitizeAuditFilters } from '../../_lib/crm-audit.js';
import { verifyAuditChainIntegrity } from '../../_lib/audit-vault.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';

const first = (value: unknown) => (Array.isArray(value) ? value[0] : value);

/**
 * GET /api/admin/audit — journal d'audit de la console (§16)
 *
 * Lecture seule. Le journal est écrit par les routes mutantes, jamais ici.
 *
 * `verify=1` rejoue la chaîne de hachage : chaque maillon référence le sceau du
 * précédent, donc une modification rétroactive se détecte. Sans cette
 * vérification, un journal « append-only » n'est qu'une convention.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const admin = await requirePlatformAdmin(req);
    const orgId = admin.platformOrganizationId;
    const clean = sanitizeAuditFilters(req.query);

    const action = first(req.query.action);
    if (typeof action === 'string' && action) {
      if (!(AUDIT_ACTIONS as readonly string[]).includes(action)) {
        return json(res, 400, { error: 'audit_action_unknown' });
      }
    }
    const entityType = first(req.query.entity_type);
    if (typeof entityType === 'string' && entityType) {
      if (!(AUDIT_ENTITIES as readonly string[]).includes(entityType)) {
        return json(res, 400, { error: 'audit_entity_unknown' });
      }
    }
    const since = first(req.query.since);
    if (typeof since === 'string' && since && Number.isNaN(Date.parse(since))) {
      return json(res, 400, { error: 'since_must_be_a_date' });
    }

    const limitRaw = Number(first(req.query.limit) ?? 100);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 100;

    const result = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const where: Record<string, unknown> = { organization_id: orgId };
      if (clean.action) where.action = clean.action;
      if (clean.entity_type) where.entity_type = clean.entity_type;
      if (clean.entity_id) where.entity_id = clean.entity_id;
      if (clean.actor) where.actor_user_id = clean.actor;
      if (clean.since) where.created_at = { gte: new Date(clean.since) };

      const items = await tx.audit_logs.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: limit,
      });

      const total = await tx.audit_logs.count({ where: { organization_id: orgId } });

      let chain: unknown = null;
      if (first(req.query.verify) === '1') {
        chain = await verifyAuditChainIntegrity(tx as never, orgId);
      }

      return { items, total, chain };
    })) as unknown as { items: unknown; total: number; chain: unknown };

    return json(res, 200, {
      items: result.items,
      total: result.total,
      chain: result.chain,
      limit,
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isAdminAccessDenied(error)) return json(res, 403, { error: 'admin_access_denied' });
    const business = sqlBusinessError(error);
    if (business) return json(res, business.status, business);
    console.error('GET /api/admin/audit failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
