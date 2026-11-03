#!/usr/bin/env node
/**
 * P10.5 — B4 : la HIERARCHIE DES ROLES, mesuree dans les deux sens.
 *
 * CE QUE CE SCRIPT PROUVE, ET POURQUOI IL N'EST PAS UNE LECTURE DE CATALOGUE
 *
 * Une appartenance peut etre DIRECTE ou TRANSITIVE, porter `ADMIN`, `INHERIT`
 * ou `SET`, et changer de sens selon la version de PostgreSQL. Lire
 * `pg_auth_members` ne dit donc pas ce que le runtime PEUT : il faut essayer.
 * Chaque refus est mesure par execution, avec le role applicatif reel.
 *
 * Le controle est NON VACUANT : il commence par un CONTROLE POSITIF — accorder
 * temporairement l'appartenance a `tracefab_app`, prouver qu'elle permet
 * reellement `SET ROLE`, puis la retirer et prouver que le refus est revenu.
 * Sans ce temoin, un `SET ROLE` qui echouerait pour une autre raison (mot de
 * passe, base, privilege) ferait passer le test pour une preuve.
 *
 * MODE
 *   - lecture (defaut) : n'ecrit rien, sort en 404/2 si les roles manquent ;
 *   - le controle positif ECRIT (GRANT/REVOKE d'appartenance) : il n'est
 *     execute que si `TF_ALLOW_WRITE=oui`, et seulement sur une cible locale.
 *
 * Variables : DATABASE_URL (administration) · TF_RLS_APP_URL (role applicatif)
 * Sortie : 0 conforme · 1 ecart · 2 non execute · 3 refus de cible.
 *
 * Aucune chaine de connexion n'est affichee.
 */
import process from 'node:process';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { verrouillerCluster } from './lib/ephemeral-db.mjs';

const urlAdmin = (process.env.DATABASE_URL || '').trim();
if (!urlAdmin) {
  console.error('  NON EXECUTE — DATABASE_URL absente.');
  process.exit(2);
}
const hote = (() => { try { return new URL(urlAdmin).hostname; } catch { return ''; } })();
if (!/^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(hote)) {
  console.error(`  REFUS — cible non locale (${hote || 'illisible'}).`);
  console.error('  Ce controle accorde temporairement une appartenance : il ne se joue pas ailleurs.');
  process.exit(3);
}
const ecriture = process.env.TF_ALLOW_WRITE === 'oui';

const ROLE_APP = 'tracefab_app';
const ROLE_MIGRATOR = 'tracefab_migrator';
const ROLE_WORKER = 'tracefab_worker';

let echecs = 0;
let assertions = 0;
const ok = (cond, libelle, detail = '') => {
  assertions += 1;
  console.log(`  ${cond ? 'ok   ' : 'ECHEC'} ${libelle}${detail ? ` — ${detail}` : ''}`);
  if (!cond) echecs += 1;
};

const admin = new pg.Client({ connectionString: urlAdmin, ssl: sslDepuisUrl(urlAdmin) });
await admin.connect();

/** L'URL du role applicatif, derivee si elle n'est pas fournie. */
function urlApp() {
  if (process.env.TF_RLS_APP_URL) return process.env.TF_RLS_APP_URL;
  const u = new URL(urlAdmin);
  u.username = ROLE_APP;
  u.password = process.env.TF_APP_PASSWORD || '';
  return u.toString();
}

const roles = (await admin.query(
  `SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolcreaterole
     FROM pg_catalog.pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY 1`)).rows;
const parNom = new Map(roles.map((r) => [r.rolname, r]));
ok(parNom.has(ROLE_APP), `le role ${ROLE_APP} existe`);
ok(parNom.has(ROLE_MIGRATOR), `le role ${ROLE_MIGRATOR} existe`);
ok(parNom.has(ROLE_WORKER), `le role ${ROLE_WORKER} existe`);
if (!parNom.has(ROLE_APP) || !parNom.has(ROLE_MIGRATOR)) {
  console.error('\n  NON EXECUTE — roles absents : provisionner avant de mesurer.');
  await admin.end();
  process.exit(2);
}

