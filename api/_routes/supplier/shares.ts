import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';
import { currentSupplier, requestedOrganizationId } from '../../_lib/supplier-profile.js';
import { sanitizeSupplierTradeSecrets } from '../../_lib/trade-secret-vault.js';

type ShareBody = {
  relationshipId?: string;
  granteeOrganizationId?: string;
  scope?: Record<string, unknown>;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return methodNotAllowed(res, ['GET', 'POST']);
  }

  try {
    const auth = await requireClerkUser(req);
    const activeOrgId = requestedOrganizationId(req);

    return await withTracefabUserContext(auth.user.id, auth.user.email, async (tx) => {
      const supplier = await currentSupplier(tx, auth.user.id, activeOrgId);
      if (!supplier) {
        return json(res, 404, { error: 'supplier_not_found' });
      }

      if (req.method === 'GET') {
        const shares = await tx.data_shares.findMany({
          where: { supplier_organization_id: supplier.organization_id },
          include: {
            organizations_data_shares_grantee_organization_idToorganizations: {
              select: { id: true, legal_name: true, display_name: true },
            },
          },
          orderBy: { created_at: 'desc' },
        });

        return json(res, 200, {
          status: 'ok',
          supplierOrganizationId: supplier.organization_id,
          shares: shares.map((s) => ({
            id: s.id,
            granteeOrganization: s.organizations_data_shares_grantee_organization_idToorganizations,
            scope: s.scope,
            status: s.status,
            startsAt: s.starts_at,
            endsAt: s.ends_at,
            createdAt: s.created_at,
          })),
        });
      }

      // POST: Create or reuse multi-brand data share with sanitized trade secrets
      const body = await readJsonBody<ShareBody>(req);
      const { relationshipId, granteeOrganizationId, scope } = body;

      if (!relationshipId || !granteeOrganizationId) {
        return json(res, 400, { error: 'missing_parameters', message: 'relationshipId and granteeOrganizationId are required.' });
      }

      // Automatically enforce trade-secret protection on the shared scope payload
      const { sanitized, confidentialCount } = sanitizeSupplierTradeSecrets(scope || {});

      const created = await tx.data_shares.create({
        data: {
          relationship_id: relationshipId,
          supplier_organization_id: supplier.organization_id,
          grantee_organization_id: granteeOrganizationId,
          scope: sanitized as any,
          created_by: auth.user.id,
        },
      });

      return json(res, 201, {
        status: 'created',
        shareId: created.id,
        protectedFieldsCount: confidentialCount,
        tradeSecretShieldActive: true,
        dataShare: created,
      });
    }, activeOrgId);
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && /^invalid_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error(`${req.method} /api/supplier/shares failed`, error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
