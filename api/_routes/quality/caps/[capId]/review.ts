import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../../_lib/http.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';
import { isUuid } from '../../../../_lib/data-requests.js';
import { reviewQualityRemediation } from '../../../../_lib/quality-cap/cap-manager.js';
import { isTenantError, requireActiveTenant, requestedTenantId } from '../../../../_lib/tenant.js';

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

    const verdict = body.verdict === 'approved' ? 'approved' : body.verdict === 'rejected' ? 'rejected' : null;
    const reviewNotes = typeof body.reviewNotes === 'string' ? body.reviewNotes.trim() : undefined;

    if (!verdict) {
      return json(res, 400, { error: 'invalid_verdict_must_be_approved_or_rejected' });
    }

    const updatedCap = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const tenant = await requireActiveTenant(tx, req, user.id, { types: ['brand'] });
      const cap = await tx.quality_corrective_action_plans.findFirst({
        where: { id: capId, brand_organization_id: tenant.organizationId },
        select: { id: true },
      });
      if (!cap) return null;
      return await reviewQualityRemediation(
        tx,
        capId,
        verdict,
        reviewNotes
      );
    }, requestedTenantId(req));

    if (!updatedCap) return json(res, 404, { error: 'cap_not_found' });
    return json(res, 200, {
      message: verdict === 'approved' ? 'remediation_approved_and_issue_resolved' : 'remediation_rejected',
      cap: updatedCap,
      isResolved: verdict === 'approved',
    });
  } catch (err: unknown) {
    if (isUnauthorized(err)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    if (isTenantError(err)) return json(res, err.status, { error: err.message });
    const sqlError = sqlBusinessError(err);
    if (sqlError) {
      return json(res, sqlError.status, { error: sqlError.error });
    }
    console.error('Review remediation error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
