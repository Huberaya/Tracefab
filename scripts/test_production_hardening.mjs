import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [vercel, router, http, auth, context, auditVault, auditChain, envAudit, hardeningMigration, envExample, packageJson] = await Promise.all([
  read('vercel.json'),
  read('api/index.ts'),
  read('api/_lib/http.ts'),
  read('api/_lib/auth.ts'),
  read('api/_lib/context.ts'),
  read('api/_lib/audit-vault.ts'),
  read('api/_routes/traceability/audit-chain.ts'),
  read('scripts/audit_production_env.mjs'),
  read('prisma/migrations/20261006220000_production_hardening/migration.sql'),
  read('.env.example'),
  read('package.json'),
]);
const config = JSON.parse(vercel);
const assertIncludes = (content, value, message) => assert.ok(content.includes(value), message || `Missing ${value}`);

assert.ok(Array.isArray(config.headers), 'Vercel security headers are missing');
const headers = config.headers.flatMap((entry) => entry.headers || []).map((entry) => entry.key);
for (const key of ['Strict-Transport-Security', 'Content-Security-Policy', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy', 'Cross-Origin-Opener-Policy', 'Cross-Origin-Resource-Policy']) {
  assert.ok(headers.includes(key), `Missing production header ${key}`);
}
assert.ok(JSON.stringify(config).includes('Cache-Control'), 'API no-store cache policy is missing');
assert.equal(JSON.stringify(config).includes('Access-Control-Allow-Origin'), false, 'Wildcard CORS must not be enabled');

assertIncludes(http, "X-Content-Type-Options", 'API responses must carry secure headers');
assertIncludes(http, "if (!res.getHeader('Cache-Control'))", 'API responses must default to no-store');
assertIncludes(router, 'Unhandled API route failure', 'Router must fail closed without exposing framework errors');
assertIncludes(auth, 'authorizedParties', 'Clerk tokens must support an authorized-party allow-list');
assertIncludes(auth, "authorized_parties_not_configured", 'Production authentication must fail closed when the party allow-list is absent');
assertIncludes(envExample, 'TRACEFAB_AUTHORIZED_PARTIES', 'Authorized Clerk parties must be documented');

assertIncludes(context, 'withTracefabWorkerContext', 'Trusted worker DB context is missing');
assertIncludes(hardeningMigration, 'FORCE ROW LEVEL SECURITY', 'Production migration must force RLS');
assertIncludes(hardeningMigration, 'tracefab_schema_catalog', 'Schema catalog RLS hardening is missing');
assertIncludes(hardeningMigration, 'tracefab_schema_bindings', 'Schema binding RLS hardening is missing');
assertIncludes(hardeningMigration, 'notification_outbox_select_trusted', 'Outbox trusted-read policy is missing');
assertIncludes(hardeningMigration, 'REVOKE UPDATE, DELETE ON audit_logs', 'Audit log append-only grant hardening is missing');
assertIncludes(auditVault, 'client: Prisma.TransactionClient', 'Audit-chain verification must use the caller transaction');
assertIncludes(auditChain, "role: { in: ['owner', 'admin', 'auditor'] }", 'Audit-chain endpoint role guard is missing');
assertIncludes(auditChain, 'verifyAuditChainIntegrity(tx', 'Audit-chain endpoint must verify through the RLS-scoped transaction');

for (const route of [
  'api/_routes/internal/notification-outbox/health.ts',
  'api/_routes/internal/notification-outbox/process.ts',
  'api/_routes/internal/notification-outbox/reminders.ts',
  'api/_routes/internal/notification-outbox/schedule.ts',
  'api/_routes/internal/p2-readiness.ts',
]) {
  const source = await read(route);
  assert.ok(source.includes('Authorized') || source.includes('authorized'), `${route} must authenticate its internal caller`);
}
assertIncludes(envAudit, 'No secret values were printed', 'Production environment audit must not print secrets');
assertIncludes(envAudit, 'TRACEFAB_ALLOW_MANUAL_INVITATION_FALLBACK', 'Production audit must enforce invitation fallback policy');
assertIncludes(envAudit, 'least-privilege application role', 'Production audit must reject owner/postgres runtime roles');
assertIncludes(packageJson, 'security:production:env', 'Production env audit command is missing');
assertIncludes(packageJson, 'security:production:hardening', 'Production hardening contract command is missing');

const plm = await read('api/_routes/integrations/plm.ts');
assert.equal(plm.includes('message: err.message'), false, 'PLM endpoint must not return internal exception messages');

console.log('Production hardening contract passed: Vercel headers, API fail-closed behavior, Clerk party binding, RLS gaps, internal endpoint guards, audit-chain tenant scope and secret-safe env checks');
