import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  assertPreviewStorageConfig,
  PREVIEW_STORAGE_BRANCH,
  PREVIEW_STORAGE_MAX_BYTES,
  previewDatabaseFingerprint,
  previewSignedObject,
  usesPreviewPostgresStorage,
  verifyPreviewCapability,
} from '../api/_lib/preview-storage-policy.js';
import { scanWithAntivirus } from '../api/_lib/storage.js';
import { analyzeDocumentBytes, runAntivirusPipeline } from '../api/_lib/cloud-storage/antivirus-scanner.js';
import { unavailableSecurityAttestations } from '../api/_lib/document-security-report.js';

// AUCUN reseau ou DB : les reponses scanner ci-dessous sont des fixtures.
// Ce test n'est pas une preuve d'antivirus ou de Preview manages.
const names = ['NODE_ENV', 'VERCEL', 'VERCEL_ENV', 'VERCEL_GIT_COMMIT_REF', 'DATABASE_URL',
  'PRIVATE_STORAGE_BACKEND', 'PRIVATE_STORAGE_PRESIGN_SECONDS', 'CLERK_SECRET_KEY',
  'TF_PREVIEW_STORAGE_TEST_ONLY', 'TF_PREVIEW_STORAGE_LOCAL_TEST', 'TF_PREVIEW_STORAGE_LOCAL_ORIGIN',
  'TF_PREVIEW_STORAGE_DB_FINGERPRINT', 'PRIVATE_STORAGE_ANTIVIRUS_URL', 'PRIVATE_STORAGE_ANTIVIRUS_TOKEN'];
