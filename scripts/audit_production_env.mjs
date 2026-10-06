import { URL } from 'node:url';

const productionMode = process.argv.includes('--production') || process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
const issues = [];
const warnings = [];

const required = [
  'DATABASE_URL',
  'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
  'CLERK_SECRET_KEY',
  'CLERK_WEBHOOK_SIGNING_SECRET',
  'TRACEFAB_AUTHORIZED_PARTIES',
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'TRACEFAB_APP_URL',
  'TRACEFAB_NOTIFICATION_WORKER_SECRET',
  'CRON_SECRET',
  'PRIVATE_STORAGE_ENDPOINT',
  'PRIVATE_STORAGE_BUCKET',
  'PRIVATE_STORAGE_REGION',
  'PRIVATE_STORAGE_ACCESS_KEY_ID',
  'PRIVATE_STORAGE_SECRET_ACCESS_KEY',
  'PRIVATE_STORAGE_ANTIVIRUS_URL',
  'PRIVATE_STORAGE_ANTIVIRUS_TOKEN',
];

function value(name) {
  return process.env[name]?.trim() || '';
}

function fail(name, reason) {
  issues.push(`${name}: ${reason}`);
}

function warn(name, reason) {
  warnings.push(`${name}: ${reason}`);
}

function looksPlaceholder(input) {
  return /replace_me|replace_with|your_|example\.com|password|change_me|localhost|127\.0\.0\.1/i.test(input);
}

function requireHttpsUrl(name, allowList = false) {
  const raw = value(name);
  if (!raw) return;
  if (allowList) {
    for (const item of raw.split(',').map((part) => part.trim()).filter(Boolean)) {
      try {
        const parsed = new URL(item);
        if (parsed.protocol !== 'https:') fail(name, 'every authorized party must use HTTPS');
      } catch {
        fail(name, 'contains an invalid URL');
      }
    }
    return;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') fail(name, 'must use HTTPS in production');
  } catch {
    fail(name, 'must be an absolute URL');
  }
}

if (productionMode) {
  if (value('NODE_ENV') !== 'production' && value('VERCEL_ENV') !== 'production') fail('NODE_ENV', 'production deployment is not explicitly identified');
  for (const name of required) {
    const current = value(name);
    if (!current) fail(name, 'missing');
    else if (looksPlaceholder(current)) fail(name, 'placeholder or local value detected');
  }

  if (value('TRACEFAB_ALLOW_MANUAL_INVITATION_FALLBACK') !== 'false') {
    fail('TRACEFAB_ALLOW_MANUAL_INVITATION_FALLBACK', 'must be exactly false in production');
  }
  if (!value('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY').startsWith('pk_live_')) fail('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'must use a live Clerk key');
  if (!value('CLERK_SECRET_KEY').startsWith('sk_live_')) fail('CLERK_SECRET_KEY', 'must use a live Clerk key');
  if (value('RESEND_API_KEY').startsWith('re_test_')) fail('RESEND_API_KEY', 'test key cannot be used in production');
  if (!value('CLERK_WEBHOOK_SIGNING_SECRET').startsWith('whsec_')) fail('CLERK_WEBHOOK_SIGNING_SECRET', 'unexpected webhook secret format');

  for (const name of ['TRACEFAB_NOTIFICATION_WORKER_SECRET', 'CRON_SECRET', 'PRIVATE_STORAGE_SECRET_ACCESS_KEY', 'PRIVATE_STORAGE_ANTIVIRUS_TOKEN']) {
    if (value(name) && value(name).length < 32) fail(name, 'must contain at least 32 characters');
  }
  const sensitiveValues = ['TRACEFAB_NOTIFICATION_WORKER_SECRET', 'CRON_SECRET', 'PRIVATE_STORAGE_SECRET_ACCESS_KEY', 'PRIVATE_STORAGE_ANTIVIRUS_TOKEN']
    .map(value)
    .filter(Boolean);
  if (new Set(sensitiveValues).size !== sensitiveValues.length) fail('internal secrets', 'secrets must be distinct');

  try {
    const database = new URL(value('DATABASE_URL'));
    if (database.protocol !== 'postgresql:' && database.protocol !== 'postgres:') fail('DATABASE_URL', 'must use the PostgreSQL scheme');
    if (!['require', 'verify-ca', 'verify-full'].includes(database.searchParams.get('sslmode') || '')) warn('DATABASE_URL', 'sslmode is not explicitly strict');
    if (/owner|postgres/i.test(database.username)) fail('DATABASE_URL', 'runtime must use a least-privilege application role, not an owner/postgres role');
  } catch {
    fail('DATABASE_URL', 'must be a valid PostgreSQL URL');
  }

  requireHttpsUrl('TRACEFAB_APP_URL');
  requireHttpsUrl('PRIVATE_STORAGE_ENDPOINT');
  requireHttpsUrl('PRIVATE_STORAGE_ANTIVIRUS_URL');
  requireHttpsUrl('TRACEFAB_AUTHORIZED_PARTIES', true);
  if (value('TRACEFAB_NOTIFICATION_ALERT_URL')) requireHttpsUrl('TRACEFAB_NOTIFICATION_ALERT_URL');
} else {
  warn('mode', 'run with --production to enforce the complete production contract');
}

console.log(`Production environment audit (${productionMode ? 'strict' : 'advisory'})`);
for (const warning of warnings) console.log(`WARN ${warning}`);
for (const issue of issues) console.log(`FAIL ${issue}`);
if (issues.length > 0) {
  console.log(`Environment audit failed with ${issues.length} issue(s). No secret values were printed.`);
  process.exit(1);
}
console.log('Environment contract passed. No secret values were printed.');
