import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

/**
 * Execute tenant-scoped queries in one transaction with the Clerk-resolved
 * internal user UUID and email available to PostgreSQL RLS and SECURITY
 * DEFINER functions.
 */
export async function withTracefabWorkerContext<T>(
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('tracefab.worker_context', 'true', true)`;
    try {
      return await callback(tx);
    } finally {
      try {
        await tx.$executeRaw`SELECT set_config('tracefab.worker_context', 'false', true)`;
      } catch {
        // Preserve the original transaction error if PostgreSQL has already
        // marked the transaction as aborted.
      }
    }
  });
}

/**
 * Execute an anonymous public read in one transaction with the public context
 * flag armed.
 *
 * Public routes must use this. Without it, every tenant table returns zero
 * rows once the application connects as `tracefab_app` — which is the point:
 * nothing is public unless a policy says so, and no policy grants anything
 * unless this flag is set.
 *
 * The flag is transaction-local (`set_config(..., true)`), so a pooled
 * connection can never carry it into the next request.
 */
export async function withTracefabPublicContext<T>(
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('tracefab.public_context', 'true', true)`;
    try {
      return await callback(tx);
    } finally {
      try {
        await tx.$executeRaw`SELECT set_config('tracefab.public_context', 'false', true)`;
      } catch {
        // Preserve the original transaction error if PostgreSQL has already
        // marked the transaction as aborted.
      }
    }
  });
}

export async function withTracefabUserContext<T>(
  userId: string,
  userEmail: string,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return prisma.$transaction(async (tx) => {
    // Workflow trigger guards use this connection-local flag. Reset it before
    // every request so a failed prior transaction cannot leave a permissive
    // value on a pooled connection.
    await tx.$executeRaw`SELECT set_config('tracefab.internal_data_collection_update', 'false', false)`;
    await tx.$executeRaw`SELECT set_config('tracefab.user_id', ${userId}, true)`;
    await tx.$executeRaw`SELECT set_config('tracefab.user_email', ${userEmail.toLowerCase()}, true)`;
    try {
      return await callback(tx);
    } finally {
      try {
        await tx.$executeRaw`SELECT set_config('tracefab.internal_data_collection_update', 'false', false)`;
      } catch {
        // Preserve the original transaction error if PostgreSQL has already
        // marked the transaction as aborted.
      }
    }
  });
}
