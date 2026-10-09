import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { emailDeliveryConfigured } from '../../_lib/email.js';
import { notificationAlertConfigured } from '../../_lib/notification-observability.js';
import { storageConfig } from '../../_lib/storage.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { workerAuthorized, workerSecretConfigured } from '../../_lib/worker-auth.js';
import { runLiveProbes } from '../../_lib/readiness-probes.js';

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!workerSecretConfigured()) return json(res, 503, { error: 'worker_not_configured' });
  if (!workerAuthorized(req)) return json(res, 401, { error: 'worker_unauthorized' });

  // ?probe=live exerce reellement chaque service au lieu de constater que ses
  // variables existent. Volontairement opt-in : on ne veut pas appeler cinq
  // services externes a chaque passage d'une sonde de supervision.
  const live = req.query?.probe === 'live';

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
  const configured_ = Object.values(services).every((service) => service.configured);

  if (!live) {
    return json(res, configured_ ? 200 : 503, {
      schema: 'tracefab-p2-readiness-v1',
      ready: configured_,
      configurationOnly: true,
      services,
    });
  }

  const probes = await runLiveProbes();
  // Le collecteur d'erreurs est souhaitable, pas bloquant : son absence degrade
  // l'exploitation, elle n'empeche pas de servir.
  const blocking = [probes.database, probes.privateStorage, probes.antivirus, probes.email, probes.alerting];
  const ready = configured_ && blocking.every((probe) => probe.reachable);
  return json(res, ready ? 200 : 503, {
    schema: 'tracefab-p2-readiness-v1',
    ready,
    configurationOnly: false,
    services,
    probes,
  });
}
