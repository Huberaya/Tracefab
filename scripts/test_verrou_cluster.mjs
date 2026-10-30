#!/usr/bin/env node
/**
 * Le verrou de CLUSTER, PROUVE : couverture, detention, liberation.
 *
 * POURQUOI
 *
 * Certaines operations touchent des objets partages par TOUTES les bases d'un
 * serveur : `pg_authid` (CREATE/ALTER ROLE), les ACL de role par defaut. Deux
 * suites lancees en parallele sur le meme cluster se marchent alors dessus.
 * Mesure du 30/10 sur PG 17.10 : `XX000 tuple concurrently updated`, une fois
 * sur trois, sur `ALTER ROLE` et sur la migration
 * `20261028120100_worker_identity_not_forgeable`.
 *
 * CE QUI EST PROUVE
 *   A. tous les chemins de provisioning / application de migrations prennent le
 *      MEME verrou, et ceux qui ne doivent PAS le prendre sont justifies ;
 *   B. le verrou est reellement detenu pendant l'operation critique (visible
 *      dans `pg_locks` depuis une AUTRE session) ;
 *   C. il est libere apres succes, apres erreur, et sur interruption ;
 *   D. une sortie brutale (kill -9) ne laisse aucun verrou : PostgreSQL libere
 *      les verrous consultatifs avec la session ;
 *   E. apres une execution de suite, aucun verrou ne reste.
 *
 * Sorties : 0 conforme · 1 defaut · 2 prerequis manquant.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as dormir } from 'node:timers/promises';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';
import { deriverUrl, verrouillerCluster } from './lib/ephemeral-db.mjs';

const RACINE = dirname(dirname(fileURLToPath(import.meta.url)));
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
  purpose: 'verrou de cluster — couverture, detention, liberation',
  exitOnFailure: true,
});

const urlProprietaire = process.env.DATABASE_URL;
const urlMaintenance = deriverUrl(urlProprietaire, 'postgres');

async function maintenance() {
  const c = new pg.Client({ connectionString: urlMaintenance, ssl: sslDepuisUrl(urlMaintenance) });
  await c.connect();
  return c;
}

/** Combien de sessions detiennent le verrou de cluster, vu d'une AUTRE session. */
async function detenteurs() {
  const c = await maintenance();
  try {
    const { rows } = await c.query(
      'SELECT count(*)::int n FROM pg_locks WHERE locktype = $1 AND objid = $2 AND granted',
      ['advisory', CLE],
    );
    return rows[0].n;
  } finally {
    await c.end();
  }
}

/* ========================================================================== *
 * A. Couverture : qui doit prendre le verrou, et qui ne doit pas
 * ========================================================================== */

console.log('\n  A. couverture — un seul verrou, pris au bon niveau');

// Chemins qui provisionnent le role ou appliquent la chaine de migrations sur un
// cluster PARTAGE : ils doivent prendre le verrou.
const DOIVENT_VERROUILLER = [
  'scripts/test_compteurs_debit.mjs',
  'scripts/test_isolation_lignes_reelles.mjs',
  'scripts/test_privileges_role_app.mjs',
  'scripts/test_provisioning_role_app.mjs',
  'scripts/test_neon_publication_deploiement.mjs',
  'scripts/seed_rls_fixture.mjs',
  'scripts/migrer_fidelement.mjs',
  'scripts/db-deploy-throwaway.mjs',
  // Harnais RLS : il provisionne le role AVANT d'appliquer la chaine de
  // migrations, puis relache le verrou avant de lancer les suites.
  'scripts/harnais_suites_rls.mjs',
  // Epreuve de `ensureAppRole` : elle cree et detruit des roles de sonde.
  'scripts/test_ensure_app_role_garde.mjs',
];