const saved = new Map(names.map((name) => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
let tests = 0;
const ok = (name: string) => { tests += 1; console.log(`  ok    ${name}`); };

try {
  for (const name of names) delete process.env[name];
  assert.equal(usesPreviewPostgresStorage(), false);
  ok('S3 reste le defaut ; aucun backend de test implicite');
  Object.assign(process.env, {
    NODE_ENV: 'test', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: PREVIEW_STORAGE_BRANCH,
    PRIVATE_STORAGE_BACKEND: 'preview-postgres', TF_PREVIEW_STORAGE_TEST_ONLY: '1',
    TF_PREVIEW_STORAGE_LOCAL_TEST: '1', TF_PREVIEW_STORAGE_LOCAL_ORIGIN: 'http://127.0.0.1:32001',
    DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:54329/tracefab_test',
    CLERK_SECRET_KEY: `sk_test_${randomBytes(24).toString('hex')}`,
  });
  process.env.TF_PREVIEW_STORAGE_DB_FINGERPRINT = previewDatabaseFingerprint(process.env.DATABASE_URL!);
  assertPreviewStorageConfig();
  ok('configuration de test explicite acceptee');

  for (const [name, value] of [
    ['VERCEL_ENV', 'production'], ['VERCEL_ENV', 'development'],
    ['VERCEL_GIT_COMMIT_REF', 'main'], ['TF_PREVIEW_STORAGE_TEST_ONLY', ''],
    ['TF_PREVIEW_STORAGE_DB_FINGERPRINT', 'a'.repeat(64)],
    ['CLERK_SECRET_KEY', 'sk_live_this_is_a_non_secret_fixture'],
    ['CLERK_SECRET_KEY', 'sk_test_short'], ['PRIVATE_STORAGE_PRESIGN_SECONDS', '3600'],
  ]) {
    const before = process.env[name]; process.env[name] = value;
    assert.throws(() => assertPreviewStorageConfig());
    if (before === undefined) delete process.env[name]; else process.env[name] = before;
  }
  ok('production, autres branches, absence dattestation, empreinte et cles invalides refuses');
  process.env.PRIVATE_STORAGE_BACKEND = 'unknown';
  assert.throws(() => usesPreviewPostgresStorage(), /private_storage_backend_invalid/);
  process.env.PRIVATE_STORAGE_BACKEND = 'preview-postgres';
  assert.throws(() => previewDatabaseFingerprint('postgresql://fixture@db.example.test/test?sslmode=disable'));
  assert.throws(() => previewDatabaseFingerprint('postgresql://fixture@db.example.test/test?sslmode=require'));
  assert.throws(() => previewDatabaseFingerprint('postgresql://fixture@db.example.test/test?SSLmode=verify-full'));
  assert.throws(() => previewDatabaseFingerprint('postgresql://fixture@db.example.test/test?sslmode=verify-full&sslmode=disable'));
  assert.throws(() => previewDatabaseFingerprint('postgresql://fixture@db.example.test/test?sslmode=verify-full&host=other'));
  assert.throws(() => previewDatabaseFingerprint('postgresql://fixture@db.example.test/test?sslmode=verify-full&HOST=other'));
  assert.throws(() => previewDatabaseFingerprint('postgresql://fixture@db.example.test/test?sslmode=verify-full&uselibpqcompat=true'));
  assert.throws(() => previewDatabaseFingerprint('postgresql://fixture@db.example.test/test?sslmode=verify-full&sslaccept=accept_invalid_certs'));
  assert.match(previewDatabaseFingerprint('postgresql://fixture@db.example.test/test?sslmode=verify-full'), /^[a-f0-9]{64}$/);
  process.env.VERCEL = '1';
  assert.throws(() => assertPreviewStorageConfig());
  delete process.env.VERCEL;
  ok('cible DB de test, TLS et absence de detournement host imposes');

  const key = '123e4567-e89b-12d3-a456-426614174000/123e4567-e89b-12d3-a456-426614174001/test.txt';
  const upload = previewSignedObject('PUT', key, 'text/plain', 11);
  const cap = upload.headers['X-Tracefab-Preview-Capability'];
  assert.equal(new URL(upload.url).search, '');
  assert.equal(new URL(upload.url).pathname, '/api/preview-storage/object');
  assert.equal(verifyPreviewCapability(cap, 'PUT')?.key, key);
  assert.equal(verifyPreviewCapability(cap, 'GET'), null);
  const [data, sig] = cap.split('.');
  const forged = `${data}.${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`;
  assert.equal(verifyPreviewCapability(forged, 'PUT'), null);
  assert.equal(verifyPreviewCapability(cap, 'PUT', Math.floor(Date.now() / 1000) + 601), null);
  assert.equal(verifyPreviewCapability('invalid', 'PUT'), null);
  assert.throws(() => previewSignedObject('PUT', key, 'text/plain', PREVIEW_STORAGE_MAX_BYTES + 1));
  assert.throws(() => previewSignedObject('PUT', key, 'text/plain', -1));
  assert.throws(() => previewSignedObject('PUT', '../other', 'text/plain', 1));
  const download = previewSignedObject('GET', key);
  assert.ok(verifyPreviewCapability(download.headers['X-Tracefab-Preview-Capability'], 'GET'));
  assert.equal(verifyPreviewCapability(download.headers['X-Tracefab-Preview-Capability'], 'PUT'), null);
  ok('capacites en en-tete : signature, methode, expiration, taille et chemin');

  const good = Buffer.from('%PDF-1.7\n%%EOF');
  const heuristic = analyzeDocumentBytes(good, 'fixture.pdf', 'application/pdf');
  assert.equal(heuristic.clean, false);
  assert.equal(heuristic.status, 'error');
  const bytes = Uint8Array.from(good).buffer;
  await assert.rejects(() => scanWithAntivirus(bytes, 'fixture.pdf', 'application/pdf'), /private_storage_antivirus_not_configured/);
  await assert.rejects(() => runAntivirusPipeline(bytes, 'fixture.pdf', 'application/pdf'), /private_storage_antivirus_not_configured/);
  ok('scanner absent : aucun verdict positif, y compris via lancien pipeline heuristique');

  process.env.PRIVATE_STORAGE_ANTIVIRUS_URL = 'http://external.example.test/scan';
  process.env.PRIVATE_STORAGE_ANTIVIRUS_TOKEN = 'test-fixture-token';
  await assert.rejects(() => scanWithAntivirus(bytes, 'fixture.pdf', 'application/pdf'), /private_storage_antivirus_url_invalid/);
  process.env.PRIVATE_STORAGE_ANTIVIRUS_URL = 'https://external.example.test/scan';
  let invoked = false;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    invoked = true;
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer test-fixture-token');
    return new Response(JSON.stringify({ clean: false, mimeType: 'application/pdf' }), { status: 200 });
  }) as typeof fetch;
  const infectedFixture = await scanWithAntivirus(bytes, 'fixture.pdf', 'application/pdf');
  assert.ok(invoked && infectedFixture.clean === false);
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
  await assert.rejects(() => scanWithAntivirus(bytes, 'fixture.pdf', 'application/pdf'), /private_storage_antivirus_invalid_response/);
  globalThis.fetch = (async () => new Response('{"clean":true}', { status: 503 })) as typeof fetch;
  await assert.rejects(() => scanWithAntivirus(bytes, 'fixture.pdf', 'application/pdf'), /private_storage_antivirus_invalid_response/);
  globalThis.fetch = (async () => { throw new Error('network_fixture'); }) as typeof fetch;
  await assert.rejects(() => runAntivirusPipeline(bytes, 'fixture.pdf', 'application/pdf'), /private_storage_antivirus_unreachable/);
  ok('contrat scanner simule : HTTPS, bearer, timeout, refus des redirections et des erreurs');

  const report = unavailableSecurityAttestations();
  assert.equal(report.antivirus.clean, null);
  assert.equal(report.antivirus.engine, null);
  assert.equal(report.antivirus.status, 'not_attested');
  assert.equal(report.isEncryptedAtRest, null);
  ok('rapport : moteur, verdict et chiffrement non attestes restent inconnus');
  console.log(`\nPASS — ${tests} groupes de gardes ; aucun service manage contacte.`);
} finally {
  globalThis.fetch = originalFetch;
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}
