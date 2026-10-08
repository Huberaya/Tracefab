import type { Prisma } from '@prisma/client';
import { appendImmutableAuditLog } from './audit-vault.js';
import { buildAuditEntry } from './crm-audit.js';
import type { AuditAction, AuditEntity } from './crm-audit.js';

/**
 * Écriture du journal d'audit — Chantier Admin 04 (§16).
 *
 * Séparé de `crm-audit.ts` parce que celui-ci est pur et donc testable sans
 * client Prisma généré ; celui-ci touche la base.
 *
 * À appeler DANS la même transaction que la mutation. Un audit écrit après coup
 * peut manquer si la requête suivante échoue, et un journal qui ne correspond
 * pas à l'état réel ne vaut plus rien comme preuve.
 */
export async function auditAdmin(
  tx: Prisma.TransactionClient,
  params: {
    admin: { platformOrganizationId: string; userId: string; fullName: string };
    entity: AuditEntity;
    action: AuditAction;
    entityId?: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    metadata?: Record<string, unknown>;
  },
) {
  return appendImmutableAuditLog(tx, buildAuditEntry(params));
}
