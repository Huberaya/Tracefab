#!/usr/bin/env node
/**
 * Lanceur commun des suites qui ecrivent en base.
 *
 * POURQUOI UN LANCEUR PLUTOT QU'UN APPEL DIRECT
 *
 * Retirer une ligne d'un workflow protege ce workflow-la, pas les suivants.
 * En branchant chaque suite destructive derriere ce lanceur, la garde de
 * cible s'applique a TOUS les chemins d'execution : CI, poste de
 * developpement, commande manuelle, script d'exploitation, futur workflow.
 *
 * Usage :
 *   node scripts/run-db-suite.mjs <chemin-du-script> [args...]
 *   node scripts/run-db-suite.mjs scripts/test_neon_security.mjs
 *
 * Variables lues par la garde : voir scripts/lib/require-throwaway-db.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const [target, ...rest] = process.argv.slice(2);

if (!target) {
  console.error('usage: node scripts/run-db-suite.mjs <script> [args...]');
  process.exit(2);
}

const absolute = resolve(ROOT, target);
if (!existsSync(absolute)) {
  console.error(`  REFUS — cible introuvable : ${target}`);
  process.exit(3);
}

const result = requireThrowawayDb({ purpose: target });
for (const line of result.summary) console.log(`  garde cible : ${line}`);
console.log('');

const isTypeScript = absolute.endsWith('.ts');
const tsxBin = join(ROOT, 'node_modules', '.bin', 'tsx');

if (isTypeScript && !existsSync(tsxBin)) {
  console.error('  NON EXECUTE — tsx absent : npm ci avant de lancer une suite TypeScript.');
  process.exit(2);
}

const child = spawn(
  isTypeScript ? tsxBin : process.execPath,
  isTypeScript ? [absolute, ...rest] : [absolute, ...rest],
  { stdio: 'inherit', cwd: ROOT, env: process.env },
);

child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
child.on('error', (error) => {
  console.error(`  ECHEC du lancement : ${error.message}`);
  process.exit(1);
});
