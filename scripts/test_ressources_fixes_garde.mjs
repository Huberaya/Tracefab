#!/usr/bin/env node
/**
 * Ressources FIXES : les deux dernieres portes qui n'avaient pas de garde.
 *
 * POURQUOI
 *
 * Le 29/10, un nom de base FIXE precede d'un `DROP ... IF EXISTS` avait ete
 * identifie et corrige pour les suites (scripts/lib/ephemeral-db.mjs) ; le 30/10
 * la meme faute a ete corrigee pour les roles (scripts/lib/ephemeral-role.mjs).
 * Deux familles de chemins etaient restees en dehors :
 *
 *   1. `scripts/audit_sql_privileges_catalog.sh` et
 *      `scripts/test_migration_integration_34_36_41.sh` :
 *          psql -c "DROP DATABASE IF EXISTS tracefab_test;"
 *      Un nom fixe, un DROP avant tout controle. Une base `tracefab_test`
 *      preexistante et remplie etait detruite.
 *
 *   2. `scripts/prepare_ci_db_role.mjs` : le role applicatif etait cree ou
 *      `ALTER ROLE`-e sans preuve d'OID, y compris s'il preexistait avec des
 *      attributs privilegies ; son mot de passe etait alors reecrit.
 *
 *   3. Le provisioning appele ISOLEMENT (les deux scripts shell) ne prenait
 *      aucun verrou de cluster, alors que `ALTER ROLE` touche `pg_authid`.
 *
 * CE QUE CE TEST PROUVE, DANS CET ORDRE
 *
 *   A. base fixe : refus sur base preexistante remplie (rien n'est detruit),
 *      adoption d'une base vide, marque posee, preuve d'OID, refus hors liste ;
 *   B. role applicatif : refus sans ecriture sur un role privilegie (mot de
 *      passe et attributs conserves, OID identique), reaffirmation sans
 *      destruction sur un role ordinaire, aucun `DROP ROLE` dans le script ;
 *   C. verrou : les deux scripts shell passent par le lanceur verrouille, et le
 *      verrou est REELLEMENT detenu pendant l'execution de l'enfant ;
 *   D. nettoyage : ce test ne laisse ni base `tf_garde_*` ni role `tf_garde_*`.
 *
 * Sorties : 0 conforme · 1 defaut · 2 prerequis manquant.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';
import { deriverUrl, verrouillerCluster } from './lib/ephemeral-db.mjs';
import {
  MARQUE,
  BaseJetableRefusee,
  detruireBaseProuvee,
  etatBase,
  reinitialiserBaseJetable,
} from './lib/base_jetable.mjs';

const RACINE = dirname(dirname(fileURLToPath(import.meta.url)));
const CLE_VERROU = 738241901;

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
  purpose: 'ressources fixes — bases et roles preexistants',
  exitOnFailure: true,
});

const urlProprietaire = process.env.DATABASE_URL;
const urlMaintenance = deriverUrl(urlProprietaire, 'postgres');
const alea = randomBytes(4).toString('hex');

async function admin() {
  const c = new pg.Client({ connectionString: urlMaintenance, ssl: sslDepuisUrl(urlMaintenance) });
  await c.connect();
  return c;
}

/** Cree une base `tf_garde_*` par SQL direct : hors garde, pour la mettre a l'epreuve. */
async function creerBaseBrute(nom) {
  const c = await admin();
  try {
    await c.query(`CREATE DATABASE "${nom}"`);
    const { rows } = await c.query('SELECT oid FROM pg_database WHERE datname = $1', [nom]);
    return String(rows[0].oid);
  } finally {
    await c.end();
  }
}

async function dropBaseBrute(nom) {
  const c = await admin();
  try {
    await c.query(`DROP DATABASE IF EXISTS "${nom}" WITH (FORCE)`);
  } finally {
    await c.end();
  }
}

