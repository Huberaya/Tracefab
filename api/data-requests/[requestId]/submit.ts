import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth';
import { withTracefabUserContext } from '../../_lib/context';
import { json, methodNotAllowed } from '../../_lib/http';
import { sqlBusinessError } from '../../_lib/sql-errors';
import { isUuid, REQUEST_SELECT, serializeRequest } from '../../_lib/data-requests';

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
    const request = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM tracefab_submit_data_request(${requestId}::uuid)
      `;
      if (!rows[0]?.id) throw new Error('data_request_submit_failed');
      const submitted = await tx.data_requests.findUnique({ where: { id: requestId }, select: REQUEST_SELECT });
      if (!submitted) throw new Error('data_request_submit_failed');
      return submitted;
    });

    return json(res, 200, {
      request: serializeRequest(request),
      delivery: { status: 'queued' },
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('POST /api/data-requests/:requestId/submit failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
