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
    SELECT
      COALESCE(SUM(byte_size), 0)::bigint AS used_bytes,
      COUNT(*)::bigint AS doc_count
    FROM documents
    WHERE owner_organization_id = ${organizationId}::uuid
      AND status NOT IN ('deleted', 'rejected')
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
  const usage = await getOrganizationStorageUsage(tx, organizationId);
  if (usage.usedBytes + newDocumentBytes > usage.quotaBytes) {
    throw new Error('organization_storage_quota_exceeded');
  }
}
