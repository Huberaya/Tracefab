/**
 * Universal Supplier Passport Types & Contracts
 * Chantier 6: Write Once, Share Everywhere & Supplier-First Virality
 */

export type TradeSecretMode = 'full_disclosure' | 'redacted' | 'strict_nda';

export interface DisclosedSections {
  sites: boolean;
  certifications: boolean;
  materials: boolean;
  quality_score: boolean;
  contact: boolean;
  exact_addresses: boolean;
}

export interface UniversalPassportRecord {
  id: string;
  supplierOrganizationId: string;
  supplierId?: string | null;
  slug: string;
  shareToken: string;
  isPublic: boolean;
  headline?: string | null;
  tradeSecretMode: TradeSecretMode;
  disclosedSections: DisclosedSections;
  ndaTerms?: string | null;
  viewsCount: number;
  lastViewedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicSupplierPassport {
  passport: {
    id: string;
    slug: string;
    shareToken: string;
    headline: string;
    tradeSecretMode: TradeSecretMode;
    ndaTerms: string;
    viewsCount: number;
    lastViewedAt?: string | null;
    createdAt: string;
    publicUrl: string;
  };
  supplier: {
    legalName: string;
    displayName: string;
    countryCode?: string | null;
    website?: string | null;
    activityTypes: string[];
    profileSummary?: string | null;
    employeeCountRange?: string | null;
    yearEstablished?: number | null;
    profileCompletion: number;
    contactName?: string | null;
    contactEmail?: string | null;
  };
  sites: Array<{
    id: string;
    name: string;
    countryCode: string;
    city?: string | null;
    address: string;
    postalCode?: string | null;
    activityTypes: string[];
    isActive: boolean;
  }>;
  certifications: Array<{
    id: string;
    standardName: string;
    standardCode?: string | null;
    issuerName?: string | null;
    certificateNumber?: string | null;
    issuedAt?: string | null;
    expiresAt?: string | null;
    status: string;
    isVerified: boolean;
  }>;
  materials: Array<{
    id: string;
    name: string;
    materialType: string;
    originCountryCode?: string | null;
    composition?: any;
  }>;
  qualityScore?: {
    completeness: number;
    freshness: number;
    documentationCoverage: number;
    consistency: number;
    computedAt: string;
  } | null;
  tradeSecretProtection: {
    exactAddressesMasked: boolean;
    mode: TradeSecretMode;
    legalBasis: string;
  };
}

export interface PassportAccessRequestRecord {
  id: string;
  passportId: string;
  supplierOrganizationId: string;
  requesterEmail: string;
  requesterName: string;
  requesterCompany: string;
  requesterOrganizationId?: string | null;
  message?: string | null;
  requestedScope: string[];
  ndaAccepted: boolean;
  ndaAcceptedAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  reviewedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateSupplierPassportInput {
  headline?: string;
  tradeSecretMode?: TradeSecretMode;
  disclosedSections?: Partial<DisclosedSections>;
  isPublic?: boolean;
}

export interface RequestPassportAccessInput {
  requesterEmail: string;
  requesterName: string;
  requesterCompany: string;
  message?: string;
  ndaAccepted?: boolean;
}
