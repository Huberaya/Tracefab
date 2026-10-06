export type DataQualityTier = 
  | 'certified'
  | 'verified'
  | 'documented'
  | 'declared'
  | 'needs_review'
  | 'missing';

export interface ComponentQualityItem {
  componentName: string;
  componentType: 'main_fabric' | 'lining' | 'trims_hardware' | 'packaging';
  weightPercentage: number;
  dataPointsCount: number;
  tier: DataQualityTier;
  hasAccreditedCert: boolean;
  hasReviewerApproval: boolean;
  hasDocumentAttached: boolean;
  isSelfDeclaredOnly: boolean;
  anomaliesDetected: string[];
}

export interface ProductQualityIndexBreakdown {
  productId: string;
  sku: string;
  overallScore: number; // 0 to 100
  completenessScore: number;
  evidenceCoverageScore: number;
  verificationScore: number;
  consistencyScore: number;
  tierDistribution: Record<DataQualityTier, number>;
  components: Array<{
    componentName: string;
    componentScore: number;
    tier: DataQualityTier;
  }>;
  csrdAuditReadiness: {
    isAuditable: boolean;
    esrsCategoryCoverage: {
      e1_climate: boolean;
      e2_pollution: boolean;
      e4_biodiversity: boolean;
      e5_circular_economy: boolean;
    };
    blockingDiscrepancies: string[];
  };
}

/**
 * Calculates a dynamic, explainable Data Quality Index across garment components.
 * Replaces opaque ratings with a strict 6-level defensible hierarchy.
 */
export function calculateDataQualityIndex(
  productId: string,
  sku: string,
  items: ComponentQualityItem[]
): ProductQualityIndexBreakdown {
  if (items.length === 0) {
    return {
      productId,
      sku,
      overallScore: 0,
      completenessScore: 0,
      evidenceCoverageScore: 0,
      verificationScore: 0,
      consistencyScore: 0,
      tierDistribution: { certified: 0, verified: 0, documented: 0, declared: 0, needs_review: 0, missing: 0 },
      components: [],
      csrdAuditReadiness: {
        isAuditable: false,
        esrsCategoryCoverage: { e1_climate: false, e2_pollution: false, e4_biodiversity: false, e5_circular_economy: false },
        blockingDiscrepancies: ['No components supplied for evaluation.'],
      },
    };
  }

  const tierDistribution: Record<DataQualityTier, number> = {
    certified: 0,
    verified: 0,
    documented: 0,
    declared: 0,
    needs_review: 0,
    missing: 0,
  };

  const blockingDiscrepancies: string[] = [];

  // Weight multipliers for the 6 tiers:
  // Certified = 100%, Verified = 85%, Documented = 65%, Declared = 35%, Needs Review = 10%, Missing = 0%
  const tierScores: Record<DataQualityTier, number> = {
    certified: 100,
    verified: 85,
    documented: 65,
    declared: 35,
    needs_review: 10,
    missing: 0,
  };

  let totalWeightedScore = 0;
  let totalWeight = 0;
  let documentedCount = 0;
  let verifiedCount = 0;

  const evaluatedComponents = items.map((item) => {
    let tier: DataQualityTier = 'missing';

    if (item.anomaliesDetected.length > 0) {
      tier = 'needs_review';
      blockingDiscrepancies.push(...item.anomaliesDetected.map(a => `[${item.componentName}]: ${a}`));
    } else if (item.hasAccreditedCert) {
      tier = 'certified';
      documentedCount++;
      verifiedCount++;
    } else if (item.hasReviewerApproval) {
      tier = 'verified';
      documentedCount++;
      verifiedCount++;
    } else if (item.hasDocumentAttached) {
      tier = 'documented';
      documentedCount++;
    } else if (item.isSelfDeclaredOnly) {
      tier = 'declared';
    } else {
      tier = 'missing';
      blockingDiscrepancies.push(`[${item.componentName}] Missing essential material provenance data.`);
    }

    tierDistribution[tier]++;
    const weight = item.weightPercentage > 0 ? item.weightPercentage : (100 / items.length);
    totalWeight += weight;
    const componentScore = tierScores[tier];
    totalWeightedScore += componentScore * weight;

    return {
      componentName: item.componentName,
      componentScore,
      tier,
    };
  });

  const overallScore = Number((totalWeightedScore / (totalWeight || 1)).toFixed(1));
  const completenessScore = Number((((items.length - tierDistribution.missing) / items.length) * 100).toFixed(1));
  const evidenceCoverageScore = Number(((documentedCount / items.length) * 100).toFixed(1));
  const verificationScore = Number(((verifiedCount / items.length) * 100).toFixed(1));
  const consistencyScore = tierDistribution.needs_review === 0 ? 100 : Math.max(0, 100 - (tierDistribution.needs_review * 25));

  // CSRD ESRS Auditable status
  const isAuditable = overallScore >= 75 && blockingDiscrepancies.length === 0 && evidenceCoverageScore >= 70;

  return {
    productId,
    sku,
    overallScore,
    completenessScore,
    evidenceCoverageScore,
    verificationScore,
    consistencyScore,
    tierDistribution,
    components: evaluatedComponents,
    csrdAuditReadiness: {
      isAuditable,
      esrsCategoryCoverage: {
        e1_climate: evidenceCoverageScore >= 80,
        e2_pollution: verificationScore >= 75,
        e4_biodiversity: overallScore >= 70,
        e5_circular_economy: completenessScore >= 85,
      },
      blockingDiscrepancies,
    },
  };
}
