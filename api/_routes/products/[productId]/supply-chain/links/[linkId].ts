import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../../../_lib/http.js';
import { activeBrandOrganizationIds, isUuid } from '../../../../../_lib/products.js';
import { sqlBusinessError } from '../../../../../_lib/sql-errors.js';
import { type SupplyChainLinkRecord } from '../../../../../_lib/supply-chain.js';

function routeParam(req: VercelRequest, key: string) {
  const value = req.query[key];
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'PATCH' && req.method !== 'DELETE') return methodNotAllowed(res, ['PATCH', 'DELETE']);

  try {
    const productId = routeParam(req, 'productId');
    const linkId = routeParam(req, 'linkId');
    if (!isUuid(productId)) return json(res, 400, { error: 'invalid_product_id' });
    if (!isUuid(linkId)) return json(res, 400, { error: 'invalid_link_id' });

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
        await tx.supply_chain_links.deleteMany({
          where: { id: linkId, product_id: productId },
        });
        return { deleted: true };
      }

      // PATCH
      const body = await readJsonBody<Record<string, unknown>>(req);
      const sequenceNumber = body.sequenceNumber !== undefined && body.sequenceNumber !== null
        ? Number(body.sequenceNumber)
        : null;
      if (sequenceNumber !== null && (!Number.isInteger(sequenceNumber) || sequenceNumber < 0)) {
        throw new Error('invalid_sequence_number');
      }

      const validFrom = body.validFrom ? String(body.validFrom).trim() : null;
      if (validFrom && !/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) throw new Error('invalid_valid_from');

      const validUntil = body.validUntil ? String(body.validUntil).trim() : null;
      if (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) throw new Error('invalid_valid_until');

      if (validFrom && validUntil && validFrom > validUntil) {
        throw new Error('invalid_link_date_range');
      }

      const evidenceDocumentId = body.evidenceDocumentId ? String(body.evidenceDocumentId).trim() : null;
      if (evidenceDocumentId && !isUuid(evidenceDocumentId)) throw new Error('invalid_evidence_document_id');

      if (evidenceDocumentId) {
        const accessRows = await tx.$queryRaw<Array<{ can_access: boolean }>>`
          SELECT tracefab_can_access_document(${evidenceDocumentId}::uuid) AS can_access
        `;
        if (!accessRows[0]?.can_access) throw new Error('invalid_evidence_document_id');
      }

      const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? body.metadata as Record<string, unknown>
        : {};

      const rows = await tx.$queryRaw<SupplyChainLinkRecord[]>`
        SELECT *
        FROM tracefab_update_supply_chain_link(
          ${linkId}::uuid,
          ${sequenceNumber},
          ${validFrom ? new Date(validFrom) : null}::date,
          ${validUntil ? new Date(validUntil) : null}::date,
          ${evidenceDocumentId}::uuid,
          ${JSON.stringify(metadata)}::jsonb
        )
      `;
      return rows[0] ?? null;
    });

    if (!result) return json(res, 404, { error: 'link_or_product_not_found' });
    if ('deleted' in result) return json(res, 200, { deleted: true });
    return json(res, 200, { link: result });
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
    console.error('PATCH/DELETE /api/products/:productId/supply-chain/links/:linkId failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
