import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
import { buildLotLineageGraph, type LotGenealogyNode } from '../../_lib/lot-genealogy.js';

type LineageGraphBody = {
  productId?: string;
  sku?: string;
  nodes?: LotGenealogyNode[];
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  const auth = await requireClerkUser(req);
  if (isUnauthorized(auth)) {
    return json(res, 401, { error: 'unauthorized' });
  }

  const body = await readJsonBody<LineageGraphBody>(req);
  const { productId, sku, nodes } = body;

  if (!productId || typeof productId !== 'string') {
    return json(res, 400, { error: 'invalid_product_id', message: 'Field "productId" is required.' });
  }

  if (!Array.isArray(nodes) || nodes.length === 0) {
    return json(res, 400, { error: 'invalid_nodes', message: 'Field "nodes" must be a non-empty array.' });
  }

  return withTracefabUserContext(auth.user.id, auth.user.email, async () => {
    const graph = buildLotLineageGraph(productId, sku || 'UNSPECIFIED', nodes);

    return json(res, 200, {
      status: 'ok',
      productId: graph.productId,
      sku: graph.sku,
      totalDepth: graph.totalDepth,
      isContinuousChain: graph.isContinuousChain,
      defectsCount: graph.auditDefects.length,
      defects: graph.auditDefects,
      rootsCount: graph.rootNodes.length,
      leavesCount: graph.leafNodes.length,
      totalNodes: Object.keys(graph.nodes).length,
      graph,
    });
  });
}
