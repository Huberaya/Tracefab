#!/usr/bin/env node
/**
 * P10.6/P11 — REJOUABILITÉ ET APPARTENANCE WORKER NEON.
 *
 * Les migrations n'exigent plus de SUPERUSER temporaire ni de runner privilégié :
 * elles accordent SET/INHERIT à current_user dans leur transaction lorsqu'il le
 * faut, puis révoquent uniquement le grant qu'elles ont créé. Les grants du
 * runner historique restent compatibles et sont nettoyés par celui-ci.
 *
 * R1 aucune migration ne demande d'élévation SUPERUSER ;
 * R2 un rôle CREATEROLE non-SUPERUSER accorde SET TRUE, endosse le rôle worker,
 *    transfère une fonction, puis révoque son appartenance ;
 * R3 la chaîne complète s'applique sur une base vierge d'un cluster déjà migré ;
 * R4 aucune appartenance directe permanente à tracefab_worker ne subsiste ;
 * R5 tracefab_app ne reçoit aucune appartenance et aucun rôle runtime n'est
 *    SUPERUSER ni BYPASSRLS ;
 * R6 le préflight de propriété ne bloque pas le propriétaire légitime.
 *
 * Sortie : 0 conforme · 1 régression · 2 non exécuté · 3 refus de cible.
 */
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { verrouillerCluster } from './lib/ephemeral-db.mjs';
import { MIGRATIONS_ASSISTEES, exigeAssistance } from './lib/migrations_assistees.mjs';
import { fonctionsCibles, propriétairesInjoignables } from './lib/preflight_proprietaires.mjs';

const urlAdmin = (process.env.DATABASE_URL || '').trim();
if (!urlAdmin) {
  console.error('  NON EXECUTE — DATABASE_URL est requise.');
  process.exit(2);
}
const hote = (() => { try { return new URL(urlAdmin).hostname; } catch { return ''; } })();
if (!/^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(hote)) {
  console.error(`  REFUS — cible non locale (${hote || 'illisible'}).`);
  process.exit(3);
}
const url = new URL(urlAdmin);
const roleExecutant = decodeURIComponent(url.username) || 'postgres';

let echecs = 0;
let assertions = 0;
const ok = (cond, libelle, detail = '') => {
  assertions += 1;
  console.log(`  ${cond ? 'ok   ' : 'ECHEC'} ${libelle}${detail ? ` — ${detail}` : ''}`);
  if (!cond) echecs += 1;
};

// ---------------------------------------------------------------------------
// R1/R2 — aucun SUPERUSER temporaire ; test réel du modèle Neon CREATEROLE
// ---------------------------------------------------------------------------
console.log('  -- appartenance worker Neon, sans SUPERUSER');

ok(Object.keys(MIGRATIONS_ASSISTEES).length === 0,
  'R1 aucune migration ne demande une assistance SUPERUSER');
ok(exigeAssistance('20261028120100_worker_identity_not_forgeable') === false,
  'R1 le bootstrap worker ne déclenche aucune élévation externe');

const migration201 = readFileSync(
  'prisma/migrations/20261028120100_worker_identity_not_forgeable/migration.sql',
  'utf8'
);
ok(/WITH SET TRUE, INHERIT TRUE, ADMIN FALSE/.test(migration201),
  'R1 le bootstrap accorde une appartenance SET/INHERIT temporaire sans ADMIN');
ok(!/ALTER ROLE tracefab_worker[\\s\\S]{0,240}NOSUPERUSER/i.test(migration201),
  'R1 aucune ALTER ROLE NOSUPERUSER qui exige un superutilisateur');
ok(/REVOKE tracefab_worker FROM/.test(migration201),
  'R1 le bootstrap révoque son appartenance temporaire');

const admin = new pg.Client({ connectionString: urlAdmin, ssl: sslDepuisUrl(urlAdmin), application_name: 'tracefab-p106-rejouable' });
await admin.connect();

