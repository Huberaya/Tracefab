import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
import { isTenantError, requireActiveTenant, requestedTenantId } from '../../_lib/tenant.js';
import { calculateDataQualityIndex, type ComponentQualityItem } from '../../_lib/quality-index.js';
import { generateAuditPackManifest } from '../../_lib/audit-pack.js';

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

  try {
    const auth = await requireClerkUser(req);

    const body = await readJsonBody<AuditPackBody>(req);
    const { productId, sku, components, evidenceDocuments } = body;

    if (!productId || typeof productId !== 'string') {
      return json(res, 400, { error: 'product_id_required' });
    }

    return await withTracefabUserContext(auth.user.id, auth.user.email, async (tx) => {
      const tenant = await requireActiveTenant(tx, req, auth.user.id);
      const qualityReport = calculateDataQualityIndex(productId, sku || 'UNSPECIFIED', components || []);
      const manifest = generateAuditPackManifest(tenant.organizationId, qualityReport, evidenceDocuments || []);

      return json(res, 200, {
        status: 'ok',
        manifest,
      });
    }, requestedTenantId(req));
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isTenantError(error)) return json(res, error.status, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('POST /api/quality/audit-pack failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
