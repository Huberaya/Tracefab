import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../../../_lib/http.js';
import { activeBrandOrganizationIds, isUuid } from '../../../../../_lib/products.js';
import { sqlBusinessError } from '../../../../../_lib/sql-errors.js';
import { type SupplyChainNodeRecord } from '../../../../../_lib/supply-chain.js';

function routeParam(req: VercelRequest, key: string) {
  const value = req.query[key];
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'PATCH' && req.method !== 'DELETE') return methodNotAllowed(res, ['PATCH', 'DELETE']);

  try {
    const productId = routeParam(req, 'productId');
    const nodeId = routeParam(req, 'nodeId');
    if (!isUuid(productId)) return json(res, 400, { error: 'invalid_product_id' });
    if (!isUuid(nodeId)) return json(res, 400, { error: 'invalid_node_id' });

    const { user } = await requireClerkUser(req);

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const brandOrgIds = await activeBrandOrganizationIds(tx, user.id);
      const product = await tx.tracefab_products.findFirst({
        where: { id: productId, brand_organization_id: { in: brandOrgIds } },
        select: { id: true, brand_organization_id: true },
      });
      if (!product) return null;

      const membership = await tx.organization_memberships.findFirst({
        where: {
          organization_id: product.brand_organization_id,
          user_id: user.id,
          status: 'active',
          role: { in: ['owner', 'admin', 'manager', 'contributor'] },
        },
        select: { id: true },
      });
      if (!membership) throw new Error('traceability_brand_role_required');

      if (req.method === 'DELETE') {
        // Delete links referencing node first, then node
        await tx.supply_chain_links.deleteMany({
          where: {
            product_id: productId,
            OR: [{ source_node_id: nodeId }, { target_node_id: nodeId }],
          },
        });
        await tx.supply_chain_nodes.deleteMany({
          where: { id: nodeId, product_id: productId },
        });
        return { deleted: true };
      }

      // PATCH
      const body = await readJsonBody<Record<string, unknown>>(req);
      const label = typeof body.label === 'string' ? body.label.trim() : null;
      if (!label) throw new Error('invalid_node_label');

      const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? body.metadata as Record<string, unknown>
        : {};

      const sourceDocumentId = body.sourceDocumentId ? String(body.sourceDocumentId).trim() : null;
      if (sourceDocumentId && !isUuid(sourceDocumentId)) throw new Error('invalid_source_document_id');

      if (sourceDocumentId) {
        const accessRows = await tx.$queryRaw<Array<{ can_access: boolean }>>`
          SELECT tracefab_can_access_document(${sourceDocumentId}::uuid) AS can_access
        `;
        if (!accessRows[0]?.can_access) throw new Error('invalid_source_document_id');
      }

      const observedAt = body.observedAt ? String(body.observedAt).trim() : null;
      if (observedAt && !/^\d{4}-\d{2}-\d{2}$/.test(observedAt)) throw new Error('invalid_observed_at');

      const rows = await tx.$queryRaw<SupplyChainNodeRecord[]>`
        SELECT *
        FROM tracefab_update_supply_chain_node(
          ${productId}::uuid,
          ${nodeId}::uuid,
          ${label},
          ${JSON.stringify(metadata)}::jsonb,
          ${sourceDocumentId}::uuid,
          ${observedAt ? new Date(observedAt) : null}::date
        )
      `;
      return rows[0] ?? null;
    });

    if (!result) return json(res, 404, { error: 'node_or_product_not_found' });
    if ('deleted' in result) return json(res, 200, { deleted: true });
    return json(res, 200, { node: result });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && (/^invalid_|^traceability_/.test(error.message))) {
      return json(res, 400, { error: error.message });
    }
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('PATCH/DELETE /api/products/:productId/supply-chain/nodes/:nodeId failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
