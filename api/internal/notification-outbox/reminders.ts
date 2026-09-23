import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, methodNotAllowed } from '../../_lib/http';
import { enqueueDueDataRequestReminders } from '../../_lib/notification-reminders';
import { queryInteger, workerAuthorized, workerSecretConfigured } from '../../_lib/worker-auth';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!workerSecretConfigured()) return json(res, 503, { error: 'notification_worker_not_configured' });
  if (!workerAuthorized(req)) return json(res, 401, { error: 'unauthorized' });

  const horizonHours = queryInteger(req, 'horizonHours', 72, 1, 720);
  if (horizonHours === null) return json(res, 400, { error: 'invalid_horizon_hours' });

  try {
    const enqueued = await enqueueDueDataRequestReminders(horizonHours);
    res.setHeader('Cache-Control', 'no-store');
    return json(res, 200, { enqueued, horizonHours });
  } catch (error) {
    console.error('POST /api/internal/notification-outbox/reminders failed', error);
    return json(res, 500, { error: 'notification_reminder_worker_failed' });
  }
}
