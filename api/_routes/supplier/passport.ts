import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabTenantContext } from '../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';
import { getOrCreateSupplierPassport, updateSupplierPassport } from '../../_lib/supplier-passport/passport-manager.js';
import type { TradeSecretMode } from '../../_lib/supplier-passport/types.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'PATCH') {
    return methodNotAllowed(res, ['GET', 'PATCH']);
  }

  try {
    const { user } = await requireClerkUser(req);
    const result = await withTracefabTenantContext(req, user, { types: ['supplier'] }, async (tx, tenant) => {
      const supplierOrgId = tenant.organizationId;

      if (req.method === 'GET') {
        return await getOrCreateSupplierPassport(tx, supplierOrgId);
      }

      // PATCH
      const body = await readJsonBody<Record<string, unknown>>(req);
      const headline = typeof body.headline === 'string' ? body.headline.trim() : undefined;
      const tradeSecretMode = typeof body.tradeSecretMode === 'string' ? (body.tradeSecretMode as TradeSecretMode) : undefined;
      const isPublic = typeof body.isPublic === 'boolean' ? body.isPublic : undefined;
      const disclosedSections = typeof body.disclosedSections === 'object' && body.disclosedSections !== null
        ? (body.disclosedSections as any)
        : undefined;

      return await updateSupplierPassport(tx, supplierOrgId, {
        headline,
        tradeSecretMode,
        isPublic,
        disclosedSections,
      });
    });

    return json(res, 200, {
      passport: result,
      publicUrl: `/passport/?ref=${result.slug}`,
    });
  } catch (err: unknown) {
    if (isUnauthorized(err)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    const sqlError = sqlBusinessError(err);
    if (sqlError) {
      return json(res, sqlError.status, { error: sqlError.error });
    }
    console.error('Supplier passport error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
