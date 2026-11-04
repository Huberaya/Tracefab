#!/usr/bin/env node
/**
 * Teste le comportement réel de Prisma 6.19.x face à un checksum historique différent.
 * Strictement limité à un schéma jetable d'une base locale tracefab_test*.
 */
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { spawnSync } from 'node:child_process';

const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) { console.error('DATABASE_URL manquant'); process.exit(2); }
const base = new URL(sourceUrl);
const database = decodeURIComponent(base.pathname.replace(/^\//, ''));
if (!['localhost', '127.0.0.1', '::1'].includes(base.hostname) || !database.startsWith('tracefab_test')) {
  console.error('REFUS : ce test exige une base locale tracefab_test*');
  process.exit(3);
}
base.searchParams.delete('schema');
const schema = 'tf_checksum_probe_' + randomBytes(6).toString('hex');
const scoped = new URL(base);
scoped.searchParams.set('schema', schema);
const work = mkdtempSync(join(tmpdir(), 'tracefab-prisma-checksum-'));
const migrations = join(work, 'prisma', 'migrations');
const schemaFile = join(work, 'prisma', 'schema.prisma');
const prisma = resolve('node_modules/.bin/prisma');
const client = new Client({ connectionString: base.toString() });

function deploy() {
  const r = spawnSync(prisma, ['migrate', 'deploy', '--schema', schemaFile], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 120000,
    env: { ...process.env, DATABASE_URL: scoped.toString(), PRISMA_HIDE_UPDATE_MESSAGE: '1' },
  });
  return { status: r.status, output: (r.stdout || '') + '\n' + (r.stderr || ''), error: r.error?.message };
}
function assert(condition, message, detail = '') {
  if (!condition) throw new Error(message + (detail ? ': ' + detail : ''));
  console.log('  ok    ' + message);
}
try {
  await client.connect();
  await client.query('CREATE SCHEMA "' + schema + '"');
  mkdirSync(migrations, { recursive: true });
  writeFileSync(schemaFile, 'generator client {\n  provider = "prisma-client-js"\n}\ndatasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n');
  const first = '20261104000100_checksum_probe_init';
  const second = '20261104000200_checksum_probe_pending';
  const firstSql = 'CREATE TABLE checksum_probe_applied (id integer PRIMARY KEY);\n';
  const secondSql = 'CREATE TABLE checksum_probe_pending (id integer PRIMARY KEY);\n';
  mkdirSync(join(migrations, first));
  writeFileSync(join(migrations, first, 'migration.sql'), firstSql);
  let r = deploy();
  assert(r.status === 0, 'première migration appliquée', r.output || r.error);
  const initial = await client.query('SELECT checksum, finished_at FROM "' + schema + '"."_prisma_migrations" WHERE migration_name = $1', [first]);
  assert(initial.rowCount === 1 && initial.rows[0].finished_at !== null, 'historique initial terminé');
  const original = initial.rows[0].checksum;
  const altered = (original[0] === '0' ? '1' : '0') + original.slice(1);
  await client.query('UPDATE "' + schema + '"."_prisma_migrations" SET checksum = $1 WHERE migration_name = $2', [altered, first]);
  mkdirSync(join(migrations, second));
  writeFileSync(join(migrations, second, 'migration.sql'), secondSql);
  r = deploy();
  assert(r.status === 0, 'migrate deploy continue malgré le checksum historique divergent', r.output || r.error);
  assert(r.output.includes('Applying migration ' + second), 'la migration pending est effectivement appliquée', r.output);
  const rows = await client.query('SELECT migration_name, checksum, finished_at FROM "' + schema + '"."_prisma_migrations" ORDER BY migration_name');
  assert(rows.rowCount === 2 && rows.rows.every(x => x.finished_at !== null), 'les deux migrations sont terminées');
  assert(rows.rows.find(x => x.migration_name === first)?.checksum === altered, 'Prisma ne réécrit pas le checksum historique');
  const expected = createHash('sha256').update(secondSql).digest('hex');
  assert(rows.rows.find(x => x.migration_name === second)?.checksum === expected, 'checksum de la nouvelle migration exact');
  const created = await client.query('SELECT to_regclass($1) AS relation', [schema + '.checksum_probe_pending']);
  assert(created.rows[0].relation !== null, 'la table pending existe réellement');
  console.log('\n  PASS — Prisma migrate deploy applique le pending sans resolve ni réécriture.');
} catch (error) {
  console.error('\n  ECHEC — ' + (error.stack || error.message));
  process.exitCode = 1;
} finally {
  try {
    if (client.connection) {
      await client.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
      await client.end();
    }
  } catch (error) {
    console.error('NETTOYAGE ECHEC — ' + error.message);
    process.exitCode = 1;
  }
  rmSync(work, { recursive: true, force: true });
}
