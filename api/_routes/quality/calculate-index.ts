import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
import { calculateDataQualityIndex, type ComponentQualityItem } from '../../_lib/quality-index.js';

type QualityCalculateBody = {
  productId?: string;
  sku?: string;
  components?: ComponentQualityItem[];
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  const auth = await requireClerkUser(req);
  if (isUnauthorized(auth)) {
    return json(res, 401, { error: 'unauthorized' });
  }

  const body = await readJsonBody<QualityCalculateBody>(req);
  const { productId, sku, components } = body;

  if (!productId || typeof productId !== 'string') {
    return json(res, 400, { error: 'product_id_required' });
  }

  if (!Array.isArray(components) || components.length === 0) {
    return json(res, 400, { error: 'components_required', message: 'Field "components" must be a non-empty array.' });
  }

  return withTracefabUserContext(auth.user.id, auth.user.email, async () => {
    const qualityReport = calculateDataQualityIndex(productId, sku || 'UNSPECIFIED', components);

    return json(res, 200, {
      status: 'ok',
      productId: qualityReport.productId,
      sku: qualityReport.sku,
      dataQualityIndex: qualityReport.overallScore,
      completeness: qualityReport.completenessScore,
      evidenceCoverage: qualityReport.evidenceCoverageScore,
      verification: qualityReport.verificationScore,
      consistency: qualityReport.consistencyScore,
      tierDistribution: qualityReport.tierDistribution,
      components: qualityReport.components,
      csrdAuditReadiness: qualityReport.csrdAuditReadiness,
    });
  });
}
