import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../../_lib/http.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';
import { isUuid } from '../../../../_lib/data-requests.js';
import { allocateTcQuantity } from '../../../../_lib/mass-balance/mass-balance-manager.js';

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
    const body = await readJsonBody<Record<string, unknown>>(req);

    const tcId = typeof body.tcId === 'string' ? body.tcId : '';
    const allocatedWeightKg = Number(body.allocatedWeightKg);
    const allocatedMeters = body.allocatedMeters ? Number(body.allocatedMeters) : undefined;
    const orderId = typeof body.orderId === 'string' && isUuid(body.orderId) ? body.orderId : undefined;
    const notes = typeof body.notes === 'string' ? body.notes.trim() : undefined;

    if (!isUuid(tcId)) {
      return json(res, 400, { error: 'invalid_tc_id' });
    }
    if (!Number.isFinite(allocatedWeightKg) || allocatedWeightKg <= 0) {
      return json(res, 400, { error: 'allocated_weight_kg_must_be_positive' });
    }

    const allocation = await withTracefabUserContext(user.id, user.email, async (tx) => {
      return await allocateTcQuantity(tx, {
        tcId,
        productId,
        allocatedWeightKg,
        allocatedMeters,
        orderId,
        notes,
      });
    });

    return json(res, 201, {
      message: 'tc_quantity_allocated',
      allocation,
    });
  } catch (err: unknown) {
    if (isUnauthorized(err)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    const sqlError = sqlBusinessError(err);
    if (sqlError) {
      return json(res, sqlError.status, { error: sqlError.error });
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('tc_quantity_exceeded_double_spending_prevented')) {
      return json(res, 400, { error: 'La quantité demandée dépasse le solde disponible sur ce Transaction Certificate (protection anti-double dépense).' });
    }
    console.error('Allocate TC error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
