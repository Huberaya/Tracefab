export type ConnectorType = 
  | 'CENTRIC_PLM'
  | 'LECTRA_KUBIX'
  | 'SAP_S4HANA'
  | 'SHOPIFY_PLUS'
  | 'INFOR_M3';

export interface ConnectorConfig {
  id: string;
  name: string;
  type: ConnectorType;
  endpointUrl: string;
  authMethod: 'API_KEY' | 'OAUTH2' | 'MUTUAL_TLS';
  syncIntervalMinutes: number;
  lastSyncedAt?: string;
  status: 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
  syncScope: Array<'BOM_COMPOSITION' | 'SUPPLIER_MASTER' | 'PURCHASE_ORDERS' | 'LOT_RECEIPTS'>;
}

export interface PlmProductSyncPayload {
  externalSystem: ConnectorType;
  plmReference: string;
  season: string;
  styleName: string;
  category: string;
  bomLines: Array<{
    itemCode: string;
    itemDescription: string;
    percentage: number;
    supplierExternalId: string;
    tier: 'TIER_1' | 'TIER_2' | 'TIER_3' | 'TIER_4';
  }>;
}

export interface PlmSyncResult {
  success: boolean;
  importedItemsCount: number;
  warnings: string[];
  normalizedProduct: {
    reference: string;
    name: string;
    category: string;
    materialsCount: number;
    mappedSuppliersCount: number;
    initialDataQualityIndex: number;
  };
}

/**
 * Ingests and normalizes product bill-of-materials from enterprise PLM / ERP systems (Centric, Lectra, SAP).
 */
export function ingestPlmProductBom(payload: PlmProductSyncPayload): PlmSyncResult {
  const warnings: string[] = [];

  if (!payload.plmReference || payload.plmReference.trim().length === 0) {
    throw new Error('PLM reference code is mandatory.');
  }

  if (!payload.bomLines || payload.bomLines.length === 0) {
    warnings.push('BOM is empty; product created without component breakdown.');
  }

  const totalPercentage = (payload.bomLines || []).reduce((sum, line) => sum + (line.percentage || 0), 0);
  if (payload.bomLines.length > 0 && Math.abs(totalPercentage - 100) > 0.5) {
    warnings.push(`PLM BOM percentage sum equals ${totalPercentage}%, expected 100%. Data flagged for revision.`);
  }

  const uniqueSuppliers = new Set(payload.bomLines.map(l => l.supplierExternalId).filter(Boolean));

  return {
    success: true,
    importedItemsCount: payload.bomLines.length,
    warnings,
    normalizedProduct: {
      reference: payload.plmReference,
      name: payload.styleName || `Style ${payload.plmReference}`,
      category: payload.category || 'Apparel',
      materialsCount: payload.bomLines.length,
      mappedSuppliersCount: uniqueSuppliers.size,
      initialDataQualityIndex: warnings.length === 0 ? 80 : 50,
    },
  };
}
