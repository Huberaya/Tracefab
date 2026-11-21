#!/usr/bin/env node
/**
 * P10 — reproduction PostgreSQL jetable du propriétaire pgcrypto géré par Neon.
 *
 * Le test installe pgcrypto dans une base jetable, transfère les fonctions
 * membres à un rôle superutilisateur non endossable (analogue à cloud_admin),
 * puis exécute le vrai provisionneur en --verifier sous un rôle non-superuser
 * CREATEROLE propriétaire de la base. Le provisionneur doit reconnaître le
 * résiduel sans tenter de REVOKE et sans aucune écriture.
 *
 * Usage via scripts/run-db-suite.mjs ; seule la base locale DATABASE_URL est
 * utilisée pour créer puis détruire les ressources temporaires.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { verrouillerCluster } from './lib/ephemeral-db.mjs';

const urlCluster = (process.env.DATABASE_URL || '').trim();
if (!urlCluster) {
  console.error('NON EXECUTE — DATABASE_URL absente.');
  process.exit(2);
}
const cluster = new URL(urlCluster);
if (!['localhost', '127.0.0.1', '::1'].includes(cluster.hostname)
    || cluster.pathname !== '/tracefab_test') {
  console.error('REFUS — le banc doit être le PostgreSQL jetable local tracefab_test.');
  process.exit(3);
}

const suffix = randomBytes(3).toString('hex');
const ownerRole = `tf_p10_owner_${suffix}`;
const platformRole = `tf_p10_cloud_${suffix}`;
const unknownRole = `tf_p10_unknown_${suffix}`;
const testAppRole = `tf_p10_app_${suffix}`;
const database = `tf_p10_pgcrypto_${suffix}`;
const ownerPassword = `p10_${randomBytes(12).toString('hex')}`;
const qid = (value) => `"${String(value).replace(/"/g, '""')}"`;

const admin = new pg.Client({ connectionString: urlCluster });
await admin.connect();
let verrou = null;
let databaseCreated = false;
let ownerCreated = false;
let platformCreated = false;
let unknownCreated = false;

async function snapshot(client) {
  const roles = (await client.query(`
    SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole,
           rolcreatedb, rolinherit
      FROM pg_catalog.pg_roles
     WHERE rolname IN ('tracefab_app', 'tracefab_migrator')
     ORDER BY rolname`)).rows;
  const totalRoles = Number((await client.query(
    'SELECT count(*)::int AS n FROM pg_catalog.pg_roles')).rows[0].n);
  const schemaOwner = (await client.query(`
    SELECT pg_catalog.pg_get_userbyid(nspowner) AS owner
      FROM pg_catalog.pg_namespace WHERE nspname = 'public'`)).rows[0]?.owner;
  const extensionOwner = (await client.query(`
    SELECT pg_catalog.pg_get_userbyid(extowner) AS owner
      FROM pg_catalog.pg_extension WHERE extname = 'pgcrypto'`)).rows[0]?.owner;
  const databaseAcl = (await client.query(`
    SELECT datacl::text AS acl FROM pg_catalog.pg_database WHERE datname = current_database()`)).rows[0]?.acl ?? null;
  const schemaAcl = (await client.query(`
    SELECT nspacl::text AS acl FROM pg_catalog.pg_namespace WHERE nspname = 'public'`)).rows[0]?.acl ?? null;
  const temporaryMemberships = Number((await client.query(`
    SELECT count(*)::int AS n
      FROM pg_catalog.pg_auth_members
     WHERE roleid = pg_catalog.to_regrole('tracefab_migrator')
       AND member = pg_catalog.to_regrole($1)`, [ownerRole])).rows[0].n);
  const pgcrypto = (await client.query(`
    SELECT count(*)::int AS functions,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM pg_catalog.aclexplode(
               COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
             ) acl WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
           ))::int AS public_execute,
           count(*) FILTER (WHERE r.rolsuper)::int AS superuser_owned
      FROM pg_catalog.pg_depend d
      JOIN pg_catalog.pg_proc p ON p.oid = d.objid
      JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
      JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
     WHERE d.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
       AND d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
       AND d.deptype = 'e' AND e.extname = 'pgcrypto'`)).rows[0];
  return { roles, totalRoles, schemaOwner, extensionOwner, databaseAcl, schemaAcl, temporaryMemberships, pgcrypto };
}

try {
  verrou = await verrouillerCluster({ urlProprietaire: urlCluster });
  const exists = (await admin.query(
    `SELECT rolname FROM pg_catalog.pg_roles WHERE rolname IN ('tracefab_app','tracefab_migrator')`,
  )).rows.map((r) => r.rolname);
  assert.ok(exists.includes('tracefab_app'), 'tracefab_app doit être provisionné avant cette étape CI');
  assert.ok(exists.includes('tracefab_migrator'), 'tracefab_migrator doit être provisionné avant cette étape CI');

  await admin.query(`CREATE ROLE ${qid(ownerRole)} LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS NOCREATEDB PASSWORD '${ownerPassword}'`);
  ownerCreated = true;
  // En Production, le provisionneur crée tracefab_migrator : son exécutant
  // conserve donc l'ADMIN OPTION sur le rôle qu'il vient de créer. Ici le
  // rôle existe déjà au niveau du cluster CI ; on reproduit explicitement
  // cette capacité pour le scénario positif. Le provisionneur doit la
  // consommer uniquement pour le GRANT SET temporaire puis la révoquer.
  await admin.query(`GRANT tracefab_migrator TO ${qid(ownerRole)} WITH ADMIN OPTION`);
  await admin.query(`CREATE ROLE ${qid(platformRole)} NOLOGIN SUPERUSER`);
  platformCreated = true;
  await admin.query(`CREATE DATABASE ${qid(database)} OWNER ${qid(ownerRole)}`);
  databaseCreated = true;

  const dbUrl = new URL(urlCluster);
  dbUrl.pathname = `/${database}`;
  const ownerUrl = new URL(dbUrl.toString());
  ownerUrl.username = ownerRole;
  ownerUrl.password = ownerPassword;

  // Reproduire exactement la dissociation Neon : l'extension appartient au
  // propriétaire non-superuser de la base, mais ses fonctions à cloud_admin.
  const ownerDb = new pg.Client({ connectionString: ownerUrl.toString() });
  await ownerDb.connect();
  try {
    await ownerDb.query('CREATE EXTENSION pgcrypto');
  } finally {
    await ownerDb.end();
  }

  const rootDb = new pg.Client({ connectionString: dbUrl.toString() });
  await rootDb.connect();
  try {
    const members = (await rootDb.query(`
      SELECT p.oid::pg_catalog.regprocedure::text AS signature
        FROM pg_catalog.pg_depend d
        JOIN pg_catalog.pg_proc p ON p.oid = d.objid
        JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
       WHERE d.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
         AND d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
         AND d.deptype = 'e' AND e.extname = 'pgcrypto'`)).rows;
    assert.ok(members.length > 0, 'pgcrypto doit exposer ses fonctions membres');
    for (const { signature } of members) {
      await rootDb.query(`ALTER FUNCTION ${signature} OWNER TO ${qid(platformRole)}`);
    }
  } finally {
    await rootDb.end();
  }

  const avantClient = new pg.Client({ connectionString: dbUrl.toString() });
  await avantClient.connect();
  const avant = await snapshot(avantClient);
  await avantClient.end();

  assert.equal(avant.extensionOwner, ownerRole, 'l’extension doit appartenir au propriétaire non-superuser de la base');
  assert.ok(avant.pgcrypto.functions > 0, 'fonctions pgcrypto présentes');
  assert.equal(avant.pgcrypto.public_execute, avant.pgcrypto.functions,
    'le fixture reproduit EXECUTE PUBLIC sur les fonctions pgcrypto');
  assert.equal(avant.pgcrypto.superuser_owned, avant.pgcrypto.functions,
    'toutes les fonctions membres sont détenues par le superutilisateur plateforme');

  const execution = spawnSync(process.execPath, ['scripts/provisionner_roles_db.mjs', '--verifier'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: ownerUrl.toString(),
      DATABASE_ADMIN_URL: '',
      TF_APP_ROLE_NAME: 'tracefab_app',
      TF_ALLOW_PROVISIONING: '',
    },
  });

  const apresClient = new pg.Client({ connectionString: dbUrl.toString() });
  await apresClient.connect();
  const apres = await snapshot(apresClient);
  await apresClient.end();

  assert.equal(execution.status, 0,
    `le vrai provisionneur doit accepter le mode Neon-managed en --verifier :\n${execution.stdout}\n${execution.stderr}`);
  assert.match(execution.stdout, /ACL PUBLIC préexistantes documentées, aucune tentative de REVOKE/,
    'le provisionneur doit signaler explicitement le résiduel géré');
  assert.deepEqual(apres, avant,
    'le mode --verifier ne doit modifier ni rôles, ni propriétaire de schéma, ni ACL pgcrypto');
  assert.match(execution.stdout, /VERDICT : rôles conformes/,
    'le provisionneur doit rendre un verdict conforme');

  // Contre-épreuve : propriétaire externe inconnu, non-superuser et non
  // endossable. Le vrai mode provisionnement doit refuser AVANT de créer le
  // rôle applicatif de sonde ou de modifier le schéma/les ACL.
  await admin.query(`CREATE ROLE ${qid(unknownRole)} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`);
  unknownCreated = true;
  const rootAgain = new pg.Client({ connectionString: dbUrl.toString() });
  await rootAgain.connect();
  try {
    const members = (await rootAgain.query(`
      SELECT p.oid::pg_catalog.regprocedure::text AS signature
        FROM pg_catalog.pg_depend d
        JOIN pg_catalog.pg_proc p ON p.oid = d.objid
        JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
       WHERE d.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
         AND d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
         AND d.deptype = 'e' AND e.extname = 'pgcrypto'`)).rows;
    for (const { signature } of members) {
      await rootAgain.query(`ALTER FUNCTION ${signature} OWNER TO ${qid(unknownRole)}`);
    }
  } finally {
    await rootAgain.end();
  }

  const avantRefusClient = new pg.Client({ connectionString: dbUrl.toString() });
  await avantRefusClient.connect();
  const avantRefus = await snapshot(avantRefusClient);
  await avantRefusClient.end();
  const ownerRefusal = spawnSync(process.execPath, ['scripts/provisionner_roles_db.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: ownerUrl.toString(),
      DATABASE_ADMIN_URL: '',
      TF_APP_ROLE_NAME: testAppRole,
      TF_ALLOW_PROVISIONING: 'oui',
    },
  });
  const apresRefusClient = new pg.Client({ connectionString: dbUrl.toString() });
  await apresRefusClient.connect();
  const apresRefus = await snapshot(apresRefusClient);
  const roleSonde = await apresRefusClient.query(
    'SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1', [testAppRole]);
  await apresRefusClient.end();

  assert.notEqual(ownerRefusal.status, 0,
    'un propriétaire externe non classé doit faire échouer le provisionnement');
  assert.match(ownerRefusal.stderr + ownerRefusal.stdout, /REFUS AVANT ÉCRITURE/,
    'le refus doit être explicite et précéder toute mutation');
  assert.equal(roleSonde.rowCount, 0,
    'le rôle applicatif de sonde ne doit pas avoir été créé');
  assert.deepEqual(apresRefus, avantRefus,
    'le refus doit laisser les rôles, le schéma et les ACL inchangés');

  // Chemin positif : propriétaire de l'extension = exécutant non-superuser,
  // donc les ACL sont modifiables. Le provisionneur réel doit soit valider
  // toutes les opérations, soit échouer en annulant intégralement la transaction.
  const rootFinal = new pg.Client({ connectionString: dbUrl.toString() });
  await rootFinal.connect();
  try {
    const members = (await rootFinal.query(`
      SELECT p.oid::pg_catalog.regprocedure::text AS signature
        FROM pg_catalog.pg_depend d
        JOIN pg_catalog.pg_proc p ON p.oid = d.objid
        JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
       WHERE d.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
         AND d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
         AND d.deptype = 'e' AND e.extname = 'pgcrypto'`)).rows;
    for (const { signature } of members) {
      await rootFinal.query(`ALTER FUNCTION ${signature} OWNER TO ${qid(ownerRole)}`);
    }
  } finally {
    await rootFinal.end();
  }

  const executionAvant = new pg.Client({ connectionString: dbUrl.toString() });
  await executionAvant.connect();
  const etatAvantProvisionnement = await snapshot(executionAvant);
  await executionAvant.end();
  const provisionnement = spawnSync(process.execPath, ['scripts/provisionner_roles_db.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: ownerUrl.toString(),
      DATABASE_ADMIN_URL: '',
      TF_APP_ROLE_NAME: testAppRole,
      TF_ALLOW_PROVISIONING: 'oui',
    },
  });

  const executionApres = new pg.Client({ connectionString: dbUrl.toString() });
  await executionApres.connect();
  const etatApresProvisionnement = await snapshot(executionApres);
  const appRole = await executionApres.query(
    'SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1', [testAppRole]);
  const hmac = (await executionApres.query(
    `SELECT pg_catalog.has_function_privilege($1, 'public.hmac(bytea,bytea,text)', 'EXECUTE') AS migrator,
            pg_catalog.has_function_privilege($2, 'public.hmac(bytea,bytea,text)', 'EXECUTE') AS app`,
    ['tracefab_migrator', testAppRole])).rows[0];
  const dbPrivileges = (await executionApres.query(
    `SELECT pg_catalog.has_database_privilege($1, current_database(), 'CREATE') AS migrator_create,
            pg_catalog.has_database_privilege($2, current_database(), 'CREATE') AS app_create`,
    ['tracefab_migrator', testAppRole])).rows[0];
  await executionApres.end();

  assert.equal(provisionnement.status, 0,
    `le provisionneur doit réussir avec un propriétaire pgcrypto accessible :\n${provisionnement.stdout}\n${provisionnement.stderr}`);
  assert.equal(appRole.rowCount, 1, 'le rôle applicatif de sonde doit être créé');
  assert.equal(etatApresProvisionnement.schemaOwner, 'tracefab_migrator',
    'le schéma public doit appartenir au rôle de migration');
  assert.equal(etatApresProvisionnement.pgcrypto.public_execute, 0,
    'EXECUTE PUBLIC doit être retiré des fonctions pgcrypto lorsque le propriétaire est accessible');
  assert.equal(hmac.migrator, true, 'le migrateur doit pouvoir exécuter hmac');
  assert.equal(hmac.app, false, 'le rôle applicatif ne doit pas pouvoir exécuter hmac');
  assert.equal(dbPrivileges.migrator_create, true, 'le migrateur doit recevoir CREATE sur la base pour être propriétaire du schéma');
  assert.equal(dbPrivileges.app_create, false, 'le rôle applicatif ne doit jamais recevoir CREATE sur la base');
  assert.equal(etatApresProvisionnement.temporaryMemberships, 0,
    'l’appartenance SET temporaire doit être révoquée avant COMMIT');
  assert.match(provisionnement.stdout, /propriété du schéma transférée avec SET temporaire puis révoqué/,
    'le chemin positif doit prouver le transfert via l’appartenance SET temporaire');
  assert.ok(etatApresProvisionnement.totalRoles === etatAvantProvisionnement.totalRoles + 1,
    'une seule identité applicative de sonde doit avoir été créée');

  // Contre-épreuve transactionnelle : le même exécutant perd CREATEROLE.
  // Les rôles applicatif et migrator existent déjà ; le provisionneur doit
  // donc atteindre l'étape SET temporaire, échouer sans privilège, puis
  // restaurer exactement les ACL et le propriétaire du schéma.
  const rootNegative = new pg.Client({ connectionString: dbUrl.toString() });
  await rootNegative.connect();
  try {
    await rootNegative.query(`ALTER SCHEMA public OWNER TO ${qid(ownerRole)}`);
    await rootNegative.query(`REVOKE tracefab_migrator FROM ${qid(ownerRole)}`);
    await rootNegative.query(`ALTER ROLE ${qid(ownerRole)} NOCREATEROLE`);
  } finally {
    await rootNegative.end();
  }
  const avantSansCreateRoleClient = new pg.Client({ connectionString: dbUrl.toString() });
  await avantSansCreateRoleClient.connect();
  const avantSansCreateRole = await snapshot(avantSansCreateRoleClient);
  await avantSansCreateRoleClient.end();

  const refusSet = spawnSync(process.execPath, ['scripts/provisionner_roles_db.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: ownerUrl.toString(),
      DATABASE_ADMIN_URL: '',
      TF_APP_ROLE_NAME: testAppRole,
      TF_ALLOW_PROVISIONING: 'oui',
    },
  });
  const apresSansCreateRoleClient = new pg.Client({ connectionString: dbUrl.toString() });
  await apresSansCreateRoleClient.connect();
  const apresSansCreateRole = await snapshot(apresSansCreateRoleClient);
  await apresSansCreateRoleClient.end();
  assert.notEqual(refusSet.status, 0,
    "sans CREATEROLE ni ADMIN OPTION, l’appartenance temporaire doit être refusée");
  assert.match(refusSet.stdout + refusSet.stderr, /ROLLBACK — provisionnement annulé intégralement/,
    'le refus tardif doit déclencher un rollback explicite');
  assert.deepEqual(apresSansCreateRole, avantSansCreateRole,
    'le refus du SET temporaire doit annuler toutes les écritures et ne laisser aucune appartenance');

  console.log('PASS — PostgreSQL réel : SET temporaire, révocation avant COMMIT, refus sans CREATEROLE et rollback atomique validés.');
} finally {
  if (databaseCreated) await admin.query(`DROP DATABASE IF EXISTS ${qid(database)} WITH (FORCE)`).catch(() => {});
  if (platformCreated) await admin.query(`DROP ROLE IF EXISTS ${qid(platformRole)}`).catch(() => {});
  if (unknownCreated) await admin.query(`DROP ROLE IF EXISTS ${qid(unknownRole)}`).catch(() => {});
  await admin.query(`DROP OWNED BY ${qid(testAppRole)}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${qid(testAppRole)}`).catch(() => {});
  if (ownerCreated) await admin.query(`DROP ROLE IF EXISTS ${qid(ownerRole)}`).catch(() => {});
  if (verrou) await verrou.relacher().catch(() => {});
  await admin.end();
}