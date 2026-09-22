import type {
  ISODateTime,
  MembershipRole,
  Supplier,
  SupplierEmployeeCountRange,
  SupplierOnboardingStatus,
  SupplierSite,
  UUID,
} from './types';

export interface SupplierProfile {
  supplier: Supplier;
  legalName: string;
  displayName: string | null;
  countryCode: string | null;
  profileSummary: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  employeeCountRange: SupplierEmployeeCountRange | null;
  yearEstablished: number | null;
  activityTypes: string[];
  sites: SupplierSite[];
  profileCompletion: number;
}

export interface InviteSupplierCommand {
  brandOrganizationId: UUID;
  email: string;
  legalName: string;
  displayName?: string | null;
  countryCode?: string | null;
  /** SHA-256 or equivalent one-way hash; the raw token stays in the delivery layer. */
  tokenHash: string;
}

export interface InviteSupplierResult {
  relationshipId: UUID;
  supplierOrganizationId: UUID;
  supplierId: UUID;
  invitationId: UUID;
  expiresAt: ISODateTime;
}

export interface AcceptInvitationResult {
  organizationId: UUID;
  membershipId: UUID;
  relationshipId: UUID | null;
  supplierId: UUID | null;
}

export interface UpdateSupplierProfileCommand {
  supplierId: UUID;
  profileSummary: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  employeeCountRange: SupplierEmployeeCountRange | null;
  yearEstablished: number | null;
  activityTypes: string[];
}

export interface SubmitSupplierProfileResult extends Supplier {
  onboardingStatus: Extract<
    SupplierOnboardingStatus,
    'submitted'
  >;
}

export interface SupplierInvitationSummary {
  invitationId: UUID;
  relationshipId: UUID;
  supplierOrganizationId: UUID;
  email: string;
  targetRole: MembershipRole;
  expiresAt: ISODateTime;
  acceptedAt: ISODateTime | null;
}
