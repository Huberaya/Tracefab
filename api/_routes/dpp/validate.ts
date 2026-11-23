import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
import { requestedTenantId } from '../../_lib/tenant.js';
import { validateDppCompliance, type CirpassDppPayload } from '../../_lib/dpp-validator.js';

type DppValidateBody = {
  payload?: Partial<CirpassDppPayload>;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  try {
    const auth = await requireClerkUser(req);

    const body = await readJsonBody<DppValidateBody>(req);
    const payload = body.payload;

    if (!payload || typeof payload !== 'object') {
      return json(res, 400, { error: 'payload_required', message: 'Field "payload" must be a CIRPASS DPP object.' });
    }

    return await withTracefabUserContext(auth.user.id, auth.user.email, async () => {
      const report = validateDppCompliance(payload);

      return json(res, 200, {
        status: 'ok',
        isValid: report.isValid,
        readinessScore: report.readinessScore,
        isPublishable: report.isPublishable,
        blockingErrors: report.blockingErrors,
        warnings: report.warnings,
        standardsPassed: report.standardsPassed,
      });
    }, requestedTenantId(req));
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('POST /api/dpp/validate failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
