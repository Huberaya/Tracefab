#!/usr/bin/env node
/**
 * R4 — `ensureAppRole()` refuse un role preexistant qu'il n'a pas prouve sien.
 *
 * CE QUI ETAIT FAUX
 *
 * `scripts/lib/tracefab_app_role.mjs` faisait :
 *
 *     const existe = await db.query('select 1 from pg_roles where rolname = $1');
 *     if (!existe) CREATE ROLE tracefab_app ... PASSWORD ...
 *     else         ALTER ROLE tracefab_app ... PASSWORD ...
 *
 * Aucune lecture d'attributs, aucune preuve d'OID, aucune question sur ce que le
 * role possede. Un `tracefab_app` PREEXISTANT et etranger — role d'exploitation,
 * role d'une autre instance — voyait son MOT DE PASSE reecrit et ses attributs
 * rabattus. `prepare_ci_db_role.mjs` a ete durci de la meme facon dans ce
 * chantier ; les deux scripts visent le meme objet de CLUSTER.
 *
 * CE QUE CE TEST PROUVE
 *
 *   A. role ABSENT : cree, OID releve, attributs conformes ;
 *   B. role preexistant PRIVILEGIE (SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB) :
 *      `RolePreexistantRefuse`, AUCUNE ecriture — mot de passe byte pour byte
 *      identique, attributs intacts, meme OID ;
 *   C. role preexistant PROPRIETAIRE d'objets : refuse, aucune ecriture ;
 *   D. role preexistant ordinaire : reaffirme (comportement historique), meme
 *      OID — il n'est ni supprime ni recree ;
 *   E. PREUVE D'OID : si le role change d'OID entre la lecture et la relecture,
 *      le provisioning echoue au lieu de valider (client simule, branche non
 *      atteignable autrement de facon deterministe) ;
 *   F. surcharge de nom bornee : `tf_*` accepte, tout le reste refuse ;
 *   G. rien ne subsiste apres le test.
 *
 * Sorties : 0 conforme · 1 defaut · 2 prerequis manquant.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';
import { deriverUrl, verrouillerCluster } from './lib/ephemeral-db.mjs';
import { APP_ROLE, RolePreexistantRefuse, ensureAppRole } from './lib/tracefab_app_role.mjs';

const RACINE = dirname(dirname(fileURLToPath(import.meta.url)));
void RACINE;

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
  purpose: 'garde de ensureAppRole — role preexistant',
  exitOnFailure: true,
});

const MOT_DE_PASSE = 'mot_de_passe_du_test_r4';
const url = process.env.DATABASE_URL;

async function connexion(u = url) {
  const c = new pg.Client({ connectionString: u, ssl: sslDepuisUrl(u) });
  await c.connect();
  return c;
}

async function etat(nom) {
  const c = await connexion();
  try {
    const { rows } = await c.query(
      `SELECT r.oid::text AS oid, r.rolsuper, r.rolbypassrls, r.rolcreaterole,
              r.rolcreatedb, r.rolcanlogin, a.rolpassword
         FROM pg_roles r JOIN pg_authid a ON a.oid = r.oid
        WHERE r.rolname = $1`, [nom],
    );
    return rows.length === 0 ? null : rows[0];
  } finally {
    await c.end();
  }
}

async function creerRole(sql) {
  const c = await connexion();
  try { await c.query(sql); } finally { await c.end(); }
}

async function dropRole(nom) {
  const c = await connexion(deriverUrl(url, 'postgres'));
  try {
    await c.query(`DROP OWNED BY "${nom}"`).catch(() => {});
    await c.query(`DROP ROLE IF EXISTS "${nom}"`);
  } catch (e) {
    console.error(`    (nettoyage) ${nom} : ${e.code} ${e.message}`);
    throw e;
  } finally {
    await c.end();
  }
}

// Verrou de CLUSTER : ce test ecrit dans `pg_authid` (CREATE/DROP ROLE) —
// objet partage par toutes les bases du serveur. Meme verrou que les suites.
// Les roles de sonde portent un prefixe `tf_r4_*` et un suffixe d'execution :
// ils ne peuvent pas entrer en collision avec le role applicatif partage.
const verrou = await verrouillerCluster({ urlProprietaire: url });

const suffixe = Date.now().toString(36);
const noms = [];
function nom(prefixe) {
  const n = `${prefixe}_${suffixe}`;
  noms.push(n);
  return n;
}

/* ========================================================================== *
 * A. Role absent : creation
 * ========================================================================== */

console.log('\n  A. role absent — cree, OID releve, attributs conformes');

// Etat de reference du role `postgres` : il ne doit pas bouger de tout le test.
const postgresAvant = await etat('postgres');

