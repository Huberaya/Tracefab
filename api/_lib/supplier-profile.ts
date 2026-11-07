import type { Prisma } from '@prisma/client';
import type { ActiveTenant } from './tenant.js';

export const SUPPLIER_PROFILE_SELECT = {
  id: true,
  organization_id: true,
  onboarding_status: true,
  activity_types: true,
  profile_version: true,
  last_submitted_at: true,
  created_at: true,
  updated_at: true,
  profile_summary: true,
  contact_name: true,
  contact_email: true,
  contact_phone: true,
  employee_count_range: true,
  year_established: true,
  profile_completion: true,
} satisfies Prisma.suppliersSelect;

export type SupplierProfileRecord = Prisma.suppliersGetPayload<{ select: typeof SUPPLIER_PROFILE_SELECT }>;

export function requestedOrganizationId(request: {
  query?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}) {
  const header = request.headers?.['x-tracefab-organization-id'];
  const query = request.query?.organizationId ?? request.query?.supplierOrganizationId;
  const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
    ? (request.body as Record<string, unknown>).organizationId ?? (request.body as Record<string, unknown>).supplierOrganizationId
    : undefined;
  const raw = Array.isArray(header) ? header[0] : header || (Array.isArray(query) ? query[0] : query) || body;
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) throw new Error('invalid_organization_id');
  return raw;
}

export async function activeSupplierOrganizationIds(
  tx: Prisma.TransactionClient,
  userId: string,
  organizationId?: string | null,
) {
  const memberships = await tx.organization_memberships.findMany({
    where: {
      user_id: userId,
      status: 'active',
      ...(organizationId ? { organization_id: organizationId } : {}),
      organizations: { type: 'supplier' },
    },
    select: { organization_id: true },
  });
  return memberships.map(({ organization_id }) => organization_id);
}

export const SUPPLIER_MUTATION_ROLES = new Set(['owner', 'admin', 'manager', 'contributor']);

export async function supplierMembership(
  tx: Prisma.TransactionClient,
  userId: string,
  organizationId: string,
) {
  return tx.organization_memberships.findUnique({
    where: { organization_id_user_id: { organization_id: organizationId, user_id: userId } },
    select: { role: true, status: true },
  });
}

export async function requireSupplierMutationRole(
  tx: Prisma.TransactionClient,
  userId: string,
  organizationId: string,
) {
  const membership = await supplierMembership(tx, userId, organizationId);
  if (!membership || membership.status !== 'active' || !SUPPLIER_MUTATION_ROLES.has(membership.role)) {
    throw new Error('supplier_data_mutation_role_required');
  }
  return membership;
}

export async function currentSupplier(
  tx: Prisma.TransactionClient,
  userId: string,
  organizationId?: string | null,
) {
  // A supplier account is a tenant, not a default chosen from the user's
  // membership history. Missing selection must never fall back to the first
  // supplier organization when the account has several memberships.
  if (!organizationId) return null;
  const membership = await tx.organization_memberships.findFirst({
    where: {
      user_id: userId,
      organization_id: organizationId,
      status: 'active',
      organizations: { type: 'supplier' },
    },
    select: { organization_id: true },
  });
  if (!membership) return null;
  return tx.suppliers.findUnique({
    where: { organization_id: membership.organization_id },
    select: SUPPLIER_PROFILE_SELECT,
  });
}

/**
 * Vérifie qu'un profil fournisseur est accessible depuis le tenant actif.
 *
 * Un partage vers une marque A ne doit pas être réutilisable par un utilisateur
 * qui est aussi membre d'une marque B. La vérification borne donc explicitement
 * la relation ou le partage à l'organisation active, au lieu de s'appuyer sur
 * tracefab_can_access_shared_subject() qui agrège toutes les adhésions du compte.
 */
