import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  UniversalPassportRecord,
  PublicSupplierPassport,
  PassportAccessRequestRecord,
  UpdateSupplierPassportInput,
  RequestPassportAccessInput,
} from './types.js';

type PrismaTx = PrismaClient | Prisma.TransactionClient;

/**
 * Retrieves or creates a Universal Supplier Passport for the active supplier organization.
 */
export async function getOrCreateSupplierPassport(
  tx: PrismaTx,
  supplierOrganizationId: string
): Promise<UniversalPassportRecord> {
  const rows = await tx.$queryRaw<Array<any>>`
    SELECT * FROM tracefab_get_or_create_supplier_passport(
      p_supplier_organization_id := ${supplierOrganizationId}::uuid
    );
  `;

  if (!rows || rows.length === 0) {
    throw new Error('failed_to_get_or_create_passport');
  }

  const p = rows[0];
  return {
    id: p.id,
    supplierOrganizationId: p.supplier_organization_id,
    supplierId: p.supplier_id,
    slug: p.slug,
    shareToken: p.share_token,
    isPublic: p.is_public,
    headline: p.headline,
    tradeSecretMode: p.trade_secret_mode,
    disclosedSections: typeof p.disclosed_sections === 'string' ? JSON.parse(p.disclosed_sections) : p.disclosed_sections,
    ndaTerms: p.nda_terms,
    viewsCount: p.views_count,
    lastViewedAt: p.last_viewed_at?.toISOString?.() || p.last_viewed_at,
    createdAt: p.created_at?.toISOString?.() || p.created_at,
    updatedAt: p.updated_at?.toISOString?.() || p.updated_at,
  };
}

/**
 * Updates an existing passport settings.
 */
export async function updateSupplierPassport(
  tx: PrismaTx,
  supplierOrganizationId: string,
  input: UpdateSupplierPassportInput
): Promise<UniversalPassportRecord> {
  const disclosedSectionsJson = input.disclosedSections
    ? JSON.stringify(input.disclosedSections)
    : null;

  const rows = await tx.$queryRaw<Array<any>>`
    SELECT * FROM tracefab_update_supplier_passport(
      p_supplier_organization_id := ${supplierOrganizationId}::uuid,
      p_headline := ${input.headline ?? null},
      p_trade_secret_mode := ${input.tradeSecretMode ?? null},
      p_disclosed_sections := ${disclosedSectionsJson ? (disclosedSectionsJson + '::jsonb') : null}::jsonb,
      p_is_public := ${input.isPublic ?? null}
    );
  `;

  if (!rows || rows.length === 0) {
    throw new Error('failed_to_update_passport');
  }

  const p = rows[0];
  return {
    id: p.id,
    supplierOrganizationId: p.supplier_organization_id,
    supplierId: p.supplier_id,
    slug: p.slug,
    shareToken: p.share_token,
    isPublic: p.is_public,
    headline: p.headline,
    tradeSecretMode: p.trade_secret_mode,
    disclosedSections: typeof p.disclosed_sections === 'string' ? JSON.parse(p.disclosed_sections) : p.disclosed_sections,
    ndaTerms: p.nda_terms,
    viewsCount: p.views_count,
    lastViewedAt: p.last_viewed_at?.toISOString?.() || p.last_viewed_at,
    createdAt: p.created_at?.toISOString?.() || p.created_at,
    updatedAt: p.updated_at?.toISOString?.() || p.updated_at,
  };
}

/**
 * Public resolver for viewing a passport without authentication.
 */
export async function getPublicSupplierPassport(
  tx: PrismaTx,
  tokenOrSlug: string
): Promise<PublicSupplierPassport> {
  const rows = await tx.$queryRaw<Array<{ tracefab_get_public_supplier_passport: any }>>`
    SELECT tracefab_get_public_supplier_passport(${tokenOrSlug}) as tracefab_get_public_supplier_passport;
  `;

  if (!rows || rows.length === 0 || !rows[0].tracefab_get_public_supplier_passport) {
    throw new Error('passport_not_found');
  }

  const payload = rows[0].tracefab_get_public_supplier_passport;
  return typeof payload === 'string' ? JSON.parse(payload) : payload;
}

/**
 * Submits an access request from an external brand looking to inspect unredacted evidence.
 */
export async function requestPassportAccess(
  tx: PrismaTx,
  tokenOrSlug: string,
  input: RequestPassportAccessInput
): Promise<{
  requestId: string;
  status: string;
  supplierOrganizationId: string;
  isExistingBrand: boolean;
  message: string;
}> {
  const rows = await tx.$queryRaw<Array<{ tracefab_request_passport_access: any }>>`
    SELECT tracefab_request_passport_access(
      p_token_or_slug := ${tokenOrSlug},
      p_requester_email := ${input.requesterEmail},
      p_requester_name := ${input.requesterName},
      p_requester_company := ${input.requesterCompany},
      p_message := ${input.message ?? null},
      p_nda_accepted := ${input.ndaAccepted ?? true}
    ) as tracefab_request_passport_access;
  `;

  if (!rows || rows.length === 0 || !rows[0].tracefab_request_passport_access) {
    throw new Error('failed_to_request_access');
  }

  const res = rows[0].tracefab_request_passport_access;
  return typeof res === 'string' ? JSON.parse(res) : res;
}

/**
 * Supplier reviews an incoming brand access request.
 */
export async function reviewPassportAccess(
  tx: PrismaTx,
  requestId: string,
  verdict: 'approved' | 'rejected'
): Promise<PassportAccessRequestRecord> {
  const rows = await tx.$queryRaw<Array<any>>`
    SELECT * FROM tracefab_review_passport_access(
      p_request_id := ${requestId}::uuid,
      p_verdict := ${verdict}
    );
  `;

  if (!rows || rows.length === 0) {
    throw new Error('access_request_not_found');
  }

  const r = rows[0];
  return {
    id: r.id,
    passportId: r.passport_id,
    supplierOrganizationId: r.supplier_organization_id,
    requesterEmail: r.requester_email,
    requesterName: r.requester_name,
    requesterCompany: r.requester_company,
    requesterOrganizationId: r.requester_organization_id,
    message: r.message,
    requestedScope: r.requested_scope,
    ndaAccepted: r.nda_accepted,
    ndaAcceptedAt: r.nda_accepted_at?.toISOString?.() || r.nda_accepted_at,
    status: r.status,
    reviewedAt: r.reviewed_at?.toISOString?.() || r.reviewed_at,
    createdAt: r.created_at?.toISOString?.() || r.created_at,
    updatedAt: r.updated_at?.toISOString?.() || r.updated_at,
  };
}
