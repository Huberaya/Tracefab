import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { isTenantError, requireActiveTenant, requestedTenantId } from '../../_lib/tenant.js';
import { verifyAuditChainIntegrity } from '../../_lib/audit-vault.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const auth = await requireClerkUser(req);

    const result = await withTracefabUserContext(auth.user.id, auth.user.email, async (tx) => {
      const tenant = await requireActiveTenant(tx, req, auth.user.id);
      const membership = await tx.organization_memberships.findFirst({
        where: {
          user_id: auth.user.id,
          organization_id: tenant.organizationId,
          status: 'active',
          role: { in: ['owner', 'admin', 'auditor'] },
        },
        select: { organization_id: true },
      });
      if (!membership) return null;

      const chain = await verifyAuditChainIntegrity(tx, tenant.organizationId);
      return { organizationId: tenant.organizationId, chain };
    }, requestedTenantId(req));

    if (!result) return json(res, 403, { error: 'audit_chain_access_denied' });
    res.setHeader('Cache-Control', 'no-store');
    return json(res, 200, {
      status: 'ok',
      organizationId: result.organizationId,
      verifiedAt: new Date().toISOString(),
      isChainValid: result.chain.isValid,
      totalAuditEntries: result.chain.totalEntries,
      brokenAtEntryId: result.chain.brokenAtEntryId || null,
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isTenantError(error)) return json(res, error.status, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('GET /api/traceability/audit-chain failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
