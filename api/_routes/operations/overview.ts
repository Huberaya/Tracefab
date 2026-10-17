import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabRequestContext } from '../../_lib/context.js';
import { isTenantError, requireActiveTenant } from '../../_lib/tenant.js';
import { json, methodNotAllowed } from '../../_lib/http.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const { user } = await requireClerkUser(req);
    const result = await withTracefabRequestContext(req, user, async (tx) => {
      // Locataire actif obligatoire, et role owner/admin DANS ce locataire.
      // Le tableau de bord d'exploitation melangeait auparavant la file de
      // notifications de toutes les organisations du compte.
      const tenant = await requireActiveTenant(tx, req, user.id, { roles: ['owner', 'admin'] });
      const memberships = [{ organization_id: tenant.organizationId, role: tenant.role }];
      const organizationIds = [tenant.organizationId];

      const rows = await tx.$queryRaw<Array<{ status: string; count: bigint; oldest: Date | null }>>`
        SELECT status, count(*)::bigint AS count, min(created_at) AS oldest
        FROM tracefab_notification_outbox
        WHERE recipient_organization_id = ANY(${organizationIds}::uuid[])
        GROUP BY status
      `;
      const summary = { pending: 0, processing: 0, sent: 0, failed: 0, oldestPendingAt: null as Date | null };
      for (const row of rows) {
        if (row.status === 'pending') { summary.pending = Number(row.count); summary.oldestPendingAt = row.oldest; }
        if (row.status === 'processing') summary.processing = Number(row.count);
        if (row.status === 'sent') summary.sent = Number(row.count);
        if (row.status === 'failed') summary.failed = Number(row.count);
      }
      const blockedRows = await tx.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint AS count
        FROM tracefab_notification_outbox
        WHERE recipient_organization_id = ANY(${organizationIds}::uuid[])
          AND status = 'processing'
          AND locked_at < now() - interval '15 minutes'
      `;
      return {
        organizations: memberships.map((membership) => ({ organizationId: membership.organization_id, role: membership.role })),
        notifications: { ...summary, blocked: Number(blockedRows[0]?.count ?? 0) },
        alertingConfigured: Boolean(process.env.TRACEFAB_NOTIFICATION_ALERT_URL?.trim()),
        schedulerConfigured: Boolean(process.env.CRON_SECRET?.trim()),
        workerConfigured: Boolean(process.env.TRACEFAB_NOTIFICATION_WORKER_SECRET?.trim()),
      };
    });

    if (!result) return json(res, 403, { error: 'operations_admin_required' });
    res.setHeader('Cache-Control', 'no-store');
    return json(res, 200, result);
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isTenantError(error)) return json(res, error.status, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('GET /api/operations/overview failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