// Chemins qui ne doivent PAS le prendre, avec la raison.
const NE_DOIVENT_PAS = [
  // Le point d'entree du provisioning : il EST la section critique. Poser le
  // verrou ici ferait attendre indefiniment un appelant qui le detient deja
  // (deux sessions differentes : un verrou consultatif n'est pas reentrant).
  ['scripts/bootstrap_app_role.mjs', 'section critique appelée par un porteur déjà verrouillé'],
  ['scripts/prepare_ci_db_role.mjs', 'idem — appele par les scripts verrouilles'],
  // Cluster prive, cree et detruit par le script lui-meme : rien a serialiser.
  ['scripts/test_routes_sous_role_app.mjs', 'embedded-postgres prive'],
  ['scripts/test_routes_ecriture_non_authentifiee.mjs', 'embedded-postgres prive'],
  // Aucun provisioning de role, aucune chaine de migrations.
  ['scripts/test_base_ephemere_garde.mjs', 'garde des bases seulement'],
  ['scripts/test_role_ephemere_garde.mjs', 'garde des roles seulement (noms uniques, aucun role partage)'],
];

for (const chemin of DOIVENT_VERROUILLER) {
  const absolu = join(RACINE, chemin);
  const existe = existsSync(absolu);
  const source = existe ? readFileSync(absolu, 'utf8') : '';
  verifier(`${chemin.split('/').pop()} prend le verrou de cluster`,
    existe && /verrouillerCluster\(/.test(source),
    existe ? 'aucun appel a verrouillerCluster' : 'fichier absent');
}

for (const [chemin, raison] of NE_DOIVENT_PAS) {
  const absolu = join(RACINE, chemin);
  if (!existsSync(absolu)) continue;
  const source = readFileSync(absolu, 'utf8');
  verifier(`${chemin.split('/').pop()} ne prend pas le verrou (${raison})`,
    !/verrouillerCluster\(/.test(source),
    'verrou pose a un niveau qui provoquerait une attente infinie');
}

// Chemins SHELL : ils appellent le provisioning en isolation depuis un script
// bash, donc hors de tout porteur de verrou. La couverture ne peut pas etre
// « le fichier contient verrouillerCluster » : c'est le LANCEUR COMMUN qui
// prend le verrou, et ces appels doivent passer par l'option dediee.
const VERROUILLENT_PAR_LANCEUR = [
  'scripts/audit_sql_privileges_catalog.sh',
  'scripts/test_migration_integration_34_36_41.sh',
];

for (const chemin of VERROUILLENT_PAR_LANCEUR) {
  const absolu = join(RACINE, chemin);
  const existe = existsSync(absolu);
  const source = existe ? readFileSync(absolu, 'utf8') : '';
  verifier(`${chemin.split('/').pop()} verrouille son provisioning isole`,
    existe && /run-db-suite\.mjs --verrou-cluster scripts\/prepare_ci_db_role\.mjs/.test(source),
    existe ? 'appel non verrouille' : 'fichier absent');
}

// Decouverte : aucun CHEMIN SHELL ne peut appeler le provisioning sans l'option.
{
  const intrus = readdirSync(join(RACINE, 'scripts'))
    .filter((n) => n.endsWith('.sh'))
    .map((n) => `scripts/${n}`)
    .filter((c) => {
      const source = readFileSync(join(RACINE, c), 'utf8');
      const appels = source.split('\n')
        .filter((l) => !l.trimStart().startsWith('#') && /prepare_ci_db_role\.mjs/.test(l));
      return appels.some((l) => !/--verrou-cluster/.test(l));
    });
  verifier('aucun script shell n appelle le provisioning sans verrou', intrus.length === 0,
    intrus.join(', '));
}

// Decouverte : aucun nouveau chemin ne peut passer entre les mailles.
{
  // Ce test enumere les chemins et prend le verrou pour l'eprouver : il ne
  // figure dans aucune des deux listes, seulement parmi les fichiers connus.
  const connus = new Set([
    ...DOIVENT_VERROUILLER,
    ...NE_DOIVENT_PAS.map(([c]) => c),
    'scripts/test_verrou_cluster.mjs',
    'scripts/test_concurrence_suites.mjs',
  ]);
  const marqueurs = /ensureAppRole\(|execFileSync\(\s*'node'[^\n]*prepare_ci_db_role|bootstrap_app_role\.mjs/;
  const intrus = readdirSync(join(RACINE, 'scripts'))
    .filter((n) => n.endsWith('.mjs'))
    .map((n) => `scripts/${n}`)
    .filter((c) => !connus.has(c) && marqueurs.test(readFileSync(join(RACINE, c), 'utf8')));
  verifier('aucun chemin non classe ne provisionne le role', intrus.length === 0, intrus.join(', '));
}

/* ========================================================================== *
 * B/C. Detention et liberation
 * ========================================================================== */

console.log('\n  B. le verrou est detenu pendant l operation critique');

{
  const avant = await detenteurs();
  const verrou = await verrouillerCluster({ urlProprietaire });
  const pendant = await detenteurs();
  verifier('avant : personne ne detient le verrou', avant === 0, `${avant} detenteur(s)`);
  verifier('pendant : exactement une session le detient (vue d une AUTRE session)', pendant === 1, `${pendant}`);

  console.log('\n  C. liberation apres succes et apres erreur');
  await verrou.relacher();
  verifier('apres liberation explicite : plus personne', (await detenteurs()) === 0, `${await detenteurs()}`);

  // Apres une erreur : le verrou doit etre relache par la suite appelante.
  const verrou2 = await verrouillerCluster({ urlProprietaire });
  let erreur = null;
  try {
    throw new Error('echec simule de la section critique');
  } catch (e) {
    erreur = e;
  } finally {
    await verrou2.relacher();
  }
  verifier('une erreur dans la section critique n empeche pas la liberation',
    erreur !== null && (await detenteurs()) === 0, `${await detenteurs()} detenteur(s)`);
}

/* ========================================================================== *
 * D. Sortie brutale : PostgreSQL libere avec la session
 * ========================================================================== */

console.log('\n  D. interruption brutale (kill -9) — aucun verrou orphelin');

{
  const enfant = spawn(process.execPath, ['-e', `
    import('${join(RACINE, 'scripts/lib/ephemeral-db.mjs').replace(/\\/g, '/')}').then(async ({ verrouillerCluster }) => {
      await verrouillerCluster({ urlProprietaire: process.env.DATABASE_URL });
      console.log('PRIS');
      setInterval(() => {}, 1000);
    });
  `], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });

  await new Promise((resoudre) => enfant.stdout.on('data', (d) => {
    if (String(d).includes('PRIS')) resoudre();
  }));
  const pendant = await detenteurs();
  enfant.kill('SIGKILL');
  await new Promise((r) => enfant.on('exit', r));
  // Laisse au serveur le temps de constater la mort de la session.
  for (let i = 0; i < 20 && (await detenteurs()) !== 0; i += 1) await dormir(50);
  const apres = await detenteurs();
  verifier('le processus enfant detenait bien le verrou', pendant === 1, `${pendant}`);
  verifier('apres kill -9, plus aucun verrou orphelin', apres === 0, `${apres} detenteur(s)`);
}

/* ========================================================================== *
 * E. Apres une suite complete : aucun verrou
 * ========================================================================== */

console.log('\n  E. apres une suite complete, aucun verrou ne reste');

{
  const suite = join(RACINE, 'scripts', 'test_isolation_lignes_reelles.mjs');
  const code = await new Promise((resoudre) => {
    const p = spawn(process.execPath, [join(RACINE, 'scripts', 'run-db-suite.mjs'), suite],
      { env: process.env, stdio: 'ignore' });
    p.on('exit', resoudre);
  });
  verifier('la suite verrouillee aboutit', code === 0, `exit=${code}`);
  verifier('aucun verrou residuel apres la suite', (await detenteurs()) === 0, `${await detenteurs()}`);
}

console.log(`\n  ${vertes}/${vertes + rouges} assertions vertes`);
if (rouges > 0) {
  console.log(`  en échec : ${echecs.join(' · ')}`);
  process.exit(1);
}
console.log('  ok — verrou unique, détenu pendant l\'opération, jamais orphelin.\n');
process.exit(0);
