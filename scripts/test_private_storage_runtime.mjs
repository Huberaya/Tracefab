#!/usr/bin/env node
import assert from 'node:assert/strict';
import { scanWithAntivirus, storageConfig } from '../api/_lib/storage.ts';

const envKeys = ['NODE_ENV','PRIVATE_STORAGE_ENDPOINT','PRIVATE_STORAGE_BUCKET','PRIVATE_STORAGE_REGION','PRIVATE_STORAGE_ACCESS_KEY_ID','PRIVATE_STORAGE_SECRET_ACCESS_KEY','PRIVATE_STORAGE_PRESIGN_SECONDS','PRIVATE_STORAGE_ANTIVIRUS_URL','PRIVATE_STORAGE_ANTIVIRUS_TOKEN'];
const saved = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
const originalFetch = globalThis.fetch;
const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
const restore = () => {
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  globalThis.fetch = originalFetch;
  if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor);
};

const ok = (label, fn) => { fn(); console.log('  ok    ' + label); };
const rejects = async (label, fn, code) => {
  await assert.rejects(fn, e => e instanceof Error && e.message === code);
  console.log('  ok    ' + label);
};

try {
  process.env.NODE_ENV = 'production';
  process.env.PRIVATE_STORAGE_ENDPOINT = 'http://storage.example.test';
  process.env.PRIVATE_STORAGE_ACCESS_KEY_ID = 'test-key';
  process.env.PRIVATE_STORAGE_SECRET_ACCESS_KEY = 'test-secret';
  process.env.PRIVATE_STORAGE_BUCKET = 'tracefab-private';
  process.env.PRIVATE_STORAGE_REGION = 'us-east-1';
  process.env.PRIVATE_STORAGE_PRESIGN_SECONDS = '300';
  ok('endpoint S3 HTTP externe refuse en production', () => assert.throws(() => storageConfig(), /private_storage_https_required/));

  process.env.NODE_ENV = 'test';
  process.env.PRIVATE_STORAGE_ENDPOINT = 'http://127.0.0.1:9000';
  ok('endpoint S3 HTTP autorise uniquement sur loopback de test', () => assert.equal(storageConfig().endpoint.hostname, '127.0.0.1'));

  process.env.PRIVATE_STORAGE_ENDPOINT = 'http://storage.example.test';
  ok('endpoint S3 HTTP externe refuse aussi hors production', () => assert.throws(() => storageConfig(), /private_storage_https_required/));

  const bytes = new TextEncoder().encode('clean test file').buffer;
  process.env.NODE_ENV = 'production';
  process.env.PRIVATE_STORAGE_ANTIVIRUS_TOKEN = 'test-token';
  process.env.PRIVATE_STORAGE_ANTIVIRUS_URL = 'http://scanner.example.test/scan';
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; return new Response('{"clean":true}', { status: 200 }); };
  await rejects('scanner HTTP externe refuse avant envoi du jeton', () => scanWithAntivirus(bytes, 'test.pdf', 'application/pdf'), 'private_storage_antivirus_https_required');
  assert.equal(fetchCalls, 0);

  process.env.PRIVATE_STORAGE_ANTIVIRUS_URL = 'https://scanner.example.test/scan';
  let observedSignal, observedRedirect;
  globalThis.fetch = async (_url, init) => {
    observedSignal = init.signal;
    observedRedirect = init.redirect;
    return new Response('{"clean":true,"mimeType":"application/pdf"}', { status: 200 });
  };
  const result = await scanWithAntivirus(bytes, 'test.pdf', 'application/pdf');
  assert.equal(result.clean, true);
  assert.equal(result.mimeType, 'application/pdf');
  assert.ok(observedSignal instanceof AbortSignal, 'scanner request must carry a bounded AbortSignal');
  assert.equal(observedRedirect, 'error', 'scanner request must not follow redirects with a bearer token');
  console.log('  ok    scanner HTTPS accepte, reponse typee, timeout et redirections refuses');

  const controller = new AbortController();
  Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: () => controller.signal });
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.signal, controller.signal);
    const timeoutError = new Error('timed out'); timeoutError.name = 'TimeoutError'; throw timeoutError;
  };
  await rejects('timeout antivirus transforme en erreur retryable explicite', () => scanWithAntivirus(bytes, 'test.pdf', 'application/pdf'), 'private_storage_antivirus_timeout');

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => { const e = new Error('body timed out'); e.name = 'TimeoutError'; throw e; },
  });
  await rejects('timeout pendant la lecture du verdict reste retryable', () => scanWithAntivirus(bytes, 'test.pdf', 'application/pdf'), 'private_storage_antivirus_timeout');

  process.env.PRIVATE_STORAGE_ANTIVIRUS_URL = 'http://127.0.0.1:8080/scan';
  process.env.NODE_ENV = 'test';
  globalThis.fetch = async () => new Response('{"clean":false}', { status: 200 });
  const infected = await scanWithAntivirus(bytes, 'test.pdf', 'application/pdf');
  assert.equal(infected.clean, false);
  console.log('  ok    scanner HTTP loopback autorise en test et verdict infecte conserve');
  console.log('\nTransport stockage/antivirus : 7 controles verts.');
} finally {
  restore();
}
