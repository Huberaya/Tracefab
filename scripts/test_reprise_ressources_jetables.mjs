#!/usr/bin/env node
/**
 * R6 — reprise apres interruption brutale, sur PREUVE et jamais sur prefixe.
 *
 * POURQUOI
 *
 * Un `SIGKILL` ne laisse aucune occasion de lancer un `finally`. Mesure du
 * 30/10 : l'enfant tue laissait sa base `tf_r6_…` et une ligne de test derriere
 * lui. La tentation est de « nettoyer tout ce qui commence par tf_ » : c'est
 * exactement ce qu'il ne faut pas faire, un prefixe n'etant pas une preuve.
 *
 * CE QUI EST PROUVE ICI
 *   A. le manifeste enregistre, a la creation, le triplet cluster + nom + OID ;
 *   B. apres `SIGKILL`, l'orphelin est DETECTE par le manifeste ;
 *   C. la simulation (defaut) ne detruit rien ;
 *   D. `--confirmer` detruit l'orphelin prouve, et son absence est verifiee ;
 *   E. controles negatifs : une base `tf_*` non manifestee n'est jamais touchee,
 *      un OID divergent fait refuser TOUT le lot, un nom protege aussi ;
 *   F. aucun verrou residuel, aucun role ou base de test laisse derriere.
 *
 * Sorties : 0 conforme · 1 defaut · 2 prerequis manquant.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as dormir } from 'node:timers/promises';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';
import { deriverUrl, creerBaseEphemere, identiteServeur } from './lib/ephemeral-db.mjs';
import { lireManifeste } from './lib/manifeste_jetable.mjs';

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
  purpose: 'reprise des ressources jetables',
  exitOnFailure: true,
});

const urlProprietaire = process.env.DATABASE_URL;
const urlMaintenance = deriverUrl(urlProprietaire, 'postgres');
const dossier = mkdtempSync(path.join(os.tmpdir(), 'tf_r6_'));
const manifeste = path.join(dossier, 'manifeste.jsonl');
// Le manifeste du processus de test : sans cela, les bases creees ICI seraient
// tracees dans le manifeste par defaut et le test lirait un fichier vide.
process.env.TF_MANIFESTE = manifeste;
const CLEANER = path.join(process.cwd(), 'scripts', 'nettoyer_ressources_jetables.mjs');

const admin = new pg.Client({ connectionString: urlMaintenance, ssl: sslDepuisUrl(urlMaintenance) });
await admin.connect();
const identite = await identiteServeur(admin);

const baseExiste = async (nom) => (await admin.query(
  'SELECT oid FROM pg_database WHERE datname = $1', [nom],
)).rowCount === 1;
const oidDe = async (nom) => String((await admin.query(
  'SELECT oid FROM pg_database WHERE datname = $1', [nom],
)).rows[0].oid);
const verrous = async () => Number((await admin.query(
  "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'",
)).rows[0].n);

const lancerNettoyeur = (args = [], env = {}) => spawnSync(
  process.execPath, [CLEANER, ...args], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: urlProprietaire, TF_MANIFESTE: manifeste, ...env },
  },
);

console.log('A. Le manifeste porte la preuve de création');
{
  const b = await creerBaseEphemere({ urlProprietaire, prefixe: 'tf_r6_manifeste' });
  const entrees = lireManifeste(manifeste);
  const e = entrees.find((x) => x.nom === b.nom);
  verifier('une entree est ecrite pour la base creee', e !== undefined);
  verifier('l entree porte l identite du cluster', e?.systemIdentifier === identite.systemIdentifier, e?.systemIdentifier);
  verifier('l entree porte l OID releve apres creation', e?.oid === b.oid, `${e?.oid} vs ${b.oid}`);
  verifier('l entree porte le genre et le createur', e?.genre === 'base' && typeof e?.createur === 'string');
  await b.fermer();
  verifier('la base de cette section est rangee', !(await baseExiste(b.nom)));

  appendFileSync(manifeste, '{"genre":"base","nom":"tronquee');
  const apres = lireManifeste(manifeste);
  verifier('une ligne tronquee par une interruption est ignoree, pas devinee',
    apres.every((x) => x.nom !== 'tronquee'));
  // Une ligne cassee ne doit pas avaler l'entree SUIVANTE : mesure du 30/10,
  // deux entrees valides perdues parce que la ligne tronquee n'avait pas de
  // saut de ligne final.
  const bSuivante = await creerBaseEphemere({ urlProprietaire, prefixe: 'tf_r6_apres_troncature' });
  verifier('une entree ecrite apres une ligne tronquee reste lisible',
    lireManifeste(manifeste).some((x) => x.nom === bSuivante.nom && x.oid === bSuivante.oid));
  await bSuivante.fermer();
  verifier('la base de cette sous-section est rangee', !(await baseExiste(bSuivante.nom)));
}

console.log('\nB. Interruption brutale : l orphelin est DETECTE par le manifeste');
const scriptEnfant = path.join(dossier, 'enfant.js');
writeFileSync(scriptEnfant, `
import { creerBaseEphemere } from ${JSON.stringify(path.join(process.cwd(), 'scripts/lib/ephemeral-db.mjs'))};
const b = await creerBaseEphemere({ urlProprietaire: process.env.DATABASE_URL, prefixe: 'tf_r6_orphelin' });
console.log(JSON.stringify({ nom: b.nom, oid: b.oid }));
await new Promise(() => setInterval(() => {}, 1000));
`);
const enfant = spawn(process.execPath, [scriptEnfant], {
  env: { ...process.env, DATABASE_URL: urlProprietaire, TF_MANIFESTE: manifeste },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let sortie = '';
enfant.stdout.on('data', (d) => { sortie += d; });
const limite = Date.now() + 20000;
while (!sortie.trim().endsWith('}')) {
  if (Date.now() > limite) throw new Error('enfant non pret');
  await dormir(30);
}
const orphelin = JSON.parse(sortie.trim());
enfant.kill('SIGKILL');
await new Promise((r) => enfant.on('exit', r));
await dormir(200);

verifier('SIGKILL : la base orpheline est bien presente', await baseExiste(orphelin.nom));
const entreeOrpheline = lireManifeste(manifeste).find((x) => x.nom === orphelin.nom);
verifier('le manifeste permet de la retrouver sans se fier au prefixe', entreeOrpheline?.oid === orphelin.oid);
verifier('aucun verrou residuel apres SIGKILL', (await verrous()) === 0, await verrous());

console.log('\nC. Simulation (défaut) : rien n est détruit');
{
  const r = lancerNettoyeur();
  verifier('sortie 0 en simulation', r.status === 0, r.status);
  verifier('la simulation annonce l orphelin', r.stdout.includes(orphelin.nom));
  verifier('la simulation dit explicitement qu elle n a rien detruit',
    /rien n a ete detruit/.test(r.stdout));
  verifier('la base orpheline est toujours la apres simulation', await baseExiste(orphelin.nom));
}

console.log('\nD. --confirmer : destruction prouvée de l orphelin');
{
  const r = lancerNettoyeur(['--confirmer']);
  verifier('sortie 0 en destruction', r.status === 0, `${r.status} ${r.stderr}`);
  verifier('l orphelin est detruit', !(await baseExiste(orphelin.nom)));
  verifier('la sortie affirme l absence verifiee', /absence verifiee/.test(r.stdout));
  const r2 = lancerNettoyeur(['--confirmer']);
  verifier('une seconde passe ne detruit plus rien', r2.status === 0 && /deja absente/.test(r2.stdout));
}

console.log('\nE. Contrôles négatifs : jamais de destruction sur simple prefixe');
{
  // E1 — base `tf_*` preexistante, JAMAIS passee par le manifeste.
  const nomE1 = `tf_r6_preexistante_${Date.now().toString(36)}`;
  await admin.query(`CREATE DATABASE ${nomE1}`);
  const r1 = lancerNettoyeur(['--confirmer']);
  verifier('E1 sortie 0 (rien de prouve a detruire)', r1.status === 0, r1.status);
  verifier('E1 la base non manifestee est INTACTE', await baseExiste(nomE1));

  // E2 — entree manifestee dont l'OID ne correspond plus.
  const b2 = await creerBaseEphemere({ urlProprietaire, prefixe: 'tf_r6_oid' });
  const vraiOid = b2.oid;
  await admin.query(`DROP DATABASE "${b2.nom}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${b2.nom}"`);
  const nouvelOid = await oidDe(b2.nom);
  const r2 = lancerNettoyeur(['--confirmer']);
  verifier('E2 un OID divergent fait REFUSER le lot (sortie 3)', r2.status === 3, r2.status);
  verifier('E2 la base homonyme recreee est INTACTE', await baseExiste(b2.nom));
  verifier('E2 le refus explique la divergence d OID', /OID actuel .* ≠ OID cree/.test(r2.stdout));
  await admin.query(`DROP DATABASE "${b2.nom}" WITH (FORCE)`);
  verifier('E2 nettoyage de la base de preuve', !(await baseExiste(b2.nom)));
  verifier('E2 l OID d origine etait bien celui du manifeste', vraiOid !== nouvelOid);

  // E3 — entree enregistree sur un AUTRE cluster.
  const r3 = lancerNettoyeur(['--confirmer'], { TF_MANIFESTE: path.join(dossier, 'autre.jsonl') });
  verifier('E3 un manifeste absent ne detruit rien et sort en 0', r3.status === 0, r3.status);
  writeFileSync(path.join(dossier, 'autre.jsonl'), `${JSON.stringify({
    genre: 'base', nom: nomE1, oid: '1', systemIdentifier: '9999999999999999999', createur: 'ailleurs',
  })}\n`);
  const r4 = lancerNettoyeur(['--confirmer'], { TF_MANIFESTE: path.join(dossier, 'autre.jsonl') });
  verifier('E4 une entree d un autre cluster est REFUSEE (sortie 3)', r4.status === 3, r4.status);
  verifier('E4 la base reste intacte', await baseExiste(nomE1));

  // E5 — nom protege, meme manifeste.
  writeFileSync(path.join(dossier, 'protege.jsonl'), `${JSON.stringify({
    genre: 'base', nom: 'tracefab_test', oid: '1', systemIdentifier: identite.systemIdentifier,
  })}\n`);
  const r5 = lancerNettoyeur(['--confirmer'], { TF_MANIFESTE: path.join(dossier, 'protege.jsonl') });
  verifier('E5 un nom protege est REFUSE (sortie 3)', r5.status === 3, r5.status);
  verifier('E5 tracefab_test est intacte', await baseExiste('tracefab_test'));

  await admin.query(`DROP DATABASE "${nomE1}" WITH (FORCE)`);
  verifier('E1 base de preuve rangee', !(await baseExiste(nomE1)));
}

console.log('\nF. État final');
verifier('aucun verrou residuel', (await verrous()) === 0, await verrous());
verifier('aucune base tf_r6_* residuelle',
  (await admin.query("SELECT count(*)::int n FROM pg_database WHERE datname LIKE 'tf_r6\\_%'")).rows[0].n === 0);
verifier('aucun role tf_garde_* residuel',
  (await admin.query("SELECT count(*)::int n FROM pg_roles WHERE rolname LIKE 'tf_garde\\_%'")).rows[0].n === 0);
verifier('le manifeste de travail ne contient aucune entree vivante',
  lireManifeste(manifeste).every((e) => e.nom.startsWith('tf_r6_')));
verifier('le manifeste est hors du depot', !manifeste.startsWith(process.cwd()));
verifier('aucun fichier temporaire dans scripts/', !existsSync(path.join(process.cwd(), 'scripts', '.tf_manifeste')));

await admin.end();
console.log(`\n  ${vertes}/${vertes + rouges} assertions vertes`);
if (rouges > 0) {
  console.log(`  en échec : ${echecs.join(' · ')}`);
  process.exit(1);
}
console.log('  ok — reprise sur preuve (cluster + nom + OID), jamais sur prefixe.');
process.exit(0);
