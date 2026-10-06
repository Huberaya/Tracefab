import type { ProductQualityIndexBreakdown } from './quality-index.js';

export interface AuditPackManifest {
  exportId: string;
  generatedAt: string;
  brandOrganizationId: string;
  productSku: string;
  complianceStandard: 'CSRD_ESRS' | 'EU_ESPR_DPP' | 'FRENCH_AGEC_ART13';
  summary: {
    dataQualityIndex: number;
    isFullyDefensible: boolean;
    auditorSignoffReady: boolean;
  };
  evidenceFiles: Array<{
    documentId: string;
    filename: string;
    sha256: string;
    standard: string;
    verifiedBy: string;
    verifiedAt: string;
  }>;
  esrsDisclosures: Record<string, { reported: boolean; evidenceRef: string }>;
}

/**
 * Builds an auditor-grade sealed audit manifest package for CSRD auditors (KPMG, EY, PwC, Mazars).
 */
export function generateAuditPackManifest(
  orgId: string,
  qualityData: ProductQualityIndexBreakdown,
  evidenceDocuments: Array<{
    id: string;
    filename: string;
    sha256: string;
    standard: string;
    verifiedBy?: string;
    verifiedAt?: string;
  }>
): AuditPackManifest {
  const exportId = `AUDIT-PACK-${qualityData.sku}-${Date.now()}`;

  const evidenceFiles = evidenceDocuments.map((doc) => ({
    documentId: doc.id,
    filename: doc.filename,
    sha256: doc.sha256,
    standard: doc.standard,
    verifiedBy: doc.verifiedBy || 'TRACEFAB_ALGORITHMIC_AUDITOR',
    verifiedAt: doc.verifiedAt || new Date().toISOString(),
  }));

  const esrsDisclosures = {
    'ESRS_E1_Carbon_Energy': {
      reported: qualityData.csrdAuditReadiness.esrsCategoryCoverage.e1_climate,
      evidenceRef: evidenceFiles[0]?.sha256 || 'NOT_ATTACHED',
    },
    'ESRS_E2_Chemical_Pollution': {
      reported: qualityData.csrdAuditReadiness.esrsCategoryCoverage.e2_pollution,
      evidenceRef: evidenceFiles.find(f => f.standard.includes('OEKO') || f.standard.includes('ZDHC'))?.sha256 || 'NOT_ATTACHED',
    },
    'ESRS_E4_Biodiversity_Ecosystems': {
      reported: qualityData.csrdAuditReadiness.esrsCategoryCoverage.e4_biodiversity,
      evidenceRef: evidenceFiles.find(f => f.standard.includes('GOTS') || f.standard.includes('ORGANIC'))?.sha256 || 'NOT_ATTACHED',
    },
    'ESRS_E5_Circular_Economy': {
      reported: qualityData.csrdAuditReadiness.esrsCategoryCoverage.e5_circular_economy,
      evidenceRef: evidenceFiles.find(f => f.standard.includes('GRS') || f.standard.includes('RECYCLED'))?.sha256 || 'NOT_ATTACHED',
    },
  };

  return {
    exportId,
    generatedAt: new Date().toISOString(),
    brandOrganizationId: orgId,
    productSku: qualityData.sku,
    complianceStandard: 'CSRD_ESRS',
    summary: {
      dataQualityIndex: qualityData.overallScore,
      isFullyDefensible: qualityData.csrdAuditReadiness.isAuditable,
      auditorSignoffReady: qualityData.overallScore >= 80 && qualityData.csrdAuditReadiness.blockingDiscrepancies.length === 0,
    },
    evidenceFiles,
    esrsDisclosures,
  };
}
