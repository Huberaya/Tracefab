import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { isUuid } from '../../../_lib/data-requests.js';
import { accessibleProduct } from '../../../_lib/quality.js';
import { calculateAndStoreProductPef } from '../../../_lib/pef/pef-calculator.js';

function routeProductId(req: VercelRequest) {
  const value = req.query.productId;
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, ['GET']);
  }

  try {
    const productId = routeProductId(req);
    if (!isUuid(productId)) {
      return json(res, 400, { error: 'invalid_product_id' });
    }

    const { user } = await requireClerkUser(req);

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const product = await accessibleProduct(tx, productId);
      if (!product) return null;

      const productRecord = await tx.tracefab_products.findUnique({
        where: { id: productId },
        select: { version: true, category: true },
      });

      const currentVersion = productRecord?.version || 1;

      // Find existing assessment for current product version
      const existing = await tx.product_pef_assessments.findFirst({
        where: { product_id: productId, product_version: currentVersion },
      });

      if (existing) {
        return {
          id: existing.id,
          productId: existing.product_id,
          productVersion: existing.product_version,
          garmentCategory: existing.garment_category,
          garmentWeightKg: Number(existing.garment_weight_kg),
          carbonFootprintKgCo2e: Number(existing.carbon_footprint_kg_co2e),
          carbonBreakdown: existing.carbon_breakdown,
          waterScarcityM3: Number(existing.water_scarcity_m3),
          waterBreakdown: existing.water_breakdown,
          eutrophicationFreshwaterKgPEq: Number(existing.eutrophication_freshwater_kg_p_eq),
          microplasticsRiskGrade: existing.microplastics_risk_grade,
          circularityScore: existing.circularity_score,
          pefEcoScore: existing.pef_eco_score,
          pefGrade: existing.pef_grade,
          conventionalComparison: existing.conventional_comparison,
          dataQualityRating: existing.data_quality_rating,
          methodologyVersion: existing.methodology_version,
          calculatedAt: existing.calculated_at.toISOString(),
        };
      }

      // If not yet computed, compute automatically
      return await calculateAndStoreProductPef(tx, {
        productId,
        customCategory: productRecord?.category || undefined,
        userId: user.id,
      });
    });

    if (!result) {
      return json(res, 404, { error: 'product_not_found' });
    }

    return json(res, 200, {
      assessment: result,
      methodology: 'PEFCR Apparel & Footwear 2024 / Loi AGEC',
      regulatoryCompliance: {
        euEsprDppReady: true,
        frenchAgecCompliant: true,
      },
    });
  } catch (err: unknown) {
    if (isUnauthorized(err)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    const sqlError = sqlBusinessError(err);
    if (sqlError) {
      return json(res, sqlError.status, { error: sqlError.error });
    }
    console.error('PEF route error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
