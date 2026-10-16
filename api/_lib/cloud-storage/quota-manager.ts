import type { Prisma } from '@prisma/client';
import type { StorageQuotaInfo } from './types.js';

export const DEFAULT_STORAGE_QUOTA_BYTES = 1024 * 1024 * 1024; // 1 GiB default

export function configuredStorageQuota(): number {
  const envVal = process.env.ORGANIZATION_STORAGE_QUOTA_BYTES?.trim();
  if (envVal) {
    const parsed = Number(envVal);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_STORAGE_QUOTA_BYTES;
}

export async function getOrganizationStorageUsage(
  tx: Prisma.TransactionClient,
  organizationId: string
): Promise<StorageQuotaInfo> {
  const rows = await tx.$queryRaw<Array<{ used_bytes: bigint | number; doc_count: bigint | number }>>`
    SELECT used_bytes, doc_count
    FROM tracefab_get_document_storage_usage(${organizationId}::uuid)
  `;

  const usedBytes = Number(rows[0]?.used_bytes || 0);
  const documentCount = Number(rows[0]?.doc_count || 0);
  const quotaBytes = configuredStorageQuota();
  const availableBytes = Math.max(0, quotaBytes - usedBytes);
  const percentageUsed = quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 1000) / 10) : 100;

  return {
    organizationId,
    usedBytes,
    quotaBytes,
    availableBytes,
    percentageUsed,
    documentCount,
    isQuotaExceeded: usedBytes >= quotaBytes,
  };
}

export async function assertStorageQuotaAvailable(
  tx: Prisma.TransactionClient,
  organizationId: string,
  newDocumentBytes: number
): Promise<void> {
  // Serialize quota checks for one tenant until the surrounding upload-intent
  // transaction commits the document row. Without this transaction-scoped
  // lock, concurrent intents can each pass against the same pre-insert total.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 0))`;
  const usage = await getOrganizationStorageUsage(tx, organizationId);
  if (usage.usedBytes + newDocumentBytes > usage.quotaBytes) {
    throw new Error('organization_storage_quota_exceeded');
  }
}
