import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth';
import { withTracefabUserContext } from '../../_lib/context';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http';
import { sqlBusinessError } from '../../_lib/sql-errors';

const PROFILE_FIELDS = {
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
};

type SupplierProfileBody = {
  profileSummary?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  employeeCountRange?: string | null;
  yearEstablished?: number | null;
  activityTypes?: string[];
};

type SupplierProfileRow = {
  id: string;
  organization_id: string;
  onboarding_status: string;
  activity_types: string[];
  profile_version: number;
  last_submitted_at: Date | null;
  created_at: Date;
  updated_at: Date;
  profile_summary: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  employee_count_range: string | null;
  year_established: number | null;
  profile_completion: string | number;
};

function routeSupplierId(req: VercelRequest) {
  const value = req.query.supplierId;
  return Array.isArray(value) ? value[0] : value;
}

function nullableString(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length > maxLength) {
    throw new Error(`invalid_${field}`);
  }
  return value.trim() || null;
}

function publicProfile(row: SupplierProfileRow) {
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
    profileCompletion: row.profile_completion,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'PATCH') return methodNotAllowed(res, ['GET', 'PATCH']);

  try {
    const supplierId = routeSupplierId(req);
    if (!supplierId || !/^[0-9a-f-]{36}$/i.test(supplierId)) {
      return json(res, 400, { error: 'invalid_supplier_id' });
    }

    const { user } = await requireClerkUser(req);
    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const current = await tx.suppliers.findUnique({ where: { id: supplierId }, select: PROFILE_FIELDS });
      if (!current) return null;
      if (req.method === 'GET') return current;

      const body = await readJsonBody<SupplierProfileBody>(req);
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

      const rows = await tx.$queryRaw<SupplierProfileRow[]>`
        SELECT *
        FROM tracefab_update_supplier_profile(
          ${supplierId}::uuid,
          ${profileSummary},
          ${contactName},
          ${contactEmail},
          ${contactPhone},
          ${employeeCountRange},
          ${yearEstablished},
          ${activityTypes}::text[]
        )
      `;
      return rows[0] ?? null;
    });

    if (!result) return json(res, 404, { error: 'supplier_not_found' });
    return json(res, 200, { profile: publicProfile(result as SupplierProfileRow) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && /^invalid_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('GET/PATCH /api/suppliers/:supplierId/profile failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
