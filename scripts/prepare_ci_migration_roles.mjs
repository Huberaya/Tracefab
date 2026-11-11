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
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';

// Refus par défaut hors base locale jetable, avant toute connexion ou mutation.
requireThrowawayDb({ variables: ['DATABASE_URL'], purpose: 'provisionnement des rôles de migration CI jetables' });

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

  await client.query('BEGIN');
  // Neon fournit pgcrypto via son rôle interne cloud_admin : le migrateur
  // applicatif non-superuser ne doit pas créer l'extension. Le banc local
  // reproduit ce prérequis en l'installant une fois avec postgres SUPERUSER,
  // avant de remettre la main au couple admin/migrateur non-superusers.
  await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  const extension = (await client.query(
    `SELECT extname FROM pg_catalog.pg_extension WHERE extname = 'pgcrypto'`,
  )).rows[0];
  if (!extension) throw new Error('pgcrypto doit être préinstallée par le bootstrap SUPERUSER jetable');
  await client.query(
    `CREATE ROLE ${ident(adminRole)} LOGIN PASSWORD ${quote(adminPassword)}
       CREATEROLE NOCREATEDB NOBYPASSRLS NOSUPERUSER NOINHERIT`,
  );
  await client.query(
    `CREATE ROLE ${ident(migratorRole)} LOGIN PASSWORD ${quote(migratorPassword)}
       CREATEROLE NOCREATEDB BYPASSRLS NOSUPERUSER INHERIT`,
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
  // Le migrateur Neon dispose de CREATE sur la base (pas de SUPERUSER) ;
  // reproduire ce droit minimal dans le service PostgreSQL jetable.
  await client.query(
    `GRANT CREATE ON DATABASE ${ident(url.pathname.slice(1))} TO ${ident(migratorRole)}`,
  );
  // Dans Neon, tracefab_migrator est propriétaire du schéma public et porte
  // BYPASSRLS (contrat de migration, jamais de runtime). Le reproduire est
  // nécessaire pour les opérations historiques de la migration initiale.
  await client.query(`ALTER SCHEMA public OWNER TO ${ident(migratorRole)}`);

  const roles = (await client.query(
    `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb,
            rolcanlogin, rolinherit
       FROM pg_catalog.pg_roles
      WHERE rolname = ANY($1::text[])
      ORDER BY rolname`,
    [[adminRole, migratorRole]],
  )).rows;
  const adminAttrs = roles.find(r => r.rolname === adminRole);
  const migratorAttrs = roles.find(r => r.rolname === migratorRole);
  if (roles.length !== 2 || !adminAttrs || !migratorAttrs
      || roles.some(r => r.rolsuper || r.rolcreatedb || !r.rolcreaterole
        || !r.rolcanlogin || r.rolreplication)
      || adminAttrs.rolbypassrls || adminAttrs.rolinherit
      || !migratorAttrs.rolbypassrls || !migratorAttrs.rolinherit) {
    throw new Error('attributs inattendus : admin sans BYPASSRLS, migrateur BYPASSRLS de migration uniquement, aucun SUPERUSER');
  }
  const schemaOwner = (await client.query(
    `SELECT pg_catalog.pg_get_userbyid(nspowner) AS owner
       FROM pg_catalog.pg_namespace WHERE nspname = 'public'`,
  )).rows[0]?.owner;
  if (schemaOwner !== migratorRole) throw new Error('tracefab_migrator doit être propriétaire du schéma public jetable');

  const databaseCreate = (await client.query(
    `SELECT has_database_privilege($1, current_database(), 'CREATE') AS allowed`,
    [migratorRole],
  )).rows[0]?.allowed;
  if (databaseCreate !== true) throw new Error('le migrateur doit disposer de CREATE sur la base jetable, sans SUPERUSER');

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
console.log('Identités CI vérifiées : admin CREATEROLE/NOBYPASSRLS ; migrateur CREATEROLE/BYPASSRLS ; aucun SUPERUSER.');
