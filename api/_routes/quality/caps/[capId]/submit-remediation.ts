import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabTenantContext } from '../../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../../_lib/http.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';
import { isUuid } from '../../../../_lib/data-requests.js';
import { submitQualityRemediation } from '../../../../_lib/quality-cap/cap-manager.js';

function routeCapId(req: VercelRequest) {
  const value = req.query.capId;
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  try {
    const capId = routeCapId(req);
    if (!isUuid(capId)) {
      return json(res, 400, { error: 'invalid_cap_id' });
    }

    const { user } = await requireClerkUser(req);
    const body = await readJsonBody<Record<string, unknown>>(req);

    const responseSummary = typeof body.responseSummary === 'string' ? body.responseSummary.trim() : '';
    const supportingDocumentId = typeof body.supportingDocumentId === 'string' && isUuid(body.supportingDocumentId)
      ? body.supportingDocumentId
      : undefined;
    const message = typeof body.message === 'string' ? body.message.trim() : undefined;

    if (!responseSummary) {
      return json(res, 400, { error: 'response_summary_required' });
    }

    const updatedCap = await withTracefabTenantContext(req, user, { types: ['supplier'] }, async (tx, tenant) => {
      const cap = await tx.quality_corrective_action_plans.findFirst({
        where: { id: capId, supplier_organization_id: tenant.organizationId },
        select: { id: true },
      });
      if (!cap) return null;
      if (supportingDocumentId) {
        const document = await tx.documents.findFirst({
          where: { id: supportingDocumentId, owner_organization_id: tenant.organizationId, status: 'available' },
          select: { id: true },
        });
        if (!document) return null;
      }
      return submitQualityRemediation(tx, capId, responseSummary, supportingDocumentId, message);
    });

    if (!updatedCap) return json(res, 404, { error: 'cap_or_supporting_document_not_found' });
    return json(res, 200, {
      message: 'remediation_submitted',
      cap: updatedCap,
    });
  } catch (err: unknown) {
    if (isUnauthorized(err)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    const sqlError = sqlBusinessError(err);
    if (sqlError) {
      return json(res, sqlError.status, { error: sqlError.error });
    }
    console.error('Submit remediation error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
