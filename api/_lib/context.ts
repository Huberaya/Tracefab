import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';

/**
 * Execute all tenant-scoped queries in one transaction with the Clerk-resolved
 * internal user UUID available to PostgreSQL RLS policies.
 */
export async function withTracefabUserContext<T>(
  userId: string,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('tracefab.user_id', ${userId}, true)`;
    return callback(tx);
  });
}
