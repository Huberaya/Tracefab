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
  return { roles, totalRoles, schemaOwner, extensionOwner, pgcrypto };
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

  console.log('PASS — PostgreSQL réel : Neon-managed accepté sans écriture ; propriétaire externe inconnu refusé avant CREATE ROLE.');
} finally {
  if (databaseCreated) await admin.query(`DROP DATABASE IF EXISTS ${qid(database)} WITH (FORCE)`).catch(() => {});
  if (platformCreated) await admin.query(`DROP ROLE IF EXISTS ${qid(platformRole)}`).catch(() => {});
  if (unknownCreated) await admin.query(`DROP ROLE IF EXISTS ${qid(unknownRole)}`).catch(() => {});
  if (ownerCreated) await admin.query(`DROP ROLE IF EXISTS ${qid(ownerRole)}`).catch(() => {});
  if (verrou) await verrou.relacher().catch(() => {});
  await admin.end();
}
