import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../_lib/auth';
import { withTracefabUserContext } from '../_lib/context';
import { json, methodNotAllowed, readJsonBody } from '../_lib/http';
import { sqlBusinessError } from '../_lib/sql-errors';
import {
  currentSupplier,
  requestedOrganizationId,
  profileMutationValues,
  serializeSupplierProfile,
} from '../_lib/supplier-profile';

type ProfileBody = Record<string, unknown>;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'PATCH') return methodNotAllowed(res, ['GET', 'PATCH']);

  try {
    const { user } = await requireClerkUser(req);
    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const current = await currentSupplier(tx, user.id, requestedOrganizationId(req));
      if (!current) return null;
      if (req.method === 'GET') return { current };

      const body = await readJsonBody<ProfileBody>(req);
      const values = profileMutationValues(body, current);
      const rows = await tx.$queryRaw<typeof current[]>`
        SELECT *
        FROM tracefab_update_supplier_profile(
          ${current.id}::uuid,
          ${values.profileSummary},
          ${values.contactName},
          ${values.contactEmail},
          ${values.contactPhone},
          ${values.employeeCountRange},
          ${values.yearEstablished},
          ${values.activityTypes}::text[]
        )
      `;
      return { current: rows[0] ?? null };
    });

    if (!result?.current) return json(res, 404, { error: 'supplier_profile_not_found' });
    return json(res, 200, {
      supplier: {
        id: result.current.id,
        organizationId: result.current.organization_id,
      },
      profile: serializeSupplierProfile(result.current),
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return json(res, 409, { error: 'supplier_profile_conflict' });
    }
    if (error instanceof Error && /^invalid_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error(`${req.method} /api/supplier/profile failed`, error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
