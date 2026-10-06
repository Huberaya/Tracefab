import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { isUuid } from '../../../_lib/data-requests.js';
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
      const summary = await withTracefabUserContext(user.id, user.email, async (tx) => {
        return await getProductMassBalanceSummary(tx, productId);
      });
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

    const recon = await withTracefabUserContext(user.id, user.email, async (tx) => {
      return await reconcileProductMassBalance(tx, {
        productId,
        productionVolumeUnits,
        cuttingWastePct,
        batchReference,
      });
    });

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
