#!/usr/bin/env node
/**
 * Prove that the SQL owner guard rejects a non-extension function owned by a
 * different role while PUBLIC still has EXECUTE. Runs only against a disposable
 * PostgreSQL target; never against a remote database.
 *
 * R12 (30/10) : cette suite portait une garde MAISON — liste d'hotes et nom de
 * base recopies a la main. Deux verites pour une meme regle : la liste commune
 * (`lib/require-throwaway-db.mjs`) pouvait refuser une cible que celle-ci
 * acceptait, et inversement. Le bloc maison est remplace par la garde commune,
 * qui est la seule definition de « cible jetable » du depot.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { nomRoleEphemere } from './lib/ephemeral-role.mjs';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('FAIL — DATABASE_URL is required for this disposable-database test.');
  process.exit(2);
}
requireThrowawayDb({
  variables: ['DATABASE_URL'],
  purpose: 'garde proprietaire SQL (scenario de refus)',
  exitOnFailure: true,
});

const migration = await readFile(
  new URL('../prisma/migrations/20261014130000_revoke_public_schema_privileges/migration.sql', import.meta.url),
  'utf8',
);
const guard = migration.match(/DO \$owner_guard\$[\s\S]*?\$owner_guard\$;/)?.[0];
assert(guard, 'The migration must contain the expected owner-guard DO block');

const client = new pg.Client({ connectionString: databaseUrl, ssl: false });
// Nom de role UNIQUE par execution. Il etait fixe (`tracefab_owner_guard_probe`)
// et precede d'un `DROP ROLE IF EXISTS` : un role preexistant de ce nom etait
// detruit avant tout controle. Le CREATE ROLE vit dans la transaction, donc la
// preuve de propriete est prise et reverifiee ICI, avant le DROP.
const role = nomRoleEphemere('tf_owner_guard_probe');
const routine = 'public.tracefab_owner_guard_probe()';
let transactionOpen = false;

try {
  await client.connect();
  await client.query('BEGIN');
  transactionOpen = true;

  // Aucun nettoyage preventif : la fixture porte un nom unique, et supprimer
  // « au cas ou » est exactement le geste qui detruit un role preexistant.
  await client.query('DROP FUNCTION IF EXISTS public.tracefab_owner_guard_probe()');
  await client.query(`CREATE ROLE ${role} NOLOGIN`);
  // Preuve de propriete : l'OID du role que CETTE execution vient de creer.
  const roleOid = (await client.query('SELECT oid FROM pg_roles WHERE rolname = $1', [role])).rows[0]?.oid;
  assert(roleOid, 'role de sonde cree mais introuvable dans pg_roles');
  await client.query(`GRANT CREATE ON SCHEMA public TO ${role}`);
  await client.query(
    'CREATE FUNCTION public.tracefab_owner_guard_probe() RETURNS boolean LANGUAGE sql AS $probe$ SELECT true $probe$',
  );
  await client.query(`ALTER FUNCTION ${routine} OWNER TO ${role}`);
  await client.query(`REVOKE CREATE ON SCHEMA public FROM ${role}`);
  // Explicitly recreate the historical vulnerability even though the CI role's default ACL is hardened.
  await client.query(`GRANT EXECUTE ON FUNCTION ${routine} TO PUBLIC`);

  // Isolate the expected error so the transaction can be cleaned up afterwards.
  await client.query('SAVEPOINT before_owner_guard');
  let caught = null;
  try {
    await client.query(guard);
  } catch (error) {
    caught = error;
    await client.query('ROLLBACK TO SAVEPOINT before_owner_guard');
  }

  assert(caught, 'Owner guard should reject the foreign-owned PUBLIC-executable function');
  assert(
    String(caught.message).includes('Migration refusée : des routines non-extension avec EXECUTE PUBLIC')
      && String(caught.message).includes('tracefab_owner_guard_probe'),
    `Owner guard must explain the offending role/routine; received: ${caught.message}`,
  );

  await client.query('DROP FUNCTION IF EXISTS public.tracefab_owner_guard_probe()');
  // Destruction refusee si le role n'est plus celui qu'on a cree.
  const oidAvantDrop = (await client.query('SELECT oid FROM pg_roles WHERE rolname = $1', [role])).rows[0]?.oid;
  assert(String(oidAvantDrop) === String(roleOid),
    `le role ${role} n a plus l OID cree : destruction refusee`);
  await client.query(`DROP ROLE ${role}`);
  await client.query('COMMIT');
  transactionOpen = false;
  console.log('PASS — owner guard refuses a foreign-owned PUBLIC EXECUTE routine and transaction cleanup succeeds.');
} catch (error) {
  if (transactionOpen) {
    try { await client.query('ROLLBACK'); } catch {}
  }
  console.error('FAIL —', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
