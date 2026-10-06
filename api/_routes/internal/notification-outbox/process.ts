import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { processNotificationOutbox } from '../../../_lib/notification-outbox.js';
import { queryInteger, workerAuthorized, workerSecretConfigured } from '../../../_lib/worker-auth.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!workerSecretConfigured()) return json(res, 503, { error: 'notification_worker_not_configured' });
  if (!workerAuthorized(req)) return json(res, 401, { error: 'unauthorized' });

  const limit = queryInteger(req, 'limit', 10, 1, 50);
  if (limit === null) return json(res, 400, { error: 'invalid_limit' });

  try {
    const summary = await processNotificationOutbox(limit);
    res.setHeader('Cache-Control', 'no-store');
    return json(res, 200, { summary });
  } catch (error) {
    console.error('POST /api/internal/notification-outbox/process failed', error);
    return json(res, 500, { error: 'notification_worker_failed' });
  }
}
