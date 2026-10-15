#!/usr/bin/env node
/**
 * Prove that the SQL owner guard rejects a non-extension function owned by a
 * different role while PUBLIC still has EXECUTE. Runs only against the
 * disposable PostgreSQL service in CI; never against a remote database.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('FAIL — DATABASE_URL is required for this disposable-database test.');
  process.exit(2);
}
const parsed = new URL(databaseUrl);
assert(
  ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
    && parsed.pathname === '/tracefab_test',
  'Safety stop: this test may run only against localhost/tracefab_test',
);

const migration = await readFile(
  new URL('../prisma/migrations/20261014130000_revoke_public_schema_privileges/migration.sql', import.meta.url),
  'utf8',
);
const guard = migration.match(/DO \$owner_guard\$[\s\S]*?\$owner_guard\$;/)?.[0];
assert(guard, 'The migration must contain the expected owner-guard DO block');

const client = new pg.Client({ connectionString: databaseUrl, ssl: false });
const role = 'tracefab_owner_guard_probe';
const routine = 'public.tracefab_owner_guard_probe()';
let transactionOpen = false;

try {
  await client.connect();
  await client.query('BEGIN');
  transactionOpen = true;

  // Clean up a leftover fixture defensively; this database is disposable.
  await client.query('DROP FUNCTION IF EXISTS public.tracefab_owner_guard_probe()');
  await client.query(`DROP ROLE IF EXISTS ${role}`);
  await client.query(`CREATE ROLE ${role} NOLOGIN`);
  await client.query(
    'CREATE FUNCTION public.tracefab_owner_guard_probe() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$',
  );
  await client.query(`ALTER FUNCTION ${routine} OWNER TO ${role}`);

  // Isolate the expected error so the transaction can be cleaned up afterwards.
  await client.query('SAVEPOINT before_owner_guard');
  let caught = null;
  try {
    await client.query(guard);
  } catch (error) {
    caught = error;
    await client.query('ROLLBACK TO SAVEPOINT before_owner_guard');
  }

  assert(caught, 'Owner guard should reject the foreign-owned PUBLIC-executable function');
  assert(
    String(caught.message).includes('Migration refusée : des routines non-extension avec EXECUTE PUBLIC')
      && String(caught.message).includes('tracefab_owner_guard_probe'),
    `Owner guard must explain the offending role/routine; received: ${caught.message}`,
  );

  await client.query('DROP FUNCTION IF EXISTS public.tracefab_owner_guard_probe()');
  await client.query(`DROP ROLE ${role}`);
  await client.query('COMMIT');
  transactionOpen = false;
  console.log('PASS — owner guard refuses a foreign-owned PUBLIC EXECUTE routine and transaction cleanup succeeds.');
} catch (error) {
  if (transactionOpen) {
    try { await client.query('ROLLBACK'); } catch {}
  }
  console.error('FAIL —', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
