#!/usr/bin/env node
/**
 * Reprise strictement conditionnelle de la tentative P10.7 echouee.
 * Le preflight a deja verifie la cible P11, l'absence de DDL partiel et le
 * besoin exact de resolution. Ce wrapper n'ecrit jamais dans _prisma_migrations
 * lui-meme : il appelle uniquement la commande officielle Prisma.
 */
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const MIGRATION = '20261106130000_identite_systeme_signee';
const flag = process.env.TRACEFAB_P11_NEEDS_RESOLVE;

if (flag === 'false') {
  console.log('Aucune tentative P10.7 echouee a resoudre.');
  process.exit(0);
}
if (flag !== 'true') {
  throw new Error('TRACEFAB_P11_NEEDS_RESOLVE absent ou invalide : arret ferme.');
}

const result = spawnSync('npx', [
  'prisma', 'migrate', 'resolve', '--rolled-back', MIGRATION,
], {
  stdio: 'inherit',
  env: process.env,
});
if (result.error) throw result.error;
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
}
