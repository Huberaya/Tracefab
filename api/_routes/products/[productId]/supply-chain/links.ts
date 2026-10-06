import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../../_lib/http.js';
import { activeBrandOrganizationIds, isUuid } from '../../../../_lib/products.js';
import { sqlBusinessError } from '../../../../_lib/sql-errors.js';
import { validateLinkInput, type SupplyChainLinkRecord } from '../../../../_lib/supply-chain.js';

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
    const input = validateLinkInput(body);

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

      if (input.evidenceDocumentId) {
        const accessRows = await tx.$queryRaw<Array<{ can_access: boolean }>>`
          SELECT tracefab_can_access_document(${input.evidenceDocumentId}::uuid) AS can_access
        `;
        if (!accessRows[0]?.can_access) throw new Error('invalid_evidence_document_id');
      }

      const rows = await tx.$queryRaw<SupplyChainLinkRecord[]>`
        SELECT *
        FROM tracefab_add_supply_chain_link(
          ${productId}::uuid,
          ${input.sourceNodeId}::uuid,
          ${input.targetNodeId}::uuid,
          ${input.linkType}::supply_chain_link_type,
          ${input.sequenceNumber},
          ${input.validFrom ? new Date(input.validFrom) : null}::date,
          ${input.validUntil ? new Date(input.validUntil) : null}::date,
          ${input.evidenceDocumentId}::uuid,
          ${JSON.stringify(input.metadata)}::jsonb
        )
      `;
      return rows[0] ?? null;
    });

    if (!result) return json(res, 404, { error: 'product_not_found' });
    return json(res, 201, { link: result });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && (/^invalid_|^traceability_|^self_/.test(error.message))) {
      return json(res, 400, { error: error.message });
    }
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('POST /api/products/:productId/supply-chain/links failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
