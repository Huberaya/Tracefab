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
// Le role de la session d'amorcage (verifie SUPERUSER juste apres) : il ecrit
// lui aussi des objets — extension, schema — et son defaut EXECUTE doit etre
// ferme au meme titre que celui du role de migration.
const sessionRole = 'postgres';
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
  // L'assertion NE DOIT PAS citer `tracefab_app` inconditionnellement : ce
  // script tourne AVANT `db:prepare-ci-role`, donc avant que le role applicatif
  // existe (mesure du 2026-11-12 : le job CI est tombe ici meme, sur
  // `role "tracefab_app" does not exist`, parce que le banc local avait un
  // `tracefab_app` residuel et pas la CI neuve). On mesure donc l'invariant
  // reel — PUBLIC ferme, proprietaire du verificateur autorise — et on ne juge
  // le role applicatif que s'il existe deja, ou il doit etre refuse.
  const hmac = (await client.query(
    `SELECT pg_catalog.has_function_privilege($1, 'public.hmac(bytea,bytea,text)', 'EXECUTE') AS migrateur,
            EXISTS (
              SELECT 1 FROM pg_catalog.pg_proc p
                CROSS JOIN LATERAL pg_catalog.aclexplode(
                  COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
               WHERE p.oid = 'public.hmac(bytea,bytea,text)'::pg_catalog.regprocedure
                 AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
            ) AS public_execute,
            (SELECT pg_catalog.to_regrole('tracefab_app') IS NULL) AS app_absente,
            CASE WHEN pg_catalog.to_regrole('tracefab_app') IS NULL THEN NULL
              ELSE pg_catalog.has_function_privilege('tracefab_app', 'public.hmac(bytea,bytea,text)', 'EXECUTE')
            END AS app`,
    [migratorRole],
  )).rows[0];
  if (hmac.migrateur !== true || hmac.public_execute !== false || hmac.app === true) {
    throw new Error(`hmac : EXECUTE doit aller au seul ${migratorRole}, jamais a PUBLIC ni au runtime`
      + ` (migrateur=${hmac.migrateur}, public=${hmac.public_execute}, app=${hmac.app_absente ? 'absente' : hmac.app})`);
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

  // ET LE DEFAUT DES FONCTIONS A VENIR DOIT ETRE FERME POUR LES DEUX ROLES.
  //
  // MESURE DU 2026-11-12, annotation du job `base-de-donnees` : l'etape
  // « Privileges SQL apres migrations » echouait sur
  //
  //   D. une fonction creee maintenant est encore executable par PUBLIC
  //
  // La chaine ferme bien ce defaut (migrations 20261012120000 et
  // 20261014120000), mais toujours pour `current_user` — c'est-a-dire pour LE
  // role qui applique cette migration. Rejoue localement, ce banc ne l'a
  // jamais vu : il appliquait la chaine avec `postgres`, donc les deux
  // commandes etaient redondantes. En CI la chaine est appliquee par
  // `tracefab_migrator` : le defaut de `postgres` restait OUVERT, et toute
  // fonction creee par `postgres` naissait executable par PUBLIC.
  //
  // Ce n'est pas un defaut de la chaine (elle ne peut pas, et ne doit pas,
  // modifier les defauts d'un AUTRE role) : c'est un prerequis administratif,
  // comme l'extension. Il est pose APRES le COMMIT — une connexion ouverte
  // sous un role cree dans la transaction courante ne le verrait pas encore.
  // L'instruction est globale (sans `IN SCHEMA`) : la variante par schema ne
  // retire pas le defaut integre du moteur, c'est la lecon du 07/10.
  const fermerDefautExecute = async (role) => {
    await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(role)} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
    // Mesure, pas lecture d'instruction : une fonction temoin est creee PAR CE
    // ROLE, sur une connexion dediee ouverte sous son nom, puis annulee.
    //
    // La connexion est construite sans mot de passe quand le role en est
    // depourvu : le service de CI est en `trust` sur `localhost`, et exiger un
    // mot de passe ici rendrait la mesure dependante d'un detail de
    // l'environnement plutot que du contrat du role.
    const u = new URL(url.toString());
    u.username = role;
    if (role === migratorRole) u.password = migratorPassword;
    else u.password = '';
    const sonde = new pg.Client({ connectionString: u.toString() });
    await sonde.connect();
    try {
      await sonde.query('BEGIN');
      await sonde.query('CREATE FUNCTION public.tf_ci_default_execute_probe() RETURNS boolean LANGUAGE sql AS $p$ SELECT true $p$');
      const { publicPeut } = (await sonde.query(`
        SELECT COALESCE(bool_or(acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'), false) AS "publicPeut"
          FROM pg_catalog.pg_proc p
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
         WHERE p.oid = 'public.tf_ci_default_execute_probe()'::pg_catalog.regprocedure`)).rows[0];
      await sonde.query('ROLLBACK');
      if (publicPeut !== false) {
        throw new Error(`defaut EXECUTE non ferme pour ${role} : une fonction creee par ce role reste executable par PUBLIC`);
      }
    } finally {
      await sonde.query('ROLLBACK').catch(() => {});
      await sonde.end().catch(() => {});
    }
  };
  for (const role of new Set([migratorRole, sessionRole])) {
    await fermerDefautExecute(role);
  }

  for (const role of new Set([migratorRole, sessionRole])) {
    await fermerDefautExecute(role);
  }
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
