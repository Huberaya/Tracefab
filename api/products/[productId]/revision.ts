import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth';
import { withTracefabUserContext } from '../../_lib/context';
import { json, methodNotAllowed } from '../../_lib/http';
import { sqlBusinessError } from '../../_lib/sql-errors';
import { activeBrandOrganizationIds, isUuid, PRODUCT_SELECT, serializeProduct } from '../../_lib/products';

type ProductIdRow = { id: string };

function routeProductId(req: VercelRequest) {
  const value = req.query.productId;
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const productId = routeProductId(req);
    if (!isUuid(productId)) return json(res, 400, { error: 'invalid_product_id' });
    const { user } = await requireClerkUser(req);

    const product = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const rows = await tx.$queryRaw<ProductIdRow[]>`
        SELECT id
        FROM tracefab_start_product_revision(${productId}::uuid)
      `;
      if (!rows[0]?.id) throw new Error('product_revision_failed');
      const organizationIds = await activeBrandOrganizationIds(tx, user.id);
      const revised = await tx.tracefab_products.findFirst({
        where: { id: productId, brand_organization_id: { in: organizationIds } },
        select: PRODUCT_SELECT,
      });
      if (!revised) throw new Error('product_revision_failed');
      return revised;
    });

    return json(res, 200, { product: serializeProduct(product) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('POST /api/products/:productId/revision failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
