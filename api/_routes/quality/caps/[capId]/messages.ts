import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabTenantContext } from '../../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../../_lib/http.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';
import { isUuid } from '../../../../_lib/data-requests.js';
import { documentAccessibleFromTenant } from '../../../../_lib/documents.js';

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

      const created = await withTracefabTenantContext(req, user, { types: ['brand', 'supplier'] }, async (tx, tenant) => {
        const cap = await tx.quality_corrective_action_plans.findFirst({
          where: { id: capId, OR: [
            { brand_organization_id: tenant.organizationId },
            { supplier_organization_id: tenant.organizationId },
          ] },
        });
        if (!cap) return null;
        if (attachmentDocumentId && !(await documentAccessibleFromTenant(tx, user.id, attachmentDocumentId, tenant))) return null;
        const senderRole: 'brand' | 'supplier' = tenant.organizationType === 'supplier' ? 'supplier' : 'brand';
        return tx.quality_cap_messages.create({
          data: {
            cap_id: capId,
            sender_organization_id: tenant.organizationId,
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
      });

      if (!created) {
        return json(res, 404, { error: 'cap_not_found' });
      }

      return json(res, 201, { message: 'message_sent', record: created });
    }

    // GET messages
    const result = await withTracefabTenantContext(req, user, { types: ['brand', 'supplier'] }, async (tx, tenant) => {
      const cap = await tx.quality_corrective_action_plans.findFirst({
        where: { id: capId, OR: [
          { brand_organization_id: tenant.organizationId },
          { supplier_organization_id: tenant.organizationId },
        ] },
        select: { id: true },
      });
      if (!cap) return null;
      return tx.quality_cap_messages.findMany({
        where: { cap_id: capId },
        include: {
          organizations: { select: { display_name: true, legal_name: true } },
          documents: { select: { id: true, original_filename: true } },
        },
        orderBy: { created_at: 'asc' },
      });
    });
    if (!result) return json(res, 404, { error: 'cap_not_found' });
    return json(res, 200, { messages: result, count: result.length });
  } catch (err: unknown) {
    if (isUnauthorized(err)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    const sqlError = sqlBusinessError(err);
    if (sqlError) {
      return json(res, sqlError.status, { error: sqlError.error });
    }
    console.error('CAP messages error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