{
  const adminRole = `tf_neon_admin_${randomBytes(3).toString('hex')}`;
  const workerRole = `tf_neon_worker_${randomBytes(3).toString('hex')}`;
  const fn = `tf_neon_owner_${randomBytes(3).toString('hex')}`;
  let tx = false;
  try {
    await admin.query('BEGIN');
    tx = true;
    const isSuper = (await admin.query('SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user')).rows[0]?.rolsuper;
    if (!isSuper) throw new Error('le banc de test local doit être administré par postgres');
    await admin.query(`CREATE ROLE ${adminRole} NOLOGIN CREATEROLE NOCREATEDB NOBYPASSRLS NOSUPERUSER NOINHERIT`);
    await admin.query(`GRANT CREATE ON SCHEMA public TO ${adminRole}`);
    await admin.query(`SET ROLE ${adminRole}`);
    await admin.query(`CREATE ROLE ${workerRole} NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB`);
    await admin.query(`GRANT ${workerRole} TO ${adminRole} WITH SET TRUE, INHERIT TRUE, ADMIN FALSE`);
    const membership = (await admin.query(
      `SELECT pg_catalog.pg_has_role($1,$2,'SET') AS can_set,
              pg_catalog.pg_has_role($1,$2,'MEMBER') AS member`,
      [adminRole, workerRole]
    )).rows[0];
    ok(membership.can_set && membership.member,
      'R2 CREATEROLE accorde SET TRUE/INHERIT TRUE sans ADMIN');
    await admin.query(`GRANT CREATE ON SCHEMA public TO ${workerRole}`);
    await admin.query(`CREATE FUNCTION public.${fn}() RETURNS integer LANGUAGE sql AS 'SELECT 1'`);
    await admin.query(`ALTER FUNCTION public.${fn}() OWNER TO ${workerRole}`);
    const owner = (await admin.query(
      `SELECT pg_catalog.pg_get_userbyid(proowner) AS owner FROM pg_catalog.pg_proc WHERE oid=$1::regprocedure`,
      [`public.${fn}()`]
    )).rows[0]?.owner;
    ok(owner === workerRole,
      'R2 SET ROLE autorise le transfert de propriété sans SUPERUSER', owner || 'propriétaire absent');
    await admin.query(`REVOKE CREATE ON SCHEMA public FROM ${workerRole}`);
    await admin.query(`REVOKE ${workerRole} FROM ${adminRole}`);
    const after = (await admin.query(
      `SELECT pg_catalog.pg_has_role($1,$2,'MEMBER') AS member`,
      [adminRole, workerRole]
    )).rows[0].member;
    ok(after === false, 'R2 l'appartenance temporaire est révoquée avant COMMIT');
    await admin.query('RESET ROLE');
    await admin.query('ROLLBACK');
    tx = false;
  } catch (e) {
    ok(false, 'R2 le modèle CREATEROLE Neon fonctionne sans SUPERUSER', (e.message || '').slice(0,100));
  } finally {
    if (tx) await admin.query('ROLLBACK').catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// R8 — préflight de PROPRIÉTÉ des fonctions visées (défaut D6, mesuré)
//
// `CREATE OR REPLACE FUNCTION` exige d'être le propriétaire. Une chaîne jouée
// par le rôle de migration ne peut donc remplacer que les fonctions qu'il a
// créées ; sur une base où elles appartiennent à un autre rôle, l'échec
// tomberait au MILIEU de la chaîne. Le préflight doit refuser AVANT, sur la
// seule foi du catalogue — et ne rien refuser quand l'exécutant est le
// propriétaire.
// ---------------------------------------------------------------------------
console.log('  -- préflight de propriété des fonctions');
{
  const sql = `CREATE OR REPLACE FUNCTION public.tracefab_current_user_id() RETURNS uuid
               LANGUAGE sql AS 'SELECT NULL::uuid';
               CREATE OR REPLACE FUNCTION public.tracefab_fonction_a_venir() RETURNS int
               LANGUAGE sql AS 'SELECT 1';`;
  const cibles = fonctionsCibles(sql);
  ok(cibles.length === 2 && cibles[0] === 'tracefab_current_user_id',
    'R8 les fonctions visées sont lues dans le fichier de migration', cibles.join(', '));

  const pourAdmin = await propriétairesInjoignables(
    admin, roleExecutant, [{ nom: 'sonde', sql }],
  );
  ok(pourAdmin.length === 0,
    'R8 le propriétaire des fonctions n est pas bloqué (aucun faux refus)',
    pourAdmin.map((e) => e.fonction).join(', ') || 'aucun écart');

  const pourMigrator = await propriétairesInjoignables(
    admin, 'tracefab_migrator', [{ nom: 'sonde', sql }],
  );
  const attendu = pourMigrator.some((e) => e.fonction === 'tracefab_current_user_id' && e.proprietaire === 'postgres');
  ok(attendu,
    'R8 un exécutant qui ne peut pas endosser le propriétaire est REFUSÉ avant la chaîne',
    pourMigrator.map((e) => `${e.fonction}→${e.proprietaire}`).join(', ') || 'aucun écart');
  ok(!pourMigrator.some((e) => e.fonction === 'tracefab_fonction_a_venir'),
    'R8 une fonction qui n existe pas encore n est pas un écart (création légitime)',
    pourMigrator.map((e) => e.fonction).join(', '));

  ok(Object.keys(MIGRATIONS_ASSISTEES).length === 0,
    'R6 le préflight de propriété ne dépend d aucune élévation assistée');
}

// ---------------------------------------------------------------------------
// R6/R7 — la chaîne complète, sur une base VIERGE du même cluster
// ---------------------------------------------------------------------------
console.log('  -- chaîne complète sur une base vierge du même cluster');
const baseTravail = `tracefab_p106_rejouable_${randomBytes(3).toString('hex')}`;
const urlBase = new URL(urlAdmin);
urlBase.pathname = `/${baseTravail}`;

// Cette suite provisionne un rôle sur un cluster PARTAGÉ avec les autres
// suites : elle prend donc le verrou de cluster autour du provisioning, comme
// `test_p105_roles_et_migrations.mjs`. Le verrou est RELÂCHÉ avant d'appeler
// `migrer_fidelement.mjs`, qui prend le sien : un verrou consultatif n'est pas
// réentrant, et le garder ici ferait attendre la chaîne jusqu'au délai
// (mesuré : 600 s, aucune sortie).
let verrou = null;
try {
  await admin.query(`CREATE DATABASE ${baseTravail}`);
  ok(true, 'R6 base de travail créée', baseTravail);

  // Le rôle applicatif est un objet de CLUSTER : il préexiste ici, ce qui est
  // exactement la situation d'une seconde base jetable.
  let bootstrap;
  try {
    verrou = await verrouillerCluster({ urlProprietaire: urlAdmin });
    bootstrap = spawnSync(process.execPath, ['scripts/bootstrap_app_role.mjs'], {
      env: { ...process.env, DATABASE_URL: urlBase.toString(), TF_APP_PASSWORD: process.env.TF_APP_PASSWORD || 'p106_jetable' },
      encoding: 'utf8',
    });
  } finally {
    if (verrou) { await verrou.relacher(); verrou = null; }
  }
  ok(bootstrap.status === 0, 'R6 rôle applicatif disponible avant la chaîne',
    (bootstrap.stderr || bootstrap.stdout || '').trim().split('\n').pop() || `code ${bootstrap.status}`);

  const chaine = spawnSync(process.execPath, ['scripts/migrer_fidelement.mjs'], {
    env: { ...process.env, DATABASE_URL: urlBase.toString(), TF_ALLOW_WRITE: 'oui' },
    encoding: 'utf8',
  });
  const sortie = `${chaine.stdout || ''}${chaine.stderr || ''}`.trim().split('\n');
  ok(chaine.status === 0, 'R6 la chaîne s applique sur une base neuve d un cluster déjà migré (défaut D5)',
    chaine.status === 0 ? sortie.filter((l) => /appliquee\(s\)/.test(l)).pop() : sortie.filter((l) => /ECHEC/.test(l)).slice(-1)[0]);

  const client = new pg.Client({ connectionString: urlBase.toString(), ssl: sslDepuisUrl(urlBase.toString()) });
  await client.connect();
  try {
    const appliquees = (await client.query(
      'SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL')).rows[0].n;
    ok(appliquees >= 60, 'R6 toutes les migrations sont appliquées', `${appliquees} migration(s)`);

    const membres = (await client.query(
      `SELECT r.rolname FROM pg_catalog.pg_auth_members m
         JOIN pg_catalog.pg_roles r ON r.oid = m.member
         JOIN pg_catalog.pg_roles c ON c.oid = m.roleid
        WHERE c.rolname = 'tracefab_worker' ORDER BY 1`)).rows.map((r) => r.rolname);
    ok(membres.length === 0,
      'R7 aucune appartenance directe permanente à tracefab_worker après la chaîne',
      membres.join(', ') || 'aucun');

    const appMembre = (await client.query(
      `SELECT count(*)::int AS n FROM pg_catalog.pg_auth_members m
         JOIN pg_catalog.pg_roles r ON r.oid = m.member
        WHERE r.rolname = 'tracefab_app'`)).rows[0].n;
    ok(appMembre === 0, 'R7 tracefab_app n hérite d aucune appartenance', `${appMembre} appartenance(s)`);

    const attributs = (await client.query(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_catalog.pg_roles
        WHERE rolname IN ('tracefab_app', 'tracefab_worker') ORDER BY 1`)).rows;
    ok(attributs.length === 2 && attributs.every((r) => !r.rolsuper && !r.rolbypassrls),
      'R7 aucun rôle runtime n est SUPERUSER ni BYPASSRLS',
      attributs.map((r) => `${r.rolname}:${r.rolsuper ? 'SUPER' : 'ok'}/${r.rolbypassrls ? 'BYPASS' : 'ok'}`).join(' '));
  } finally {
    await client.end();
  }
} catch (e) {
  ok(false, 'R6 la chaîne a pu être mesurée', (e.message || '').split('\n')[0].slice(0, 80));
} finally {
  // R7 — la base de travail disparaît, quoi qu'il arrive.
  const destruction = await admin.query(
    `SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity
      WHERE datname = $1 AND pid <> pg_catalog.pg_backend_pid()`, [baseTravail]).catch(() => ({ rows: [] }));
  void destruction;
  await admin.query(`DROP DATABASE IF EXISTS ${baseTravail} WITH (FORCE)`).catch((e) => {
    console.error(`  info  destruction de ${baseTravail} : ${e.message}`);
  });
  const restantes = (await admin.query(
    'SELECT count(*)::int AS n FROM pg_database WHERE datname = $1', [baseTravail])).rows[0].n;
  ok(restantes === 0, 'R7 la base de travail est détruite (aucune base résiduelle)', `${restantes} restante(s)`);
  if (verrou) await verrou.relacher();
}

await admin.end();

console.log('');
if (echecs === 0) {
  console.log(`  P10.6 rejouabilite de la chaine : ${assertions} assertions — rejouable dans un meme cluster.`);
  process.exit(0);
}
console.log(`  ${echecs} ÉCHEC sur ${assertions} assertions.`);
process.exit(1);
