import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { computeEvidenceHash } from './mass-balance.js';

export interface AuditSeal {
  entryId: string;
  timestamp: string;
  actorUserId?: string | null;
  organizationId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  evidenceHash: string;
  previousHash: string;
  signature: string;
}

/**
 * Creates an immutable, hash-chained audit record in the Neon PostgreSQL database.
 * Every audit log entry references the SHA-256 seal of the preceding entry, preventing retroactive tampering.
 */
export async function appendImmutableAuditLog(
  client: Prisma.TransactionClient | typeof prisma,
  params: {
    organizationId: string;
    actorUserId?: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    beforeState?: Record<string, unknown> | null;
    afterState?: Record<string, unknown> | null;
    metadata?: Record<string, unknown>;
  }
) {
  /*
   * Verrou consultatif de transaction, par organisation.
   *
   * La chaîne LIT le hachage précédent puis ÉCRIT le suivant. Sans
   * sérialisation, deux ajouts concurrents liraient le même previousHash et
   * produiraient deux maillons frères : verifyAuditChainIntegrity() signalerait
   * alors une chaîne cassée sur un journal pourtant intact. Le défaut existait
   * déjà, mais la console Admin multiplie les points d'écriture — le corriger
   * ici protège aussi les appelants existants.
   *
   * pg_advisory_xact_lock est libéré à la fin de la transaction : il ne peut pas
   * fuiter. Une collision de hachage entre deux organisations ne provoque qu'une
   * sérialisation inutile, jamais une donnée fausse.
   */
  await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.organizationId}))`;

  // 1. Fetch previous log hash for this organization to maintain linear hash chain
  const previousLog = await client.audit_logs.findFirst({
    where: { organization_id: params.organizationId },
    orderBy: { created_at: 'desc' },
    select: { id: true, created_at: true, metadata: true },
  });

  const prevMeta = (previousLog?.metadata as Record<string, unknown>) || {};
  const previousHash = typeof prevMeta.entryHash === 'string' 
    ? prevMeta.entryHash 
    : '0000000000000000000000000000000000000000000000000000000000000000';

  const timestamp = new Date().toISOString();

  // 2. Compute canonical digest of current state change
  const payloadToHash = {
    previousHash,
    organizationId: params.organizationId,
    actorUserId: params.actorUserId || null,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId || null,
    beforeState: params.beforeState || null,
    afterState: params.afterState || null,
    timestamp,
  };

  const entryHash = computeEvidenceHash(payloadToHash);

  // 3. Persist sealed log in audit_logs table
  const created = await client.audit_logs.create({
    data: {
      organization_id: params.organizationId,
      actor_user_id: params.actorUserId || null,
      action: params.action,
      entity_type: params.entityType,
      entity_id: params.entityId || null,
      before_state: params.beforeState as Prisma.InputJsonValue,
      after_state: params.afterState as Prisma.InputJsonValue,
      metadata: {
        ...(params.metadata || {}),
        entryHash,
        previousHash,
        sealedAt: timestamp,
        algorithm: 'SHA-256',
      } as Prisma.InputJsonValue,
    },
  });

  return {
    id: created.id,
    entryHash,
    previousHash,
    sealedAt: timestamp,
  };
}

/**
 * Validates the chronological cryptographic hash-chain for an organization's audit trail.
 */
export async function verifyAuditChainIntegrity(
  client: Prisma.TransactionClient | typeof prisma,
  organizationId: string,
): Promise<{ isValid: boolean; totalEntries: number; brokenAtEntryId?: string }> {
  const logs = await client.audit_logs.findMany({
    where: { organization_id: organizationId },
    orderBy: { created_at: 'asc' },
  });

  if (logs.length === 0) {
    return { isValid: true, totalEntries: 0 };
  }

  let expectedPrevHash = '0000000000000000000000000000000000000000000000000000000000000000';

  for (const log of logs) {
    const meta = (log.metadata as Record<string, unknown>) || {};
    const recordedHash = meta.entryHash;
    const recordedPrevHash = meta.previousHash;

    if (recordedPrevHash !== expectedPrevHash) {
      return {
        isValid: false,
        totalEntries: logs.length,
        brokenAtEntryId: log.id,
      };
    }

    // Recompute payload hash to ensure content was not altered
    const recomputedHash = computeEvidenceHash({
      previousHash: expectedPrevHash,
      organizationId: log.organization_id,
      actorUserId: log.actor_user_id,
      action: log.action,
      entityType: log.entity_type,
      entityId: log.entity_id,
      beforeState: log.before_state,
      afterState: log.after_state,
      timestamp: meta.sealedAt || log.created_at.toISOString(),
    });

    if (recordedHash && recordedHash !== recomputedHash) {
      return {
        isValid: false,
        totalEntries: logs.length,
        brokenAtEntryId: log.id,
      };
    }

    expectedPrevHash = typeof recordedHash === 'string' ? recordedHash : expectedPrevHash;
  }

  return { isValid: true, totalEntries: logs.length };
}
