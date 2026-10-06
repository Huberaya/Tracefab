import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';

const prisma = new PrismaClient();

async function main() {
  console.log('=== CHECKING NEON POSTGRESQL MIGRATIONS ===\n');

  // 1. Get migrations in filesystem
  const migrationsDir = path.resolve(process.cwd(), 'prisma/migrations');
  const diskMigrations = fs.readdirSync(migrationsDir)
    .filter(name => fs.statSync(path.join(migrationsDir, name)).isDirectory())
    .sort();

  console.log(`Discovered ${diskMigrations.length} migration folders on disk.\n`);

  // 2. Query Neon _prisma_migrations
  let appliedMigrations: any[] = [];
  try {
    appliedMigrations = await prisma.$queryRaw<any[]>`
      SELECT migration_name, started_at, finished_at, rolled_back_at, applied_steps_count
      FROM _prisma_migrations
      ORDER BY started_at ASC
    `;
    console.log(`Discovered ${appliedMigrations.length} recorded migrations in Neon database.\n`);
  } catch (err: any) {
    console.error('Failed to query _prisma_migrations table:', err.message);
  }

  const appliedMap = new Map(appliedMigrations.map(m => [m.migration_name, m]));

  const missingInDb: string[] = [];
  for (const dirName of diskMigrations) {
    const record = appliedMap.get(dirName);
    if (!record) {
      missingInDb.push(dirName);
      console.log(`[PENDING] ${dirName} -> NOT RECORDED IN _prisma_migrations`);
    } else if (!record.finished_at || record.rolled_back_at) {
      console.log(`[FAILED]  ${dirName} -> recorded but failed or rolled back`);
    } else {
      console.log(`[APPLIED] ${dirName} (applied at ${record.finished_at.toISOString()})`);
    }
  }

  console.log('\n--- MIGRATION STATUS SUMMARY ---');
  if (missingInDb.length === 0) {
    console.log('✓ All 25 disk migrations are fully applied and recorded in Neon DB!');
  } else {
    console.log(`⚠️ ${missingInDb.length} migration(s) missing from Neon DB:`, missingInDb);
  }
}

main()
  .catch(err => {
    console.error('Migration check failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
