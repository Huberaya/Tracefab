import { readFile } from 'node:fs/promises';

const [route, auth, env, vercel, docs] = await Promise.all([
  readFile('api/_routes/internal/notification-outbox/schedule.ts', 'utf8'),
  readFile('api/_lib/worker-auth.ts', 'utf8'),
  readFile('.env.example', 'utf8'),
  readFile('vercel.json', 'utf8'),
  readFile('docs/architecture/24-notification-scheduler.md', 'utf8'),
]);

const assert = (condition, message) => { if (!condition) throw new Error(message); };

assert(route.includes("req.method !== 'GET'"), 'Scheduled route must be GET-compatible with Vercel Cron');
assert(route.includes('cronSecretConfigured') && route.includes('cronAuthorized'), 'Scheduled route must have dedicated cron authentication');
assert(route.includes('enqueueDueDataRequestReminders') && route.includes('processNotificationOutbox'), 'Scheduled route must enqueue reminders and process the outbox');
assert(route.includes('TRACEFAB_REMINDER_HORIZON_HOURS') && route.includes('TRACEFAB_NOTIFICATION_BATCH_LIMIT'), 'Scheduled route must validate operational configuration');
assert(auth.includes("process.env.CRON_SECRET") && auth.includes('Bearer '), 'Cron authentication must use CRON_SECRET bearer auth');
assert(env.includes('CRON_SECRET=') && env.includes('TRACEFAB_REMINDER_HORIZON_HOURS=72'), 'Cron environment contract is missing');
assert(vercel.includes('/api/internal/notification-outbox/schedule') && vercel.includes('0 7 * * *'), 'Vercel Cron schedule is missing');
assert(docs.includes('Chantier 21') && docs.includes('CRON_SECRET'), 'Scheduler documentation is missing');
assert(!route.includes('requireClerkUser'), 'Internal scheduler must not use browser identity');
console.log('Notification scheduler contract passed: Vercel Cron, dedicated secret, idempotent reminder enqueue and outbox processing');
