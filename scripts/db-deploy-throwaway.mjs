#!/usr/bin/env node
/**
 * Applique `prisma migrate deploy` UNIQUEMENT sur une base jetable locale.
 *
 * `npm run db:deploy` est la commande operationnelle : `prisma migrate deploy`,
 * sans garde. Un operateur qui l'invoque a choisi sa cible. La CI n'est pas
 * un operateur. Cette commande inverse l'ordre : garde d'abord, binaire
 * prisma LOCAL ensuite. Jamais `npx`. Aucun argument. Aucun opt-in distant :
 * TRACEFAB_ALLOW_* ne rend pas une cible migrable ici.
 *
 * CE N'EST PAS UN REMPLACEMENT DE `db:deploy`.
 *
 * Le parseur Prisma (schema-engine) n'est pas eprouve ici. La classification
 * est celle de require-throwaway-db (hote effectif, hostaddr refuse).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  requireThrowawayDb,
  EXIT_REFUSED,
} from './lib/require-throwaway-db.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const prismaBin = join(ROOT, 'node_modules', '.bin', 'prisma');

if (process.argv.length > 2) {
  console.error('  REFUS — db:deploy:throwaway n accepte aucun argument.');
  console.error('  Pas de --schema, pas de --url, pas de sous-commande : la cible');
  console.error('  se lit dans DATABASE_URL, apres classification. Sortie 2.');
  process.exit(2);
}

const variablesPresentes = ['DATABASE_URL', 'DIRECT_URL']
  .filter((variable) => (process.env[variable] || '').trim());
const result = requireThrowawayDb({
  purpose: 'prisma migrate deploy (base jetable)',
  variables: variablesPresentes.length > 0 ? variablesPresentes : ['DATABASE_URL'],
});

for (const entry of result.verdicts) {
  if (!entry.verdict.allowed || entry.verdict.code !== 'throwaway_local') {
    console.error('  REFUS — db:deploy:throwaway n accepte qu une cible locale jetable.');
    console.error('  Aucun opt-in distant, aucune liste blanche, aucun argument : sortie 3.');
    process.exit(EXIT_REFUSED);
  }
}

for (const line of result.summary) console.log(`  garde cible : ${line}`);
console.log('');

if (!existsSync(prismaBin)) {
  console.error('  NON EXECUTE — binaire prisma local absent (node_modules/.bin/prisma).');
  console.error('  npm ci avant de migrer. npx est interdit ici : sortie 2.');
  process.exit(2);
}

function caviarderFlux(texte) {
  let s = String(texte);
  for (const nom of ['DATABASE_URL', 'DIRECT_URL']) {
    const valeur = (process.env[nom] || '').trim();
    if (valeur.length >= 8) s = s.split(valeur).join(`[redacted:${nom}]`);
  }
  return s.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]');
}

function relayer(source, dest) {
  source.setEncoding('utf8');
  source.on('data', (chunk) => {
    dest.write(caviarderFlux(chunk));
  });
}

const child = spawn(
  prismaBin,
  ['migrate', 'deploy'],
  { stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT, env: process.env },
);

relayer(child.stdout, process.stdout);
relayer(child.stderr, process.stderr);

let codeSortie = 1;
let fluxOuverts = 2;
let enfantFini = false;
function tenterSortie() {
  if (!enfantFini || fluxOuverts > 0) return;
  process.exit(codeSortie);
}
child.stdout.on('end', () => { fluxOuverts -= 1; tenterSortie(); });
child.stderr.on('end', () => { fluxOuverts -= 1; tenterSortie(); });
child.on('close', (code, signal) => {
  codeSortie = signal ? 1 : (code ?? 1);
  enfantFini = true;
  tenterSortie();
});
child.on('error', (error) => {
  console.error(`  ECHEC du lancement prisma : ${error.message}`);
  process.exit(1);
});
