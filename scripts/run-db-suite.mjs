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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';
import { chooseSuiteLoader } from './lib/choose-suite-loader.mjs';

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

// Toutes les variables de connexion PRESENTES sont verifiees, pas seulement
// DATABASE_URL : une suite peut se connecter avec TF_RLS_APP_URL, et cette
// seconde cible ne doit pas pouvoir viser une autre base que la premiere.
// Exiger les deux en permanence ferait echouer les suites qui n'en posent
// qu'une ; elles sont donc verifiees selon ce qui est fourni.
const variablesPresentes = ['DATABASE_URL', 'TF_RLS_APP_URL']
  .filter((variable) => (process.env[variable] || '').trim());
const result = requireThrowawayDb({
  purpose: target,
  variables: variablesPresentes.length > 0 ? variablesPresentes : ['DATABASE_URL'],
});
for (const line of result.summary) console.log(`  garde cible : ${line}`);
console.log('');

// Le chargeur suit le CONTENU de la suite, pas seulement son extension : un
// .mjs qui importe des modules TypeScript du depot a besoin de tsx, sinon il
// meurt sur un ERR_MODULE_NOT_FOUND etrangera a la base et a la garde.
const chargeur = chooseSuiteLoader(absolute, readFileSync(absolute, 'utf8'));
const tsxBin = join(ROOT, 'node_modules', '.bin', 'tsx');

if (chargeur === 'tsx' && !existsSync(tsxBin)) {
  console.error('  NON EXECUTE — tsx absent : npm ci avant de lancer une suite qui importe du TypeScript.');
  process.exit(2);
}

console.log(`  chargeur : ${chargeur}${chargeur === 'tsx' ? ' (la suite importe du TypeScript)' : ''}`);

const child = spawn(
  chargeur === 'tsx' ? tsxBin : process.execPath,
  [absolute, ...rest],
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
