import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
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

  const auth = await requireClerkUser(req);
  if (isUnauthorized(auth)) {
    return json(res, 401, { error: 'unauthorized' });
  }

  const body = await readJsonBody<AuditPackBody>(req);
  const { productId, sku, components, evidenceDocuments } = body;

  if (!productId || typeof productId !== 'string') {
    return json(res, 400, { error: 'product_id_required' });
  }

  return withTracefabUserContext(auth.user.id, auth.user.email, async (tx) => {
    const membership = await tx.organization_memberships.findFirst({
      where: { user_id: auth.user.id, status: 'active' },
      select: { organization_id: true },
    });

    const orgId = membership?.organization_id || 'org-audit-demo';
    const qualityReport = calculateDataQualityIndex(productId, sku || 'UNSPECIFIED', components || []);
    const manifest = generateAuditPackManifest(orgId, qualityReport, evidenceDocuments || []);

    return json(res, 200, {
      status: 'ok',
      manifest,
    });
  });
}
