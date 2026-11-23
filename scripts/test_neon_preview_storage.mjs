#!/usr/bin/env node
/**
 * VRAI routeur HTTP + VRAI PostgreSQL local jetable + role applicatif RLS.
 * Clerk est une doublure locale ; l'antivirus est soit une doublure, soit
 * ClamAV local avec une SEULE signature EICAR (opt-in CI). Le stockage est
 * effectivement PostgreSQL, pas une map en memoire. Ce test n'est PAS une
 * preuve de Preview, Clerk ou antivirus manages.
 *
 * La garde impose des URL locales jetables avant TOUTE ecriture. La table de
 * test ci-dessous est une fixture CI : aucun script de provisionnement distant
 * ou migration de production n'est invoque depuis ce test.
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';
import { eicarTestBytes } from './lib/preview_harness_safety.mjs';
import { createTestPrisma, injectPrismaSingleton } from './lib/test_prisma_client.mjs';
import { startClerkTestIdp, startPrivateStorageServices, applyLocalServiceEnv, startApiHttpServer } from './lib/local_test_services.mjs';
import { startLocalClamavTestService } from './lib/local_clamav_test_service.mjs';

if (process.env.NODE_ENV === 'production' || process.env.VERCEL || process.env.VERCEL_ENV === 'production'
    || (process.env.CLERK_SECRET_KEY || '').startsWith('sk_live_')) {
  console.error('REFUS — aucun test local ne peut tourner en contexte de production.'); process.exit(3);
}
const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.TF_RLS_APP_URL;
if (!ownerUrl || !appUrl) { console.error('NON EXECUTE — DATABASE_URL et TF_RLS_APP_URL requis.'); process.exit(2); }
const guard = requireThrowawayDb({ purpose: 'test_neon_preview_storage', variables: ['DATABASE_URL', 'TF_RLS_APP_URL'] });
if (guard.verdicts.some((item) => item.verdict.code !== 'throwaway_local')) {
  console.error('REFUS — seule une base locale jetable est acceptee.'); process.exit(3);
}
process.env.NODE_ENV = 'test';
process.env.VERCEL_ENV = 'preview';
process.env.VERCEL_GIT_COMMIT_REF = 'arena/647ac97c-tracefab';
process.env.TF_PREVIEW_STORAGE_TEST_ONLY = '1';
process.env.TF_PREVIEW_STORAGE_LOCAL_TEST = '1';

const { previewDatabaseFingerprint, PREVIEW_STORAGE_MAX_BYTES } = await import('../api/_lib/preview-storage-policy.ts');
process.env.TF_PREVIEW_STORAGE_DB_FINGERPRINT = previewDatabaseFingerprint(ownerUrl);
if (process.env.TF_PREVIEW_STORAGE_DB_FINGERPRINT !== previewDatabaseFingerprint(appUrl)) {
  console.error('REFUS — les roles de test ne ciblent pas la meme base locale.'); process.exit(3);
}
const suffix = randomUUID().slice(0, 8);
const identities = {
  alpha: { id: `user_preview_a_${suffix}`, email: `a-${suffix}@example.test`, firstName: 'A', lastName: 'Test' },
  beta: { id: `user_preview_b_${suffix}`, email: `b-${suffix}@example.test`, firstName: 'B', lastName: 'Test' },
};
const orgA = randomUUID(); const orgB = randomUUID();
const userA = randomUUID(); const userB = randomUUID();
let admin; let prisma; let clerk; let localServices; let clamav; let api;
let checks = 0;
const pass = (label) => { checks += 1; console.log(`  ok    ${label}`); };

try {
  admin = new pg.Client({ connectionString: ownerUrl });
  await admin.connect();
  // DDL strictement dans la base locale jetable controlee ci-dessus.
  await admin.query('CREATE SCHEMA IF NOT EXISTS tracefab_preview_store');
  await admin.query('REVOKE ALL ON SCHEMA tracefab_preview_store FROM PUBLIC');
  await admin.query(`CREATE TABLE IF NOT EXISTS tracefab_preview_store.objects (
    object_key text PRIMARY KEY,
    content_type text NOT NULL CHECK (content_type IN ('application/pdf', 'image/png', 'image/jpeg', 'text/plain')),
    body bytea NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 1048576),
    created_at timestamptz NOT NULL DEFAULT NOW(), expires_at timestamptz NOT NULL
  )`);
  await admin.query('ALTER TABLE tracefab_preview_store.objects ENABLE ROW LEVEL SECURITY');
  await admin.query('ALTER TABLE tracefab_preview_store.objects FORCE ROW LEVEL SECURITY');
  const policies = await admin.query("SELECT policyname FROM pg_policies WHERE schemaname='tracefab_preview_store' AND tablename='objects'");
  const policyNames = new Set(policies.rows.map((row) => row.policyname));
  if (!policyNames.has('preview_object_read')) await admin.query(`CREATE POLICY preview_object_read ON tracefab_preview_store.objects FOR SELECT TO tracefab_app
    USING (object_key = current_setting('tracefab.preview_storage_key', true) AND expires_at > NOW())`);
  if (!policyNames.has('preview_object_insert')) await admin.query(`CREATE POLICY preview_object_insert ON tracefab_preview_store.objects FOR INSERT TO tracefab_app
    WITH CHECK (object_key = current_setting('tracefab.preview_storage_key', true)
      AND expires_at > NOW() AND expires_at <= NOW() + INTERVAL '25 hours')`);
  await admin.query('REVOKE ALL ON TABLE tracefab_preview_store.objects FROM PUBLIC');
  await admin.query('GRANT USAGE ON SCHEMA tracefab_preview_store TO tracefab_app');
  await admin.query('GRANT SELECT, INSERT ON TABLE tracefab_preview_store.objects TO tracefab_app');
  const privileges = await admin.query(`SELECT
    has_table_privilege('tracefab_app','tracefab_preview_store.objects','SELECT') AS can_read,
    has_table_privilege('tracefab_app','tracefab_preview_store.objects','INSERT') AS can_insert,
    has_table_privilege('tracefab_app','tracefab_preview_store.objects','UPDATE') AS can_update,
    has_table_privilege('tracefab_app','tracefab_preview_store.objects','DELETE') AS can_delete,
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
      LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
      WHERE n.nspname='tracefab_preview_store' AND c.relname='objects' AND acl.grantee=0) AS public_access,
    (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='tracefab_preview_store.objects'::regclass) AS rls_forced`);
  assert.deepEqual(privileges.rows[0], { can_read: true, can_insert: true, can_update: false, can_delete: false, public_access: false, rls_forced: true });
  pass('table de test privee : RLS forcee, aucun droit PUBLIC ni UPDATE/DELETE pour le role applicatif');

  await admin.query(`insert into users (id, clerk_user_id, email, full_name) values
    ($1,$2,$3,'Preview Alpha'),($4,$5,$6,'Preview Beta')`,
    [userA, identities.alpha.id, identities.alpha.email, userB, identities.beta.id, identities.beta.email]);
  await admin.query(`insert into organizations (id,type,legal_name,country_code,created_by) values
    ($1,'brand','Preview Alpha','FR',$2),($3,'brand','Preview Beta','FR',$4)`, [orgA, userA, orgB, userB]);
  await admin.query(`insert into organization_memberships (organization_id,user_id,role,status) values
    ($1,$2,'owner','active'),($3,$4,'owner','active')`, [orgA, userA, orgB, userB]);
  prisma = await createTestPrisma(appUrl);
  injectPrismaSingleton(prisma);
  const appRole = await prisma.$queryRaw`SELECT current_user::text AS role,
    (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname=current_user) AS bypass`;
  assert.equal(appRole[0].role, 'tracefab_app'); assert.equal(appRole[0].bypass, false);
  const { assertPreviewTransactionRole } = await import('../api/_lib/preview-postgres-store.ts');
  await prisma.$transaction((tx) => assertPreviewTransactionRole(tx));
  const ownerPrisma = await createTestPrisma(ownerUrl);
  try {
    await assert.rejects(() => ownerPrisma.$transaction((tx) => assertPreviewTransactionRole(tx)), /private_storage_preview_role_invalid/);
  } finally {
    await ownerPrisma.$disconnect();
  }
  pass('API executee avec tracefab_app sans BYPASSRLS ; role proprietaire refuse');

  clerk = startClerkTestIdp([identities.alpha, identities.beta]);
  localServices = await startPrivateStorageServices();
  applyLocalServiceEnv({ clerk, storage: localServices });
  if (process.env.TF_PREVIEW_TEST_REAL_CLAMAV === '1') {
    clamav = await startLocalClamavTestService();
    process.env.PRIVATE_STORAGE_ANTIVIRUS_URL = clamav.url;
    process.env.PRIVATE_STORAGE_ANTIVIRUS_TOKEN = clamav.token;
  }
  process.env.PRIVATE_STORAGE_BACKEND = 'preview-postgres';
  const { default: handler } = await import('../api/index.ts');
  api = await startApiHttpServer(handler);
  process.env.TF_PREVIEW_STORAGE_LOCAL_ORIGIN = api.baseUrl;
  const tokenA = clerk.issueToken(identities.alpha.id);
  const tokenB = clerk.issueToken(identities.beta.id);
  async function call(method, path, { token = tokenA, org = orgA, body } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (org) headers['X-Tracefab-Organization-Id'] = org;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${api.baseUrl}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, headers: response.headers, data: await response.json().catch(() => null) };
  }
  const beta = (method, path, body) => call(method, path, { token: tokenB, org: orgB, body });
  const content = Buffer.concat([Buffer.from('%PDF-1.7\nfixture\n'), Buffer.from([0, 255, 128, 13, 10])]);
  const intent = await call('POST', '/api/documents/upload-intent', { body: {
    originalFilename: 'fixture.pdf', contentType: 'application/pdf', byteSize: content.length, kind: 'other',
    metadata: { security_scan: { clean: true, engine: 'invented-client-engine' } },
  } });
  assert.equal(intent.status, 201); assert.equal(intent.data.document.status, 'uploaded');
  const docId = intent.data.document.id; const transfer = intent.data.upload;
  assert.equal(new URL(transfer.url).search, '');
  assert.ok(transfer.headers['X-Tracefab-Preview-Capability']);
  pass('intention authentifiee : document uploaded, capacite dans en-tete et non dans URL');

  const noCap = await fetch(transfer.url);
  assert.equal(noCap.status, 403);
  const [payload, signature] = transfer.headers['X-Tracefab-Preview-Capability'].split('.');
  const forged = `${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  const forgedResponse = await fetch(transfer.url, { method: 'PUT', headers: { ...transfer.headers,
    'X-Tracefab-Preview-Capability': forged }, body: content });
  assert.equal(forgedResponse.status, 403);
  const wrongMethod = await fetch(transfer.url, { headers: { 'X-Tracefab-Preview-Capability': transfer.headers['X-Tracefab-Preview-Capability'] } });
  assert.equal(wrongMethod.status, 403);
  pass('lien sans capacite, capacite falsifiee ou mauvaise methode : refus 403');

  const wrongSize = await fetch(transfer.url, { method: 'PUT', headers: transfer.headers, body: content.subarray(0, -1) });
  assert.equal(wrongSize.status, 400);
  const uploaded = await fetch(transfer.url, { method: 'PUT', headers: transfer.headers, body: content });
  assert.equal(uploaded.status, 200);
  const duplicate = await fetch(transfer.url, { method: 'PUT', headers: transfer.headers, body: Buffer.alloc(content.length, 65) });
  assert.equal(duplicate.status, 409);
  assert.equal(localServices.objects.size, 0);
  const sansContexte = await prisma.$queryRaw`SELECT object_key FROM tracefab_preview_store.objects`;
  assert.equal(sansContexte.length, 0);
  const mauvaiseCle = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('tracefab.preview_storage_key', ${'non-autorise'}, true)`;
    return tx.$queryRaw`SELECT object_key FROM tracefab_preview_store.objects`;
  });
  assert.equal(mauvaiseCle.length, 0);
  pass('octets en PostgreSQL ; ecrasement refuse, RLS cache les lignes sans contexte ou avec mauvaise cle');

  const tooLarge = await call('POST', '/api/documents/upload-intent', { body: {
    originalFilename: 'large.txt', contentType: 'text/plain', byteSize: PREVIEW_STORAGE_MAX_BYTES + 1, kind: 'other',
  } });
  assert.equal(tooLarge.status, 400);
  pass('taille du backend Preview limitee a 1 MiB des lintention');

  const scanner = process.env.PRIVATE_STORAGE_ANTIVIRUS_URL;
  delete process.env.PRIVATE_STORAGE_ANTIVIRUS_URL;
  const unavailable = await call('POST', `/api/documents/${docId}/scan`);
  assert.equal(unavailable.status, 503);
  assert.equal((await call('GET', `/api/documents/${docId}/download`)).status, 404);
  process.env.PRIVATE_STORAGE_ANTIVIRUS_URL = scanner;
  pass('scanner absent : 503, document non telechargeable, jamais valide');

  const scan = await call('POST', `/api/documents/${docId}/scan`);
  assert.equal(scan.status, 200); assert.equal(scan.data.scan.status, 'clean');
  assert.equal(scan.data.document.sha256, createHash('sha256').update(content).digest('hex'));
  assert.equal(clamav ? clamav.stats().scans : localServices.stats().scans.length, 1);
  pass(`reprise du scan avec ${clamav ? 'ClamAV local (signature EICAR seule)' : 'doublure locale'} : statut available et SHA-256 exact`);

  const forbidden = await beta('GET', `/api/documents/${docId}/download`);
  assert.equal(forbidden.status, 404);
  assert.equal((await beta('GET', `/api/documents/${docId}/security-report`)).status, 404);
  assert.equal((await call('GET', `/api/documents/${docId}/download`, { token: null, org: null })).status, 401);
  pass('organisation Beta et requete sans jeton ne recoivent aucune capacite de telechargement');

  const signed = await call('GET', `/api/documents/${docId}/download`);
  assert.equal(signed.status, 200);
  const download = signed.data.download;
  assert.equal((await fetch(download.url)).status, 403);
  const result = await fetch(download.url, { headers: download.headers });
  assert.equal(result.status, 200);
  assert.ok(/private/.test(result.headers.get('cache-control')) && /no-store/.test(result.headers.get('cache-control')));
  assert.ok(Buffer.from(await result.arrayBuffer()).equals(content));
  const mutateWithReadCap = await fetch(download.url, { method: 'PUT', headers: { ...download.headers,
    'Content-Type': 'application/octet-stream' }, body: content });
  assert.equal(mutateWithReadCap.status, 403);
  pass('telechargement prive : octets binaires identiques, cache interdit et capacite GET non reutilisable en PUT');

  const report = await call('GET', `/api/documents/${docId}/security-report`);
  assert.equal(report.status, 200);
  assert.equal(report.data.securityReport.antivirus.clean, null);
  assert.equal(report.data.securityReport.antivirus.engine, null);
  assert.equal(report.data.securityReport.integrity.isEncryptedAtRest, null);
  pass('rapport ignore la metadata client qui revendiquait un faux moteur antivirus');

  const eicar = eicarTestBytes();
  const infectedIntent = await call('POST', '/api/documents/upload-intent', { body: {
    originalFilename: 'fixture-eicar.txt', contentType: 'text/plain', byteSize: eicar.length, kind: 'other',
  } });
  assert.equal(infectedIntent.status, 201);
  const infectedUpload = infectedIntent.data.upload;
  assert.equal((await fetch(infectedUpload.url, { method: 'PUT', headers: infectedUpload.headers, body: eicar })).status, 200);
  const rejected = await call('POST', `/api/documents/${infectedIntent.data.document.id}/scan`);
  assert.equal(rejected.status, 200); assert.equal(rejected.data.scan.status, 'rejected');
  assert.equal((await call('GET', `/api/documents/${infectedIntent.data.document.id}/download`)).status, 404);
  assert.equal(clamav ? clamav.stats().scans : localServices.stats().scans.length, 2);
  pass(`EICAR canonique rejete et non telechargeable avec ${clamav ? 'ClamAV local (signature EICAR seule)' : 'une doublure antivirus locale'}`);

  console.log(`\nPASS — ${checks} groupes ; PostgreSQL et HTTP locaux reels, Clerk simule, antivirus ${clamav ? 'ClamAV local limite a EICAR' : 'simule'}. Preview non testee.`);
} catch (error) {
  console.error(`ECHEC — ${error instanceof Error ? error.message : 'test_failed'}`);
  process.exitCode = 1;
} finally {
  if (api) await api.stop().catch(() => {});
  if (clamav) await clamav.stop().catch(() => {});
  if (localServices) await localServices.stop().catch(() => {});
  if (clerk) clerk.stop();
  if (prisma) await prisma.$disconnect().catch(() => {});
  if (admin) {
    // Suppression limitee aux objets de CETTE fixture, uniquement apres garde locale.
    await admin.query('DELETE FROM tracefab_preview_store.objects WHERE object_key LIKE $1', [`${orgA}/%`]).catch(() => {});
    await admin.end().catch(() => {});
  }
}
