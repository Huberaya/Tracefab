import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { emailDeliveryConfigured } from '../../_lib/email.js';
import { notificationAlertConfigured } from '../../_lib/notification-observability.js';
import { storageConfig } from '../../_lib/storage.js';
import { json, methodNotAllowed } from '../../_lib/http.js';
import { workerAuthorized, workerSecretConfigured } from '../../_lib/worker-auth.js';
import { probeDatabaseIdentity, runLiveProbes } from '../../_lib/readiness-probes.js';

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

  // Identite reelle de la connexion applicative — opt-in.
  //
  // Deja derriere workerSecretConfigured() puis workerAuthorized(), donc jamais
  // expose sans authentification. Opt-in pour deux raisons : la sonde interroge
  // la base, et un nom de role n'a pas a figurer dans chaque passage de sonde de
  // supervision.
  //
  // C'est le seul moyen de mesurer l'identite reellement utilisee par le
  // runtime : la requete passe par le meme client Prisma que les routes. Un
  // psql branche sur la meme URL mesurerait une autre connexion et ne
  // prouverait rien. Tant que cette sonde n'a pas ete executee sur le runtime
  // reel, l'identite de Production reste non mesuree.
  const wantIdentity = req.query?.identity === '1';
  const databaseIdentity = wantIdentity ? await probeDatabaseIdentity() : undefined;
  // En mode diagnostic, la readiness est rouge tant que l'identité effective
  // ne prouve pas le rôle applicatif sans privilèges de contournement RLS.
  const identitySafe = !wantIdentity || Boolean(
    databaseIdentity?.measured &&
    databaseIdentity.currentUser === 'tracefab_app' &&
    databaseIdentity.sessionUser === 'tracefab_app' &&
    databaseIdentity.bypassesRls === false &&
    databaseIdentity.isSuperuser === false,
  );

  if (!live) {
    return json(res, configured_ && identitySafe ? 200 : 503, {
      schema: 'tracefab-p2-readiness-v1',
      ready: configured_ && identitySafe,
      configurationOnly: true,
      services,
      ...(databaseIdentity ? { databaseIdentity } : {}),
    });
  }

  const probes = await runLiveProbes();
  // Le collecteur d'erreurs est souhaitable, pas bloquant : son absence degrade
  // l'exploitation, elle n'empeche pas de servir.
  const blocking = [probes.database, probes.privateStorage, probes.antivirus, probes.email, probes.alerting];
  const ready = configured_ && blocking.every((probe) => probe.reachable) && identitySafe;
  return json(res, ready ? 200 : 503, {
    schema: 'tracefab-p2-readiness-v1',
    ready,
    configurationOnly: false,
    services,
    probes,
    ...(databaseIdentity ? { databaseIdentity } : {}),
  });
}
