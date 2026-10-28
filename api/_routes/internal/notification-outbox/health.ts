import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { notificationAlertConfigured } from '../../../_lib/notification-observability.js';
import { withTracefabWorkerContext } from '../../../_lib/context.js';
import { workerAuthorized, workerSecretConfigured } from '../../../_lib/worker-auth.js';

type OutboxHealthRow = {
  pending: number;
  processing: number;
  sent: number;
  failed: number;
  ready: number;
  staleProcessing: number;
  exhausted: number;
  oldestReadyAt: Date | null;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!workerSecretConfigured()) return json(res, 503, { error: 'notification_worker_not_configured' });
  if (!workerAuthorized(req)) return json(res, 401, { error: 'unauthorized' });

  try {
    // Compteurs lus par une fonction dediee : la sante de l'outbox n'a pas
    // besoin de voir les lignes, seulement de les compter. Une requete directe
    // exigerait le contexte worker, c'est-a-dire le drapeau falsifiable que le
    // correctif vient de retirer.
    const rows = await withTracefabWorkerContext((tx) => tx.$queryRaw<OutboxHealthRow[]>`
      SELECT * FROM tracefab_notification_outbox_health()
    `);
    const health = rows[0] || { pending: 0, processing: 0, sent: 0, failed: 0, ready: 0, staleProcessing: 0, exhausted: 0, oldestReadyAt: null };
    const degraded = health.staleProcessing > 0 || health.exhausted > 0;
    res.setHeader('Cache-Control', 'no-store');
    return json(res, degraded ? 503 : 200, {
      ok: !degraded,
      service: 'tracefab-notification-outbox',
      status: degraded ? 'degraded' : 'ok',
      alertingConfigured: notificationAlertConfigured(),
      health,
    });
  } catch (error) {
    console.error('GET /api/internal/notification-outbox/health failed', error);
    return json(res, 503, { ok: false, error: 'notification_outbox_unavailable' });
  }
}
