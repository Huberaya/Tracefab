import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { isUuid, PRODUCT_SELECT, serializeProduct } from '../../../_lib/products.js';
import { isTenantError, requireActiveTenant, requestedTenantId, tenantFilter } from '../../../_lib/tenant.js';

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
      // Locataire actif obligatoire, resolu AVANT toute mutation : `{ in:
      // organizationIds }` bornait l'utilisateur, pas le locataire affiche.
      const tenant = await requireActiveTenant(tx, req, user.id, { types: ['brand'] });

      // Appartenance verifiee avant d'ecrire. `tracefab_start_product_revision`
      // verifie son propre role, mais pas le locataire actif de la requete :
      // sans ce controle prealable, une revision serait ouverte sur un produit
      // d'un autre tenant du compte avant que la route ne s'en apercoive.
      const owned = await tx.tracefab_products.findFirst({
        where: { id: productId, brand_organization_id: tenantFilter(tenant) },
        select: { id: true },
      });
      if (!owned) throw new Error('product_not_found');

      const rows = await tx.$queryRaw<ProductIdRow[]>`
        SELECT id
        FROM tracefab_start_product_revision(${productId}::uuid)
      `;
      if (!rows[0]?.id) throw new Error('product_revision_failed');
      const revised = await tx.tracefab_products.findFirst({
        where: { id: productId, brand_organization_id: tenantFilter(tenant) },
        select: PRODUCT_SELECT,
      });
      if (!revised) throw new Error('product_revision_failed');
      return revised;
    }, requestedTenantId(req));

    return json(res, 200, { product: serializeProduct(product) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isTenantError(error)) return json(res, error.status, { error: error.message });
    // Un produit d'un autre tenant et un produit inexistant renvoient la meme
    // reponse : la route ne doit pas reveler qu'un identifiant existe ailleurs.
    if (error instanceof Error && error.message === 'product_not_found') {
      return json(res, 404, { error: 'product_not_found' });
    }
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('POST /api/products/:productId/revision failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
