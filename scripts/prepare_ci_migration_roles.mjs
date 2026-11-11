#!/usr/bin/env node
/**
 * Provisionne deux identités NON-SUPERUSER pour la chaîne de migrations CI.
 *
 * Autorisé uniquement sur le service PostgreSQL jetable de GitHub Actions :
 * localhost/127.0.0.1, base tracefab_test, session initiale postgres SUPERUSER.
 * Les mots de passe sont aléatoires, masqués et transmis uniquement via
 * GITHUB_OUTPUT pour les deux étapes qui en ont besoin.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const raw = (process.env.DATABASE_URL || '').trim();
const output = process.env.GITHUB_OUTPUT;
if (!raw || !output) {
  console.error('REFUS — DATABASE_URL et GITHUB_OUTPUT sont obligatoires.');
  process.exit(2);
}

let url;
try { url = new URL(raw); } catch {
  console.error('REFUS — DATABASE_URL illisible.');
  process.exit(2);
}
if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)
    || url.pathname !== '/tracefab_test'
    || url.username !== 'postgres'
    || url.password !== 'postgres'
    || (url.port && url.port !== '5432')) {
  console.error('REFUS — cible autorisée uniquement : postgres@localhost:5432/tracefab_test.');
  process.exit(3);
}

const adminRole = 'tracefab_ci_admin';
const migratorRole = 'tracefab_migrator';
const adminPassword = randomBytes(32).toString('hex');
const migratorPassword = randomBytes(32).toString('hex');
const quote = (v) => "'" + String(v).replace(/'/g, "''") + "'";
const ident = (v) => '"' + String(v).replace(/"/g, '""') + '"';
const client = new pg.Client({ connectionString: raw });

await client.connect();
try {
  const session = (await client.query(
    `SELECT current_user AS name, r.rolsuper
       FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`,
  )).rows[0];
  if (session?.name !== 'postgres' || session.rolsuper !== true) {
    throw new Error('la session initiale doit être postgres SUPERUSER du service jetable');
  }

  const existing = (await client.query(
    `SELECT rolname FROM pg_catalog.pg_roles
      WHERE rolname = ANY($1::text[])`,
    [[adminRole, migratorRole]],
  )).rows;
  if (existing.length) {
    throw new Error(`rôle(s) CI préexistant(s), refus de les réutiliser : ${existing.map(x => x.rolname).join(', ')}`);
  }

  // Neon fournit pgcrypto au niveau plateforme. Le banc local reproduit
  // ce prérequis avant de donner au migrateur son seul privilège CREATE DB.
  await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  await client.query('BEGIN');
  await client.query(
    `CREATE ROLE ${ident(adminRole)} LOGIN PASSWORD ${quote(adminPassword)}
       CREATEROLE BYPASSRLS NOCREATEDB NOSUPERUSER NOINHERIT`,
  );
  await client.query(
    `CREATE ROLE ${ident(migratorRole)} LOGIN PASSWORD ${quote(migratorPassword)}
       CREATEROLE NOCREATEDB NOBYPASSRLS NOSUPERUSER NOINHERIT`,
  );
  // Le grantor est postgres, distinct de l'administrateur : ADMIN-only est
  // transmissible sans accorder à l'admin SET/INHERIT par défaut.
  await client.query(
    `GRANT ${ident(migratorRole)} TO ${ident(adminRole)}
       WITH ADMIN TRUE, SET FALSE, INHERIT FALSE`,
  );
  await client.query(
    `GRANT CREATE ON SCHEMA public TO ${ident(adminRole)} WITH GRANT OPTION`,
  );
  await client.query(
    `GRANT CREATE ON SCHEMA public TO ${ident(migratorRole)} WITH GRANT OPTION`,
  );
  // Le rôle migrateur ne doit pas pouvoir créer l'extension lui-même :
  // pgcrypto est préinstallée, mais CREATE DB est nécessaire pour que
  // CREATE EXTENSION IF NOT EXISTS soit accepté par PostgreSQL 17.
  await client.query(
    `GRANT CREATE ON DATABASE ${ident('tracefab_test')} TO ${ident(migratorRole)}`,
  );
  await client.query(
    `ALTER SCHEMA public OWNER TO ${ident(migratorRole)}`,
  );

  const roles = (await client.query(
    `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb,
            rolcanlogin, rolinherit
       FROM pg_catalog.pg_roles
      WHERE rolname = ANY($1::text[])
      ORDER BY rolname`,
    [[adminRole, migratorRole]],
  )).rows;
  if (roles.length !== 2 || roles.some(r =>
    r.rolsuper || !r.rolbypassrls || r.rolcreatedb || !r.rolcreaterole
      || !r.rolcanlogin || r.rolinherit)) {
    throw new Error('attributs inattendus : admin/migrateur doivent être CREATEROLE+BYPASSRLS, jamais SUPERUSER');
  }
  const membership = (await client.query(
    `SELECT admin_option, set_option, inherit_option
       FROM pg_catalog.pg_auth_members
      WHERE member = $1::regrole AND roleid = $2::regrole`,
    [adminRole, migratorRole],
  )).rows;
  if (membership.length !== 1 || !membership[0].admin_option
      || membership[0].set_option || membership[0].inherit_option) {
    throw new Error('l’administrateur ne détient pas exactement ADMIN-only sur le migrateur');
  }

  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}

process.stdout.write(`::add-mask::${adminPassword}\n::add-mask::${migratorPassword}\n`);
const host = url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname;
const port = url.port || '5432';
const database = url.pathname.slice(1);
const migratorUrl = `postgresql://${migratorRole}:${migratorPassword}@${host}:${port}/${database}`;
const adminUrl = `postgresql://${adminRole}:${adminPassword}@${host}:${port}/${database}`;
await import('node:fs/promises').then(({ appendFile }) =>
  appendFile(output, `migrator_url=${migratorUrl}\nadmin_url=${adminUrl}\n`));
console.log('Identités CI créées et vérifiées : deux CREATEROLE non-superusers, sans BYPASSRLS.');
