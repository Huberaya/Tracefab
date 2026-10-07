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
  /* Optionnels : un champ absent signifie « non mesuré », jamais une valeur par
     défaut. Ces valeurs finissent signées dans un pass remis au consommateur —
     un chiffre de repli y devient une affirmation environnementale fausse. */
  countryOfManufacture?: string;
  countryOfDesign?: string;
  weightGrams?: number;
  certifiedComposition?: string;
  materials: Array<{
    name: string;
    percentage: number;
    role?: string;
    originCountry?: string;
  }>;
  pefScore?: number;
  pefGrade?: string; // 'A' | 'B' | 'C' | 'D' | 'E'
  carbonFootprintKgCo2e?: number;
  waterScarcityM3?: number;
  circularityScore?: number;
  dppUrl: string;
  digitalLinkUri: string;
  verificationDate: string;
  transactionCertificateNumber?: string;
  supplyChainSummary?: string;
  careInstructions?: string;
  recyclingInstructions?: string;
  /**
   * Valeurs substituées par un repli faute de donnée en base. Additif et
   * optionnel : les consommateurs existants continuent de compiler. Toute
   * interface grand public doit traiter ces champs comme absents, jamais comme
   * mesurés — un chiffre de repli n'est pas une mesure.
   */
  dataGaps?: string[];
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
