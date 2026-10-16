/**
 * Forme des donnees de passeport, avec PROVENANCE explicite.
 *
 * Regle du chantier 1A-C : chaque valeur affichee dans un DPP ou une carte
 * Wallet est soit reliee a une source identifiable, soit clairement signalee
 * comme indisponible / non renseignee / non verifiee. Aucune valeur metier
 * n'est generee « pour faire joli » : une substitution peut etre prise pour
 * une donnee reelle, et c'est exactement le defaut a faire disparaitre.
 *
 * Les quatre etats :
 *   - 'sourced'     : la valeur vient de la source annoncee (champ `source`),
 *                     generalement une table de la base, parfois un calcul
 *                     deterministe declare comme tel ;
 *   - 'unverified'  : la valeur existe mais sa provenance n'etablit pas une
 *                     verification (statut `declared` / `needs_review`) ;
 *   - 'not_filled'  : le modele attend la donnee et personne ne l'a remplie ;
 *   - 'unavailable' : la fonctionnalite ne produit pas cette donnee en
 *                     l'etat (pas d'evaluation PEF, pas de consigne de
 *                     recyclage modelisee) — « indisponible ».
 */

export type ProvenanceStatus = 'sourced' | 'unverified' | 'not_filled' | 'unavailable';

export interface SourcedField<T> {
  value: T | null;
  status: ProvenanceStatus;
  /** Origine de la valeur : table.colonne, fonction SQL, ou 'calcul: …'. */
  source: string | null;
}

export const PROVENANCE_LABELS_FR: Record<ProvenanceStatus, string> = {
  sourced: 'Source vérifiée',
  unverified: 'Non vérifié',
  not_filled: 'Non renseigné',
  unavailable: 'Indisponible',
};

/** Texte a afficher pour un champ : la valeur si elle est presentable, sinon
 * l'etat explicite. Une valeur non verifiee reste affichee MAIS marquee. */
export function fieldDisplay<T>(field: SourcedField<T>): string {
  if (field.status === 'sourced' && field.value !== null && field.value !== undefined) {
    return String(field.value);
  }
  if (field.status === 'unverified' && field.value !== null && field.value !== undefined) {
    return `${String(field.value)} (${PROVENANCE_LABELS_FR.unverified})`;
  }
  return PROVENANCE_LABELS_FR[field.status] ?? PROVENANCE_LABELS_FR.unavailable;
}

export interface DppMaterial {
  name: SourcedField<string>;
  percentage: SourcedField<number>;
  role: SourcedField<string>;
  originCountry: SourcedField<string>;
}

export interface DppPassData {
  productId: string;

  // Identite — colonnes NOT NULL de tracefab_products.
  productName: SourcedField<string>;
  productReference: SourcedField<string>;
  sku: SourcedField<string>;
  /** GTIN issu de product_identifiers (type 'gtin'). Jamais un SKU deguise. */
  gtin: SourcedField<string>;
  /** Identifiant de passeport, derive de la reference et de la version. */
  serialNumber: SourcedField<string>;
  category: SourcedField<string>;
  brandName: SourcedField<string>;

  // Fabrication — colonnes produit, ou etat explicite.
  countryOfManufacture: SourcedField<string>;
  countryOfDesign: SourcedField<string>;
  weightGrams: SourcedField<number>;
  composition: SourcedField<string>;
  materials: DppMaterial[];
  supplyChainSummary: SourcedField<string>;

  // Environnement — uniquement si une evaluation PEF existe.
  pefScore: SourcedField<number>;
  pefGrade: SourcedField<string>;
  carbonFootprintKgCo2e: SourcedField<number>;
  waterScarcityM3: SourcedField<number>;
  circularityScore: SourcedField<number>;

  // Preuves et entretien.
  verificationDate: SourcedField<string>;
  transactionCertificateNumber: SourcedField<string>;
  careInstructions: SourcedField<string>;
  recyclingInstructions: SourcedField<string>;

  // Liens — derives de donnees reelles (jamais de prefixe EPC invente).
  dppUrl: string;
  digitalLinkUri: SourcedField<string>;

  /**
   * Provenance globale presentee au consommateur : 'live' UNIQUEMENT si au
   * moins une donnee metier est 'sourced' et que le produit ressort d'une
   * publication explicite. Un passeport entierement vide ou non verifie se
   * declare tel quel.
   */
  presentation: {
    source: 'live' | 'partial' | 'empty';
    /** Nombre de champs metier reels (sourced) presentes. */
    sourcedFieldCount: number;
    /** Nombre de champs absents ou indisponibles. */
    missingFieldCount: number;
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
