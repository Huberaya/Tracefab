import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { processNotificationOutbox } from '../../../_lib/notification-outbox.js';
import { enqueueDueDataRequestReminders } from '../../../_lib/notification-reminders.js';
import { emitNotificationAlert, notificationAlertConfigured, notificationLog, notificationRunId } from '../../../_lib/notification-observability.js';
import { cronAuthorized, cronSecretConfigured } from '../../../_lib/worker-auth.js';

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

  const runId = notificationRunId();
  try {
    const enqueued = await enqueueDueDataRequestReminders(horizonHours);
    const summary = await processNotificationOutbox(batchLimit);
    const alerts: Record<string, string> = {};
    if (summary.failed > 0) {
      alerts.failed = await emitNotificationAlert('notification_delivery_failed', { runId, failed: summary.failed, pending: summary.pending });
    }
    if (summary.notConfigured > 0) {
      alerts.notConfigured = await emitNotificationAlert('notification_delivery_not_configured', { runId, notConfigured: summary.notConfigured });
    }
    notificationLog('notification_schedule_completed', {
      runId,
      enqueued,
      claimed: summary.claimed,
      sent: summary.sent,
      pending: summary.pending,
      failed: summary.failed,
      alertingConfigured: notificationAlertConfigured(),
    });
    res.setHeader('Cache-Control', 'no-store');
    return json(res, 200, {
      schedule: 'notification_outbox',
      runId,
      horizonHours,
      batchLimit,
      reminders: { enqueued },
      processing: summary,
      alerts,
      alertingConfigured: notificationAlertConfigured(),
    });
  } catch (error) {
    notificationLog('notification_schedule_failed', { runId, errorCode: 'notification_schedule_failed' });
    await emitNotificationAlert('notification_schedule_failed', { runId, errorCode: 'notification_schedule_failed' });
    return json(res, 500, { error: 'notification_schedule_failed', runId });
  }
}