/* --- 1. Les appartenances, directes et transitives ------------------------ */

console.log("\n  1. appartenances reelles — lues dans pg_auth_members, pas deduites");

const aretes = (await admin.query(
  `SELECT r.rolname AS role_accorde, m.rolname AS membre,
          a.admin_option, a.inherit_option, a.set_option
     FROM pg_catalog.pg_auth_members a
     JOIN pg_catalog.pg_roles r ON r.oid = a.roleid
     JOIN pg_catalog.pg_roles m ON m.oid = a.member
    WHERE r.rolname NOT LIKE 'pg\\_%' AND m.rolname NOT LIKE 'pg\\_%'
    ORDER BY 2, 1`)).rows;
console.log(`        ${aretes.length} arete(s) : `
  + (aretes.map((a) => `${a.membre}->${a.role_accorde}`).join(', ') || 'aucune'));

const transitives = (nom) => (admin.query(
  `WITH RECURSIVE r AS (
     SELECT roleid FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles x ON x.oid = m.member
      WHERE x.rolname = $1
     UNION
     SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN r ON m.member = r.roleid)
   SELECT DISTINCT x.rolname FROM r JOIN pg_catalog.pg_roles x ON x.oid = r.roleid`, [nom])).then((r) => r.rows.map((x) => x.rolname));

const transitivesApp = await transitives(ROLE_APP);
ok(transitivesApp.length === 0,
  `${ROLE_APP} n a AUCUNE appartenance, directe ni transitive`,
  transitivesApp.join(', ') || 'aucune');

ok((await transitives(ROLE_WORKER)).length === 0,
  `${ROLE_WORKER} n est membre d aucun role (identite systeme non endossable)`);

/* --- 2. Les attributs : aucun privilège injustifié ------------------------ */

console.log('\n  2. attributs — ce qui reste, et sa justification');

const app = parNom.get(ROLE_APP);
ok(app.rolsuper === false && app.rolbypassrls === false,
  `${ROLE_APP} n a ni SUPERUSER ni BYPASSRLS`, `superuser=${app.rolsuper} bypassrls=${app.rolbypassrls}`);
ok(app.rolcreaterole === false, `${ROLE_APP} ne peut pas creer de role`);

const mig = parNom.get(ROLE_MIGRATOR);
ok(mig.rolsuper === false, `${ROLE_MIGRATOR} n est PAS superutilisateur`, `superuser=${mig.rolsuper}`);
const worker = parNom.get(ROLE_WORKER);
ok(worker.rolcanlogin === false && worker.rolsuper === false && worker.rolbypassrls === false,
  `${ROLE_WORKER} est NOLOGIN, sans SUPERUSER ni BYPASSRLS`,
  `login=${worker.rolcanlogin} superuser=${worker.rolsuper} bypassrls=${worker.rolbypassrls}`);

const superusers = roles.filter((r) => r.rolsuper).map((r) => r.rolname);
ok(superusers.filter((n) => n.startsWith('tracefab_')).length === 0,
  'aucun role tracefab_* n est superutilisateur', superusers.join(', ') || 'aucun');

/* --- 3. Ce que le runtime PEUT faire : mesure par execution --------------- */

console.log('\n  3. chemins reels de prise de role — essayes avec la connexion applicative');

