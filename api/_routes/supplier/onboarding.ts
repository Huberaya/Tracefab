import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';
import { requiredString, optionalString } from '../../_lib/data-requests.js';
import { SUPPLIER_PROFILE_SELECT, serializeSupplierProfile } from '../../_lib/supplier-profile.js';

interface OnboardingBody {
  legalName?: string;
  displayName?: string | null;
  countryCode?: string | null;
  profileSummary?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  activityTypes?: string[] | null;
}

type RegistrationRow = {
  organization_id: string;
  supplier_id: string;
  membership_id: string;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  try {
    const { user } = await requireClerkUser(req);
    const body = await readJsonBody<OnboardingBody>(req);

    const legalName = requiredString(body.legalName, 'supplier_legal_name', 180);
    const displayName = optionalString(body.displayName, 'supplier_display_name', 180);
    const rawCountry = optionalString(body.countryCode, 'country_code', 10);
    const countryCode = rawCountry ? rawCountry.toUpperCase() : null;

    if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) {
      return json(res, 400, { error: 'invalid_country_code' });
    }

    const profileSummary = optionalString(body.profileSummary, 'profile_summary', 4000);
    const contactName = optionalString(body.contactName, 'contact_name', 180) || user.fullName || null;
    const contactPhone = optionalString(body.contactPhone, 'contact_phone', 50);

    const activityTypes = Array.isArray(body.activityTypes)
      ? body.activityTypes.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim())
      : [];

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      // 1. Call registration procedure
      const rows = await tx.$queryRaw<RegistrationRow[]>`
        SELECT *
        FROM tracefab_register_supplier_organization(
          ${legalName},
          ${displayName},
          ${countryCode},
          ${profileSummary},
          ${contactName},
          ${contactPhone},
          ${activityTypes}::text[]
        )
      `;

      const reg = rows[0];
      if (!reg) throw new Error('supplier_registration_failed');

      // 2. Query created organization and supplier profile
      const org = await tx.organizations.findUnique({
        where: { id: reg.organization_id },
        select: {
          id: true,
          type: true,
          legal_name: true,
          display_name: true,
          country_code: true,
          status: true,
        },
      });

      const supplierProfile = await tx.suppliers.findUnique({
        where: { id: reg.supplier_id },
        select: SUPPLIER_PROFILE_SELECT,
      });

      if (!org || !supplierProfile) throw new Error('supplier_registration_verification_failed');

      return {
        organization: org,
        supplier: {
          id: supplierProfile.id,
          organizationId: supplierProfile.organization_id,
        },
        profile: serializeSupplierProfile(supplierProfile),
      };
    });

    return json(res, 201, result);
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && /^invalid_/.test(error.message)) {
      return json(res, 400, { error: error.message });
    }
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('POST /api/supplier/onboarding failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