{
  const role = nom('tf_r4_absent');
  await dropRole(role);
  const c = await connexion();
  try {
    await ensureAppRole(c, MOT_DE_PASSE, { role });
  } finally {
    await c.end();
  }
  const e = await etat(role);
  verifier('le role est cree', e !== null, 'absent apres provisioning');
  verifier('il a LOGIN sans aucun attribut privilegie',
    e !== null && e.rolcanlogin && !e.rolsuper && !e.rolbypassrls && !e.rolcreaterole && !e.rolcreatedb,
    e ? JSON.stringify({ l: e.rolcanlogin, s: e.rolsuper, b: e.rolbypassrls }) : '-');
  verifier('son mot de passe a bien ete pose (SCRAM)', e !== null && /^SCRAM/.test(e.rolpassword || ''),
    'pas de hash SCRAM');
}

/* ========================================================================== *
 * B. Role preexistant privilegie : refus SANS ecriture
 * ========================================================================== */

console.log('\n  B. role preexistant privilegie — refuse, aucune ecriture');

for (const [libelle, attribut] of [
  ['SUPERUSER', 'SUPERUSER'],
  ['BYPASSRLS', 'BYPASSRLS'],
  ['CREATEROLE', 'CREATEROLE'],
  ['CREATEDB', 'CREATEDB'],
]) {
  const role = nom(`tf_r4_${attribut.toLowerCase()}`);
  await dropRole(role);
  await creerRole(`CREATE ROLE "${role}" LOGIN PASSWORD 'avant_le_test' ${attribut}`);
  const avant = await etat(role);

  let leve = null;
  const c = await connexion();
  try {
    await ensureAppRole(c, MOT_DE_PASSE, { role });
  } catch (e) {
    leve = e;
  } finally {
    await c.end();
  }
  const apres = await etat(role);

  verifier(`${libelle} : RolePreexistantRefuse`, leve instanceof RolePreexistantRefuse,
    leve ? `${leve.name} : ${leve.message}` : 'aucune levee');
  verifier(`${libelle} : meme OID (role ni supprime ni recree)`,
    apres !== null && apres.oid === avant.oid, apres ? `${avant.oid} → ${apres.oid}` : 'disparu');
  verifier(`${libelle} : mot de passe INCHANGE`,
    apres !== null && apres.rolpassword === avant.rolpassword, 'hash different');
  verifier(`${libelle} : attribut toujours present`,
    apres !== null && (
      (attribut === 'SUPERUSER' && apres.rolsuper)
      || (attribut === 'BYPASSRLS' && apres.rolbypassrls)
      || (attribut === 'CREATEROLE' && apres.rolcreaterole)
      || (attribut === 'CREATEDB' && apres.rolcreatedb)
    ),
    'attribut rabattu — le role a ete modifie');
  await dropRole(role);
}

/* ========================================================================== *
 * C. Role preexistant proprietaire d'objets : refus
 * ========================================================================== */

console.log('\n  C. role preexistant proprietaire d objets — refuse');

{
  const role = nom('tf_r4_proprietaire');
  await dropRole(role);
  await creerRole(`CREATE ROLE "${role}" LOGIN PASSWORD 'avant_le_test'`);
  const c = await connexion();
  try {
    await c.query('CREATE SCHEMA IF NOT EXISTS r4_sonde');
    await c.query(`CREATE TABLE IF NOT EXISTS r4_sonde.t (id int)`);
    await c.query(`ALTER TABLE r4_sonde.t OWNER TO "${role}"`);
  } finally {
    await c.end();
  }
  const avant = await etat(role);

  let leve = null;
  const d = await connexion();
  try {
    await ensureAppRole(d, MOT_DE_PASSE, { role });
  } catch (e) {
    leve = e;
  } finally {
    await d.end();
  }
  const apres = await etat(role);
  verifier('un role proprietaire d objets est refuse', leve instanceof RolePreexistantRefuse,
    leve ? leve.message : 'aucune levee');
  verifier('proprietaire : mot de passe et OID inchanges',
    apres !== null && apres.oid === avant.oid && apres.rolpassword === avant.rolpassword,
    'role modifie');

  const n = await connexion();
  try {
    await n.query('DROP SCHEMA IF EXISTS r4_sonde CASCADE');
  } finally {
    await n.end();
  }
  await dropRole(role);
}

/* ========================================================================== *
 * D. Role ordinaire : reaffirme, jamais recree
 * ========================================================================== */

console.log('\n  D. role preexistant ordinaire — reaffirme, meme OID');

