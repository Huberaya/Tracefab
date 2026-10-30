#!/usr/bin/env node
/**
 * Deux suites DIFFERENTES, en parallele, sur le MEME cluster.
 *
 * Le defaut corrige le 30/10 n'apparaissait qu'entre deux suites distinctes :
 * `test_compteurs_debit` et `test_isolation_lignes_reelles` provisionnent le
 * meme role de cluster et appliquent la meme chaine de migrations. Lancees
 * ensemble, l'une echouait en `XX000 tuple concurrently updated` — une fois sur
 * trois — sur `ALTER ROLE` ou sur la migration `20261028120100`.
 *
 * Ce test ne se contente pas de constater que « ca passe » :
 *   A. il lance deux suites DIFFERENTES en concurrence, N fois ;
 *   B. il PROUVE que le verrou serialise reellement : verrou tenu de
 *      l'exterieur => la suite ne peut pas aboutir ; verrou relache => elle
 *      aboutit ;
 *   C. il verifie qu'il ne reste ni base, ni role, ni verrou.
 *
 * Sorties : 0 conforme · 1 defaut · 2 prerequis manquant.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as dormir } from 'node:timers/promises';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';
import { deriverUrl, verrouillerCluster } from './lib/ephemeral-db.mjs';

const RACINE = dirname(dirname(fileURLToPath(import.meta.url)));
const TOURS = Number(process.env.TF_CONCURRENCE_ROUNDS || 3);
const CLE = 738241901;

let vertes = 0;
let rouges = 0;
const echecs = [];
function verifier(etiquette, ok, detail) {
  if (ok) {
    vertes += 1;
    console.log(`    ok    ${etiquette}`);
  } else {
    rouges += 1;
    echecs.push(etiquette);
    console.log(`    ECHEC ${etiquette}${detail ? ` — observé : ${detail}` : ''}`);
  }
}

requireThrowawayDb({
  variables: ['DATABASE_URL'],
  purpose: 'concurrence inter-suites — deux suites differentes, un seul cluster',
  exitOnFailure: true,
});

const urlProprietaire = process.env.DATABASE_URL;
const urlMaintenance = deriverUrl(urlProprietaire, 'postgres');

async function maintenance() {
  const c = new pg.Client({ connectionString: urlMaintenance, ssl: sslDepuisUrl(urlMaintenance) });
  await c.connect();
  return c;
}

/** Lance une suite via le lanceur commun ; rend son code de sortie. */
function lancerSuite(chemin) {
  return new Promise((resoudre) => {
    const p = spawn(process.execPath, [join(RACINE, 'scripts', 'run-db-suite.mjs'), join(RACINE, chemin)],
      { env: process.env, stdio: 'ignore' });
    p.on('exit', (code) => resoudre(code));
  });
}

/* ========================================================================== *
 * A. Deux suites DIFFERENTES, en concurrence
 * ========================================================================== */

console.log(`\n  A. ${TOURS} tours — deux suites differentes en concurrence`);

// Deux suites qui, chacune : provisionnent le role de cluster, appliquent la
// chaine de migrations, puis verifient des politiques. Elles ne partagent rien
// d'autre que le cluster — c'est exactement le cas qui echouait.
const PAIRE = [
  ['scripts/test_compteurs_debit.mjs', 'scripts/test_privileges_role_app.mjs'],
  ['scripts/test_isolation_lignes_reelles.mjs', 'scripts/test_provisioning_role_app.mjs'],
];

for (let tour = 1; tour <= TOURS; tour += 1) {
  const [a, b] = PAIRE[(tour - 1) % PAIRE.length];
  const [ca, cb] = await Promise.all([lancerSuite(a), lancerSuite(b)]);
  verifier(`tour ${tour} : ${a.split('/').pop()} + ${b.split('/').pop()}`,
    ca === 0 && cb === 0, `${a.split('/').pop()}=${ca}, ${b.split('/').pop()}=${cb}`);
}

/* ========================================================================== *
 * B. Le verrou serialise reellement
 * ========================================================================== */

console.log('\n  B. preuve de serialisation — verrou tenu de l exterieur');

{
  const verrou = await verrouillerCluster({ urlProprietaire });
  let termine = false;
  const suite = lancerSuite('scripts/test_privileges_role_app.mjs').then((code) => {
    termine = true;
    return code;
  });

  await dormir(4000);
  const bloque = !termine;
  verifier('la suite ne peut pas aboutir tant que le verrou est tenu', bloque,
    termine ? 'la suite a abouti sans attendre le verrou' : '');

  await verrou.relacher();
  const code = await suite;
  verifier('une fois le verrou relache, la suite aboutit', code === 0, `exit=${code}`);
  verifier('et le processus concurrent observe bien la fin', termine, 'suite non terminee');
}

/* ========================================================================== *
 * C. Rien ne reste
 * ========================================================================== */

console.log('\n  C. apres la campagne — ni base, ni role, ni verrou residuel');

{
  const c = await maintenance();
  const bases = await c.query(
    "SELECT datname FROM pg_database WHERE datname LIKE 'tf\\_%' OR datname LIKE 'tracefab\\_%' AND datname <> 'tracefab_test'",
  );
  const roles = await c.query(
    "SELECT rolname FROM pg_roles WHERE rolname LIKE 'tf\\_role\\_%' OR rolname LIKE 'tf\\_sonde\\_%' OR rolname LIKE 'tf\\_bypass\\_%'",
  );
  const verrous = await c.query(
    'SELECT count(*)::int n FROM pg_locks WHERE locktype = $1 AND objid = $2',
    ['advisory', CLE],
  );
  await c.end();

  verifier('aucune base ephemere residuelle', bases.rowCount === 0, bases.rows.map((r) => r.datname).join(', '));
  verifier('aucun role de sonde residuel', roles.rowCount === 0, roles.rows.map((r) => r.rolname).join(', '));
  verifier('aucun verrou de cluster residuel', verrous.rows[0].n === 0, `${verrous.rows[0].n} verrou(s)`);
}

console.log(`\n  ${vertes}/${vertes + rouges} assertions vertes`);
if (rouges > 0) {
  console.log(`  en échec : ${echecs.join(' · ')}`);
  process.exit(1);
}
console.log('  ok — deux suites différentes cohabitent, et le verrou les sérialise vraiment.\n');
process.exit(0);
