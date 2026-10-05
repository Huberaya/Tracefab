import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import {
  profileMutationValues,
  serializeSupplierProfile,
  SUPPLIER_PROFILE_SELECT,
  type SupplierProfileRecord,
} from '../../../_lib/supplier-profile.js';

function routeSupplierId(req: VercelRequest) {
  const value = req.query.supplierId;
  return Array.isArray(value) ? value[0] : value;
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
      const current = await tx.suppliers.findUnique({ where: { id: supplierId }, select: SUPPLIER_PROFILE_SELECT });
      if (!current) return null;
      if (req.method === 'GET') return current;

      const body = await readJsonBody<Record<string, unknown>>(req);
      const values = profileMutationValues(body, current);
      const rows = await tx.$queryRaw<SupplierProfileRecord[]>`
        SELECT *
        FROM tracefab_update_supplier_profile(
          ${supplierId}::uuid,
          ${values.profileSummary},
          ${values.contactName},
          ${values.contactEmail},
          ${values.contactPhone},
          ${values.employeeCountRange},
          ${values.yearEstablished},
          ${values.activityTypes}::text[]
        )
      `;
      return rows[0] ?? null;
    });

    if (!result) return json(res, 404, { error: 'supplier_not_found' });
    return json(res, 200, { profile: serializeSupplierProfile(result) });
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
    console.error('GET/PATCH /api/suppliers/:supplierId/profile failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
