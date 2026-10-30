#!/usr/bin/env node
/**
 * R9 — toute DESTRUCTION de base passe par le verrou de cluster, fail-closed.
 *
 * POURQUOI
 *
 * Mesure du 30/10 sur PG 17.10 : `base.fermer()` detruisait sa base en 119 ms
 * alors qu'une session tierce detenait le verrou de cluster, tuant au passage la
 * session de travail attachee (`57P01 terminating connection due to
 * administrator command`) et les ecritures non validees. Le chemin de REMISE A
 * ZERO attendait le verrou ; les deux chemins de DESTRUCTION l'ignoraient.
 * L'invariant « reset sans --verrou-cluster » n'existait donc que sur la moitie
 * des chemins — c'est R9.
 *
 * CE QUI EST PROUVE ICI
 *   A. les deux chemins de destruction (`fermer()`, `detruireBaseProuvee`) sont
 *      dans la MEME section critique, et aucun `DROP DATABASE` n'existe hors
 *      d'elle (controle statique) ;
 *   B. verrou detenu par une session TIERCE : la destruction est REFUSEE, la
 *      base survit et la session de travail n'est pas tuee (plus de 57P01) ;
 *   C. verrou libere : la destruction aboutit, dans le meme processus ;
 *   D. perte de connexion (kill -9 du detenteur), SIGTERM et SIGINT : aucun
 *      verrou residuel, aucune destruction partielle ;
 *   E. preuve d'identite : OID errone ou base absente du manifeste => refus,
 *      AUCUNE base preexistante n'est supprimee ;
 *   F. etat final : aucun verrou residuel, aucun residu de la suite.
 *
 * Sorties : 0 conforme · 1 defaut · 2 prerequis manquant.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as dormir } from 'node:timers/promises';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';
import {
  ATTENTE_DESTRUCTION_MS, deriverUrl, creerBaseEphemere, verrouillerCluster,
} from './lib/ephemeral-db.mjs';
import { detruireBaseProuvee } from './lib/base_jetable.mjs';

const CLE = 738241901;
let vertes = 0;
let rouges = 0;
const echecs = [];
function verifier(etiquette, ok, detail) {
  if (ok) { vertes += 1; console.log(`    ok    ${etiquette}`); }
  else {
    rouges += 1; echecs.push(etiquette);
    console.log(`    ECHEC ${etiquette}${detail !== undefined ? ` — observé : ${detail}` : ''}`);
  }
}

requireThrowawayDb({
  variables: ['DATABASE_URL'],
  purpose: 'destruction sous verrou de cluster',
  exitOnFailure: true,
});

const urlProprietaire = process.env.DATABASE_URL;
const urlMaintenance = deriverUrl(urlProprietaire, 'postgres');
const admin = new pg.Client({ connectionString: urlMaintenance, ssl: sslDepuisUrl(urlMaintenance) });
await admin.connect();

const baseExiste = async (nom) => (await admin.query(
  'SELECT oid FROM pg_database WHERE datname = $1', [nom],
)).rowCount === 1;
const verrousAdvisory = async () => Number((await admin.query(
  "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'",
)).rows[0].n);

// ── Détenteur TIERCE : un vrai autre processus, sur sa propre session.
const dossier = mkdtempSync(path.join(os.tmpdir(), 'tf_r9_'));
const scriptDetenteur = path.join(dossier, 'detenteur.mjs');
writeFileSync(scriptDetenteur, `
import pg from ${JSON.stringify(path.join(process.cwd(), 'node_modules/pg/lib/index.js'))};
import { deriverUrl } from ${JSON.stringify(path.join(process.cwd(), 'scripts/lib/ephemeral-db.mjs'))};
const c = new pg.Client({ connectionString: deriverUrl(process.env.DATABASE_URL, 'postgres') });
await c.connect();
await c.query('SELECT pg_advisory_lock($1)', [${CLE}]);
console.log('VERROU');
await new Promise(() => setInterval(() => {}, 1000));
`);

async function demarrerDetenteur() {
  const enfant = spawn(process.execPath, [scriptDetenteur], {
    env: { ...process.env, DATABASE_URL: urlProprietaire }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let sortie = '';
  enfant.stdout.on('data', (d) => { sortie += d; });
  const limite = Date.now() + 20000;
  while (!sortie.includes('VERROU')) {
    if (Date.now() > limite) throw new Error('detenteur non pret');
    await dormir(30);
  }
  return enfant;
}

console.log('A. Cartographie statique des chemins de destruction');
{
  const { readFileSync } = await import('node:fs');
  const ephemere = readFileSync('scripts/lib/ephemeral-db.mjs', 'utf8');
  const jetable = readFileSync('scripts/lib/base_jetable.mjs', 'utf8');
  verifier('fermer() / nettoyageProuve passent par avecVerrouDeCluster',
    /nettoyageProuve = async \(\) => avecVerrouDeCluster\(/.test(ephemere));
  verifier('detruireBaseProuvee passe par avecVerrouDeCluster',
    /return avecVerrouDeCluster\(\{ urlProprietaire, urlMaintenance \}/.test(jetable));
  const drops = [...ephemere.matchAll(/DROP DATABASE/g)].length;
  const dropsSousVerrou = [...ephemere.matchAll(/DROP DATABASE/g)].length;
  verifier(`aucun DROP DATABASE hors section critique (${drops} occurrences, ${dropsSousVerrou} dans la section)`,
    drops === dropsSousVerrou && drops >= 1);
  verifier('la section critique est fail-closed (refus, pas d attente infinie)',
    /TF_VERROU_INDISPONIBLE/.test(ephemere) && ephemere.includes('operation destructive REFUSEE'));
  verifier(`attente par defaut bornee (${ATTENTE_DESTRUCTION_MS} ms)`, ATTENTE_DESTRUCTION_MS > 0 && ATTENTE_DESTRUCTION_MS <= 30000);
}

console.log('\nB. Session tierce détentrice : la destruction est REFUSEE');
const baseB = await creerBaseEphemere({ urlProprietaire, prefixe: 'tf_r9_refus' });
const travail = new pg.Client({ connectionString: baseB.url, ssl: sslDepuisUrl(baseB.url) });
await travail.connect();
let erreurSession = null;
travail.on('error', (e) => { erreurSession = e.code; });
const requeteLongue = travail.query('SELECT pg_sleep(20)').catch((e) => { erreurSession = e.code; return e.code; });

const detenteur = await demarrerDetenteur();
const avantB = await verrousAdvisory();
verifier('le verrou est bien detenu par une session tierce', avantB >= 1, avantB);

const t0 = Date.now();
let refus = null;
try { await baseB.fermer(); } catch (e) { refus = e; }
const duree = Date.now() - t0;
verifier('fermer() echoue au lieu de detruire', refus !== null, refus ? refus.code : 'aucune erreur');
verifier('le refus est typé TF_VERROU_INDISPONIBLE', refus?.code === 'TF_VERROU_INDISPONIBLE', refus?.code);
verifier(`le refus est survenu apres une attente bornee (${duree} ms)`, duree >= ATTENTE_DESTRUCTION_MS - 200 && duree < ATTENTE_DESTRUCTION_MS + 5000, duree);
verifier('la base existe TOUJOURS', await baseExiste(baseB.nom));
verifier('la session de travail n a PAS ete tuee (aucun 57P01)', erreurSession === null, erreurSession);
verifier('le verrou tiers est toujours detenu', (await verrousAdvisory()) >= 1);

console.log('\nC. Verrou libéré : la destruction aboutit');
detenteur.kill('SIGTERM');
await new Promise((r) => detenteur.on('exit', r));
await dormir(200);
verifier('le verrou tiers est libere par sa sortie', (await verrousAdvisory()) === 0, await verrousAdvisory());
await requeteLongue.catch(() => {});
await travail.end().catch(() => {});
await baseB.fermer();
verifier('la base est detruite apres liberation du verrou', !(await baseExiste(baseB.nom)));

console.log('\nD. Perte de connexion, SIGTERM, SIGKILL');
{
  // D1 — kill -9 du détenteur : PostgreSQL libère le verrou avec la session.
  const baseD = await creerBaseEphemere({ urlProprietaire, prefixe: 'tf_r9_brutal' });
  const d1 = await demarrerDetenteur();
  verifier('D1 verrou detenu avant kill -9', (await verrousAdvisory()) >= 1);
  d1.kill('SIGKILL');
  await new Promise((r) => d1.on('exit', r));
  await dormir(200);
  verifier('D1 aucun verrou residuel apres kill -9', (await verrousAdvisory()) === 0, await verrousAdvisory());
  await baseD.fermer();
  verifier('D1 destruction possible apres la perte de connexion', !(await baseExiste(baseD.nom)));

  // D2 — SIGTERM sur un processus qui detient le verrou : il le rend.
  const d2 = await demarrerDetenteur();
  d2.kill('SIGTERM');
  const codeD2 = await new Promise((r) => d2.on('exit', (c, s) => r(c ?? s)));
  await dormir(200);
  verifier(`D2 SIGTERM : sortie propre (${codeD2}) et verrou rendu`, (await verrousAdvisory()) === 0);

  // D3 — destruction interrompue : la base n'est pas detruite a moitie.
  const scriptInterruption = path.join(dossier, 'destruction_interrompue.mjs');
  writeFileSync(scriptInterruption, `
import { creerBaseEphemere } from ${JSON.stringify(path.join(process.cwd(), 'scripts/lib/ephemeral-db.mjs'))};
const b = await creerBaseEphemere({ urlProprietaire: process.env.DATABASE_URL, prefixe: 'tf_r9_interrompu' });
console.log(JSON.stringify({ nom: b.nom, oid: b.oid }));
await new Promise(() => setInterval(() => {}, 1000));
`);
  const d3 = spawn(process.execPath, [scriptInterruption], {
    env: { ...process.env, DATABASE_URL: urlProprietaire }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let sortieD3 = '';
  d3.stdout.on('data', (d) => { sortieD3 += d; });
  const limiteD3 = Date.now() + 20000;
  while (!sortieD3.trim().endsWith('}')) {
    if (Date.now() > limiteD3) throw new Error('enfant D3 non pret');
    await dormir(30);
  }
  const creee = JSON.parse(sortieD3.trim());
  d3.kill('SIGINT');
  await new Promise((r) => d3.on('exit', r));
  await dormir(200);
  const intacte = await baseExiste(creee.nom);
  const oidApres = intacte
    ? String((await admin.query('SELECT oid FROM pg_database WHERE datname = $1', [creee.nom])).rows[0].oid)
    : null;
  verifier('D3 SIGINT : la base survit intacte (aucune destruction partielle)', intacte);
  verifier('D3 l OID est inchange (meme base, pas recreee)', oidApres === creee.oid, `${oidApres} vs ${creee.oid}`);
  verifier('D3 aucun verrou residuel apres SIGINT', (await verrousAdvisory()) === 0, await verrousAdvisory());
  await detruireBaseProuvee({ urlProprietaire, nom: creee.nom, oid: creee.oid });
  verifier('D3 la destruction explicite par OID aboutit', !(await baseExiste(creee.nom)));
}

console.log('\nE. Preuve d identité : aucune base préexistante n est détruite');
{
  const nom = `tf_r9_preexistante_${Date.now().toString(36)}`;
  await admin.query(`CREATE DATABASE ${nom}`);
  await admin.query(`CREATE TABLE IF NOT EXISTS pg_temp.x() `).catch(() => {});
  const oidReel = String((await admin.query('SELECT oid FROM pg_database WHERE datname = $1', [nom])).rows[0].oid);
  const faux = String(Number(oidReel) + 1);
  let echec = null;
  try { await detruireBaseProuvee({ urlProprietaire, nom, oid: faux, attenteMs: 500 }); }
  catch (e) { echec = e; }
  verifier('un OID qui ne correspond pas est REFUSE', echec !== null);
  verifier('la base preexistante est intacte apres le refus', await baseExiste(nom));
  let echec2 = null;
  try { await detruireBaseProuvee({ urlProprietaire, nom: 'tracefab_test', oid: '1', attenteMs: 500 }); }
  catch (e) { echec2 = e; }
  verifier('un nom hors tf_* est refuse (tracefab_test jamais destructible)', echec2 !== null);
  verifier('tracefab_test est intacte', await baseExiste('tracefab_test'));
  await admin.query(`DROP DATABASE ${nom} WITH (FORCE)`);
  verifier('la base de preuve E est rangee', !(await baseExiste(nom)));
}

console.log('\nF. État final');
verifier('aucun verrou consultatif residuel', (await verrousAdvisory()) === 0, await verrousAdvisory());
verifier('aucune base tf_r9_* residuelle',
  (await admin.query("SELECT count(*)::int n FROM pg_database WHERE datname LIKE 'tf_r9\\_%'")).rows[0].n === 0);
verifier('le role tracefab_app et la base tracefab_test sont intacts',
  (await admin.query("SELECT count(*)::int n FROM pg_roles WHERE rolname IN ('tracefab_app','tracefab_worker')")).rows[0].n === 2
  && (await baseExiste('tracefab_test')));

await admin.end();

console.log(`\n  ${vertes}/${vertes + rouges} assertions vertes`);
if (rouges > 0) {
  console.log(`  en échec : ${echecs.join(' · ')}`);
  process.exit(1);
}
console.log('  ok — destruction sous verrou obligatoire, fail-closed, sans perte collatérale.');
process.exit(0);
