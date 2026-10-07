import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../../_lib/http.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';
import { isUuid } from '../../../../_lib/data-requests.js';
import { accessibleProduct } from '../../../../_lib/quality.js';
import { calculateAndStoreProductPef } from '../../../../_lib/pef/pef-calculator.js';

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

    const customWeightKg = typeof body.garmentWeightKg === 'number' && body.garmentWeightKg > 0
      ? body.garmentWeightKg
      : undefined;

    const customCategory = typeof body.garmentCategory === 'string' && body.garmentCategory.trim().length > 0
      ? body.garmentCategory.trim()
      : undefined;

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const product = await accessibleProduct(tx, productId);
      if (!product) return null;

      const productRecord = await tx.tracefab_products.findUnique({
        where: { id: productId },
        select: { category: true },
      });

      return await calculateAndStoreProductPef(tx, {
        productId,
        customWeightKg,
        customCategory: customCategory || productRecord?.category || undefined,
        userId: user.id,
      });
    });

    if (!result) {
      return json(res, 404, { error: 'product_not_found' });
    }

    return json(res, 200, {
      message: 'pef_assessment_computed',
      assessment: result,
      regulatoryCompliance: {
        euEsprDppReady: true,
        frenchAgecCompliant: true,
      },
    });
  } catch (err: unknown) {
    if (isUnauthorized(err)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    const sqlError = sqlBusinessError(err);
    if (sqlError) {
      return json(res, sqlError.status, { error: sqlError.error });
    }
    console.error('PEF calculate error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
