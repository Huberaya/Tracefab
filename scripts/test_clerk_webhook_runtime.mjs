#!/usr/bin/env node
/**
 * P10.7 — preuve comportementale du webhook Clerk signe.
 *
 * Le test utilise le vrai verifyWebhook de @clerk/backend et le vrai handler.
 * Seule la transaction Prisma est doublee : aucune base distante, aucun secret
 * Clerk de l'environnement et aucune donnee client ne sont touches.
 *
 * Il prouve :
 *   1. une signature falsifiee est rejetee AVANT toute transaction ;
 *   2. une signature valide traverse le handler et appelle la synchronisation ;
 *   3. le contexte worker pose puis nettoie une identite systeme signee ;
 *   4. la reponse HTTP expose bien getHeader (contrat requis par json()).
 *
 * Exécution : node --import tsx scripts/test_clerk_webhook_runtime.mjs
 */
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';

const secret = `whsec_${randomBytes(32).toString('base64')}`;
const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
const calls = { transactions: 0, execute: [], queries: [] };

globalThis.tracefabPrisma = {
  async $transaction(callback) {
    calls.transactions += 1;
    return callback({
      async $executeRaw(strings, ...values) {
        calls.execute.push({ sql: strings.join('?'), values });
        return 1;
      },
      async $queryRaw(strings, ...values) {
        calls.queries.push({ sql: strings.join('?'), values });
        return [{ id: 'p107-webhook-fixture' }];
      },
    });
  },
};

process.env.CLERK_WEBHOOK_SIGNING_SECRET = secret;
process.env.TRACEFAB_IDENTITY_KEY = randomBytes(32).toString('hex');

const { default: handler } = await import('../api/_routes/webhooks/clerk.ts');

function createResponse() {
  const headers = new Map();
  return {
    statusCode: 200,
    payload: undefined,
    getHeader(name) { return headers.get(name); },
    setHeader(name, value) { headers.set(name, value); return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

function signedRequest(type, data, { tamper = false } = {}) {
  const body = JSON.stringify({
    object: 'event',
    type,
    data,
    timestamp: Date.now(),
    instance_id: 'ins_tracefab_preview_fixture',
  });
  const id = `msg_${randomBytes(16).toString('hex')}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  let signature = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
  if (tamper) signature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  return {
    method: 'POST',
    body,
    headers: {
      host: 'tracefab.local',
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signature}`,
    },
  };
}

const invalidResponse = createResponse();
const originalConsoleError = console.error;
console.error = () => {};
try {
  await handler(signedRequest('organization.created', { id: 'org_invalid' }, { tamper: true }), invalidResponse);
} finally {
  console.error = originalConsoleError;
}
assert.equal(invalidResponse.statusCode, 400);
assert.equal(invalidResponse.payload.error, 'invalid_clerk_webhook');
assert.equal(calls.transactions, 0, 'une signature invalide ne doit ouvrir aucune transaction');

const validResponse = createResponse();
await handler(signedRequest('organization.created', {
  id: 'org_tracefab_p107_webhook_fixture',
  name: 'TraceFab P10.7 Webhook Fixture',
  slug: 'tracefab-p107-webhook-fixture',
  public_metadata: {
    tracefab_organization_type: 'brand',
    legal_name: 'TraceFab P10.7 Webhook Fixture',
  },
}), validResponse);

assert.equal(validResponse.statusCode, 200);
assert.deepEqual(validResponse.payload, { ok: true, eventType: 'organization.created' });
assert.equal(calls.transactions, 1);
assert.equal(calls.queries.length, 1);
assert.match(calls.queries[0].sql, /tracefab_sync_clerk_organization/);
assert.equal(calls.execute.length, 2, 'l identite systeme doit etre posee puis nettoyee');
assert.match(calls.execute[0].sql, /tracefab\.identity_systeme/);
assert.match(calls.execute[0].sql, /true/);
assert.match(calls.execute[1].sql, /tracefab\.identity_systeme/);
assert.equal(typeof validResponse.getHeader, 'function');

console.log('  ok    signature invalide rejetee avant toute transaction');
console.log('  ok    signature valide acceptee par le vrai verifyWebhook');
console.log('  ok    contexte systeme signe pose puis nettoye');
console.log('  ok    synchronisation organisation appellee via fonction SQL dediee');
console.log('  ok    contrat VercelResponse getHeader/setHeader/status/json respecte');
console.log('\n  Webhook Clerk P10.7 : 5/5 assertions vertes.');
