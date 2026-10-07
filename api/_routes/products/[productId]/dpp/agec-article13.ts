import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../../_lib/context.js';
import { json, methodNotAllowed } from '../../../../_lib/http.js';
import { activeBrandOrganizationIds, isUuid } from '../../../../_lib/products.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';
import { deriveAgecArticle13, isAgecGeographyComplete, type AgecSourceNode } from '../../../../_lib/agec.js';

function routeProductId(req: VercelRequest) {
  const value = req.query.productId;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Déclaration géographique AGEC article 13 d'un produit.
 *
 * Les trois pays (tissage/tricotage, teinture/impression, confection) sont déduits
 * des nœuds de traçabilité déjà saisis, pas d'une table dédiée : aucune migration.
 * Ce qui ne peut pas être établi remonte dans `gaps` avec sa raison, et les trois
 * champs sans source de traçabilité sont signalés comme devant être déclarés.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const productId = routeProductId(req);
    if (!isUuid(productId)) return json(res, 400, { error: 'invalid_product_id' });
    const { user } = await requireClerkUser(req);

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const brandOrgIds = await activeBrandOrganizationIds(tx, user.id);
      const product = await tx.tracefab_products.findFirst({
        where: { id: productId, brand_organization_id: { in: brandOrgIds } },
        select: { id: true, name: true, reference: true },
      });
      if (!product) return null;

      const nodes = await tx.supply_chain_nodes.findMany({
        where: { product_id: productId },
        select: {
          id: true,
          node_type: true,
          label: true,
          process_code: true,
          metadata: true,
          status: true,
          supplier_sites: { select: { name: true, country_code: true } },
        },
        orderBy: { created_at: 'asc' },
      });

      const sourceNodes: AgecSourceNode[] = nodes.map((node) => ({
        id: node.id,
        node_type: node.node_type,
        process_code: node.process_code,
        metadata: (node.metadata ?? null) as Record<string, unknown> | null,
        site_country: node.supplier_sites?.country_code ?? null,
      }));

      const derivation = deriveAgecArticle13(sourceNodes);

      return {
        product,
        agec: derivation.agec,
        gaps: derivation.gaps,
        derivedFrom: derivation.derivedFrom,
        complete: isAgecGeographyComplete(derivation.agec),
        nodeCount: nodes.length,
      };
    });

    if (!result) return json(res, 404, { error: 'product_not_found' });
    return json(res, 200, result);
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && /^invalid_/.test(error.message)) {
      return json(res, 400, { error: error.message });
    }
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('GET /api/products/:productId/dpp/agec-article13 failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
