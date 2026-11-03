import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabRequestContext } from '../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { isUuid } from '../../../_lib/data-requests.js';
import { accessibleProduct } from '../../../_lib/quality.js';
import {
  getProductMassBalanceSummary,
  reconcileProductMassBalance,
} from '../../../_lib/mass-balance/mass-balance-manager.js';

function routeProductId(req: VercelRequest) {
  const value = req.query.productId;
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return methodNotAllowed(res, ['GET', 'POST']);
  }

  try {
    const productId = routeProductId(req);
    if (!isUuid(productId)) {
      return json(res, 400, { error: 'invalid_product_id' });
    }

    const { user } = await requireClerkUser(req);

    if (req.method === 'GET') {
      const summary = await withTracefabRequestContext(req, user, async (tx) => {
        const product = await accessibleProduct(tx, productId);
        if (!product) return null;
        return getProductMassBalanceSummary(tx, productId);
      });
      if (!summary) return json(res, 404, { error: 'product_not_found' });
      return json(res, 200, summary);
    }

    // POST: Reconcile product mass balance
    const body = await readJsonBody<Record<string, unknown>>(req);
    const productionVolumeUnits = Number(body.productionVolumeUnits);
    const cuttingWastePct = body.cuttingWastePct !== undefined ? Number(body.cuttingWastePct) : undefined;
    const batchReference = typeof body.batchReference === 'string' ? body.batchReference.trim() : undefined;

    if (!Number.isFinite(productionVolumeUnits) || productionVolumeUnits < 0) {
      return json(res, 400, { error: 'production_volume_units_must_be_positive_or_zero' });
    }

    const recon = await withTracefabRequestContext(req, user, async (tx) => {
      const product = await accessibleProduct(tx, productId);
      if (!product) return null;
      return reconcileProductMassBalance(tx, {
        productId,
        productionVolumeUnits,
        cuttingWastePct,
        batchReference,
      });
    });
    if (!recon) return json(res, 404, { error: 'product_not_found' });

    return json(res, 200, {
      message: 'mass_balance_reconciled',
      reconciliation: recon,
    });
  } catch (err: unknown) {
    if (isUnauthorized(err)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    const sqlError = sqlBusinessError(err);
    if (sqlError) {
      return json(res, sqlError.status, { error: sqlError.error });
    }
    console.error('Product mass balance error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
