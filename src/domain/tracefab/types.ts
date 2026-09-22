/**
 * Canonical domain types for Tracefab.
 *
 * These types intentionally mirror the Tracefab Supabase migrations. They are
 * domain contracts, not generated database types yet. Database type generation
 * will be introduced once the schema is connected to a project.
 */

export type UUID = string;
export type ISODateTime = string;
export type ISODate = string;

export type OrganizationType = 'brand' | 'supplier' | 'verifier' | 'platform';
export type OrganizationStatus = 'invited' | 'active' | 'suspended' | 'archived';
export type MembershipRole = 'owner' | 'admin' | 'manager' | 'contributor' | 'viewer' | 'auditor';
export type MembershipStatus = 'invited' | 'active' | 'suspended' | 'revoked';
export type RelationshipStatus = 'invited' | 'active' | 'suspended' | 'ended';
export type SupplierOnboardingStatus = 'not_started' | 'invited' | 'in_progress' | 'submitted' | 'approved' | 'rejected';
export type SupplierEmployeeCountRange = '1_10' | '11_50' | '51_250' | '251_1000' | '1001_plus';
export type ProductStatus = 'draft' | 'active' | 'archived';
export type ProductDataReadiness = 'not_started' | 'in_progress' | 'data_ready' | 'needs_review';
export type ProductIdentifierType = 'gtin' | 'ean' | 'upc' | 'internal';
export type NodeType = 'product' | 'material' | 'organization' | 'site' | 'process';
export type SupplyChainLinkType = 'sourced_from' | 'transformed_at' | 'manufactured_at' | 'supplied_by' | 'contains' | 'next_step';
export type DataRequestStatus = 'draft' | 'sent' | 'in_progress' | 'submitted' | 'changes_requested' | 'approved' | 'cancelled';
export type DataRequestItemStatus = 'pending' | 'answered' | 'needs_review' | 'accepted' | 'rejected';
export type DataType = 'text' | 'number' | 'boolean' | 'date' | 'country' | 'percentage' | 'json' | 'document';
export type DataValueStatus = 'declared' | 'documented' | 'checked_for_consistency' | 'verified_by_reviewer' | 'certified_by_third_party' | 'expired' | 'needs_review';
export type DocumentKind = 'certificate' | 'technical_spec' | 'origin_proof' | 'audit_report' | 'invoice' | 'other';
export type DocumentStatus = 'uploaded' | 'scanning' | 'available' | 'rejected' | 'deleted';
export type DocumentVisibility = 'private' | 'shared' | 'public_projection';
export type VerificationStatus = 'pending' | 'passed' | 'failed' | 'needs_review' | 'expired';
export type ShareStatus = 'active' | 'revoked' | 'expired';
export type DppReadinessStatus = 'not_started' | 'in_progress' | 'data_ready' | 'review_required' | 'ready_to_publish' | 'published';

