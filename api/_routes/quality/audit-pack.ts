import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabRequestContext } from '../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
import { calculateDataQualityIndex, type ComponentQualityItem } from '../../_lib/quality-index.js';
import { generateAuditPackManifest } from '../../_lib/audit-pack.js';
import { accessibleProduct } from '../../_lib/quality.js';
import { isUuid } from '../../_lib/products.js';

type AuditPackBody = {
  productId?: string;
  sku?: string;
  components?: ComponentQualityItem[];
  evidenceDocuments?: Array<{
    id: string;
    filename: string;
    sha256: string;
    standard: string;
    verifiedBy?: string;
    verifiedAt?: string;
  }>;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  const auth = await requireClerkUser(req);
  if (isUnauthorized(auth)) {
    return json(res, 401, { error: 'unauthorized' });
  }

  const body = await readJsonBody<AuditPackBody>(req);
  const { productId, sku, components, evidenceDocuments } = body;

  if (!isUuid(productId)) {
    return json(res, 400, { error: 'product_id_required' });
  }

  const manifest = await withTracefabRequestContext(req, auth.user, async (tx) => {
    const product = await accessibleProduct(tx, productId);
    if (!product) return null;
    const membership = await tx.organization_memberships.findFirst({
      where: {
        user_id: auth.user.id,
        organization_id: product.brand_organization_id,
        status: 'active',
        role: { in: ['owner', 'admin', 'manager', 'auditor'] },
      },
      select: { organization_id: true },
    });
    if (!membership) return null;
    const qualityReport = calculateDataQualityIndex(productId, sku || 'UNSPECIFIED', components || []);
    return generateAuditPackManifest(product.brand_organization_id, qualityReport, evidenceDocuments || []);
  });
  if (!manifest) return json(res, 404, { error: 'product_not_found_or_audit_role_required' });
  return json(res, 200, { status: 'ok', manifest });
}
