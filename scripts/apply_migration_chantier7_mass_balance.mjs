import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';

const prisma = new PrismaClient();

async function run() {
  console.log('--- Applying Migration Chantier 7: Mass-Balance Anti-Fraud Engine ---');
  const sqlFile = path.resolve('prisma/migrations/20261006260000_mass_balance_anti_fraud_engine/migration.sql');
  const content = fs.readFileSync(sqlFile, 'utf8');

  const statements = [];
  let current = '';
  let inDollarQuote = false;
  let quoteTag = '';

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inDollarQuote && trimmed.startsWith('--')) {
      continue;
    }

    const dollarMatches = line.match(/\$[a-zA-Z0-9_]*\$/g);
    if (dollarMatches) {
      for (const match of dollarMatches) {
        if (!inDollarQuote) {
          inDollarQuote = true;
          quoteTag = match;
        } else if (inDollarQuote && match === quoteTag) {
          inDollarQuote = false;
          quoteTag = '';
        }
      }
    }

    current += line + '\n';

    if (!inDollarQuote && trimmed.endsWith(';')) {
      const stmt = current.trim();
      if (stmt.length > 0) {
        statements.push(stmt);
      }
      current = '';
    }
  }

  if (current.trim().length > 0) {
    statements.push(current.trim());
  }

  console.log(`Found ${statements.length} SQL statements to execute.`);

  for (let i = 0; i < statements.length; i++) {
    const s = statements[i];
    const preview = s.slice(0, 60).replace(/\n/g, ' ');
    process.stdout.write(`[${i + 1}/${statements.length}] ${preview}... `);
    try {
      await prisma.$executeRawUnsafe(s);
      console.log('OK');
    } catch (err) {
      console.error('\nFailed SQL:');
      console.error(s);
      throw err;
    }
  }

  console.log('✓ Migration applied successfully to Neon PostgreSQL!');
  await prisma.$disconnect();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
