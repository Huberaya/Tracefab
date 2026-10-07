import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { reviewPassportAccess } from '../../../_lib/supplier-passport/passport-manager.js';
import { isUuid } from '../../../_lib/data-requests.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return methodNotAllowed(res, ['GET', 'POST']);
  }

  try {
    const { user } = await requireClerkUser(req);
    const orgIdQuery = typeof req.query.organizationId === 'string' ? req.query.organizationId : undefined;

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      let supplierOrgId = orgIdQuery;
      if (!supplierOrgId) {
        const membership = await tx.organization_memberships.findFirst({
          where: {
            user_id: user.id,
            status: 'active',
            organizations: { type: 'supplier' },
          },
          select: { organization_id: true },
        });
        supplierOrgId = membership?.organization_id;
      }

      if (!supplierOrgId) {
        throw new Error('supplier_organization_not_found');
      }

      if (req.method === 'GET') {
        const requests = await tx.supplier_passport_access_requests.findMany({
          where: { supplier_organization_id: supplierOrgId },
          include: {
            organizations_supplier_passport_access_requests_requester_organization_idToorganizations: {
              select: { id: true, display_name: true, legal_name: true },
            },
          },
          orderBy: { created_at: 'desc' },
        });
        return requests;
      }

      // POST: review request
      const body = await readJsonBody<Record<string, unknown>>(req);
      const requestId = typeof body.requestId === 'string' ? body.requestId : '';
      const verdict = body.verdict === 'approved' ? 'approved' : body.verdict === 'rejected' ? 'rejected' : null;

      if (!isUuid(requestId)) {
        throw new Error('invalid_request_id');
      }
      if (!verdict) {
        throw new Error('invalid_verdict_must_be_approved_or_rejected');
      }

      return await reviewPassportAccess(tx, requestId, verdict);
    });

    return json(res, 200, {
      requests: req.method === 'GET' ? result : undefined,
      request: req.method === 'POST' ? result : undefined,
    });
  } catch (err: unknown) {
    if (isUnauthorized(err)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    const sqlError = sqlBusinessError(err);
    if (sqlError) {
      return json(res, sqlError.status, { error: sqlError.error });
    }
    console.error('Passport access requests error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
