#!/usr/bin/env node
/**
 * BANC DE `scripts/inventaire_consommateurs_base.mjs`.
 *
 * Le 27/10/2026, la premiere version du script annoncait deux violations :
 * « 2 clients Prisma » et « un secret de base dans les workflows ». Verifie :
 * les deux etaient des COMMENTAIRES. Un inventaire qui lit les commentaires
 * invente des consommateurs ; un inventaire qui ne les lit pas doit quand meme
 * voir un vrai second client.
 *
 * Ce banc verrouille les deux sens :
 *   - le depot actuel passe les invariants (aucun faux positif residuel) ;
 *   - le rapport nomme exactement un client Prisma et aucun secret de base ;
 *   - il declare explicitement ce qu'il ne peut pas verifier.
 *
 * Sortie : 0 si tout tient, 1 sinon.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RAPPORT = join(ROOT, '.inventaire-test.json');

let echecs = 0;
const verifie = (ok, titre, detail = '') => {
  if (!ok) echecs += 1;
  console.log(`  ${ok ? 'ok    ' : 'ECHEC '} ${titre}${detail ? ` — ${detail}` : ''}`);
};

const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'inventaire_consommateurs_base.mjs'),
  '--json', '.inventaire-test.json'], { cwd: ROOT, encoding: 'utf8' });
const sortie = `${r.stdout || ''}${r.stderr || ''}`;

console.log("\nBanc de l'inventaire des consommateurs\n--------------------------------------");
verifie(r.status === 0, 'les invariants du depot passent', `code ${r.status}`);
verifie(/ok\s+un seul client Prisma/.test(sortie), 'un seul client Prisma est reconnu');
verifie(/ok\s+aucun workflow ne lit de secret de base/.test(sortie),
  'aucun secret de base dans les workflows (les commentaires ne comptent pas)');

if (!existsSync(RAPPORT)) {
  verifie(false, 'le rapport JSON est ecrit');
} else {
  const rapport = JSON.parse(readFileSync(RAPPORT, 'utf8'));
  verifie(Array.isArray(rapport.clients_prisma) && rapport.clients_prisma.length === 1,
    'le rapport ne liste qu\'un client Prisma', JSON.stringify(rapport.clients_prisma));
  verifie(Array.isArray(rapport.secrets_workflows)
    && !rapport.secrets_workflows.some((s) => /DATABASE|POSTGRES|NEON/.test(s)),
  'le rapport ne liste aucun secret de base', JSON.stringify(rapport.secrets_workflows));
  verifie(Object.keys(rapport.variables_base).some((v) => /DATABASE_URL/.test(v)),
    'la variable de connexion est identifiee');
  verifie(Array.isArray(rapport.non_verifiable) && rapport.non_verifiable.length >= 3,
    'le rapport declare ce qu\'il ne peut pas verifier', String(rapport.non_verifiable?.length));
  verifie(Array.isArray(rapport.crons_vercel) && rapport.crons_vercel.length >= 1,
    'les crons du runtime sont inventories', String(rapport.crons_vercel?.length));
  verifie(rapport.violations.length === 0, 'aucune violation');
  rmSync(RAPPORT, { force: true });
}

console.log(`\n${echecs ? 'ECHEC' : 'OK'} — ${echecs} cas en echec.`);
process.exit(echecs ? 1 : 0);