/** Compte une table SANS la creer (lecture seule). */
async function compterTable(nom, table) {
  const url = deriverUrl(urlProprietaire, nom);
  const c = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url) });
  await c.connect();
  try {
    const { rows } = await c.query(
      `SELECT count(*)::int n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'public' AND c.relname = $1`, [table],
    );
    return rows[0].n;
  } finally {
    await c.end();
  }
}

async function tableDansBase(nom, table) {
  const url = deriverUrl(urlProprietaire, nom);
  const c = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url) });
  await c.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS "${table}" (id int)`);
    const { rows } = await c.query(
      `SELECT count(*)::int n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'public' AND c.relname = $1`, [table],
    );
    return rows[0].n;
  } finally {
    await c.end();
  }
}

const basesCreees = [];
const rolesCrees = [];

async function roleEtat(nom) {
  const c = await admin();
  try {
    const { rows } = await c.query(
      `SELECT a.oid, a.rolsuper, a.rolbypassrls, a.rolcreaterole, a.rolcreatedb,
              a.rolcanlogin, a.rolpassword
         FROM pg_authid a WHERE a.rolname = $1`, [nom],
    );
    return rows.length === 0 ? null : { ...rows[0], oid: String(rows[0].oid) };
  } finally {
    await c.end();
  }
}

async function dropRoleBrut(nom) {
  const c = await admin();
  try {
    await c.query(`DROP ROLE IF EXISTS "${nom}"`);
  } finally {
    await c.end();
  }
}

function envRole(nom) {
  return {
    ...process.env,
    TF_APP_ROLE_NAME: nom,
    TF_APP_PASSWORD: 'mot_de_passe_jetable',
    DATABASE_URL: urlProprietaire,
  };
}

function lancer(script, args, env = process.env) {
  const r = spawnSync(process.execPath, [join(RACINE, script), ...args], {
    env, cwd: RACINE, encoding: 'utf8',
  });
  return { code: r.status, sortie: `${r.stdout || ''}${r.stderr || ''}` };
}

/* ========================================================================== *
 * A. Base fixe : refus, adoption, marque, preuve d'OID
 * ========================================================================== */

console.log('\n  A. base fixe — une base preexistante remplie est CONSERVEE');

{
  const nom = `tf_garde_remplie_${alea}`;
  basesCreees.push(nom);
  await dropBaseBrute(nom);
  const oidAvant = await creerBaseBrute(nom);
  await tableDansBase(nom, 'travail_en_cours');

  let refus = null;
  try {
    await reinitialiserBaseJetable({ urlProprietaire, nom });
  } catch (e) {
    refus = e;
  }
  verifier('la garde refuse une base preexistante remplie et non marquee',
    refus instanceof BaseJetableRefusee && refus.exitCode === 2,
    refus ? refus.message : 'aucun refus');

  const apres = await etatBase(urlProprietaire, nom);
  verifier('la base refusee existe toujours, avec le MEME OID',
    apres !== null && apres.oid === oidAvant, apres ? `oid=${apres.oid}` : 'base absente');
  verifier('aucune marque n a ete posee sur la base refusee',
    apres !== null && apres.marque === null, apres ? String(apres.marque) : '-');
  const table = await compterTable(nom, 'travail_en_cours');
  verifier('la table preexistante est intacte (conservation prouvee)', table === 1, `n=${table}`);
  await dropBaseBrute(nom);
}

console.log('\n  A2. base vide : adoptee, marquee, puis destructible — preuve d OID');

{
  const nom = `tf_garde_vide_${alea}`;
  basesCreees.push(nom);
  await dropBaseBrute(nom);
  const oidAvant = await creerBaseBrute(nom);

  const r1 = await reinitialiserBaseJetable({ urlProprietaire, nom });
  verifier('une base preexistante VIDE est adoptee (et non refusee)',
    r1.adoption === 'vide' && r1.action === 'recreee', `${r1.adoption}/${r1.action}`);
  verifier('l OID a bien change : la base a ete recreee, pas reutilisee',
    r1.oidAvant === oidAvant && r1.oidApres !== oidAvant, `${r1.oidAvant} → ${r1.oidApres}`);

  const marquee = await etatBase(urlProprietaire, nom);
  verifier('la base recreee porte la marque qui autorise la destruction',
    marquee !== null && marquee.marque === MARQUE, marquee ? String(marquee.marque) : '-');

  // La marque autorise la destruction meme quand la base s'est remplie : c'est
  // la difference avec une base preexistante non marquee.
  await tableDansBase(nom, 'reste_du_run_precedent');
  const r2 = await reinitialiserBaseJetable({ urlProprietaire, nom });
  verifier('une base MARQUEE est recreee meme remplie', r2.adoption === 'marquee', r2.adoption);
  const vide = await compterTable(nom, 'reste_du_run_precedent');
  verifier('la table du run precedent a bien disparu', vide === 0, `n=${vide}`);
  await dropBaseBrute(nom);
}

console.log('\n  A3. liste fermee et refus par la CLI');

{
  let refus = null;
  try {
    await reinitialiserBaseJetable({ urlProprietaire, nom: 'postgres' });
  } catch (e) {
    refus = e;
  }
  verifier('un nom hors liste fermee est refuse', refus instanceof BaseJetableRefusee,
    refus ? refus.message : 'aucun refus');
  const c = await admin();
  try {
    const { rows } = await c.query("SELECT count(*)::int n FROM pg_database WHERE datname = 'postgres'");
    verifier('la base postgres est toujours la', rows[0].n === 1, `n=${rows[0].n}`);
  } finally {
    await c.end();
  }

  // Controle de bout en bout par la CLI utilisee par les scripts shell.
  const nom = `tf_garde_cli_${alea}`;
  basesCreees.push(nom);
  await dropBaseBrute(nom);
  await creerBaseBrute(nom);
  await tableDansBase(nom, 'donnees_reelles');
  const cli = lancer('scripts/reinitialiser_base_jetable.mjs', [], {
    ...process.env, DATABASE_URL: urlProprietaire, TF_RESET_BASE: nom,
  });
  verifier('la CLI sort en 2 sur une base preexistante remplie', cli.code === 2, `exit=${cli.code}`);
  const table = await compterTable(nom, 'donnees_reelles');
  verifier('la CLI n a rien detruit (table toujours la)', table === 1, `n=${table}`);
  await dropBaseBrute(nom);
}

console.log('\n  A4. les deux scripts shell ne detruisent plus a l aveugle');

for (const script of ['scripts/audit_sql_privileges_catalog.sh', 'scripts/test_migration_integration_34_36_41.sh']) {
  const source = readFileSync(join(RACINE, script), 'utf8');
  const lignesActives = source.split('\n').filter((l) => !l.trimStart().startsWith('#'));
  const dropNu = lignesActives.some((l) => /DROP\s+DATABASE\s+IF\s+EXISTS\s+tracefab_test/i.test(l));
  verifier(`${script.split('/').pop()} n a plus de DROP DATABASE nu`, !dropNu,
    'DROP DATABASE IF EXISTS tracefab_test encore present');
  verifier(`${script.split('/').pop()} passe par la garde`,
    /reinitialiser_base_jetable\.mjs/.test(source), 'appel a la garde absent');
  verifier(`${script.split('/').pop()} transforme un refus de la garde en refus (code 2)`,
    /2\|3\)\s*refuse/.test(source), 'pas de branche de refus');
}

/* ========================================================================== *
 * B. Role applicatif : OID, conservation, aucun DROP
 * ========================================================================== */

console.log('\n  B. role applicatif — un role preexistant privilegie est CONSERVE');

// Les sections B ecrivent dans `pg_authid`, objet de CLUSTER : on prend le meme
// verrou que les suites. Les enfants lances ici (`prepare_ci_db_role.mjs`) ne le
// prennent pas eux-memes : aucun interblocage possible.
//
// Le verrou est relache explicitement apres la section B3. Aucun risque de
// fuite : un verrou consultatif est libere avec la session, donc une sortie
// brutale de ce test ne peut pas le laisser derriere lui.
const verrouRoles = await verrouillerCluster({ urlProprietaire });
{
  const nom = `tf_garde_super_${alea}`;
  rolesCrees.push(nom);
  await dropRoleBrut(nom);
  const c = await admin();
  try {
    await c.query(`CREATE ROLE "${nom}" SUPERUSER LOGIN PASSWORD 'avant_le_test'`);
  } finally {
    await c.end();
  }
  const avant = await roleEtat(nom);

  const r = lancer('scripts/prepare_ci_db_role.mjs', [], envRole(nom));
  verifier('le script refuse un role preexistant SUPERUSER (exit 2)', r.code === 2, `exit=${r.code}`);

  const apres = await roleEtat(nom);
  verifier('le role existe toujours, MEME OID', apres !== null && apres.oid === avant.oid,
    apres ? `${avant.oid} → ${apres.oid}` : 'role disparu');
  verifier('le role est toujours SUPERUSER', apres !== null && apres.rolsuper === true,
    apres ? String(apres.rolsuper) : '-');
  verifier('le MOT DE PASSE n a pas ete reecrit (empreinte identique)',
    apres !== null && apres.rolpassword === avant.rolpassword, 'hash different');
  await dropRoleBrut(nom);
}

console.log('\n  B2. role ordinaire : reaffirme, jamais supprime ; role absent : cree puis range');

{
  const nom = `tf_garde_ordinaire_${alea}`;
  rolesCrees.push(nom);
  await dropRoleBrut(nom);
  const c = await admin();
  try {
    await c.query(`CREATE ROLE "${nom}" LOGIN PASSWORD 'avant_le_test'`);
  } finally {
    await c.end();
  }
  const avant = await roleEtat(nom);
  const r = lancer('scripts/prepare_ci_db_role.mjs', [], envRole(nom));
  const apres = await roleEtat(nom);
  verifier('un role ordinaire preexistant est accepte (exit 0)', r.code === 0, `exit=${r.code}`);
  verifier('il n a pas ete supprime puis recree : MEME OID',
    apres !== null && apres.oid === avant.oid, apres ? `${avant.oid} → ${apres.oid}` : 'absent');
  verifier('ses attributs sont reaffirmes sans privilege',
    apres !== null && !apres.rolsuper && !apres.rolbypassrls && !apres.rolcreaterole && !apres.rolcreatedb,
    'attribut privilegie present');
  await dropRoleBrut(nom);

  const absent = `tf_garde_cree_${alea}`;
  rolesCrees.push(absent);
  const r2 = lancer('scripts/prepare_ci_db_role.mjs', [], envRole(absent));
  const cree = await roleEtat(absent);
  verifier('un role absent est cree et son OID est imprime',
    r2.code === 0 && cree !== null && r2.sortie.includes(cree.oid),
    `exit=${r2.code}`);
  const nettoye = await dropRoleBrut(absent);
  verifier('le role cree par ce test est range (nettoyage prouve)',
    (await roleEtat(absent)) === null, 'role encore present');
  void nettoye;
}

console.log('\n  B3. le script ne peut pas viser un role privilegie, et ne supprime rien');

{
  const source = readFileSync(join(RACINE, 'scripts/prepare_ci_db_role.mjs'), 'utf8');
  const actives = source.split('\n').filter((l) => !l.trimStart().startsWith('*')
    && !l.trimStart().startsWith('//'));
  verifier('aucun DROP ROLE dans prepare_ci_db_role.mjs',
    !actives.some((l) => /DROP\s+ROLE/i.test(l)), 'DROP ROLE present');
  verifier('l OID est compare avant/apres (preuve d identite)',
    /apres\.oid\s*!==\s*avant\.oid/.test(source), 'comparaison absente');
  verifier('le nom par defaut reste tracefab_app',
    /TF_APP_ROLE_NAME\s*\|\|\s*'tracefab_app'/.test(source), 'defaut modifie');

  const postgresAvant = await roleEtat('postgres');
  const r = lancer('scripts/prepare_ci_db_role.mjs', [], {
    ...envRole('postgres'), TF_APP_ROLE_NAME: 'postgres',
  });
  const postgresApres = await roleEtat('postgres');
  verifier('une surcharge de nom hors tf_* est refusee (exit 2)', r.code === 2, `exit=${r.code}`);
  verifier('le role postgres est inchange (OID et empreinte du mot de passe)',
    postgresApres !== null && postgresApres.oid === postgresAvant.oid
      && postgresApres.rolpassword === postgresAvant.rolpassword, 'role modifie');
}

/* ========================================================================== *
 * C. Verrou de cluster sur le provisioning isole
 * ========================================================================== */

await verrouRoles.relacher();

console.log('\n  C. provisioning isole — verrou de cluster reellement detenu');

for (const script of ['scripts/audit_sql_privileges_catalog.sh', 'scripts/test_migration_integration_34_36_41.sh']) {
  const source = readFileSync(join(RACINE, script), 'utf8');
  verifier(`${script.split('/').pop()} verrouille le provisioning`,
    /run-db-suite\.mjs --verrou-cluster scripts\/prepare_ci_db_role\.mjs/.test(source),
    'appel non verrouille');
}

{
  // Suite temoin : elle regarde, depuis une AUTRE session, combien de sessions
  // detiennent le verrou consultatif. Lancee par le lanceur avec l'option, elle
  // doit voir 1 — la preuve que le verrou est bien tenu PENDANT l'enfant.
  const temoin = join(RACINE, 'scripts', `.tf_temoin_verrou_${alea}.mjs`);
  writeFileSync(temoin, `
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { deriverUrl, verrouillerCluster } from './lib/ephemeral-db.mjs';
const url = deriverUrl(process.env.DATABASE_URL, 'postgres');
const c = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url) });
await c.connect();
const { rows } = await c.query(
  'SELECT count(*)::int n FROM pg_locks WHERE locktype = $1 AND objid = $2 AND granted',
  ['advisory', ${CLE_VERROU}]);
