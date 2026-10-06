import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { currentSupplier, requestedOrganizationId, serializeSupplierProfile } from '../../../_lib/supplier-profile.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const { user } = await requireClerkUser(req);
    const profile = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const current = await currentSupplier(tx, user.id, requestedOrganizationId(req));
      if (!current) return null;
      const rows = await tx.$queryRaw<typeof current[]>`
        SELECT * FROM tracefab_submit_supplier_profile(${current.id}::uuid)
      `;
      return rows[0] ?? null;
    });

    if (!profile) return json(res, 404, { error: 'supplier_profile_not_found' });
    return json(res, 200, {
      profile: serializeSupplierProfile(profile),
      status: 'submitted',
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return json(res, 409, { error: 'supplier_profile_conflict' });
    }
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('POST /api/supplier/profile/submit failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
