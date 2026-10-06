import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { emailDeliveryConfigured } from '../../_lib/email.js';
import { notificationAlertConfigured } from '../../_lib/notification-observability.js';
import { storageConfig } from '../../_lib/storage.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { workerAuthorized, workerSecretConfigured } from '../../_lib/worker-auth.js';

function configured(name: string) {
  return Boolean(process.env[name]?.trim());
}

function privateStorageReadiness() {
  const required = ['PRIVATE_STORAGE_ENDPOINT', 'PRIVATE_STORAGE_BUCKET', 'PRIVATE_STORAGE_REGION', 'PRIVATE_STORAGE_ACCESS_KEY_ID', 'PRIVATE_STORAGE_SECRET_ACCESS_KEY', 'PRIVATE_STORAGE_ANTIVIRUS_URL', 'PRIVATE_STORAGE_ANTIVIRUS_TOKEN'];
  const missing = required.filter((name) => !configured(name));
  let configValid = false;
  if (missing.length === 0) {
    try {
      storageConfig();
      configValid = true;
    } catch {
      configValid = false;
    }
  }
  return { configured: missing.length === 0 && configValid, missing, probe: 'configuration_only' };
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!workerSecretConfigured()) return json(res, 503, { error: 'worker_not_configured' });
  if (!workerAuthorized(req)) return json(res, 401, { error: 'worker_unauthorized' });

  const privateStorage = privateStorageReadiness();
  const email = {
    configured: emailDeliveryConfigured(),
    missing: ['RESEND_API_KEY', 'EMAIL_FROM', 'TRACEFAB_APP_URL'].filter((name) => !configured(name)),
    probe: 'configuration_only',
  };
  const alerting = {
    configured: notificationAlertConfigured() && configured('TRACEFAB_NOTIFICATION_ALERT_TOKEN'),
    missing: ['TRACEFAB_NOTIFICATION_ALERT_URL', 'TRACEFAB_NOTIFICATION_ALERT_TOKEN'].filter((name) => !configured(name)),
    probe: 'configuration_only',
  };
  const services = { privateStorage, email, alerting };
  const ready = Object.values(services).every((service) => service.configured);
  return json(res, ready ? 200 : 503, {
    schema: 'tracefab-p2-readiness-v1',
    ready,
    configurationOnly: true,
    services,
  });
}
