import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';
import { isTenantError, resolveActiveTenant, requestedTenantId } from '../../_lib/tenant.js';
import { getOrCreateSupplierPassport, updateSupplierPassport } from '../../_lib/supplier-passport/passport-manager.js';
import type { TradeSecretMode } from '../../_lib/supplier-passport/types.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'PATCH') {
    return methodNotAllowed(res, ['GET', 'PATCH']);
  }

  try {
    const { user } = await requireClerkUser(req);
    const activeOrganizationId = requestedTenantId(req);

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const tenant = await resolveActiveTenant(tx, user.id, activeOrganizationId, { types: ['supplier'] });

      if (req.method === 'GET') {
        return await getOrCreateSupplierPassport(tx, tenant.organizationId);
      }

      // PATCH
      const body = await readJsonBody<Record<string, unknown>>(req);
      const headline = typeof body.headline === 'string' ? body.headline.trim() : undefined;
      const tradeSecretMode = typeof body.tradeSecretMode === 'string' ? (body.tradeSecretMode as TradeSecretMode) : undefined;
      const isPublic = typeof body.isPublic === 'boolean' ? body.isPublic : undefined;
      const disclosedSections = typeof body.disclosedSections === 'object' && body.disclosedSections !== null
        ? (body.disclosedSections as any)
        : undefined;

      return await updateSupplierPassport(tx, tenant.organizationId, {
        headline,
        tradeSecretMode,
        isPublic,
        disclosedSections,
      });
    }, activeOrganizationId);

    return json(res, 200, {
      passport: result,
      publicUrl: `/passport/?ref=${result.slug}`,
    });
  } catch (err: unknown) {
    if (isUnauthorized(err)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    if (isTenantError(err)) return json(res, err.status, { error: err.message });
    const sqlError = sqlBusinessError(err);
    if (sqlError) {
      return json(res, sqlError.status, { error: sqlError.error });
    }
    console.error('Supplier passport error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
