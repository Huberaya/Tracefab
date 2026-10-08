import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../../_lib/context.js';
import { json, methodNotAllowed } from '../../../../_lib/http.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';
import { isUuid } from '../../../../_lib/data-requests.js';
import { accessibleProduct, serializeQualityScore } from '../../../../_lib/quality.js';

/* Chantier 10 — Quality Center premium : historique des scores qualite d'un
   produit. Chaque calcul (tracefab_compute_product_quality) INSERE une
   ligne dans data_quality_scores : l'historique est donc une donnee reelle,
   sans migration. Retourne les 30 derniers instantanes en ordre
   chronologique croissant, pour la vue tendances. Aucun lissage, aucune
   interpolation. */

const HISTORY_LIMIT = 30;

function routeProductId(req: VercelRequest) {
  const value = req.query.productId;
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const productId = routeProductId(req);
    if (!isUuid(productId)) return json(res, 400, { error: 'invalid_product_id' });
    const { user } = await requireClerkUser(req);
    const history = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const product = await accessibleProduct(tx, productId);
      if (!product) return null;
      return tx.data_quality_scores.findMany({
        where: { product_id: productId },
        orderBy: { computed_at: 'desc' },
        take: HISTORY_LIMIT,
      });
    });
    if (!history) return json(res, 404, { error: 'product_not_found' });
    return json(res, 200, { history: history.reverse().map(serializeQualityScore) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('GET /api/quality/products/:productId/history failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
