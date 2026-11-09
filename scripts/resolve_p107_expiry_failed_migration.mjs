#!/usr/bin/env node
/**
 * Reprise Prisma strictement conditionnelle de la migration additive P10.7.
 * N'ecrit jamais directement dans _prisma_migrations.
 */
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const migration = '20261109170000_p107_expiration_floor';
const flag = process.env.TRACEFAB_P11_EXPIRY_NEEDS_RESOLVE;
if (flag === 'false') {
  console.log('Aucune tentative echouee de la correction TTL a resoudre.');
  process.exit(0);
}
if (flag !== 'true') throw new Error('TRACEFAB_P11_EXPIRY_NEEDS_RESOLVE absent ou invalide.');
const result = spawnSync('npx', ['prisma', 'migrate', 'resolve', '--rolled-back', migration], {
  stdio: 'inherit',
  env: process.env,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