console.log('DETENTEURS=' + rows[0].n);
await c.end();
process.exit(rows[0].n === 1 ? 0 : 1);
`, 'utf8');

  try {
    const verrouille = lancer('scripts/run-db-suite.mjs', ['--verrou-cluster', temoin]);
    verifier('avec --verrou-cluster, l enfant voit exactement 1 detenteur',
      verrouille.code === 0 && /DETENTEURS=1/.test(verrouille.sortie),
      verrouille.sortie.trim().split('\n').pop());

    const libre = lancer('scripts/run-db-suite.mjs', [temoin]);
    verifier('controle negatif : sans l option, aucun verrou n est pris',
      libre.code === 1 && /DETENTEURS=0/.test(libre.sortie),
      libre.sortie.trim().split('\n').pop());
  } finally {
    rmSync(temoin, { force: true });
  }
  verifier('la suite temoin a ete rangee', !existsSync(temoin), temoin);
}

/* ========================================================================== *
 * D. Nettoyage : ni base ni role laisses derriere
 * ========================================================================== */

console.log('\n  D. ce test ne laisse rien derriere');

{
  const c = await admin();
  try {
    const { rows: b } = await c.query(
      "SELECT datname FROM pg_database WHERE datname LIKE 'tf_garde_%' ORDER BY 1",
    );
    verifier('aucune base tf_garde_* residuelle', b.length === 0,
      b.map((r) => r.datname).join(', '));
    const { rows: r } = await c.query(
      "SELECT rolname FROM pg_roles WHERE rolname LIKE 'tf_garde_%' ORDER BY 1",
    );
    verifier('aucun role tf_garde_* residuel', r.length === 0,
      r.map((x) => x.rolname).join(', '));
  } finally {
    await c.end();
  }
}

console.log(`\n  ${vertes}/${vertes + rouges} assertions vertes`);
if (rouges > 0) {
  console.log(`  en échec : ${echecs.join(' · ')}`);
  process.exit(1);
}
console.log('  ok — bases fixes et roles preexistants conserves, provisioning verrouille.\n');
process.exit(0);