export async function supplierAccessibleFromTenant(
  tx: Prisma.TransactionClient,
  userId: string,
  supplierId: string,
  tenant: ActiveTenant,
  options: { allowRelationship?: boolean } = {},
): Promise<{ id: string; ownerOrganizationId: string; isOwner: boolean } | null> {
  const rows = await tx.$queryRaw<Array<{ id: string; owner_organization_id: string; is_owner: boolean }>>`
    SELECT
      s.id,
      s.organization_id AS owner_organization_id,
      (${tenant.organizationType} = 'supplier' AND s.organization_id = ${tenant.organizationId}::uuid) AS is_owner
    FROM suppliers s
    WHERE s.id = ${supplierId}::uuid
      AND (
        (
          ${tenant.organizationType} = 'supplier'
          AND s.organization_id = ${tenant.organizationId}::uuid
        )
        OR (
          ${tenant.organizationType} = 'brand'
          AND (
            (
              ${options.allowRelationship === true}::boolean
              AND EXISTS (
                SELECT 1
                FROM brand_supplier_relationships r
              WHERE r.brand_organization_id = ${tenant.organizationId}::uuid
                AND r.supplier_organization_id = s.organization_id
                  AND r.status = 'active'
              )
            )
            OR EXISTS (
              SELECT 1
              FROM data_shares sh
              JOIN organization_memberships m
                ON m.organization_id = sh.grantee_organization_id
               AND m.user_id = ${userId}::uuid
               AND m.status = 'active'
              WHERE sh.supplier_organization_id = s.organization_id
                AND sh.grantee_organization_id = ${tenant.organizationId}::uuid
                AND sh.status = 'active'
                AND sh.starts_at <= now()
                AND (sh.ends_at IS NULL OR sh.ends_at >= now())
                AND (
                  COALESCE((sh.scope ->> 'all')::boolean, false)
                  OR COALESCE(sh.scope -> 'supplier_ids', '[]'::jsonb) ? s.id::text
                )
            )
          )
        )
      )
    LIMIT 1
  `;
  const row = rows[0];
  return row
    ? { id: row.id, ownerOrganizationId: row.owner_organization_id, isOwner: row.is_owner }
    : null;
}

export function serializeSupplierProfile(row: SupplierProfileRecord) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    onboardingStatus: row.onboarding_status,
    activityTypes: row.activity_types,
    profileVersion: row.profile_version,
    lastSubmittedAt: row.last_submitted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    profileSummary: row.profile_summary,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    employeeCountRange: row.employee_count_range,
    yearEstablished: row.year_established,
    profileCompletion: String(row.profile_completion),
  };
}

export function nullableString(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length > maxLength) throw new Error(`invalid_${field}`);
  return value.trim() || null;
}

export function profileMutationValues(body: Record<string, unknown>, current: SupplierProfileRecord) {
  const allowedKeys = new Set([
    'profileSummary',
    'contactName',
    'contactEmail',
    'contactPhone',
    'employeeCountRange',
    'yearEstablished',
    'activityTypes',
  ]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) throw new Error('invalid_supplier_profile_fields');

  const profileSummary = Object.prototype.hasOwnProperty.call(body, 'profileSummary')
    ? nullableString(body.profileSummary, 'profile_summary', 10000)
    : current.profile_summary;
  const contactName = Object.prototype.hasOwnProperty.call(body, 'contactName')
    ? nullableString(body.contactName, 'contact_name', 180)
    : current.contact_name;
  const contactEmail = Object.prototype.hasOwnProperty.call(body, 'contactEmail')
    ? nullableString(body.contactEmail, 'contact_email', 320)
    : current.contact_email;
  const contactPhone = Object.prototype.hasOwnProperty.call(body, 'contactPhone')
    ? nullableString(body.contactPhone, 'contact_phone', 80)
    : current.contact_phone;
  const employeeCountRange = Object.prototype.hasOwnProperty.call(body, 'employeeCountRange')
    ? nullableString(body.employeeCountRange, 'employee_count_range', 80)
    : current.employee_count_range;
  const yearEstablished = Object.prototype.hasOwnProperty.call(body, 'yearEstablished')
    ? body.yearEstablished ?? null
    : current.year_established;
  const activityTypes = Object.prototype.hasOwnProperty.call(body, 'activityTypes')
    ? body.activityTypes
    : current.activity_types;

  if (contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) throw new Error('invalid_contact_email');
  if (yearEstablished !== null && (typeof yearEstablished !== 'number' || !Number.isInteger(yearEstablished) || yearEstablished < 1800 || yearEstablished > new Date().getUTCFullYear())) {
    throw new Error('invalid_year_established');
  }
  if (!Array.isArray(activityTypes) || activityTypes.some((value) => typeof value !== 'string' || value.trim().length === 0 || value.length > 120) || activityTypes.length > 50) {
    throw new Error('invalid_activity_types');
  }

  return { profileSummary, contactName, contactEmail, contactPhone, employeeCountRange, yearEstablished, activityTypes };
}
