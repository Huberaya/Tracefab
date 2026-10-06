import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { isUuid } from '../../_lib/products.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { verifyAuditChainIntegrity } from '../../_lib/audit-vault.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const auth = await requireClerkUser(req);
    const requestedOrganizationId = typeof req.query.organizationId === 'string' ? req.query.organizationId : null;
    if (requestedOrganizationId && !isUuid(requestedOrganizationId)) {
      return json(res, 400, { error: 'invalid_organization_id' });
    }

    const result = await withTracefabUserContext(auth.user.id, auth.user.email, async (tx) => {
      const organizationId = requestedOrganizationId || (await tx.organization_memberships.findFirst({
        where: { user_id: auth.user.id, status: 'active', role: { in: ['owner', 'admin', 'auditor'] } },
        select: { organization_id: true },
        orderBy: { created_at: 'asc' },
      }))?.organization_id;
      if (!organizationId) return null;

      const membership = await tx.organization_memberships.findFirst({
        where: {
          user_id: auth.user.id,
          organization_id: organizationId,
          status: 'active',
          role: { in: ['owner', 'admin', 'auditor'] },
        },
        select: { organization_id: true },
      });
      if (!membership) return null;

      const chain = await verifyAuditChainIntegrity(tx, organizationId);
      return { organizationId, chain };
    });

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
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('GET /api/traceability/audit-chain failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
