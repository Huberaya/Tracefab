#!/usr/bin/env node
/**
 * Reprise conditionnelle de la seule tentative echouee de la migration RLS P10.7.
 * N'ecrit jamais dans _prisma_migrations directement : Prisma resolve uniquement.
 */
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';

const MIGRATION = '20261109190000_p107_worker_organizations_update';
const EXPECTED_ENDPOINT = 'ep-lively-field-b1wicg4v';
const rawUrl = (process.env.DATABASE_URL || '').trim();
if (!rawUrl) throw new Error('DATABASE_URL absente : arret ferme.');
const parsed = new URL(rawUrl);
if (!parsed.hostname.startsWith(EXPECTED_ENDPOINT + '.') || parsed.hostname.includes('-pooler')) {
  throw new Error('Cible refusee : connexion directe Neon Preview P11 requise.');
}
const client = new pg.Client({ connectionString: rawUrl, ssl: sslDepuisUrl(rawUrl) });
try {
  await client.connect();
  const identity = (await client.query(
    'SELECT current_database() AS database, current_user AS role'
  )).rows[0];
  if (identity.database !== 'neondb' || identity.role !== 'neondb_owner') {
    throw new Error('Cible refusee : neondb_owner sur neondb requis.');
  }
  const rows = (await client.query(
    'SELECT migration_name, finished_at, rolled_back_at FROM public._prisma_migrations WHERE migration_name = $1 ORDER BY started_at',
    [MIGRATION]
  )).rows;
  const unresolved = rows.filter((row) => !row.finished_at && !row.rolled_back_at);
  if (unresolved.length === 0) {
    console.log('Aucune tentative echouee non resolue pour ' + MIGRATION + '.');
    process.exit(0);
  }
  if (unresolved.length !== 1 || rows.some((row) => row.finished_at)) {
    throw new Error('Historique inattendu : resolution automatique refusee.');
  }
  const policy = (await client.query(
    "SELECT qual, with_check FROM pg_policies WHERE schemaname='public' AND tablename='organizations' AND policyname='organizations_worker_update'"
  )).rows[0];
  if (policy && (!/tracefab_worker/.test(policy.qual || '') || !/tracefab_worker/.test(policy.with_check || ''))) {
    throw new Error('Politique partielle inattendue : resolution refusee.');
  }
  console.log('Tentative echouee unique confirmee; resolution via Prisma --rolled-back.');
} finally {
  await client.end().catch(() => {});
}
const result = spawnSync('npx', ['prisma', 'migrate', 'resolve', '--rolled-back', MIGRATION], {
  stdio: 'inherit',
  env: process.env,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
