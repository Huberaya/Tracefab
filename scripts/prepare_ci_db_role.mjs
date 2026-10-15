#!/usr/bin/env node
/**
 * Prépare le rôle applicatif dans la base PostgreSQL jetable AVANT les migrations.
 * Garde-fou strict : refuse tout hôte autre que localhost/127.0.0.1 et toute
 * base autre que tracefab_test. Aucun secret de production n'est accepté ici.
 */
import pg from 'pg';

const rawUrl = process.env.DATABASE_URL;
const password = process.env.TF_APP_PASSWORD;
if (!rawUrl || !password) {
  console.error('DATABASE_URL et TF_APP_PASSWORD sont requis.');
  process.exit(2);
}

const parsed = new URL(rawUrl);
if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
    || parsed.pathname !== '/tracefab_test') {
  console.error('REFUS : ce script ne fonctionne que sur la base jetable locale tracefab_test.');
  process.exit(2);
}

const client = new pg.Client({
  connectionString: rawUrl,
  ssl: false,
});
const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'";

await client.connect();
try {
  const exists = await client.query("select 1 from pg_roles where rolname = 'tracefab_app'");
  if (exists.rowCount === 0) {
    await client.query(
      `CREATE ROLE tracefab_app LOGIN PASSWORD ${quote(password)} NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB`,
    );
  } else {
    await client.query(
      `ALTER ROLE tracefab_app WITH LOGIN PASSWORD ${quote(password)} NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB`,
    );
  }
  const result = await client.query(
    "select rolbypassrls, rolsuper, rolcreaterole, rolcreatedb from pg_roles where rolname = 'tracefab_app'",
  );
  const role = result.rows[0];
  if (role.rolbypassrls || role.rolsuper || role.rolcreaterole || role.rolcreatedb) {
    throw new Error('tracefab_app possède un attribut privilégié inattendu.');
  }
  console.log('Rôle tracefab_app préparé avant migrations : NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB.');
} finally {
  await client.end();
}
