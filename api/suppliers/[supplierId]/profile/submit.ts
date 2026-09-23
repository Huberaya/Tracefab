import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth';
import { withTracefabUserContext } from '../../../_lib/context';
import { json, methodNotAllowed } from '../../../_lib/http';
import { sqlBusinessError } from '../../../_lib/sql-errors';

type SubmittedSupplierRow = {
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

function publicProfile(row: SubmittedSupplierRow) {
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
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const supplierId = routeSupplierId(req);
    if (!supplierId || !/^[0-9a-f-]{36}$/i.test(supplierId)) {
      return json(res, 400, { error: 'invalid_supplier_id' });
    }

    const { user } = await requireClerkUser(req);
    const rows = await withTracefabUserContext(user.id, user.email, (tx) =>
      tx.$queryRaw<SubmittedSupplierRow[]>`
        SELECT *
        FROM tracefab_submit_supplier_profile(${supplierId}::uuid)
      `,
    );
    const row = rows[0];
    if (!row) return json(res, 404, { error: 'supplier_not_found' });
    return json(res, 200, { profile: publicProfile(row) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('POST /api/suppliers/:supplierId/profile/submit failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