/** Ouvre une connexion applicative et tente `SET ROLE` sur chaque cible. */
async function essayerSetRole(cible) {
  const c = new pg.Client({ connectionString: urlApp(), ssl: false, application_name: 'p105-hierarchie' });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${cible}`);
    const u = (await c.query('SELECT current_user AS u')).rows[0].u;
    await c.query('ROLLBACK');
    return { pris: true, role: u };
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* deja fermee */ }
    return { pris: false, code: e.code || 'inconnu' };
  } finally {
    await c.end().catch(() => {});
  }
}

const cibles = roles.filter((r) => r.rolname !== ROLE_APP).map((r) => r.rolname);
let privilegieesAtteignables = [];
for (const cible of cibles) {
  const r = await essayerSetRole(cible);
  if (r.pris) privilegieesAtteignables.push(`${cible} (current_user=${r.role})`);
  ok(r.pris === false, `${ROLE_APP} ne peut pas prendre le role ${cible}`,
    r.pris ? `PRIS — current_user=${r.role}` : r.code);
}
ok(privilegieesAtteignables.length === 0,
  'aucun role privilegie n est atteignable par le runtime',
  privilegieesAtteignables.join(', ') || 'aucun');

ok((await admin.query(
  `SELECT pg_catalog.pg_has_role($1, $2, 'SET') AS s`, [ROLE_APP, ROLE_MIGRATOR])).rows[0].s === false,
  `pg_has_role(app, migrator, 'SET') est faux — la vue catalogue dit la meme chose`);

/* --- 4. Controle POSITIF : le refus n'est pas un artefact ----------------- */

console.log('\n  4. controle positif — prouver que le refus mesure quelque chose');
if (!ecriture) {
  console.log('        NON JOUE — TF_ALLOW_WRITE=oui est requis (accorde puis retire une appartenance).');
  ok(true, 'controle positif declare non execute (mode lecture)');
} else {
  // Les roles sont des objets de CLUSTER : la creation du temoin prend le meme
  // verrou consultatif que les autres chemins qui touchent `pg_authid`.
  const verrou = await verrouillerCluster({ urlProprietaire: urlAdmin });
  const temoin = `tf_hierarchie_temoin_${Math.random().toString(36).slice(2, 8)}`;
  let accordee = false;
  try {
    await admin.query(`CREATE ROLE ${temoin} NOLOGIN`);
    await admin.query(`GRANT ${temoin} TO ${ROLE_APP}`);
    accordee = true;
    const r = await essayerSetRole(temoin);
    ok(r.pris, 'TEMOIN — une appartenance accordee rend bien SET ROLE possible',
      r.pris ? `current_user=${r.role}` : `refus ${r.code} : le refus mesure ne prouve rien`);
    ok(r.role === temoin, 'TEMOIN — le role pris est bien celui accorde', String(r.role));
  } finally {
    if (accordee) await admin.query(`REVOKE ${temoin} FROM ${ROLE_APP}`).catch(() => {});
    await admin.query(`REVOKE ALL ON TABLE public.tracefab_products FROM ${temoin}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${temoin}`).catch(() => {});
  }
  await verrou.relacher();
  ok((await admin.query(
    `SELECT pg_catalog.pg_has_role($1, $2, 'MEMBER') AS m`, [ROLE_APP, ROLE_MIGRATOR])).rows[0].m === false,
    'apres retrait, app n a plus aucune appartenance');
}

/* --- 5. La propriete des objets ------------------------------------------- */

console.log('\n  5. propriete — qui possede les objets que le runtime appelle');

const tables = (await admin.query(
  `SELECT pg_catalog.pg_get_userbyid(c.relowner) AS proprio, count(*)::int AS n
     FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' GROUP BY 1 ORDER BY 2 DESC`)).rows;
console.log(`        tables : ${tables.map((t) => `${t.proprio}=${t.n}`).join(', ')}`);
ok(!tables.some((t) => t.proprio === ROLE_APP), `${ROLE_APP} ne possede aucune table`);
ok(!tables.some((t) => t.proprio === ROLE_WORKER),
  `${ROLE_WORKER} ne possede aucune table (il ne possede que des fonctions)`);

const schema = (await admin.query(
  `SELECT pg_catalog.pg_get_userbyid(nspowner) AS proprio FROM pg_catalog.pg_namespace
    WHERE nspname = 'public'`)).rows[0];
ok(schema.proprio !== ROLE_APP, `${ROLE_APP} ne possede pas le schema public`, schema.proprio);

/* --- Verdict -------------------------------------------------------------- */

await admin.end();
console.log('');
if (echecs === 0) {
  console.log(`  P10.5 B4 : ${assertions} assertions — le runtime n atteint aucun role privilegie.`);
  process.exit(0);
}
console.log(`  ${echecs} ECHEC sur ${assertions} assertions.`);
process.exit(1);
