import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabTenantContext } from '../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
import { calculateDataQualityIndex, type ComponentQualityItem } from '../../_lib/quality-index.js';
import { generateAuditPackManifest } from '../../_lib/audit-pack.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';
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

  try {
    const manifest = await withTracefabTenantContext(
      req,
      auth.user,
      { types: ['brand'], roles: ['owner', 'admin', 'manager', 'auditor'] },
      async (tx, tenant) => {
        const product = await tx.tracefab_products.findFirst({
          where: { id: productId, brand_organization_id: tenant.organizationId },
          select: { id: true },
        });
        if (!product) return null;
        const qualityReport = calculateDataQualityIndex(productId, sku || 'UNSPECIFIED', components || []);
        return generateAuditPackManifest(tenant.organizationId, qualityReport, evidenceDocuments || []);
      },
    );
    if (!manifest) return json(res, 404, { error: 'product_not_found' });
    return json(res, 200, { status: 'ok', manifest });
  } catch (error) {
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    console.error('POST /api/quality/audit-pack failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
