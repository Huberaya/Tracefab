import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { activeOrganizationIds } from '../../../_lib/products.js';
import { isUuid } from '../../../_lib/data-requests.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';

function routeRequestId(req: VercelRequest) {
  const value = req.query.requestId;
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const requestId = routeRequestId(req);
    if (!isUuid(requestId)) return json(res, 400, { error: 'invalid_request_id' });
    const { user } = await requireClerkUser(req);
    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const brandOrganizationIds = await activeOrganizationIds(tx, user.id);
      const request = await tx.data_requests.findFirst({
        where: {
          id: requestId,
          brand_organization_id: { in: brandOrganizationIds },
          status: { in: ['sent', 'in_progress', 'changes_requested'] },
        },
        select: { id: true },
      });
      if (!request) return null;
      const rows = await tx.$queryRaw<Array<{
        id: string;
        event_key: string;
        event_type: string;
        request_id: string;
        status: string;
        available_at: Date;
      }>>`
        SELECT id, event_key, event_type, request_id, status, available_at
        FROM tracefab_enqueue_manual_data_request_reminder(${requestId}::uuid)
      `;
      return rows[0] ?? null;
    });
    if (!result) return json(res, 404, { error: 'data_request_not_found' });
    return json(res, 202, {
      queued: true,
      notification: {
        id: result.id,
        eventKey: result.event_key,
        eventType: result.event_type,
        requestId: result.request_id,
        status: result.status,
        availableAt: result.available_at,
      },
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('POST /api/data-requests/:requestId/remind failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
