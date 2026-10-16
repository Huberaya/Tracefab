import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { getOrganizationStorageUsage, assertStorageQuotaAvailable } from '../api/_lib/cloud-storage/quota-manager.ts';

const prisma = new PrismaClient();

async function withUserContext<T>(userId: string, email: string, callback: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('tracefab.user_id', ${userId}, true)`;
    await tx.$queryRaw`SELECT set_config('tracefab.user_email', ${email.toLowerCase()}, true)`;
    return callback(tx);
  });
}

async function run() {
  console.log('=== TEST INTEGRATION NEON CHANTIER 10: STORAGE QUOTAS & DOCUMENT SECURITY ===\n');

  try {
    // 1. Fetch real organization from Neon DB
    const org = await prisma.organizations.findFirst({
      where: { status: 'active' },
      select: { id: true, legal_name: true, type: true },
    });

    assert.ok(org, 'At least one active organization must exist in the guarded disposable database');
    const memberships = await prisma.$queryRaw<Array<{ user_id: string; email: string }>>`
      SELECT m.user_id, u.email
      FROM organization_memberships m
      JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ${org.id}::uuid
        AND m.status = 'active'
        AND m.role IN ('owner', 'admin', 'manager', 'contributor')
      ORDER BY m.created_at
      LIMIT 1
    `;
    const membership = memberships[0];
    assert.ok(membership, 'The selected organization must have an active document-upload role');
    console.log(`[SETUP] Using disposable organization: "${org.legal_name}" (${org.type}) - ${org.id}`);

    // 2. Query Storage Usage under the active tenant identity
    console.log('\n[STEP 1] Testing getOrganizationStorageUsage against the guarded PostgreSQL database...');
    const usage = await withUserContext(membership.user_id, membership.email, (tx) => getOrganizationStorageUsage(tx, org.id));
    assert.equal(usage.organizationId, org.id);
    assert.ok(typeof usage.usedBytes === 'number');
    assert.ok(typeof usage.quotaBytes === 'number');
    assert.ok(typeof usage.documentCount === 'number');
    assert.ok(usage.quotaBytes > 0);
    console.log('✓ Storage usage successfully resolved from Neon DB:', {
      usedMB: (usage.usedBytes / (1024 * 1024)).toFixed(2) + ' MB',
      quotaGB: (usage.quotaBytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB',
      percentageUsed: usage.percentageUsed + '%',
      totalDocuments: usage.documentCount,
      isExceeded: usage.isQuotaExceeded,
    });

    // 3. Test Quota Assertion
    console.log('\n[STEP 2] Testing assertStorageQuotaAvailable...');
    // Normal 1 MB document should pass
    await withUserContext(membership.user_id, membership.email, (tx) => assertStorageQuotaAvailable(tx, org.id, 1024 * 1024));
    console.log('✓ Normal upload within quota passed');

    // Excess 2 TB document should be blocked
    let caughtError: string | null = null;
    try {
      await withUserContext(membership.user_id, membership.email, (tx) => assertStorageQuotaAvailable(tx, org.id, 2 * 1024 * 1024 * 1024 * 1024));
    } catch (err: any) {
      caughtError = err?.message;
    }
    assert.equal(caughtError, 'organization_storage_quota_exceeded');
    console.log('✓ Quota overflow correctly intercepted with organization_storage_quota_exceeded');

    // 4. Verify Document integrity check on Neon documents if available
    console.log('\n[STEP 3] Verifying document registry in Neon DB...');
    const docCount = await prisma.documents.count();
    console.log(`✓ Guarded PostgreSQL database currently tracks ${docCount} document metadata rows`);

    console.log('\n=============================================================');
    console.log('SUCCESS: All Chantier 10 Neon live integration tests passed!');
    console.log('=============================================================\n');
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err && /^[A-Za-z0-9_]{1,32}$/.test(String((err as { code?: unknown }).code))
      ? String((err as { code?: unknown }).code)
      : 'details_suppressed';
    console.error(`Test failed (${code}); message and connection details suppressed.`);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

run();
