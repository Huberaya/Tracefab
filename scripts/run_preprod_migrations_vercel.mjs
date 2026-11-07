#!/usr/bin/env node
/**
 * One-shot Prisma migration runner for the isolated Vercel Preview build.
 *
 * It is deliberately pinned to one Neon endpoint, one database, one role,
 * one Git branch, and one Vercel environment. It refuses every other target.
 * DATABASE_URL is injected as a branch-scoped sensitive Vercel variable and
 * is never printed.
 */
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_BRANCH = 'ops/tracefab-preprod-migrator-20261107';
const EXPECTED_HOST = 'ep-lively-field-b1wicg4v.c-5.eu-central-1.aws.neon.tech';
const EXPECTED_DATABASE = 'neondb';
const EXPECTED_ROLE = 'tracefab_migrator';

function refuse(message) {
  console.error(`\nREFUS RUNNER PRISMA : ${message}\n`);
  process.exit(1);
}

if (process.env.TF_MIGRATION_RUNNER_TARGET !== 'preproduction') {
  refuse('TF_MIGRATION_RUNNER_TARGET doit être preproduction.');
}
if (process.env.VERCEL !== '1' || process.env.VERCEL_ENV !== 'preview') {
  refuse('exécution autorisée uniquement dans un build Vercel Preview.');
}
if (process.env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH) {
  refuse('branche Git inattendue.');
}

const rawUrl = (process.env.DATABASE_URL || '').trim();
if (!rawUrl) refuse('DATABASE_URL absente.');
let parsed;
try { parsed = new URL(rawUrl); } catch { refuse('DATABASE_URL invalide.'); }
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) refuse('protocole PostgreSQL attendu.');
if (parsed.hostname !== EXPECTED_HOST) refuse('hôte Neon différent de la Préproduction attendue.');
if (parsed.hostname.includes('-pooler')) refuse('connexion poolée interdite pour Prisma Migrate.');
if (decodeURIComponent(parsed.username) !== EXPECTED_ROLE) refuse('rôle PostgreSQL inattendu.');
if (parsed.pathname !== `/${EXPECTED_DATABASE}`) refuse('base PostgreSQL inattendue.');
if (parsed.searchParams.get('sslmode') !== 'require') refuse('TLS PostgreSQL obligatoire.');

const cli = [
  join(ROOT, 'node_modules', 'prisma', 'build', 'index.js'),
  join(ROOT, 'node_modules', 'prisma', 'build', 'index.mjs'),
].find((path) => existsSync(path));
if (!cli) refuse('CLI Prisma local introuvable.');

function prisma(args, label) {
  console.log(`\n========== ${label} ==========`);
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    refuse(`${label} a échoué (code ${result.status ?? 'inconnu'}).`);
  }
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

console.log('Runner Prisma TraceFab — Préproduction Neon');
console.log(`Branche: ${EXPECTED_BRANCH} ; rôle: ${EXPECTED_ROLE} ; base: ${EXPECTED_DATABASE}`);
console.log('L’URL de connexion est masquée.');

const before = prisma(['migrate', 'status'], '1/4 — migrate status avant');
if (!/not yet been applied|following migration|pending/i.test(before)) {
  refuse('le status initial ne signale pas de migrations en attente ; arrêt préventif.');
}

const deploy = prisma(['migrate', 'deploy'], '2/4 — migrate deploy');
const applied = (deploy.match(/Applying migration/g) || []).length;
console.log(`Migrations annoncées comme appliquées pendant ce deploy : ${applied}`);
if (applied !== 30) refuse(`30 migrations étaient attendues, ${applied} observées.`);

const after = prisma(['migrate', 'status'], '3/4 — migrate status après');
if (!/up to date|no pending migrations/i.test(after)) {
  refuse('le status final ne confirme pas une base à jour.');
}

const second = prisma(['migrate', 'deploy'], '4/4 — second migrate deploy (idempotence)');
if (!/no pending migrations to apply/i.test(second)) {
  refuse('le second deploy ne confirme pas un no-op.');
}

console.log('\nVERDICT : Prisma 6.19.3 — Préproduction appliquée, à jour et idempotente.');
