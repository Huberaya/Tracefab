import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabRequestContext } from '../../../_lib/context.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { isUuid } from '../../../_lib/products.js';
import { isTenantError, requireActiveTenant, tenantFilter } from '../../../_lib/tenant.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import {
  computeTraceabilitySummary,
  groupGraphByStages,
  type SupplyChainGraphPayload,
} from '../../../_lib/supply-chain.js';

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

    const result = await withTracefabRequestContext(req, user, async (tx) => {
      const tenant = await requireActiveTenant(tx, req, user.id, { types: ['brand'] });
      const product = await tx.tracefab_products.findFirst({
        where: { id: productId, brand_organization_id: tenantFilter(tenant) },
        select: { id: true, name: true, reference: true, version: true },
      });
      if (!product) return null;

      const rows = await tx.$queryRaw<Array<{ graph: SupplyChainGraphPayload }>>`
        SELECT tracefab_get_product_traceability(${productId}::uuid) AS graph
      `;
      const graph = rows[0]?.graph ?? { product_id: productId, nodes: [], links: [] };

      // A declared node exists before its first edge. The historical graph
      // function discovers nodes through edges, so freshly-created standalone
      // nodes vanished on reload and could never be selected for that first
      // edge. New mutations carry their graph product in reserved metadata;
      // expose those nodes until a link makes them part of the canonical graph.
      const standaloneNodes = await tx.$queryRaw<SupplyChainGraphPayload['nodes']>`
        SELECT n.*
        FROM supply_chain_nodes n
        WHERE n.metadata ->> 'graphProductId' = ${productId}
          AND NOT EXISTS (
            SELECT 1 FROM supply_chain_links l
            WHERE l.product_id = ${productId}::uuid
              AND (l.source_node_id = n.id OR l.target_node_id = n.id)
          )
        ORDER BY n.created_at ASC
      `;
      const knownNodeIds = new Set(graph.nodes.map((node) => node.id));
      graph.nodes.push(...standaloneNodes.filter((node) => !knownNodeIds.has(node.id)));

      const stages = groupGraphByStages(graph.nodes);
      const summary = computeTraceabilitySummary(graph.nodes, graph.links);

      return { product, graph, stages, summary };
    });

    if (!result) return json(res, 404, { error: 'product_not_found' });
    return json(res, 200, {
      product: result.product,
      graph: result.graph,
      stages: result.stages,
      summary: result.summary,
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isTenantError(error)) return json(res, error.status, { error: error.message });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && /^invalid_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('GET /api/products/:productId/supply-chain failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
