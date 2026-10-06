export type PlmErpSystemType =
  | 'centric_plm'
  | 'lectra_kubix'
  | 'sap_s4hana'
  | 'infor_fashion'
  | 'gs1_epcis'
  | 'generic_csv';

export interface NormalizedPlmMaterial {
  name: string;
  materialType: string;
  originCountryCode?: string;
  composition: Record<string, number>;
  percentage: number;
  role?: string;
}

export interface NormalizedPlmStep {
  label: string;
  processCode: string;
  countryCode?: string;
  facilityName?: string;
  gln?: string;
}

export interface NormalizedPlmProduct {
  reference: string;
  name: string;
  sku?: string;
  category?: string;
  description?: string;
  colorName?: string;
  countryOfManufacture?: string;
  weightGrams?: number;
  gtin?: string;
  materials: NormalizedPlmMaterial[];
  productionSteps: NormalizedPlmStep[];
}

export interface GtinValidationResult {
  raw: string;
  cleanGtin: string;
  isValid: boolean;
  format: 'GTIN-8' | 'GTIN-12' | 'GTIN-13' | 'GTIN-14' | 'INVALID';
  checkDigit: number;
  calculatedCheckDigit: number;
  digitalLinkUri: string;
  error?: string;
}

export interface Gs1DigitalLinkOptions {
  domain?: string;
  gtin: string;
  serial?: string;
  lot?: string;
  linkType?: 'gs1:dpp' | 'gs1:pip' | 'gs1:epcis' | 'gs1:certificationInfo' | 'gs1:sustainabilityInfo';
}

export interface IngestionJobSummary {
  success: boolean;
  jobId: string;
  systemType: PlmErpSystemType;
  recordsIngested: number;
  productsCreated: number;
  productsUpdated: number;
  materialsCreated: number;
  identifiersCreated: number;
  nodesCreated: number;
  summary: string;
}
