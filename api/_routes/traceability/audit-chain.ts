import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { verifyAuditChainIntegrity } from '../../_lib/audit-vault.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, ['GET']);
  }

  const auth = await requireClerkUser(req);
  if (isUnauthorized(auth)) {
    return json(res, 401, { error: 'unauthorized' });
  }

  return withTracefabUserContext(auth.user.id, auth.user.email, async (tx) => {
    let orgId = typeof req.query.organizationId === 'string' ? req.query.organizationId : null;

    if (!orgId) {
      const membership = await tx.organization_memberships.findFirst({
        where: { user_id: auth.user.id, status: 'active' },
        select: { organization_id: true },
      });
      orgId = membership?.organization_id || null;
    }

    if (!orgId) {
      return json(res, 400, { error: 'organization_required' });
    }

    const result = await verifyAuditChainIntegrity(orgId);

    return json(res, 200, {
      status: 'ok',
      organizationId: orgId,
      verifiedAt: new Date().toISOString(),
      isChainValid: result.isValid,
      totalAuditEntries: result.totalEntries,
      brokenAtEntryId: result.brokenAtEntryId || null,
    });
  });
}
