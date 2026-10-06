import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const [html, reminderRoute, reminderMigration, email] = await Promise.all([
  readFile(new URL('../brand-console/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../api/_routes/data-requests/[requestId]/remind.ts', import.meta.url), 'utf8'),
  readFile(new URL('../prisma/migrations/20261006130000_tracefab_manual_data_request_reminders/migration.sql', import.meta.url), 'utf8'),
  readFile(new URL('../api/_lib/email.ts', import.meta.url), 'utf8'),
]);
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert(script, 'Brand Console inline application script is missing');

const temporaryScript = '/tmp/tracefab-brand-console-check.mjs';
await writeFile(temporaryScript, script);
const syntax = spawnSync(process.execPath, ['--check', temporaryScript], { encoding: 'utf8' });
await unlink(temporaryScript).catch(() => {});
assert(syntax.status === 0, syntax.stderr || 'Brand Console script syntax is invalid');

for (const contract of [
  '/api/config',
  '/api/me',
  '/api/suppliers',
  '/api/materials',
  '/api/products',
  '/materials',
  '/identifiers',
  '/api/data-requests',
  '/api/data-requests/',
  '/remind',
  '/api/questionnaires',
  '/api/quality/products/',
  '/api/data-responses/',
  'data-action="new-request"',
  'data-action="new-product"',
  'data-action="invite-supplier"',
  'data-action="remind-request"',
]) {
  assert(html.includes(contract), `Brand Console contract missing: ${contract}`);
}
for (const formContract of [
  'id="product-detail-form"',
  'id="material-form"',
  'material-edit-form',
  'id="identifier-form"',
  'identifier-edit-form',
  'const method = isUpdate ? \'PATCH\' : \'POST\';',
  "method: identifierId ? 'PATCH' : 'POST'",
]) {
  assert(html.includes(formContract), `Brand Console form contract missing: ${formContract}`);
}
assert(html.includes('Authorization = `Bearer ${token}`'), 'Clerk session token must be sent through Authorization');
assert(!html.includes('localhost'), 'Brand Console must not call localhost from browser code');
assert(!/sk_live_|secret_key|ghp_[A-Za-z0-9]/i.test(html), 'Brand Console must not contain private credentials');
assert(html.toLowerCase().includes('tracefab'), 'Brand Console branding is missing');
assert(reminderRoute.includes("req.method !== 'POST'") && reminderRoute.includes('activeOrganizationIds') && reminderRoute.includes('withTracefabUserContext'), 'Manual reminder route must be authenticated and brand-tenant scoped');
assert(reminderMigration.includes("request_manual_reminder") && reminderMigration.includes('ON CONFLICT (event_key) DO NOTHING') && reminderMigration.includes('REVOKE EXECUTE'), 'Manual reminder migration must be typed, idempotent and non-public');
assert(email.includes('request_manual_reminder'), 'Manual reminder email copy is missing');
console.log('Brand Console contract passed: static shell, Clerk bootstrap, API actions, reminder workflow and browser-safe URLs');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
