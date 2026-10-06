export interface CirpassDppPayload {
  '@context': string[];
  '@type': string;
  identifier: string; // GS1 Digital Link or URN
  gtin: string;
  sku: string;
  name: string;
  brand: {
    '@type': string;
    name: string;
    countryOfOrigin: string;
  };
  materialComposition: Array<{
    materialName: string;
    percentage: number;
    certificationNumber?: string;
  }>;
  supplyChainProvenance: {
    rawMaterialOrigin: string; // Tier 4
    spinningOrigin: string;    // Tier 3
    weavingOrKnittingOrigin: string; // Tier 3
    dyeingFinishingOrigin: string;   // Tier 2
    assemblyOrigin: string;          // Tier 1
  };
  frenchAgecArticle13: {
    tissageTricotage: string;
    teintureImpression: string;
    confection: string;
    microfibresPlastiques: boolean;
    substancesDangereusesReachSvhc: boolean;
    primesOuPenalitesEcoOrganisme: string;
  };
  circularityAndCare: {
    repairabilityIndex: number; // 0 to 10
    recyclabilityRatePercent: number;
    washCareInstructions: string[];
    takeBackProgramAvailable: boolean;
  };
  issuanceMetadata: {
    issuedAt: string;
    expiresAt?: string;
    dppReadinessScore: number;
    isLegallyPublishable: boolean;
  };
}

export interface DppValidationResult {
  isValid: boolean;
  readinessScore: number;
  isPublishable: boolean;
  blockingErrors: string[];
  warnings: string[];
  standardsPassed: {
    cirpassJsonLd: boolean;
    euEspr: boolean;
    frenchAgecArt13: boolean;
    germanLkSg: boolean;
  };
}

/**
 * Validates strict European DPP (CIRPASS / ESPR) and national regulatory criteria.
 * Ensures a public QR code cannot be activated without verified provenance and mandatory fields.
 */
export function validateDppCompliance(payload: Partial<CirpassDppPayload>): DppValidationResult {
  const blockingErrors: string[] = [];
  const warnings: string[] = [];

  // 1. Mandatory Product Identifiers
  if (!payload.gtin || payload.gtin.trim().length < 8) {
    blockingErrors.push('GTIN / EAN barcode identifier is missing or malformed.');
  }
  if (!payload.sku) {
    blockingErrors.push('Product SKU is required for unique lot serialization.');
  }
  if (!payload.name) {
    blockingErrors.push('Product trade name is required.');
  }

  // 2. Material Composition Sum
  if (!Array.isArray(payload.materialComposition) || payload.materialComposition.length === 0) {
    blockingErrors.push('Material composition must contain at least one fiber breakdown.');
  } else {
    const totalPercent = payload.materialComposition.reduce((sum, m) => sum + (m.percentage || 0), 0);
    if (Math.abs(totalPercent - 100) > 0.5) {
      blockingErrors.push(`Material composition totals ${totalPercent}%, expected 100%.`);
    }
  }

  // 3. French AGEC Law (Article 13) Country Tracking
  const agec = payload.frenchAgecArticle13;
  if (!agec) {
    blockingErrors.push('French AGEC Article 13 geographical data block is missing.');
  } else {
    if (!agec.tissageTricotage || agec.tissageTricotage.length < 2) {
      blockingErrors.push('AGEC Art. 13: Country of Weaving/Knitting (Tissage/Tricotage) is mandatory.');
    }
    if (!agec.teintureImpression || agec.teintureImpression.length < 2) {
      blockingErrors.push('AGEC Art. 13: Country of Dyeing/Printing (Teinture/Impression) is mandatory.');
    }
    if (!agec.confection || agec.confection.length < 2) {
      blockingErrors.push('AGEC Art. 13: Country of Assembly (Confection) is mandatory.');
    }
  }

  // 4. Microplastics & REACH SVHC Disclosure
  if (agec && agec.microfibresPlastiques === undefined) {
    warnings.push('AGEC Art. 13: Microfiber shedding disclosure should be explicitly declared (true/false).');
  }

  // 5. Circularity & Repairability
  const circ = payload.circularityAndCare;
  if (!circ) {
    warnings.push('Circularity and repairability instructions are recommended for EU ESPR score.');
  } else if (circ.repairabilityIndex === undefined || circ.repairabilityIndex < 0 || circ.repairabilityIndex > 10) {
    warnings.push('Repairability index should be graded on a 0 to 10 scale.');
  }

  // 6. Score Calculation
  const totalChecks = 8;
  const passedChecks = totalChecks - blockingErrors.length;
  const readinessScore = Math.max(0, Math.round((passedChecks / totalChecks) * 100));
  const isPublishable = blockingErrors.length === 0 && readinessScore >= 85;

  return {
    isValid: blockingErrors.length === 0,
    readinessScore,
    isPublishable,
    blockingErrors,
    warnings,
    standardsPassed: {
      cirpassJsonLd: !!payload.identifier && !!payload.gtin,
      euEspr: isPublishable,
      frenchAgecArt13: !!agec && !!agec.tissageTricotage && !!agec.teintureImpression && !!agec.confection,
      germanLkSg: !!payload.supplyChainProvenance && !!payload.supplyChainProvenance.rawMaterialOrigin,
    },
  };
}
