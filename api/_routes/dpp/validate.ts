import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
import { validateDppCompliance, type CirpassDppPayload } from '../../_lib/dpp-validator.js';

type DppValidateBody = {
  payload?: Partial<CirpassDppPayload>;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  const auth = await requireClerkUser(req);
  if (isUnauthorized(auth)) {
    return json(res, 401, { error: 'unauthorized' });
  }

  const body = await readJsonBody<DppValidateBody>(req);
  const payload = body.payload;

  if (!payload || typeof payload !== 'object') {
    return json(res, 400, { error: 'payload_required', message: 'Field "payload" must be a CIRPASS DPP object.' });
  }

  return withTracefabUserContext(auth.user.id, auth.user.email, async () => {
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
  });
}
