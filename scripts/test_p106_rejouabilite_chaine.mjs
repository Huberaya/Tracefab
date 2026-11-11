#!/usr/bin/env node
/**
 * P10.6/P11 — REJOUABILITÉ ET APPARTENANCE WORKER NEON.
 *
 * Le SQL des migrations n'introduit aucun SUPERUSER et révoque ses grants.
 * Le SQL et le runner n'introduisent aucun SUPERUSER.
 * Le migrateur CREATEROLE crée tracefab_worker, s'accorde le bail technique
 * dans la migration de bootstrap puis le révoque lui-même. Les migrations
 * ultérieures reçoivent un bail transactionnel du runner administratif.
 *
 * R1 aucun chemin ne rend le migrateur SUPERUSER ni ne demande d'élévation ;
 * R2 le migrateur délègue ADMIN-only au runner ; l'admin accorde ensuite
 *    SET/INHERIT temporaire au migrateur. Le runner révoque les deux baux
 *    administratifs et SET/INHERIT ; le migrateur conserve ADMIN-only.
 * R3 la chaîne complète s'applique sur une base vierge d'un cluster déjà migré ;
 * R4 aucun droit SET/USAGE ni grant INHERIT actif vers tracefab_worker ne subsiste ;
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
// R1/R2 — SQL sans élévation ; assistance du runner de rehearsal bornée
// ---------------------------------------------------------------------------
console.log('  -- appartenance worker Neon, SQL sans SUPERUSER');

const bootstrap = '20261028120100_worker_identity_not_forgeable';
ok(Object.keys(MIGRATIONS_ASSISTEES).length === 0 &&
   exigeAssistance(bootstrap) === false,
  'R1 le bootstrap ne requiert aucune assistance SUPERUSER');

const migration201 = readFileSync(
  'prisma/migrations/20261028120100_worker_identity_not_forgeable/migration.sql',
  'utf8'
);
ok(/WITH SET TRUE, INHERIT TRUE, ADMIN TRUE/.test(migration201),
  'R1 le migrateur conserve ADMIN-only pour déléguer au runner');
ok(!/ALTER ROLE tracefab_worker[\s\S]{0,240}NOSUPERUSER/i.test(migration201),
  'R1 aucune ALTER ROLE NOSUPERUSER qui exige un superutilisateur');
ok(/REVOKE SET OPTION FOR tracefab_worker/.test(migration201)
   && /REVOKE INHERIT OPTION FOR tracefab_worker/.test(migration201),
  'R1 le bootstrap retire SET/INHERIT tout en conservant ADMIN-only');

const admin = new pg.Client({ connectionString: urlAdmin, ssl: sslDepuisUrl(urlAdmin), application_name: 'tracefab-p106-rejouable' });
await admin.connect();

{
  const adminRole = `tf_neon_admin_${randomBytes(3).toString('hex')}`;
  const migratorRole = `tf_neon_migrator_${randomBytes(3).toString('hex')}`;
  const workerRole = `tf_neon_worker_${randomBytes(3).toString('hex')}`;
  const fn = `tf_neon_owner_${randomBytes(3).toString('hex')}`;
  const password = randomBytes(16).toString('hex');
  let operator = null;
  let adminRoleCreated = false;
  let migratorRoleCreated = false;
  try {
    // Le grantor du migrateur est le propriétaire du banc (postgres), pas
    // la session administrative : PostgreSQL interdit de rendre ADMIN à son
    // propre grantor. Cela reproduit la séparation cloud_admin / neondb_owner.
    await admin.query(`CREATE ROLE ${adminRole} LOGIN PASSWORD '${password}' CREATEROLE NOCREATEDB NOBYPASSRLS NOSUPERUSER NOINHERIT`);
    adminRoleCreated = true;
    await admin.query(`CREATE ROLE ${migratorRole} NOLOGIN CREATEROLE NOBYPASSRLS NOSUPERUSER NOCREATEDB NOINHERIT`);
    migratorRoleCreated = true;
    await admin.query(`GRANT ${migratorRole} TO ${adminRole} WITH ADMIN TRUE, SET FALSE, INHERIT FALSE`);
    await admin.query(`GRANT CREATE ON SCHEMA public TO ${adminRole} WITH GRANT OPTION`);
    await admin.query(`GRANT CREATE ON SCHEMA public TO ${migratorRole} WITH GRANT OPTION`);

    const operatorUrl = new URL(urlAdmin.toString());
    operatorUrl.username = adminRole;
    operatorUrl.password = password;
    operator = new pg.Client({
      connectionString: operatorUrl.toString(),
      ssl: sslDepuisUrl(operatorUrl.toString()),
      application_name: 'tracefab-p106-neon-createrole',
    });
    await operator.connect();
    await operator.query('BEGIN');

    const isSuper = (await operator.query(
      'SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user'
    )).rows[0]?.rolsuper;
    if (isSuper) throw new Error('le rôle CREATEROLE de test ne doit pas être SUPERUSER');

    // Reproduire les deux baux du runner Neon dans une seule transaction :
    // l'admin endosse temporairement le migrateur, qui endosse ensuite le worker.
    await operator.query(`GRANT ${migratorRole} TO ${adminRole} WITH SET TRUE, INHERIT TRUE, ADMIN FALSE`);
    const adminLease = (await operator.query(
      `SELECT pg_catalog.pg_has_role($1,$2,'SET') AS can_set,
              pg_catalog.pg_has_role($1,$2,'USAGE') AS can_use`,
      [adminRole, migratorRole]
    )).rows[0];
    ok(adminLease.can_set && adminLease.can_use,
      'R2 le runner accorde temporairement SET/INHERIT du migrateur à sa session administrative');

    await operator.query(`SET ROLE ${migratorRole}`);
    const current = (await operator.query('SELECT current_user AS u, session_user AS s')).rows[0];
    ok(current.u === migratorRole && current.s === adminRole,
      'R2 la session administrative endosse le migrateur sans SUPERUSER');

    await operator.query(`CREATE ROLE ${workerRole} NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB`);
    await operator.query(`GRANT ${workerRole} TO ${migratorRole} WITH SET TRUE, INHERIT TRUE, ADMIN TRUE`);
    await operator.query(`GRANT CREATE ON SCHEMA public TO ${workerRole}`);
    const creatorLease = (await operator.query(
      `SELECT pg_catalog.pg_has_role($1,$2,'SET') AS can_set,
              pg_catalog.pg_has_role($1,$2,'USAGE') AS can_use,
              EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
                       WHERE m.member=$1::regrole AND m.roleid=$2::regrole
                         AND m.admin_option) AS has_admin`,
      [migratorRole, workerRole]
    )).rows[0];
    ok(creatorLease.can_set && creatorLease.can_use && creatorLease.has_admin,
      'R2 le migrateur NOINHERIT conserve ADMIN/SET/INHERIT sur le worker créé');

    await operator.query(`CREATE FUNCTION public.${fn}() RETURNS integer LANGUAGE sql AS 'SELECT 1'`);
    await operator.query(`ALTER FUNCTION public.${fn}() OWNER TO ${workerRole}`);
    const owner = (await operator.query(
      `SELECT pg_catalog.pg_get_userbyid(proowner) AS owner FROM pg_catalog.pg_proc WHERE oid=$1::regprocedure`,
      [`public.${fn}()`]
    )).rows[0]?.owner;
    ok(owner === workerRole,
      'R2 le migrateur transfère une fonction au worker sans SUPERUSER', owner || 'propriétaire absent');

    // Comme le bootstrap, le migrateur retire SET/INHERIT mais garde ADMIN.
    await operator.query(`REVOKE SET OPTION FOR ${workerRole} FROM ${migratorRole}`);
    await operator.query(`REVOKE INHERIT OPTION FOR ${workerRole} FROM ${migratorRole}`);
    const migratorBootstrap = (await operator.query(
      `SELECT pg_catalog.pg_has_role($1,$2,'SET') AS can_set,
              pg_catalog.pg_has_role($1,$2,'USAGE') AS can_use,
              EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
                       WHERE m.member=$1::regrole AND m.roleid=$2::regrole
                         AND m.admin_option) AS has_admin`,
      [migratorRole, workerRole]
    )).rows[0];
    ok(migratorBootstrap.can_set === false && migratorBootstrap.can_use === false
      && migratorBootstrap.has_admin === true,
      'R2 le migrateur ne conserve que ADMIN après le bootstrap');

    // Le migrateur délègue ADMIN-only à la session administrative ; celle-ci
    // peut alors accorder SET/INHERIT au migrateur pour la migration suivante.
    await operator.query(`GRANT ${workerRole} TO ${adminRole} WITH ADMIN TRUE, SET FALSE, INHERIT FALSE`);
    const adminWorkerAdmin = (await operator.query(
      `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
                       WHERE m.member=$1::regrole AND m.roleid=$2::regrole
                         AND m.admin_option AND NOT m.set_option AND NOT m.inherit_option) AS has_admin`,
      [adminRole, workerRole]
    )).rows[0].has_admin;
    ok(adminWorkerAdmin,
      'R2 la session administrative reçoit ADMIN-only, sans SET ni INHERIT');

    await operator.query('RESET ROLE');
    await operator.query(`GRANT ${workerRole} TO ${migratorRole} WITH SET TRUE, INHERIT TRUE, ADMIN FALSE`);
    const membership = (await operator.query(
      `SELECT pg_catalog.pg_has_role($1,$2,'SET') AS can_set,
              pg_catalog.pg_has_role($1,$2,'USAGE') AS can_use`,
      [migratorRole, workerRole]
    )).rows[0];
    ok(membership.can_set && membership.can_use,
      'R2 l admin accorde le bail SET/INHERIT au migrateur grâce à ADMIN-only');

    await operator.query(`SET ROLE ${migratorRole}`);
    const session = (await operator.query('SELECT current_user AS u, session_user AS s')).rows[0];
    ok(session.u === migratorRole && session.s === adminRole,
      'R2 le migrateur reprend son identité pendant la migration');

    await operator.query('RESET ROLE');
    await operator.query(`REVOKE ${workerRole} FROM ${migratorRole}`);
    await operator.query(`REVOKE ${workerRole} FROM ${adminRole}`);
    await operator.query(`REVOKE ${migratorRole} FROM ${adminRole}`);

    const workerAfterRows = (await operator.query(
      `SELECT admin_option, inherit_option, set_option
         FROM pg_catalog.pg_auth_members
        WHERE member=$1::regrole AND roleid=$2::regrole`,
      [migratorRole, workerRole]
    )).rows;
    const workerAfter = (await operator.query(
      `SELECT pg_catalog.pg_has_role($1,$2,'SET') AS can_set,
              pg_catalog.pg_has_role($1,$2,'USAGE') AS can_use`,
      [migratorRole, workerRole]
    )).rows[0];
    const workerEffective = workerAfterRows.filter((r) => r.set_option || r.inherit_option);
    const migratorAdminOnly = workerAfterRows.some((r) => r.admin_option && !r.set_option && !r.inherit_option);
    ok(workerAfter.can_set === false && workerAfter.can_use === false
      && workerEffective.length === 0 && migratorAdminOnly,
      'R2 après nettoyage, le migrateur ne garde que ADMIN-only sur le worker',
      `SET=${workerAfter.can_set} · USAGE=${workerAfter.can_use} · ADMIN-only=${migratorAdminOnly}`);

    const adminWorkerRows = (await operator.query(
      `SELECT admin_option, inherit_option, set_option
         FROM pg_catalog.pg_auth_members
        WHERE member=$1::regrole AND roleid=$2::regrole`,
      [adminRole, workerRole]
    )).rows;
    ok(adminWorkerRows.length === 0,
      'R2 le bail ADMIN-only de la session administrative est révoqué');

    const migratorAfterRows = (await operator.query(
      `SELECT admin_option, inherit_option, set_option
         FROM pg_catalog.pg_auth_members
        WHERE member=$1::regrole AND roleid=$2::regrole`,
      [adminRole, migratorRole]
    )).rows;
    const migratorAfter = (await operator.query(
      `SELECT pg_catalog.pg_has_role($1,$2,'SET') AS can_set,
              pg_catalog.pg_has_role($1,$2,'USAGE') AS can_use`,
      [adminRole, migratorRole]
    )).rows[0];
    const migratorEffective = migratorAfterRows.filter((r) => r.set_option || r.inherit_option);
    ok(migratorAfter.can_set === false && migratorAfter.can_use === false && migratorEffective.length === 0,
      'R2 le bail migrateur de la session administrative est révoqué avant COMMIT',
      `SET=${migratorAfter.can_set} · USAGE=${migratorAfter.can_use} · grants effectifs=${migratorEffective.length}`);

    await operator.query('ROLLBACK');
  } catch (e) {
    ok(false, 'R2 le modèle CREATEROLE Neon fonctionne sans SUPERUSER', (e.message || '').slice(0,100));
  } finally {
    if (operator) {
      await operator.query('ROLLBACK').catch(() => {});
      await operator.end().catch(() => {});
    }
    if (migratorRoleCreated) {
      await admin.query(`REVOKE ${migratorRole} FROM ${adminRole}`).catch(() => {});
      await admin.query(`DROP OWNED BY ${migratorRole}`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${migratorRole}`).catch((e) => {
        console.error(`  info  nettoyage du rôle ${migratorRole} : ${e.message}`);
      });
    }
    if (adminRoleCreated) {
      await admin.query(`DROP OWNED BY ${adminRole}`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${adminRole}`).catch((e) => {
        console.error(`  info  nettoyage du rôle ${adminRole} : ${e.message}`);
      });
    }
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

  const assistancesHorsBootstrap = Object.keys(MIGRATIONS_ASSISTEES).filter((n) => n !== bootstrap);
  ok(assistancesHorsBootstrap.length === 0,
    'R6 aucune migration ne dépend d une assistance SUPERUSER',
    assistancesHorsBootstrap.join(', ') || 'aucune');
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
  // exactement la situation d'une seconde base jetable. La chaîne s'exécute
  // réellement sous tracefab_migrator (CREATEROLE/BYPASSRLS/NOINHERIT), tandis
  // que TF_ADMIN_URL reste l'identité administrative du banc PostgreSQL.
  let bootstrap;
  let chaine = { status: 1, stdout: '', stderr: 'bootstrap non exécuté' };
  let baseAdmin = null;
  const motDePasseMigrateur = randomBytes(32).toString('hex');
  try {
    verrou = await verrouillerCluster({ urlProprietaire: urlAdmin });
    bootstrap = spawnSync(process.execPath, ['scripts/bootstrap_app_role.mjs'], {
      env: { ...process.env, DATABASE_URL: urlBase.toString(), TF_APP_PASSWORD: process.env.TF_APP_PASSWORD || 'p106_jetable' },
      encoding: 'utf8',
    });
    ok(bootstrap.status === 0, 'R6 rôle applicatif disponible avant la chaîne',
      (bootstrap.stderr || bootstrap.stdout || '').trim().split('\n').pop() || `code ${bootstrap.status}`);

    if (bootstrap.status === 0) {
      await admin.query(`CREATE ROLE tracefab_migrator LOGIN PASSWORD '${motDePasseMigrateur}' CREATEROLE BYPASSRLS NOINHERIT NOSUPERUSER NOCREATEDB NOREPLICATION`);
      baseAdmin = new pg.Client({ connectionString: urlBase.toString(), ssl: sslDepuisUrl(urlBase.toString()) });
      await baseAdmin.connect();
      // Neon installe pgcrypto côté plateforme ; le rôle migrateur ne reçoit
      // jamais CREATE EXTENSION. On reproduit ce prérequis administratif.
      await baseAdmin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await baseAdmin.query(`GRANT CREATE ON DATABASE ${baseTravail} TO tracefab_migrator`);
      await baseAdmin.query('ALTER SCHEMA public OWNER TO tracefab_migrator');
      await baseAdmin.end();
      baseAdmin = null;
    }
  } finally {
    if (baseAdmin) await baseAdmin.end().catch(() => {});
    if (verrou) { await verrou.relacher(); verrou = null; }
  }

  if (bootstrap?.status === 0) {
    const urlMigrator = new URL(urlBase.toString());
    urlMigrator.username = 'tracefab_migrator';
    urlMigrator.password = motDePasseMigrateur;
    chaine = spawnSync(process.execPath, ['scripts/migrer_fidelement.mjs'], {
      env: {
        ...process.env,
        DATABASE_URL: urlMigrator.toString(),
        TF_ADMIN_URL: urlBase.toString(),
        TF_ALLOW_WRITE: 'oui',
      },
      encoding: 'utf8',
    });
  }
  const sortie = `${chaine.stdout || ''}${chaine.stderr || ''}`.trim().split('\n');
  ok(chaine.status === 0, 'R6 le runner applique la chaîne sous tracefab_migrator sans élévation SUPERUSER',
    chaine.status === 0 ? sortie.filter((l) => /appliquee\(s\)/.test(l)).pop() : sortie.filter((l) => /ECHEC|ERREUR|ERROR/.test(l)).slice(-1)[0] || sortie.slice(-1)[0]);

  const client = new pg.Client({ connectionString: urlBase.toString(), ssl: sslDepuisUrl(urlBase.toString()) });
  await client.connect();
  try {
    const appliquees = (await client.query(
      'SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL')).rows[0].n;
    ok(appliquees >= 90, 'R6 toutes les migrations sont appliquées par le migrateur non-superuser', `${appliquees} migration(s)`);

    const membres = (await client.query(
      `SELECT r.rolname,
              pg_catalog.pg_has_role(r.oid, c.oid, 'SET') AS peut_set,
              pg_catalog.pg_has_role(r.oid, c.oid, 'USAGE') AS peut_utiliser,
              bool_or(m.set_option OR m.inherit_option) AS grant_effectif,
              bool_or(m.admin_option) AS admin_only_possible
         FROM pg_catalog.pg_auth_members m
         JOIN pg_catalog.pg_roles r ON r.oid = m.member
         JOIN pg_catalog.pg_roles c ON c.oid = m.roleid
        WHERE c.rolname = 'tracefab_worker'
        GROUP BY r.rolname, r.oid, c.oid
        ORDER BY r.rolname`)).rows;
    const membresEffectifs = membres.filter((r) =>
      r.peut_set || r.peut_utiliser || r.grant_effectif);
    ok(membresEffectifs.length === 0,
      'R7 aucun droit SET/USAGE ni grant INHERIT actif vers tracefab_worker après la chaîne',
      membresEffectifs.map((r) => r.rolname).join(', ') ||
        `aucun (lignes ADMIN-only résiduelles tolérées : ${membres.length})`);

    const bailAdminActif = (await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM pg_catalog.pg_auth_members m
         JOIN pg_catalog.pg_roles r ON r.oid=m.member
         JOIN pg_catalog.pg_roles w ON w.oid=m.roleid
        WHERE r.rolname='postgres' AND w.rolname='tracefab_migrator'
          AND (m.set_option OR m.inherit_option)
      ) AS actif`)).rows[0].actif;
    ok(bailAdminActif === false,
      'R7 aucun bail SET/INHERIT du migrateur ne subsiste sur la session administrative');

    const attributsMigrateur = (await client.query(
      `SELECT rolsuper, rolbypassrls, rolcreaterole, rolinherit
         FROM pg_catalog.pg_roles WHERE rolname='tracefab_migrator'`)).rows[0];
    ok(!!attributsMigrateur && !attributsMigrateur.rolsuper
      && attributsMigrateur.rolbypassrls && attributsMigrateur.rolcreaterole
      && !attributsMigrateur.rolinherit,
      'R7 le migrateur reste CREATEROLE/BYPASSRLS/NOINHERIT et jamais SUPERUSER');

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
  // R7 — la base de travail et les rôles jetables disparaissent, quoi qu'il arrive.
  try {
    verrou = await verrouillerCluster({ urlProprietaire: urlAdmin });
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
    await admin.query('REVOKE tracefab_worker FROM tracefab_migrator').catch(() => {});
    await admin.query('REVOKE tracefab_worker FROM postgres').catch(() => {});
    await admin.query('REVOKE tracefab_migrator FROM postgres').catch(() => {});
    await admin.query('DROP OWNED BY tracefab_worker').catch(() => {});
    await admin.query('DROP OWNED BY tracefab_migrator').catch(() => {});
    await admin.query('DROP ROLE IF EXISTS tracefab_worker').catch((e) => {
      console.error(`  info  nettoyage tracefab_worker : ${e.message}`);
    });
    await admin.query('DROP ROLE IF EXISTS tracefab_migrator').catch((e) => {
      console.error(`  info  nettoyage tracefab_migrator : ${e.message}`);
    });
    const rolesRestants = (await admin.query(
      `SELECT count(*)::int AS n FROM pg_catalog.pg_roles WHERE rolname IN ('tracefab_migrator','tracefab_worker')`)).rows[0].n;
    ok(rolesRestants === 0, 'R7 les rôles migrateur/worker jetables sont supprimés', `${rolesRestants} rôle(s) restant(s)`);
  } finally {
    if (verrou) { await verrou.relacher(); verrou = null; }
  }
}

await admin.end();

console.log('');
if (echecs === 0) {
  console.log(`  P10.6 rejouabilite de la chaine : ${assertions} assertions — rejouable dans un meme cluster.`);
  process.exit(0);
}
console.log(`  ${echecs} ÉCHEC sur ${assertions} assertions.`);
process.exit(1);
