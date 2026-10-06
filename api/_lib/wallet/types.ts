export interface DppPassData {
  productId: string;
  brandName: string;
  brandLegalName: string;
  productName: string;
  productReference: string;
  sku: string;
  gtin: string;
  serialNumber: string;
  category: string;
  countryOfManufacture: string;
  countryOfDesign: string;
  weightGrams: number;
  certifiedComposition: string;
  materials: Array<{
    name: string;
    percentage: number;
    role?: string;
    originCountry?: string;
  }>;
  pefScore: number;
  pefGrade: string; // 'A' | 'B' | 'C' | 'D' | 'E'
  carbonFootprintKgCo2e: number;
  waterScarcityM3: number;
  circularityScore: number;
  dppUrl: string;
  digitalLinkUri: string;
  verificationDate: string;
  transactionCertificateNumber?: string;
  supplyChainSummary?: string;
  careInstructions?: string;
  recyclingInstructions?: string;
}

export interface AppleWalletOptions {
  passTypeIdentifier?: string;
  teamIdentifier?: string;
  passCertificatePem?: string;
  passKeyPem?: string;
  wwdrCertificatePem?: string;
  useMockSignature?: boolean;
}

export interface GoogleWalletOptions {
  issuerId?: string;
  serviceAccountKeyJson?: string;
  classId?: string;
}
