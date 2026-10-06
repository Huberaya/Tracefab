import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { isUuid } from '../../../_lib/data-requests.js';
import { accessibleProduct } from '../../../_lib/quality.js';
import { executeProductGreenClaimsAudit } from '../../../_lib/green-claims/claim-auditor.js';

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

    if (req.method === 'POST') {
      const body = await readJsonBody<Record<string, unknown>>(req);
      const claimText = typeof body.claimText === 'string' ? body.claimText.trim() : '';
      const claimType = typeof body.claimType === 'string' ? body.claimType : 'product_level';
      const targetSubjectId = typeof body.targetSubjectId === 'string' && isUuid(body.targetSubjectId) ? body.targetSubjectId : null;

      if (!claimText) {
        return json(res, 400, { error: 'claim_text_required' });
      }

      const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
        const product = await accessibleProduct(tx, productId);
        if (!product) return null;

        const prodRecord = await tx.tracefab_products.findUnique({
          where: { id: productId },
          select: { version: true, brand_organization_id: true },
        });

        const createdClaim = await tx.product_green_claims.create({
          data: {
            product_id: productId,
            product_version: prodRecord?.version || 1,
            brand_organization_id: prodRecord?.brand_organization_id || product.ownerOrganizationId,
            claim_text: claimText,
            claim_type: claimType,
            target_subject_id: targetSubjectId,
          },
        });

        // Trigger auto-audit to update compliance score
        const audit = await executeProductGreenClaimsAudit(tx, { productId, userId: user.id });

        return { claim: createdClaim, audit };
      });

      if (!result) {
        return json(res, 404, { error: 'product_not_found' });
      }

      return json(res, 201, {
        message: 'claim_registered',
        claim: result.claim,
        audit: result.audit,
      });
    }

    // GET: List claims & latest audit
    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const product = await accessibleProduct(tx, productId);
      if (!product) return null;

      const prodRecord = await tx.tracefab_products.findUnique({
        where: { id: productId },
        select: { version: true },
      });

      const version = prodRecord?.version || 1;

      const claims = await tx.product_green_claims.findMany({
        where: { product_id: productId, product_version: version },
        orderBy: { created_at: 'asc' },
      });

      let audit = await tx.green_claims_audits.findUnique({
        where: { product_id_product_version: { product_id: productId, product_version: version } },
      });

      if (!audit && claims.length > 0) {
        // Run first audit automatically
        audit = await executeProductGreenClaimsAudit(tx, { productId, userId: user.id }) as any;
      }

      return { claims, audit };
    });

    if (!result) {
      return json(res, 404, { error: 'product_not_found' });
    }

    return json(res, 200, {
      claims: result.claims,
      audit: result.audit,
      directive: 'EU Green Claims Directive (UE 2024/825)',
    });
  } catch (err: unknown) {
    if (isUnauthorized(err)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    const sqlError = sqlBusinessError(err);
    if (sqlError) {
      return json(res, sqlError.status, { error: sqlError.error });
    }
    console.error('Green claims route error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
