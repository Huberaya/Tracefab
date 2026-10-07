import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../../_lib/context.js';
import { json, methodNotAllowed } from '../../../../_lib/http.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';
import { isUuid } from '../../../../_lib/data-requests.js';
import { accessibleProduct } from '../../../../_lib/quality.js';
import { executeProductGreenClaimsAudit } from '../../../../_lib/green-claims/claim-auditor.js';

function routeProductId(req: VercelRequest) {
  const value = req.query.productId;
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  try {
    const productId = routeProductId(req);
    if (!isUuid(productId)) {
      return json(res, 400, { error: 'invalid_product_id' });
    }

    const { user } = await requireClerkUser(req);

    const auditResult = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const product = await accessibleProduct(tx, productId);
      if (!product) return null;

      return await executeProductGreenClaimsAudit(tx, {
        productId,
        userId: user.id,
      });
    });

    if (!auditResult) {
      return json(res, 404, { error: 'product_not_found' });
    }

    return json(res, 200, {
      message: 'audit_completed',
      audit: auditResult,
      isGreenwashingRisk: auditResult.auditVerdict === 'non_compliant_greenwashing_risk',
    });
  } catch (err: unknown) {
    if (isUnauthorized(err)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    const sqlError = sqlBusinessError(err);
    if (sqlError) {
      return json(res, sqlError.status, { error: sqlError.error });
    }
    console.error('Green claims audit route error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
