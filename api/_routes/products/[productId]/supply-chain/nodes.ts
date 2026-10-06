import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../../_lib/http.js';
import { activeBrandOrganizationIds, isUuid } from '../../../../_lib/products.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';
import { validateNodeInput, type SupplyChainNodeRecord } from '../../../../_lib/supply-chain.js';

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
    const body = await readJsonBody<Record<string, unknown>>(req);
    const input = validateNodeInput(body);

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const brandOrgIds = await activeBrandOrganizationIds(tx, user.id);
      const product = await tx.tracefab_products.findFirst({
        where: { id: productId, brand_organization_id: { in: brandOrgIds } },
        select: { id: true, brand_organization_id: true },
      });
      if (!product) return null;

      // Verify mutation role
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

      // Verify source document access if specified
      if (input.sourceDocumentId) {
        const accessRows = await tx.$queryRaw<Array<{ can_access: boolean }>>`
          SELECT tracefab_can_access_document(${input.sourceDocumentId}::uuid) AS can_access
        `;
        if (!accessRows[0]?.can_access) throw new Error('invalid_source_document_id');
      }

      const rows = await tx.$queryRaw<SupplyChainNodeRecord[]>`
        SELECT *
        FROM tracefab_create_supply_chain_node(
          ${productId}::uuid,
          ${input.nodeType}::node_type,
          ${input.label},
          ${input.organizationId}::uuid,
          ${input.supplierSiteId}::uuid,
          ${input.productId || (input.nodeType === 'product' ? productId : null)}::uuid,
          ${input.materialId}::uuid,
          ${input.processCode},
          ${JSON.stringify(input.metadata)}::jsonb,
          ${input.sourceDocumentId}::uuid,
          ${input.observedAt ? new Date(input.observedAt) : null}::date
        )
      `;
      return rows[0] ?? null;
    });

    if (!result) return json(res, 404, { error: 'product_not_found' });
    return json(res, 201, { node: result });
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
    console.error('POST /api/products/:productId/supply-chain/nodes failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