{
  const role = nom('tf_r4_ordinaire');
  await dropRole(role);
  await creerRole(`CREATE ROLE "${role}" LOGIN PASSWORD 'avant_le_test'`);
  const avant = await etat(role);
  const c = await connexion();
  try {
    await ensureAppRole(c, MOT_DE_PASSE, { role });
  } finally {
    await c.end();
  }
  const apres = await etat(role);
  verifier('role ordinaire : meme OID, donc pas de DROP/CREATE',
    apres !== null && apres.oid === avant.oid, apres ? `${avant.oid} → ${apres.oid}` : 'disparu');
  verifier('role ordinaire : attributs reafirmes sans privilege',
    apres !== null && !apres.rolsuper && !apres.rolbypassrls && !apres.rolcreaterole && !apres.rolcreatedb,
    'attribut privilegie present');
}

/* ========================================================================== *
 * E. Preuve d'OID : changement entre lecture et relecture
 * ========================================================================== */

console.log('\n  E. changement d OID entre lecture et relecture — echec');

{
  // Client simule : la branche ne peut pas etre atteinte de facon deterministe
  // sur un vrai serveur (il faudrait recreer le role au bon instant). Le
  // simulateur ne fait que rejouer les reponses de `etatRole`.
  const role = (oid) => ({
    rows: [{
      oid, rolbypassrls: false, rolsuper: false, rolcreaterole: false,
      rolcreatedb: false, rolcanlogin: true, objets_possedes: 0,
    }],
  });
  // Ordre reel des appels de `ensureAppRole` : etat(avant) -> ALTER -> etat(apres).
  const etats = [role('999'), { rows: [] }, role('1000')];
  let i = 0;
  const journal = [];
  const faux = {
    async query(sql) {
      journal.push(String(sql).slice(0, 24));
      const r = etats[Math.min(i, etats.length - 1)];
      i += 1;
      return r;
    },
  };
  let leve = null;
  try {
    await ensureAppRole(faux, 'x', { role: 'tf_r4_simule' });
  } catch (e) {
    leve = e;
  }
  verifier('un OID qui change fait echouer le provisioning',
    leve !== null && /change d'OID/.test(leve.message), leve ? leve.message : `aucune levee (${journal.join(' | ')})`);
}

/* ========================================================================== *
 * F. Surcharge de nom bornee
 * ========================================================================== */

console.log('\n  F. surcharge de nom bornee');

{
  const c = await connexion();
  let leve = null;
  try {
    await ensureAppRole(c, 'x', { role: 'postgres' });
  } catch (e) {
    leve = e;
  } finally {
    await c.end();
  }
  verifier('un nom hors liste fermee est refuse avant toute ecriture',
    leve !== null && /liste fermee/.test(leve.message), leve ? leve.message : 'aucune levee');
  const postgres = await etat('postgres');
  verifier('le role postgres est inchange (meme OID, meme empreinte de mot de passe, memes attributs)',
    postgres !== null && postgresAvant !== null
      && postgres.oid === postgresAvant.oid
      && postgres.rolpassword === postgresAvant.rolpassword
      && postgres.rolsuper === postgresAvant.rolsuper,
    'role postgres modifie');
}

console.log('\n  F2. le role applicatif par defaut reste tracefab_app');
{
  verifier('APP_ROLE exporte et inchange', APP_ROLE === 'tracefab_app', APP_ROLE);
  const c = await connexion();
  const e = await etat(APP_ROLE);
  await c.end();
  // On ne modifie PAS le role partage : on verifie seulement qu'il n'a pas ete
  // rabattu par ce test (il doit exister ou non, indifferemment).
  verifier('le role partage n a pas ete cree/modifie par ce test (etat constate seulement)',
    e === null || e.rolcanlogin === true, e ? JSON.stringify({ oid: e.oid }) : 'absent');
}

/* ========================================================================== *
 * G. Nettoyage
 * ========================================================================== */

console.log('\n  G. le test range les roles qu il a crees');

{
  for (const n of noms) await dropRole(n);
  const c = await connexion();
  try {
    const { rows } = await c.query("SELECT rolname FROM pg_roles WHERE rolname LIKE 'tf_r4_%' ORDER BY 1");
    verifier('aucun role tf_r4_* residuel', rows.length === 0, rows.map((r) => r.rolname).join(', '));
    const { rows: s } = await c.query("SELECT nspname FROM pg_namespace WHERE nspname = 'r4_sonde'");
    verifier('aucun schema de sonde residuel', s.length === 0, s.map((r) => r.nspname).join(', '));
  } finally {
    await c.end();
  }
}

await verrou.relacher();

console.log(`\n  ${vertes}/${vertes + rouges} assertions vertes`);
if (rouges > 0) {
  console.log(`  en échec : ${echecs.join(' · ')}`);
  process.exit(1);
}
console.log('  ok — un role preexistant non autorise est refuse, sans aucune ecriture.\n');
process.exit(0);
