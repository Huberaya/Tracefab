import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth';
import { withTracefabUserContext } from '../../_lib/context';
import { json, methodNotAllowed } from '../../_lib/http';
import { sqlBusinessError } from '../../_lib/sql-errors';
import { isUuid, REQUEST_SELECT, serializeRequest } from '../../_lib/data-requests';
import { organizationNotificationAudience } from '../../_lib/notifications';
import { sendDataRequestNotificationEmail } from '../../_lib/email';

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
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM tracefab_send_data_request(${requestId}::uuid)
      `;
      if (!rows[0]?.id) throw new Error('data_request_send_failed');
      const request = await tx.data_requests.findUnique({ where: { id: requestId }, select: REQUEST_SELECT });
      if (!request) throw new Error('data_request_send_failed');
      const [brand, supplierAudience] = await Promise.all([
        tx.organizations.findUnique({ where: { id: request.brand_organization_id }, select: { legal_name: true, display_name: true } }),
        organizationNotificationAudience(tx, request.supplier_organization_id),
      ]);
      return {
        request,
        brandName: brand?.display_name || brand?.legal_name || 'Tracefab brand',
        supplierAudience,
      };
    });

    const delivery = await sendDataRequestNotificationEmail({
      to: result.supplierAudience.recipients.map(({ email }) => email),
      recipientName: result.supplierAudience.recipients[0]?.fullName || 'Supplier team',
      brandName: result.brandName,
      supplierName: result.supplierAudience.organizationName,
      requestTitle: result.request.title,
      requestId: result.request.id,
      dueAt: result.request.due_at,
      event: 'request_sent',
    });

    return json(res, 200, {
      request: serializeRequest(result.request),
      delivery: delivery.status === 'sent'
        ? { status: delivery.status, providerId: delivery.providerId }
        : { status: delivery.status },
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('POST /api/data-requests/:requestId/send failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
