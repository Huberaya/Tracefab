import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { assertStorageQuotaAvailable, getOrganizationStorageUsage } from '../api/_lib/cloud-storage/quota-manager.ts';

const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.TF_RLS_APP_URL;
if (!ownerUrl || !appUrl) {
  console.error('NON EXECUTE — DATABASE_URL and TF_RLS_APP_URL are required; run only through the throwaway DB-suite guard.');
  process.exit(2);
}

const client = (connectionString: string) => new pg.Client({
  connectionString,
  ssl: /sslmode=(require|verify-full|verify-ca)/.test(connectionString) ? { rejectUnauthorized: false } : false,
});
const owner = client(ownerUrl);
const app = client(appUrl);
const prisma = new PrismaClient({ datasources: { db: { url: appUrl } } });
const userA = randomUUID();
const userB = randomUUID();
const organizationA = randomUUID();
const organizationB = randomUUID();
let documentA = '';
let documentARejected = '';
let documentB = '';
const suffix = randomUUID().slice(0, 10);
const emailA = `document-a-${suffix}@example.test`;
const emailB = `document-b-${suffix}@example.test`;
const sha = 'a'.repeat(64);
let failures = 0;
const ok = (message: string) => console.log(`  ok    ${message}`);

async function withAppUser<T>(userId: string, email: string, callback: () => Promise<T>): Promise<T> {
  await app.query('BEGIN');
  try {
    await app.query("SELECT set_config('tracefab.user_id', $1, true)", [userId]);
    await app.query("SELECT set_config('tracefab.user_email', $1, true)", [email]);
    const result = await callback();
    await app.query('COMMIT');
    return result;
  } catch (error) {
    await app.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function withPrismaAppUser<T>(
  userId: string,
  email: string,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('tracefab.user_id', ${userId}, true)`;
    await tx.$executeRaw`SELECT set_config('tracefab.user_email', ${email.toLowerCase()}, true)`;
    return callback(tx);
  });
}

async function expectAppFailure(userId: string, email: string, code: string, operation: () => Promise<unknown>) {
  try {
    await withAppUser(userId, email, operation);
  } catch (error) {
    assert(String((error as Error)?.message ?? error).includes(code), `expected ${code}, received ${(error as Error)?.message ?? error}`);
    return;
  }
  throw new Error(`expected SQL failure ${code}`);
}

async function registerDocument(userId: string, email: string, organizationId: string, name: string, size: number, metadata: Record<string, unknown> = {}) {
  const path = `${organizationId}/${randomUUID()}/${name}`;
  return withAppUser(userId, email, async () => {
    const result = await app.query(
      `SELECT (tracefab_register_document(
        $1::uuid, $2, $3, 'application/pdf', $4::bigint, NULL,
        'certificate'::document_kind, NULL, $5::jsonb
      )).id AS id`,
      [organizationId, path, name, size, JSON.stringify(metadata)],
    );
    const id = result.rows[0]?.id as string | undefined;
    assert.ok(id, 'document registration returned no row');
    return { id, path };
  });
}

async function finalize(userId: string, email: string, documentId: string, scanPassed: boolean, size: number) {
  return withAppUser(userId, email, async () => {
    const result = await app.query(
      'SELECT (tracefab_finalize_document_upload($1::uuid, $2, $3, $4::bigint)).status AS status',
      [documentId, sha, scanPassed, size],
    );
    return result.rows[0]?.status as string;
  });
}

async function main() {
  await owner.connect();
  await app.connect();
  const role = await app.query('SELECT current_user AS role, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass');
  assert.equal(role.rows[0]?.bypass, false, 'application role must not bypass RLS');
  ok(`test role ${role.rows[0]?.role} is subject to RLS`);

  await owner.query(
    'INSERT INTO users (id, clerk_user_id, email, full_name) VALUES ($1, $3, $4, $5), ($2, $6, $7, $8)',
    [userA, userB, `document-a-${suffix}`, emailA, 'Document tenant A', `document-b-${suffix}`, emailB, 'Document tenant B'],
  );
  await owner.query(
    `INSERT INTO organizations (id, type, legal_name, display_name, status, created_by) VALUES
       ($1, 'supplier', $3, $5, 'active', $7), ($2, 'supplier', $4, $6, 'active', $8)`,
    [organizationA, organizationB, `Document A ${suffix}`, `Document B ${suffix}`, `Doc A ${suffix}`, `Doc B ${suffix}`, userA, userB],
  );
  await owner.query(
    `INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES
       ($1, $3, 'owner', 'active'), ($2, $4, 'owner', 'active')`,
    [organizationA, organizationB, userA, userB],
  );

  const registeredA = await registerDocument(userA, emailA, organizationA, 'clean.pdf', 8, {
    security_scan: { clean: true, engine: 'forged-client-value' },
    scan_passed: true,
  });
  const registeredARejected = await registerDocument(userA, emailA, organizationA, 'rejected.pdf', 12);
  const registeredB = await registerDocument(userB, emailB, organizationB, 'tenant-b.pdf', 9);
  documentA = registeredA.id;
  documentARejected = registeredARejected.id;
  documentB = registeredB.id;
  assert.match(registeredA.path, new RegExp(`^${organizationA}/`));
  assert.match(registeredARejected.path, new RegExp(`^${organizationA}/`));
  const ownPendingRows = await withAppUser(userA, emailA, async () => {
    const result = await app.query('SELECT id FROM documents WHERE id = ANY($1::uuid[])', [[documentA, documentARejected, documentB]]);
    return result.rows.map((row) => row.id).sort();
  });
  assert.deepEqual(ownPendingRows, [documentA, documentARejected].sort(), 'RLS must expose owner pending docs but hide another tenant pending doc');
  ok('RLS exposes owner pending rows for retry/listing but hides another tenant pending document');

  const scanClaimRows = await withAppUser(userA, emailA, async () => {
    await app.query("SELECT set_config('tracefab.internal_document_update', 'true', true)");
    const result = await app.query(
      "UPDATE documents SET status = 'scanning'::document_status WHERE id = $1::uuid AND status = 'uploaded'::document_status",
      [documentA],
    );
    await app.query("SELECT set_config('tracefab.internal_document_update', 'false', true)");
    return result.rowCount;
  });
  assert.equal(scanClaimRows, 1, 'authorized owner must be able to commit a retryable scanning state');
  ok('authorized tenant can commit scanning before external I/O; failures remain pending and non-downloadable');

  await expectAppFailure(userA, emailA, 'document_finalize_role_required', async () => {
    await app.query('SELECT tracefab_finalize_document_upload($1::uuid, $2, true, 9::bigint)', [documentB, sha]);
  });
  ok('tenant A cannot finalize tenant B document through SECURITY DEFINER function');

  await expectAppFailure(userB, emailB, 'document_size_mismatch', async () => {
    await app.query('SELECT tracefab_finalize_document_upload($1::uuid, $2, true, 10::bigint)', [documentB, sha]);
  });
  ok('SQL finalizer independently rejects declared/actual byte-size mismatch');

  const available = await finalize(userA, emailA, documentA, true, 8);
  assert.equal(available, 'available');
  const metadata = await owner.query('SELECT metadata FROM documents WHERE id = $1', [documentA]);
  assert.equal(metadata.rows[0]?.metadata?.security_scan, undefined, 'client-supplied scan claim must be stripped by SQL finalization');
  assert.equal(metadata.rows[0]?.metadata?.scan_passed, true, 'server finalizer must set its own scan_passed field');
  ok('authorized SQL finalization marks clean lifecycle state and removes forged scan metadata');

  await expectAppFailure(userA, emailA, 'document_size_mismatch', async () => {
    await app.query('SELECT tracefab_finalize_document_upload($1::uuid, $2, true, 13::bigint)', [documentARejected, sha]);
  });
  const rejected = await finalize(userA, emailA, documentARejected, false, 13);
  assert.equal(rejected, 'rejected');
  const rejectedSize = await owner.query('SELECT byte_size FROM documents WHERE id = $1', [documentARejected]);
  assert.equal(Number(rejectedSize.rows[0]?.byte_size), 13, 'rejected actual size must be persisted for quota accounting');
  const rejectedB = await finalize(userB, emailB, documentB, false, 9);
  assert.equal(rejectedB, 'rejected');
  ok('rejected verdict persists actual bytes for quota accounting and never becomes available');

  const accessA = await withAppUser(userA, emailA, async () => {
    const result = await app.query('SELECT tracefab_can_access_document($1::uuid) AS can_access', [documentA]);
    return result.rows[0]?.can_access;
  });
  const accessBFromA = await withAppUser(userA, emailA, async () => {
    const result = await app.query('SELECT tracefab_can_access_document($1::uuid) AS can_access', [documentB]);
    return result.rows[0]?.can_access;
  });
  const rejectedAccess = await withAppUser(userA, emailA, async () => {
    const result = await app.query('SELECT tracefab_can_access_document($1::uuid) AS can_access', [documentARejected]);
    return result.rows[0]?.can_access;
  });
  assert.equal(accessA, true);
  assert.equal(accessBFromA, false);
  assert.equal(rejectedAccess, false);
  ok('document access is tenant-scoped and rejected rows remain inaccessible');

  await expectAppFailure(userA, emailA, 'document_upload_role_required', async () => {
    await app.query('SELECT * FROM tracefab_get_document_storage_usage($1::uuid)', [organizationB]);
  });
  ok('storage aggregate refuses a different tenant even though it returns only totals');

  await withAppUser(userA, emailA, async () => {
    await app.query('SELECT tracefab_soft_delete_document($1::uuid)', [documentA]);
  });
  const deletedRowsVisible = await withAppUser(userA, emailA, async () => {
    const result = await app.query('SELECT id FROM documents WHERE id = $1::uuid', [documentA]);
    return result.rowCount;
  });
  assert.equal(deletedRowsVisible, 0, 'soft-deleted document metadata must remain hidden under SELECT RLS');
  const priorQuota = process.env.ORGANIZATION_STORAGE_QUOTA_BYTES;
  process.env.ORGANIZATION_STORAGE_QUOTA_BYTES = '30';
  try {
    const usage = await withPrismaAppUser(userA, emailA, (tx) => getOrganizationStorageUsage(tx, organizationA));
    assert.equal(usage.usedBytes, 21, 'quota must include the available and rejected/soft-deleted objects still in storage even though deleted rows are hidden by SELECT RLS');
    assert.equal(usage.documentCount, 2);
    await withPrismaAppUser(userA, emailA, (tx) => assertStorageQuotaAvailable(tx, organizationA, 9));
    let quotaError: unknown;
    try {
      await withPrismaAppUser(userA, emailA, (tx) => assertStorageQuotaAvailable(tx, organizationA, 10));
    } catch (error) {
      quotaError = error;
    }
    assert(String((quotaError as Error)?.message ?? '').includes('organization_storage_quota_exceeded'));
  } finally {
    if (priorQuota === undefined) delete process.env.ORGANIZATION_STORAGE_QUOTA_BYTES;
    else process.env.ORGANIZATION_STORAGE_QUOTA_BYTES = priorQuota;
  }
  ok('quota reports physical bytes for rejected/soft-deleted rows and enforces the configured threshold');

  const afterSoftDelete = await withAppUser(userA, emailA, async () => {
    const result = await app.query('SELECT tracefab_can_access_document($1::uuid) AS can_access', [documentA]);
    return result.rows[0]?.can_access;
  });
  assert.equal(afterSoftDelete, false);
  ok('soft delete revokes tenant download authorization without claiming physical S3 deletion');
}

try {
  await main();
  console.log('PASS — SQL document authorization/finalization and quota checks executed on the guarded disposable PostgreSQL target; no S3 or antivirus service was contacted.');
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error && /^[A-Za-z0-9_]{1,32}$/.test(String((error as { code?: unknown }).code))
    ? String((error as { code?: unknown }).code)
    : 'details_suppressed';
  console.error(`FAIL — document-storage database behavior (${code}); message and connection details suppressed.`);
  failures += 1;
} finally {
  await prisma.$disconnect();
  await owner.query('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [[organizationA, organizationB]]).catch(() => {});
  await owner.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[userA, userB]]).catch(() => {});
  await app.end().catch(() => {});
  await owner.end().catch(() => {});
}

if (failures > 0) process.exit(1);
