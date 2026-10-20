import type { VercelRequest, VercelResponse } from '../../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabRequestContext } from '../../../../_lib/context.js';
import { json, methodNotAllowed } from '../../../../_lib/http.js';
import { isTenantError, requireActiveTenant } from '../../../../_lib/tenant.js';

/**
 * Automatic baseline generation used to manufacture plausible spinning,
 * weaving, dyeing and assembly stages from a BOM even when no source declared
 * those stages. A structural graph must never be presented as provenance, so
 * real tenants must create explicit declared nodes instead.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const { user } = await requireClerkUser(req);
    await withTracefabRequestContext(req, user, async (tx) => {
      await requireActiveTenant(tx, req, user.id, { types: ['brand'] });
    });
    return json(res, 410, { error: 'synthetic_baseline_generation_disabled' });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isTenantError(error)) return json(res, error.status, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('POST /api/products/:productId/supply-chain/generate-baseline failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
