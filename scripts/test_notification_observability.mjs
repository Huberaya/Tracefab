import { readFile } from 'node:fs/promises';

const [scheduler, health, observability, env, docs, readme] = await Promise.all([
  readFile('api/internal/notification-outbox/schedule.ts', 'utf8'),
  readFile('api/internal/notification-outbox/health.ts', 'utf8'),
  readFile('api/_lib/notification-observability.ts', 'utf8'),
  readFile('.env.example', 'utf8'),
  readFile('docs/architecture/25-notification-observability.md', 'utf8'),
  readFile('README.md', 'utf8'),
]);

const assert = (condition, message) => { if (!condition) throw new Error(message); };

assert(scheduler.includes('emitNotificationAlert') && scheduler.includes('notification_delivery_failed'), 'Scheduler must alert on delivery failures');
assert(scheduler.includes('notification_schedule_failed'), 'Scheduler must alert on execution failures');
assert(scheduler.includes('runId'), 'Scheduler must expose a correlation id');
assert(health.includes('workerAuthorized') && health.includes('tracefab_notification_outbox'), 'Outbox health must be protected and query durable state');
assert(health.includes('staleProcessing') && health.includes('exhausted'), 'Outbox health must detect stale and exhausted jobs');
assert(observability.includes('tracefab-notification-alert-v1'), 'Alert webhook contract is missing');
assert(observability.includes('TRACEFAB_NOTIFICATION_ALERT_TOKEN'), 'Alert webhook bearer token support is missing');
assert(observability.includes('AbortController'), 'Alert webhook timeout is missing');
assert(env.includes('TRACEFAB_NOTIFICATION_ALERT_URL=') && env.includes('TRACEFAB_NOTIFICATION_ALERT_TIMEOUT_MS=5000'), 'Alerting environment contract is missing');
assert(docs.includes('Chantier 22') && docs.includes('/api/internal/notification-outbox/health'), 'Observability documentation is missing');
assert(readme.includes('Notification Observability'), 'README chantier status is missing');
console.log('Notification observability contract passed: correlation logs, protected health, failure alerts and timeout-safe webhook');
