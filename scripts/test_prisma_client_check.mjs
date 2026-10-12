#!/usr/bin/env node
/**
 * Preuve du controle de client Prisma.
 *
 * Un controle qui refuse tout ne prouve rien ; un controle qui accepte tout
 * non plus. Cette suite installe le verificateur dans trois projets jetables
 * sous /tmp et verifie les trois issues :
 *
 *   1. client factice          -> le controle DOIT echouer ;
 *   2. client conforme         -> le controle DOIT passer ;
 *   3. client incomplet        -> le controle DOIT echouer.
 *
 * Le projet jetable reprend le vrai `prisma/schema.prisma` : le nombre de
 * modeles attendus est donc celui du depot, pas une valeur inventee.
 *
 * Aucun fichier du depot n'est modifie : tout se passe sous /tmp.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let echecs = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const ko = (m) => { echecs += 1; console.log(`  ECHEC ${m}`); };

const STUB = `"use strict";
class PrismaClient {
  constructor() {
    throw new Error('@prisma/client did not initialize yet. Please run "prisma generate" and try to import it again.');
  }
}
module.exports = { PrismaClient, Prisma: { defineExtension: (e) => e }, default: {} };
`;

/** Client conforme : tout modele du schema expose un delegue, sans connexion. */
const CONFORMING = `"use strict";
const delegate = () => ({ findMany: async () => [], findFirst: async () => null });
class PrismaClient {
  constructor() {
    return new Proxy(this, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === 'symbol') return undefined;
        return delegate();
      },
    });
  }
  async $transaction(fn) { return typeof fn === 'function' ? fn(this) : []; }
  async $queryRaw() { return []; }
  async $executeRaw() { return 0; }
  async $connect() {}
  async $disconnect() {}
}
module.exports = { PrismaClient, Prisma: { defineExtension: (e) => e }, default: {} };
`;

/** Client incomplet : construit, mais un modele du schema manque. */
const INCOMPLETE = `"use strict";
const delegate = () => ({ findMany: async () => [] });
class PrismaClient {
  constructor() {
    return new Proxy(this, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === 'symbol') return undefined;
        // Le premier modele du schema est volontairement absent.
        if (prop === 'user') return undefined;
        return delegate();
      },
    });
  }
  async $transaction(fn) { return typeof fn === 'function' ? fn(this) : []; }
  async $connect() {}
  async $disconnect() {}
}
module.exports = { PrismaClient, Prisma: { defineExtension: (e) => e }, default: {} };
`;

function project(label, clientSource) {
  const dir = mkdtempSync(join(tmpdir(), `tracefab-prisma-${label}-`));
  mkdirSync(join(dir, 'prisma'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', '@prisma', 'client'), { recursive: true });
  cpSync(join(ROOT, 'prisma', 'schema.prisma'), join(dir, 'prisma', 'schema.prisma'));
  cpSync(join(ROOT, 'scripts', 'verify_prisma_client.mjs'), join(dir, 'scripts', 'verify_prisma_client.mjs'));
  writeFileSync(join(dir, 'node_modules', '@prisma', 'client', 'package.json'),
    JSON.stringify({ name: '@prisma/client', version: '0.0.0-shim', main: 'index.js' }));
  writeFileSync(join(dir, 'node_modules', '@prisma', 'client', 'index.js'), clientSource);
  return dir;
}

function run(dir) {
  const result = spawnSync(process.execPath, [join(dir, 'scripts', 'verify_prisma_client.mjs')],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, DATABASE_URL: '' } });
  return { code: result.status, out: `${result.stdout || ''}${result.stderr || ''}` };
}

const cases = [
  ['client factice', STUB, 1, 'repli factice'],
  ['client conforme', CONFORMING, 0, 'conforme'],
  ['client incomplet', INCOMPLETE, 1, 'delegue'],
];

console.log('\n  Le controle doit distinguer les trois etats d un client Prisma\n');
const dirs = [];
for (const [label, source, expected, needle] of cases) {
  const dir = project(label.replace(/\s+/g, '-'), source);
  dirs.push(dir);
  const { code, out } = run(dir);
  const verdictOk = code === expected;
  const messageOk = out.toLowerCase().includes(needle.toLowerCase());
  if (verdictOk && messageOk) ok(`${label} -> sortie ${code} (attendue ${expected}), diagnostic explicite`);
  else if (!verdictOk) ko(`${label} -> sortie ${code}, attendue ${expected}`);
  else ko(`${label} -> sortie ${code} correcte mais diagnostic sans « ${needle} »`);
}

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });

console.log('\n  --------------------------------------------');
console.log(`  ${echecs === 0 ? 'Controle de client Prisma : OK.' : `Controle de client Prisma : ${echecs} echec(s).`}`);
console.log('  --------------------------------------------\n');
if (echecs > 0) process.exit(1);
