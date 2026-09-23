import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';

/**
 * Execute tenant-scoped queries in one transaction with the Clerk-resolved
 * internal user UUID and email available to PostgreSQL RLS and SECURITY
 * DEFINER functions.
 */
export async function withTracefabUserContext<T>(
  userId: string,
  userEmail: string,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('tracefab.user_id', ${userId}, true)`;
    await tx.$executeRaw`SELECT set_config('tracefab.user_email', ${userEmail.toLowerCase()}, true)`;
    return callback(tx);
  });
}
