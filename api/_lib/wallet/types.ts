/**
 * Donnees d'un passeport produit.
 *
 * POURQUOI TANT DE CHAMPS SONT OPTIONNELS
 *
 * Ils etaient tous obligatoires. Un type obligatoire ne cree pas la donnee :
 * il OBLIGE la couche qui le construit a inventer quelque chose. C'est
 * exactement ce qui se passait — un produit sans analyse PEF ressortait avec
 * `pefScore: 78, pefGrade: 'B', carbonFootprintKgCo2e: 3.42`, un produit sans
 * matiere declaree avec « 100% Coton peigne », un produit sans chaine avec
 * « Filature -> Tissage -> Ennoblissement -> Confection auditee ».
 *
 * Ces valeurs partaient telles quelles dans un laissez-passer Wallet, sur le
 * telephone d'un consommateur, sans rien qui les distingue d'une mesure.
 *
 * `undefined` signifie donc « non renseigne », et toute surface d'affichage
 * doit omettre la rubrique plutot que la combler. Rendre ces champs optionnels
 * transforme le compilateur en controleur : on ne peut plus lire un score
 * environnemental sans avoir traite son absence.
 */
export interface DppPassData {
  productId: string;
  brandName: string;
  brandLegalName: string;
  /** Pays de la marque, rendu par tracefab_public_brand(). */
  brandCountry?: string;
  productName: string;
  productReference: string;
  sku: string;
  gtin: string;
  serialNumber: string;
  category: string;
  /* --- Ci-dessous : valeurs metier. Absentes tant qu'elles ne sont pas
     etablies par une donnee reelle. Ne jamais substituer de valeur par
     defaut. --- */
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
  /** Date de derniere mise a jour verifiee. Absente si rien ne l'etablit. */
  verificationDate?: string;
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
