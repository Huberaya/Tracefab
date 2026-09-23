import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { tracefabPrisma?: PrismaClient };

export const prisma = globalForPrisma.tracefabPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.tracefabPrisma = prisma;
}
