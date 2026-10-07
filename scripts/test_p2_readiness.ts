import assert from 'node:assert/strict';
import handler from '../api/_routes/internal/p2-readiness.js';

type TestRequest = {
  method: string;
  headers: Record<string, string>;
  query: Record<string, string>;
};

type TestResponse = {
  statusCode: number;
  payload: unknown;
  headers: Map<string, string>;
  getHeader(name: string): string | undefined;
  setHeader(name: string, value: string): TestResponse;
  status(status: number): TestResponse;
  json(payload: unknown): TestResponse;
};

function response(): TestResponse {
  const output: TestResponse = {
    statusCode: 200,
    payload: undefined,
    headers: new Map(),
    getHeader(name) { return this.headers.get(name); },
    setHeader(name, value) { this.headers.set(name, value); return this; },
    status(status) { this.statusCode = status; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  return output;
}

const names = [
  'NODE_ENV',
  'TRACEFAB_NOTIFICATION_WORKER_SECRET',
  'PRIVATE_STORAGE_ENDPOINT',
  'PRIVATE_STORAGE_BUCKET',
  'PRIVATE_STORAGE_REGION',
  'PRIVATE_STORAGE_ACCESS_KEY_ID',
  'PRIVATE_STORAGE_SECRET_ACCESS_KEY',
  'PRIVATE_STORAGE_ANTIVIRUS_URL',
  'PRIVATE_STORAGE_ANTIVIRUS_TOKEN',
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'TRACEFAB_APP_URL',
  'TRACEFAB_NOTIFICATION_ALERT_URL',
  'TRACEFAB_NOTIFICATION_ALERT_TOKEN',
];
const saved = new Map(names.map((name) => [name, process.env[name]]));

try {
  for (const name of names) delete process.env[name];
  process.env.NODE_ENV = 'test';

  let req: TestRequest = { method: 'GET', headers: {}, query: {} };
  let res = response();
  handler(req as never, res as never);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.payload, { error: 'worker_not_configured' });

  process.env.TRACEFAB_NOTIFICATION_WORKER_SECRET = 'unit-worker-secret';
  req = { method: 'GET', headers: { 'x-tracefab-worker-secret': 'wrong-secret' }, query: {} };
  res = response();
  handler(req as never, res as never);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.payload, { error: 'worker_unauthorized' });

  req = { method: 'GET', headers: { 'x-tracefab-worker-secret': 'unit-worker-secret' }, query: {} };
  res = response();
  handler(req as never, res as never);
  assert.equal(res.statusCode, 503);
  assert.equal((res.payload as { ready: boolean }).ready, false);
  assert.equal((res.payload as { configurationOnly: boolean }).configurationOnly, true);
  assert.equal(JSON.stringify(res.payload).includes('unit-worker-secret'), false);

  Object.assign(process.env, {
    PRIVATE_STORAGE_ENDPOINT: 'https://storage.invalid',
    PRIVATE_STORAGE_BUCKET: 'tracefab-private',
    PRIVATE_STORAGE_REGION: 'auto',
    PRIVATE_STORAGE_ACCESS_KEY_ID: 'unit-access-key',
    PRIVATE_STORAGE_SECRET_ACCESS_KEY: 'unit-secret-key',
    PRIVATE_STORAGE_ANTIVIRUS_URL: 'https://antivirus.invalid/scan',
    PRIVATE_STORAGE_ANTIVIRUS_TOKEN: 'unit-antivirus-token',
    RESEND_API_KEY: 'unit-resend-key',
    EMAIL_FROM: 'Tracefab <staging@example.com>',
    TRACEFAB_APP_URL: 'https://staging.example.com',
    TRACEFAB_NOTIFICATION_ALERT_URL: 'https://alerts.invalid/webhook',
    TRACEFAB_NOTIFICATION_ALERT_TOKEN: 'unit-alert-token',
  });
  res = response();
  handler(req as never, res as never);
  assert.equal(res.statusCode, 200);
  const payload = res.payload as { schema: string; ready: boolean; configurationOnly: boolean; services: Record<string, { configured: boolean; probe: string }> };
  assert.equal(payload.schema, 'tracefab-p2-readiness-v1');
  assert.equal(payload.ready, true);
  assert.equal(payload.configurationOnly, true);
  for (const service of Object.values(payload.services)) {
    assert.equal(service.configured, true);
    assert.equal(service.probe, 'configuration_only');
  }
  assert.equal(JSON.stringify(payload).includes('unit-secret-key'), false);
  assert.equal(JSON.stringify(payload).includes('unit-resend-key'), false);

  console.log('P2 readiness unit contract passed: worker authentication, fail-closed configuration and secret-free configuration-only readiness');
} finally {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
