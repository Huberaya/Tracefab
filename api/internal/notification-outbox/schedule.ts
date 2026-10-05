import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, methodNotAllowed } from '../../_lib/http';
import { processNotificationOutbox } from '../../_lib/notification-outbox';
import { enqueueDueDataRequestReminders } from '../../_lib/notification-reminders';
import { cronAuthorized, cronSecretConfigured } from '../../_lib/worker-auth';

function configuredInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!cronSecretConfigured()) return json(res, 503, { error: 'notification_cron_not_configured' });
  if (!cronAuthorized(req)) return json(res, 401, { error: 'unauthorized' });

  const horizonHours = configuredInteger('TRACEFAB_REMINDER_HORIZON_HOURS', 72, 1, 720);
  const batchLimit = configuredInteger('TRACEFAB_NOTIFICATION_BATCH_LIMIT', 10, 1, 50);
  if (horizonHours === null || batchLimit === null) return json(res, 503, { error: 'notification_cron_configuration_invalid' });

  try {
    const enqueued = await enqueueDueDataRequestReminders(horizonHours);
    const summary = await processNotificationOutbox(batchLimit);
    res.setHeader('Cache-Control', 'no-store');
    return json(res, 200, {
      schedule: 'notification_outbox',
      horizonHours,
      batchLimit,
      reminders: { enqueued },
      processing: summary,
    });
  } catch (error) {
    console.error('GET /api/internal/notification-outbox/schedule failed', error);
    return json(res, 500, { error: 'notification_schedule_failed' });
  }
}
