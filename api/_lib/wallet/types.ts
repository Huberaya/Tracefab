/**
 * Données d'un passeport produit, telles que servies au consommateur.
 *
 * UN `null` N'EST PAS UN DÉFAUT DE STYLE, C'EST UNE AFFIRMATION
 *   Chaque champ métier est nullable parce qu'il peut ne pas exister. Auparavant
 *   chacun portait une valeur de substitution codée en dur — `pefScore: 78`,
 *   `pefGrade: 'B'`, `countryOfManufacture: 'PT'`, `weightGrams: 250`,
 *   `certifiedComposition: '100% Coton peigné'`,
 *   `supplyChainSummary: 'Filature ➔ Tissage ➔ Ennoblissement ➔ Confection
 *   auditée'` — et `verificationDate` retombait sur `new Date()`, c'est-à-dire
 *   une date de vérification inventée à aujourd'hui.
 *
 *   Ces valeurs étaient indiscernables de données réelles : ni le type, ni la
 *   carte Wallet, ni la page DPP ne signalaient la différence. `null` rend
 *   l'absence explicite et oblige l'affichage à dire « non renseigné ».
 */
export interface DppPassData {
  productId: string;

  /** Nom affiché de la marque, via tracefab_public_brand(). null si la marque
      n'a aucun produit publié — la fonction ne rend alors rien. */
  brandName: string | null;
  /** Jamais la raison sociale sur une surface publique. */
  brandLegalName: string | null;

  productName: string;
  productReference: string;
  sku: string | null;
  gtin: string | null;
  serialNumber: string;

  category: string | null;
  countryOfManufacture: string | null;
  countryOfDesign: string | null;
  weightGrams: number | null;

  /** null quand le produit n'a aucune composition sourcée. */
  certifiedComposition: string | null;
  materials: Array<{
    name: string | null;
    percentage: number | null;
    role?: string | null;
    originCountry?: string | null;
  }>;

  /** null en l'absence d'évaluation PEF. Un score inventé est une allégation
      environnementale sans fondement. */
  pefScore: number | null;
  pefGrade: string | null;
  carbonFootprintKgCo2e: number | null;
  waterScarcityM3: number | null;
  circularityScore: number | null;

  dppUrl: string;
  digitalLinkUri: string;

  /** Date de calcul du DPP, issue de dpp_records.computed_at. null si aucun
      enregistrement : ce n'est ni updated_at, ni aujourd'hui. */
  verificationDate: string | null;

  /** Numéro réel de transaction certificate (tc_number). null si aucun —
      jamais un numéro fabriqué à partir d'un identifiant de réconciliation. */
  transactionCertificateNumber: string | null;

  supplyChainSummary: string | null;
  careInstructions: Record<string, unknown> | null;
  recyclingInstructions: Record<string, unknown> | null;

  /**
   * Provenance de ce qui est servi. Sans elle, « live » ne veut rien dire :
   * une carte peut être techniquement générée tout en étant vide de données
   * sourcées.
   */
  provenance: {
    /** 'live' uniquement si au moins une donnée métier vient de la base. */
    status: 'live' | 'incomplete';
    /** Champs effectivement issus d'une ligne de la base. */
    sourced: string[];
    /** Champs absents : l'affichage doit dire « non renseigné ». */
    notProvided: string[];
    /** Comment le produit a été résolu — nécessaire pour juger de la confiance. */
    resolvedBy: 'gtin' | 'public_slug' | 'reference' | 'sku' | 'id';
    /** null quand la résolution est ambiguë entre plusieurs marques. */
    ambiguousWith: number;
  };
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
