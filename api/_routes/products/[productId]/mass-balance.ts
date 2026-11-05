import type { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { isUuid } from '../../../_lib/data-requests.js';
import { isTenantError, requestedTenantId, resolveActiveTenant } from '../../../_lib/tenant.js';
import {
  getProductMassBalanceSummary,
  reconcileProductMassBalance,
} from '../../../_lib/mass-balance/mass-balance-manager.js';

function routeProductId(req: VercelRequest) {
  const value = req.query.productId;
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return methodNotAllowed(res, ['GET', 'POST']);
  }

  try {
    const productId = routeProductId(req);
    if (!isUuid(productId)) {
      return json(res, 400, { error: 'invalid_product_id' });
    }

    const { user } = await requireClerkUser(req);
    const activeOrganizationId = requestedTenantId(req);

    if (req.method === 'GET') {
      const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
        const tenant = await resolveActiveTenant(tx, user.id, activeOrganizationId, { types: ['brand'] });
        const product = await tx.tracefab_products.findFirst({
          where: { id: productId, brand_organization_id: tenant.organizationId },
          select: { id: true },
        });
        if (!product) return null;
        return getProductMassBalanceSummary(tx, productId);
      }, activeOrganizationId);
      if (!result) return json(res, 404, { error: 'product_not_found' });
      return json(res, 200, result);
    }

    // POST: réconcilier uniquement le produit du tenant brand actif.
    const body = await readJsonBody<Record<string, unknown>>(req);
    const productionVolumeUnits = Number(body.productionVolumeUnits);
    const cuttingWastePct = body.cuttingWastePct !== undefined ? Number(body.cuttingWastePct) : undefined;
    const batchReference = typeof body.batchReference === 'string' ? body.batchReference.trim() : undefined;

    if (!Number.isFinite(productionVolumeUnits) || productionVolumeUnits < 0) {
      return json(res, 400, { error: 'production_volume_units_must_be_positive_or_zero' });
    }

    const recon = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const tenant = await resolveActiveTenant(tx, user.id, activeOrganizationId, { types: ['brand'] });
      const product = await tx.tracefab_products.findFirst({
        where: { id: productId, brand_organization_id: tenant.organizationId },
        select: { id: true },
      });
      if (!product) return null;
      return reconcileProductMassBalance(tx, {
        productId,
        productionVolumeUnits,
        cuttingWastePct,
        batchReference,
      });
    }, activeOrganizationId);

    if (!recon) return json(res, 404, { error: 'product_not_found' });
    return json(res, 200, {
      message: 'mass_balance_reconciled',
      reconciliation: recon,
    });
  } catch (err: unknown) {
    if (isUnauthorized(err)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    if (isTenantError(err)) {
      return json(res, err.status, { error: err.message });
    }
    const sqlError = sqlBusinessError(err);
    if (sqlError) {
      return json(res, sqlError.status, { error: sqlError.error });
    }
    console.error('Product mass balance error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
