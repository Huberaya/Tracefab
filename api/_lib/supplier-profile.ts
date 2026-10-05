import type { Prisma } from '@prisma/client';

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
}) {
  const header = request.headers?.['x-tracefab-organization-id'];
  const query = request.query?.organizationId;
  const raw = Array.isArray(header) ? header[0] : header || (Array.isArray(query) ? query[0] : query);
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !/^[0-9a-f-]{36}$/i.test(raw)) throw new Error('invalid_organization_id');
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
  const membership = await tx.organization_memberships.findFirst({
    where: {
      user_id: userId,
      status: 'active',
      ...(organizationId ? { organization_id: organizationId } : {}),
      organizations: { type: 'supplier' },
    },
    select: { organization_id: true },
    orderBy: { created_at: 'asc' },
  });
  if (!membership) return null;
  return tx.suppliers.findUnique({
    where: { organization_id: membership.organization_id },
    select: SUPPLIER_PROFILE_SELECT,
  });
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
