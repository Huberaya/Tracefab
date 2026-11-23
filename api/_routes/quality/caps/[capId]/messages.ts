import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../../_lib/http.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';
import { isTenantError, requireActiveTenant, requestedTenantId } from '../../../../_lib/tenant.js';
import { isUuid } from '../../../../_lib/data-requests.js';

function routeCapId(req: VercelRequest) {
  const value = req.query.capId;
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return methodNotAllowed(res, ['GET', 'POST']);
  }

  try {
    const capId = routeCapId(req);
    if (!isUuid(capId)) {
      return json(res, 400, { error: 'invalid_cap_id' });
    }

    const { user } = await requireClerkUser(req);

    if (req.method === 'POST') {
      const body = await readJsonBody<Record<string, unknown>>(req);
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      const attachmentDocumentId = typeof body.attachmentDocumentId === 'string' && isUuid(body.attachmentDocumentId)
        ? body.attachmentDocumentId
        : null;

      if (!message) {
        return json(res, 400, { error: 'message_required' });
      }

      const created = await withTracefabUserContext(user.id, user.email, async (tx) => {
        const tenant = await requireActiveTenant(tx, req, user.id);
        const cap = await tx.quality_corrective_action_plans.findUnique({
          where: { id: capId },
        });

        if (!cap) return null;

        let senderOrgId = '';
        let senderRole: 'brand' | 'supplier' = 'brand';

        if (tenant.organizationId === cap.brand_organization_id) {
          senderOrgId = cap.brand_organization_id;
          senderRole = 'brand';
        } else if (tenant.organizationId === cap.supplier_organization_id) {
          senderOrgId = cap.supplier_organization_id;
          senderRole = 'supplier';
        } else {
          throw new Error('access_denied_to_cap');
        }

        return await tx.quality_cap_messages.create({
          data: {
            cap_id: capId,
            sender_organization_id: senderOrgId,
            sender_user_id: user.id,
            sender_role: senderRole,
            message,
            attachment_document_id: attachmentDocumentId,
          },
          include: {
            organizations: { select: { display_name: true, legal_name: true } },
            documents: { select: { id: true, original_filename: true } },
          },
        });
      }, requestedTenantId(req));

      if (!created) {
        return json(res, 404, { error: 'cap_not_found' });
      }

      return json(res, 201, { message: 'message_sent', record: created });
    }

    // GET messages
    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      await requireActiveTenant(tx, req, user.id);
      const messages = await tx.quality_cap_messages.findMany({
        where: { cap_id: capId },
        include: {
          organizations: { select: { display_name: true, legal_name: true } },
          documents: { select: { id: true, original_filename: true } },
        },
        orderBy: { created_at: 'asc' },
      });

      return messages;
    }, requestedTenantId(req));

    return json(res, 200, { messages: result, count: result.length });
  } catch (err: unknown) {
    if (isUnauthorized(err)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    if (isTenantError(err)) {
      return json(res, err.status, { error: err.message });
    }
    const sqlError = sqlBusinessError(err);
    if (sqlError) {
      return json(res, sqlError.status, { error: sqlError.error });
    }
    console.error('CAP messages error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