export interface Organization {
  id: UUID;
  type: OrganizationType;
  legalName: string;
  displayName: string | null;
  countryCode: string | null;
  registrationNumber: string | null;
  website: string | null;
  status: OrganizationStatus;
  createdBy: UUID | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface OrganizationMembership {
  id: UUID;
  organizationId: UUID;
  userId: UUID;
  role: MembershipRole;
  status: MembershipStatus;
  invitedBy: UUID | null;
  joinedAt: ISODateTime | null;
  createdAt: ISODateTime;
}

export interface Supplier {
  id: UUID;
  organizationId: UUID;
  onboardingStatus: SupplierOnboardingStatus;
  activityTypes: string[];
  profileSummary: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  employeeCountRange: SupplierEmployeeCountRange | null;
  yearEstablished: number | null;
  profileCompletion: number;
  profileVersion: number;
  lastSubmittedAt: ISODateTime | null;
  lastProfileUpdatedBy: UUID | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface SupplierSite {
  id: UUID;
  supplierId: UUID;
  name: string;
  countryCode: string;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
  activityTypes: string[];
  isActive: boolean;
}

export interface TracefabProduct {
  id: UUID;
  brandOrganizationId: UUID;
  reference: string;
  sku: string | null;
  name: string;
  category: string | null;
  description: string | null;
  productFamily: string | null;
  colorName: string | null;
  sizeRange: string[];
  countryOfDesign: string | null;
  countryOfManufacture: string | null;
  weightGrams: number | null;
  careInstructions: Record<string, unknown>;
  status: ProductStatus;
  version: number;
  dataReadiness: ProductDataReadiness;
  dataCompletion: number;
  dataReadyAt: ISODateTime | null;
  lastDataUpdatedBy: UUID | null;
  publicSlug: string | null;
  createdBy: UUID | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface ProductMaterial {
  productId: UUID;
  materialId: UUID;
  materialRole: string;
  percentage: number | null;
  unit: string;
  productVersion: number;
  createdAt: ISODateTime;
}

export interface ProductIdentifier {
  id: UUID;
  productId: UUID;
  identifierType: ProductIdentifierType;
  identifierValue: string;
  isPrimary: boolean;
  createdBy: UUID | null;
  createdAt: ISODateTime;
}

export interface Material {
  id: UUID;
  ownerOrganizationId: UUID;
  materialType: string;
  name: string;
  normalizedName: string | null;
  composition: Record<string, unknown>;
  originCountryCode: string | null;
  createdBy: UUID | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface DataPoint {
  id: UUID;
  ownerOrganizationId: UUID;
  supplierId: UUID | null;
  supplierSiteId: UUID | null;
  productId: UUID | null;
  materialId: UUID | null;
  dataKey: string;
  value: unknown;
  dataType: DataType;
  status: DataValueStatus;
  sourceDocumentId: UUID | null;
  declaredBy: UUID | null;
  validFrom: ISODate | null;
  validUntil: ISODate | null;
  version: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface DataRequest {
  id: UUID;
  brandOrganizationId: UUID;
  supplierOrganizationId: UUID;
  relationshipId: UUID;
  productId: UUID | null;
  title: string;
  questionnaireKey: string;
  questionnaireVersion: string;
  status: DataRequestStatus;
  dueAt: ISODateTime | null;
  idempotencyKey: string | null;
  completionPercentage: number;
  createdBy: UUID | null;
  submittedAt: ISODateTime | null;
  closedAt: ISODateTime | null;
  lastActivityAt: ISODateTime | null;
  reviewedAt: ISODateTime | null;
  reviewedBy: UUID | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface DataRequestItem {
  id: UUID;
  dataRequestId: UUID;
  fieldKey: string;
  label: string;
  dataType: DataType;
  required: boolean;
  evidenceRequired: boolean;
  helpText: string | null;
  validationRules: Record<string, unknown>;
  evidenceKinds: string[];
  visibility: Record<string, unknown>;
  status: DataRequestItemStatus;
  sortOrder: number;
  createdAt: ISODateTime;
}

export interface DataResponse {
  id: UUID;
  dataRequestItemId: UUID;
  value: unknown;
  dataType: DataType;
  status: DataValueStatus;
  sourceDocumentId: UUID | null;
  respondedBy: UUID | null;
  supersedesId: UUID | null;
  responseVersion: number;
  isCurrent: boolean;
  reviewComment: string | null;
  submittedAt: ISODateTime;
  reviewedAt: ISODateTime | null;
  reviewedBy: UUID | null;
}

export interface Document {
  id: UUID;
  ownerOrganizationId: UUID;
  storageBucket: string;
  storagePath: string;
  originalFilename: string;
  contentType: string;
  byteSize: number;
  sha256: string | null;
  kind: DocumentKind;
  status: DocumentStatus;
  visibility: DocumentVisibility;
  expiresAt: ISODate | null;
  uploadedBy: UUID | null;
  createdAt: ISODateTime;
}

export interface DataShareScope {
  all?: boolean;
  supplierIds?: UUID[];
  supplierSiteIds?: UUID[];
  productIds?: UUID[];
  materialIds?: UUID[];
  documentIds?: UUID[];
  dataPointIds?: UUID[];
  certificationIds?: UUID[];
}

export interface DataShare {
  id: UUID;
  relationshipId: UUID;
  supplierOrganizationId: UUID;
  granteeOrganizationId: UUID;
  scope: DataShareScope;
  status: ShareStatus;
  startsAt: ISODateTime;
  endsAt: ISODateTime | null;
  createdBy: UUID | null;
  revokedAt: ISODateTime | null;
  createdAt: ISODateTime;
}

export interface DppRecord {
  id: UUID;
  productId: UUID;
  productVersion: number;
  requirementProfileKey: string;
  requirementProfileVersion: string;
  readinessStatus: DppReadinessStatus;
  missingFields: string[];
  blockingIssues: string[];
  computedAt: ISODateTime;
  computedBy: UUID | null;
}
