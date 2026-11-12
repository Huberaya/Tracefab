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

  // ET IL FAUT AUSSI FERMER SON `EXECUTE` A PUBLIC — MESURE DU 2026-11-12.
  //
  // `CREATE EXTENSION` installe les fonctions avec `proacl = NULL`, donc avec
  // l'ACL PAR DEFAUT : `EXECUTE` accorde a PUBLIC. `prepare_ci_migration_roles`
  // creait l'extension sous `postgres` SUPERUSER et s'arretait la. Or le
  // proprietaire des fonctions n'est PAS le migrateur, et la chaine ne peut pas
  // les fermer : la migration 20261028120000 ne revoque que sur les fonctions
  // dont `proowner = ANY (proprietaires)` — les 37 fonctions de l'extension en
  // sont exclues. Resultat en CI, mesure dans la session du 2026-11-12 :
  //
  //   npm run audit:privileges -> 37 anomalies bloquantes, dont
  //     « BLOQUANT fonction executable par PUBLIC : hmac »
  //     « BLOQUANT fonction executable par PUBLIC : digest »
  //   npm run test:neon:privileges-role-app -> les mesures d'ACL tombent
  //
  // et la garde runtime chercherait a revoquer des droits qu'elle ne possede
  // pas, en laissant les 37 fonctions ouvertes a tout role du cluster.
  //
  // La procedure existe, elle est documentee et mesuree : le script de
  // provisionnement des roles (celui de la section 9 de
  // docs/security/2026-10-31-p105-connexions-runtime.md) fait exactement ces
  // REVOKE dans sa fonction d'installation d'extension. Ce banc de CI doit donc
  // appliquer le MEME prerequis administratif, une fois, sous le SUPERUSER
  // jetable : c'est le role de la plateforme (Neon : cloud_admin) et non celui
  // du migrateur. Aucun droit n'est accorde a `tracefab_app`.
  const fonctionsExtension = (await client.query(
    `SELECT p.oid::pg_catalog.regprocedure::text AS signature
       FROM pg_catalog.pg_depend d
       JOIN pg_catalog.pg_proc p ON p.oid = d.objid
      WHERE d.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
        AND d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
        AND d.deptype = 'e'
        AND d.refobjid = (SELECT oid FROM pg_catalog.pg_extension WHERE extname = 'pgcrypto')
      ORDER BY 1`,
  )).rows.map((r) => r.signature);
  for (const signature of fonctionsExtension) {
    await client.query(`REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC`);
  }
  const encoreOuvertes = (await client.query(
    `SELECT count(*)::int AS n
       FROM pg_catalog.pg_depend d
       JOIN pg_catalog.pg_proc p ON p.oid = d.objid
      WHERE d.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
        AND d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
        AND d.deptype = 'e'
        AND d.refobjid = (SELECT oid FROM pg_catalog.pg_extension WHERE extname = 'pgcrypto')
        AND EXISTS (SELECT 1 FROM pg_catalog.aclexplode(
              COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
             WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE')`,
  )).rows[0].n;
  if (encoreOuvertes !== 0) {
    throw new Error(`pgcrypto : ${encoreOuvertes} fonction(s) encore executable(s) par PUBLIC apres REVOKE`);
  }
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

  // LE PROPRIETAIRE DU VERIFICATEUR SIGNE DOIT POUVOIR APPELER `hmac`.
  //
  // MESURE DU 2026-11-12, en rejouant le job `base-de-donnees` pas a pas :
  // `npm run test:neon:app-readiness` sortait en `42501 permission denied for
  // function hmac` sur le chemin LEGITIME — le jeton systeme signe, accepte par
  // construction. Ce n'est PAS un defaut de securite : c'est un prerequis
  // administratif manquant, et celui que la procedure de production documente
  // (`docs/security/2026-10-31-p105-provisionnement.md` § 4, et le script de
  // provisionnement des roles, fonction d'installation d'extension).
  //
  // Le raisonnement, mesure :
  //   - `pgcrypto` est installee par ce bootstrap SUPERUSER. Ses 37 fonctions
  //     appartiennent donc a `postgres`, PAS au role de migration ;
  //   - la chaine ne peut pas leur retirer l'EXECUTE (la migration de registre
  //     ne revoque que sur les fonctions de `proprietaires`) — d'ou les REVOKE
  //     faits plus haut, sous l'autorite qui possede reellement les fonctions ;
  //   - une fois PUBLIC ferme, seul le PROPRIETAIRE des fonctions peut appeler
  //     `hmac`. Le proprietaire du verificateur SECURITY DEFINER est le role de
  //     migration : il doit donc recevoir le STRICT necessaire.
  //
  // On n'accorde RIEN au runtime : `tracefab_app` reste sans EXECUTE sur
  // l'extension, et l'assertion ci-dessous le prouve explicitement. Accorder
  // `hmac` au role applicatif serait precisement l'affaiblissement que la
  // procedure interdit.
  await client.query('GRANT EXECUTE ON FUNCTION public.hmac(bytea, bytea, text) TO ' + ident(migratorRole));
  const hmac = (await client.query(
    `SELECT pg_catalog.has_function_privilege($1, 'public.hmac(bytea,bytea,text)', 'EXECUTE') AS migrateur,
            pg_catalog.has_function_privilege('tracefab_app', 'public.hmac(bytea,bytea,text)', 'EXECUTE') AS app`,
    [migratorRole],
  )).rows[0];
  if (hmac.migrateur !== true || hmac.app !== false) {
    throw new Error(`hmac : EXECUTE doit aller au seul ${migratorRole} (migrateur=${hmac.migrateur}, app=${hmac.app})`);
  }

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
