#!/usr/bin/env node
/**
 * P10.6/P11 — REJOUABILITÉ ET APPARTENANCE WORKER NEON.
 *
 * Le SQL des migrations n'introduit aucun SUPERUSER et révoque ses grants.
 * Le SQL et le runner n'introduisent aucun SUPERUSER.
 * L'administrateur CREATEROLE préprovisionne tracefab_worker et garde ADMIN-only.
 * Il accorde SET/INHERIT au migrateur uniquement pendant chaque migration
 * déclarée ; le runner révoque ce bail avant COMMIT.
 *
 * R1 aucun chemin ne rend le migrateur SUPERUSER ni ne demande d'élévation ;
 * R2 l'admin préprovisionne le worker et accorde un bail SET/INHERIT sans ADMIN ;
 *    le runner révoque ce bail après chaque migration ; l'admin garde ADMIN-only.
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
ok(/tracefab_worker_must_be_preprovisioned_by_runner/.test(migration201),
  'R1 le bootstrap refuse un worker absent au lieu de créer un rôle');
ok(/tracefab\.worker_membership_managed/.test(migration201)
   && /pg_has_role\(current_user, 'tracefab_worker', 'SET'\)/.test(migration201)
   && /pg_has_role\(current_user, 'tracefab_worker', 'USAGE'\)/.test(migration201),
  'R1 le bootstrap exige un bail runner SET/INHERIT explicite');
ok(!/ADMIN TRUE/.test(migration201)
   && !/ALTER ROLE tracefab_worker[\s\S]{0,240}NOSUPERUSER/i.test(migration201),
  'R1 la migration ne délègue pas ADMIN et ne demande aucune élévation');

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

    // L'administrateur crée le worker et conserve ADMIN-only. Il accorde
    // uniquement SET/INHERIT au migrateur, comme le runner réel.
    await operator.query(`GRANT ${migratorRole} TO ${adminRole} WITH SET TRUE, INHERIT TRUE, ADMIN FALSE`);
    const adminLease = (await operator.query(
      `SELECT pg_catalog.pg_has_role($1,$2,'SET') AS can_set,
              pg_catalog.pg_has_role($1,$2,'USAGE') AS can_use`,
      [adminRole, migratorRole]
    )).rows[0];
    ok(adminLease.can_set && adminLease.can_use,
      'R2 le runner accorde temporairement SET/INHERIT du migrateur à sa session administrative');

    await operator.query(`CREATE ROLE ${workerRole} NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB`);
    const adminWorker = (await operator.query(
      `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
                       WHERE m.member=$1::regrole AND m.roleid=$2::regrole
                         AND m.admin_option AND NOT m.set_option AND NOT m.inherit_option) AS admin_only`,
      [adminRole, workerRole]
    )).rows[0].admin_only;
    ok(adminWorker,
      'R2 le créateur du worker conserve ADMIN-only, sans SET ni INHERIT');

    await operator.query(`GRANT ${workerRole} TO ${migratorRole} WITH SET TRUE, INHERIT TRUE, ADMIN FALSE`);
    await operator.query(`GRANT CREATE ON SCHEMA public TO ${workerRole}`);
    const workerLease = (await operator.query(
      `SELECT pg_catalog.pg_has_role($1,$2,'SET') AS can_set,
              pg_catalog.pg_has_role($1,$2,'USAGE') AS can_use,
              EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
                       WHERE m.member=$1::regrole AND m.roleid=$2::regrole
                         AND NOT m.admin_option AND m.set_option AND m.inherit_option) AS set_inherit_only`,
      [migratorRole, workerRole]
    )).rows[0];
    ok(workerLease.can_set && workerLease.can_use && workerLease.set_inherit_only,
      'R2 le migrateur reçoit SET/INHERIT sans ADMIN');

    await operator.query(`SET ROLE ${migratorRole}`);
    const current = (await operator.query('SELECT current_user AS u, session_user AS s')).rows[0];
    ok(current.u === migratorRole && current.s === adminRole,
      'R2 la session administrative endosse le migrateur sans SUPERUSER');

    await operator.query(`CREATE FUNCTION public.${fn}() RETURNS integer LANGUAGE sql AS 'SELECT 1'`);
    await operator.query(`ALTER FUNCTION public.${fn}() OWNER TO ${workerRole}`);
    const owner = (await operator.query(
      `SELECT pg_catalog.pg_get_userbyid(proowner) AS owner FROM pg_catalog.pg_proc WHERE oid=$1::regprocedure`,
      [`public.${fn}()`]
    )).rows[0]?.owner;
    ok(owner === workerRole,
      'R2 le migrateur transfère une fonction au worker sans SUPERUSER', owner || 'propriétaire absent');

    // Fin de migration : le runner retire le bail SET/INHERIT du migrateur.
    await operator.query('RESET ROLE');
    await operator.query(`REVOKE ${workerRole} FROM ${migratorRole}`);
    const workerAfter = (await operator.query(
      `SELECT pg_catalog.pg_has_role($1,$2,'SET') AS can_set,
              pg_catalog.pg_has_role($1,$2,'USAGE') AS can_use,
              EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
                       WHERE m.member=$1::regrole AND m.roleid=$2::regrole
                         AND (m.admin_option OR m.set_option OR m.inherit_option)) AS any_membership`,
      [migratorRole, workerRole]
    )).rows[0];
    ok(workerAfter.can_set === false && workerAfter.can_use === false
      && workerAfter.any_membership === false,
      'R2 le runner révoque entièrement le bail worker du migrateur');

    // Migration suivante : l'admin peut réaccorder SET/INHERIT grâce à
    // l'ADMIN-only qu'il conserve comme créateur du worker.
    await operator.query(`GRANT ${workerRole} TO ${migratorRole} WITH SET TRUE, INHERIT TRUE, ADMIN FALSE`);
    const nextLease = (await operator.query(
      `SELECT pg_catalog.pg_has_role($1,$2,'SET') AS can_set,
              pg_catalog.pg_has_role($1,$2,'USAGE') AS can_use`,
      [migratorRole, workerRole]
    )).rows[0];
    ok(nextLease.can_set && nextLease.can_use,
      'R2 le bail SET/INHERIT peut être réaccordé pour la migration suivante');
    await operator.query(`SET ROLE ${migratorRole}`);
    const session = (await operator.query('SELECT current_user AS u, session_user AS s')).rows[0];
    ok(session.u === migratorRole && session.s === adminRole,
      'R2 le migrateur reprend son identité pendant la migration suivante');

    await operator.query('RESET ROLE');
    await operator.query(`REVOKE ${workerRole} FROM ${migratorRole}`);
    await operator.query(`REVOKE ${migratorRole} FROM ${adminRole}`);

    const workerAfterRows = (await operator.query(
      `SELECT admin_option, inherit_option, set_option
         FROM pg_catalog.pg_auth_members
        WHERE member=$1::regrole AND roleid=$2::regrole`,
      [migratorRole, workerRole]
    )).rows;
    ok(workerAfterRows.length === 0,
      'R2 aucun privilège worker ne subsiste sur le migrateur');

    const adminWorkerRows = (await operator.query(
      `SELECT admin_option, inherit_option, set_option
         FROM pg_catalog.pg_auth_members
        WHERE member=$1::regrole AND roleid=$2::regrole`,
      [adminRole, workerRole]
    )).rows;
    ok(adminWorkerRows.length === 1 && adminWorkerRows[0].admin_option
      && !adminWorkerRows[0].set_option && !adminWorkerRows[0].inherit_option,
      'R2 la session administrative conserve uniquement ADMIN-only sur le worker');

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
  const fonctionExistante = `tf_p106_preflight_${randomBytes(3).toString('hex')}`;
  await admin.query(`CREATE FUNCTION public.${fonctionExistante}() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid'`);
  const sql = `CREATE OR REPLACE FUNCTION public.${fonctionExistante}() RETURNS uuid
               LANGUAGE sql AS 'SELECT NULL::uuid';
               CREATE OR REPLACE FUNCTION public.tracefab_fonction_a_venir() RETURNS int
               LANGUAGE sql AS 'SELECT 1';`;
  const cibles = fonctionsCibles(sql);
  ok(cibles.length === 2 && cibles[0] === fonctionExistante,
    'R8 les fonctions visées sont lues dans le fichier de migration', cibles.join(', '));

  const pourAdmin = await propriétairesInjoignables(
    admin, roleExecutant, [{ nom: 'sonde', sql }],
  );
  ok(pourAdmin.length === 0,
    'R8 le propriétaire des fonctions n est pas bloqué (aucun faux refus)',
    pourAdmin.map((e) => e.fonction).join(', ') || 'aucun écart');

  // Le migrateur de la chaîne n'est créé qu'après ce contrôle. Utiliser
  // ici un rôle non-propriétaire réellement présent, sinon la sonde ne teste
  // qu'un nom absent et ne peut pas démontrer le refus attendu.
  const roleSansPropriete = `tf_p106_nonowner_${randomBytes(3).toString('hex')}`;
  await admin.query(`CREATE ROLE ${roleSansPropriete} NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB`);
  let pourRoleSansPropriete;
  try {
    pourRoleSansPropriete = await propriétairesInjoignables(
      admin, roleSansPropriete, [{ nom: 'sonde', sql }],
    );
  } finally {
    await admin.query(`DROP ROLE IF EXISTS ${roleSansPropriete}`)
    await admin.query(`DROP FUNCTION IF EXISTS public.${fonctionExistante}()`);
  }
  const attendu = pourRoleSansPropriete.some((e) =>
    e.fonction === fonctionExistante && e.proprietaire === roleExecutant);
  ok(attendu,
    'R8 un exécutant non-propriétaire existant est REFUSÉ avant la chaîne',
    pourRoleSansPropriete.map((e) => `${e.fonction}→${e.proprietaire}`).join(', ') || 'aucun écart');
  ok(!pourRoleSansPropriete.some((e) => e.fonction === 'tracefab_fonction_a_venir'),
    'R8 une fonction qui n existe pas encore n est pas un écart (création légitime)',
    pourRoleSansPropriete.map((e) => e.fonction).join(', '));

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
// Ce que cette suite a CREE, et donc ce qu'elle a le droit de detruire a la fin.
// Un role preexistant (CI, suite voisine) ne lui appartient pas : le supprimer
// casserait le banc pour les suites suivantes. Declare ici, hors du `try` de
// mesure, parce que le nettoyage R7 vit dans le `finally` EXTERIEUR.
const rolesPreexistants = new Set();
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
  const motDePasseAdmin = randomBytes(32).toString('hex');
  const motDePasseMigrateur = randomBytes(32).toString('hex');
  try {
    verrou = await verrouillerCluster({ urlProprietaire: urlAdmin });
    // `tracefab_app` est un objet de CLUSTER : en CI il est cree AVANT ce job
    // par `db:prepare-ci-role`, et il porte alors les privileges que la chaine
    // lui a accordes dans `tracefab_test`. R7 ne doit compter comme « jetable »
    // que ce que cette suite a elle-meme cree — sinon elle exige de detruire un
    // role qui ne lui appartient pas, et `DROP ROLE` echoue sur ses dependances
    // (« role cannot be dropped because some objects depend on it »).
    //
    // Mesure du 2026-11-12 : sans cette ligne, l'etape P10.6 de la CI laissait
    // `tracefab_app` derriere elle et R7 comptait 1 restant sur 2 crees.
    const appDejaLa = (await admin.query(
      'SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1', ['tracefab_app'])).rows.length > 0;
    if (appDejaLa) rolesPreexistants.add('tracefab_app');
    bootstrap = spawnSync(process.execPath, ['scripts/bootstrap_app_role.mjs'], {
      env: { ...process.env, DATABASE_URL: urlBase.toString(), TF_APP_PASSWORD: process.env.TF_APP_PASSWORD || 'p106_jetable' },
      encoding: 'utf8',
    });
    ok(bootstrap.status === 0, 'R6 rôle applicatif disponible avant la chaîne',
      (bootstrap.stderr || bootstrap.stdout || '').trim().split('\n').pop() || `code ${bootstrap.status}`);

    if (bootstrap.status === 0) {
      // Le grantor du migrateur est postgres (banc), pas tracefab_admin :
      // PostgreSQL interdit de rendre ADMIN à son propre grantor.
      // Les deux roles sont des objets de CLUSTER : ils peuvent avoir ete laisses
      // par une execution precedente interrompue, ou etre ceux qu'une autre suite
      // du meme banc vient de provisionner (`prepare_ci_migration_roles.mjs` en
      // CI — avec un mot de passe aleatoire et jamais publie). Un `CREATE ROLE`
      // inconditionnel rendait donc la chaine NON MESUREE dans ces deux cas
      // (« role "tracefab_migrator" already exists », puis 2 roles restants et
      // deux assertions en echec). On repart d'un etat propre, en ne touchant
      // qu'a des roles non superutilisateurs, et en reaffirmant leur contrat.
      for (const [role, mdp] of [[ 'tracefab_admin', motDePasseAdmin ], [ 'tracefab_migrator', motDePasseMigrateur ]]) {
        // Un role « preexistant » n'est pas seulement un nom deja pris : c'est
        // aussi un role qui POSSEDE des objets dans la base courante. Un
        // `DROP ROLE` echouerait alors sur ces dependances, et un
        // `DROP OWNED BY` les effacerait — c'est-a-dire detruirait un etat du
        // banc que cette suite n'a pas produit (mesure du 2026-11-12 : le
        // schema `public` et 11 fonctions de `tracefab_test` appartiennent a
        // `tracefab_worker` apres une application de la chaine).
        const dejaPresents = (await admin.query(
          `SELECT 1 FROM pg_catalog.pg_roles r
            WHERE r.rolname = $1
              AND (EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend d
                            WHERE d.refobjid = r.oid AND d.deptype = 'o'
                              AND d.dbid = (SELECT oid FROM pg_catalog.pg_database
                                             WHERE datname = pg_catalog.current_database()))
                OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
                            WHERE m.member = r.oid OR m.roleid = r.oid))`, [role])).rows.length > 0;
        if (dejaPresents) rolesPreexistants.add(role);
        const existant = (await admin.query(
          `SELECT rolcanlogin, rolsuper, rolcreaterole, rolbypassrls, rolcreatedb, rolreplication
             FROM pg_catalog.pg_roles WHERE rolname = $1`, [role])).rows[0];
        if (existant && (existant.rolsuper || existant.rolcreatedb || !existant.rolcanlogin || !existant.rolcreaterole)) {
          throw new Error(`role preexistant ${role} hors contrat ou privilegie : la suite ne le modifie pas`);
        }
        if (existant) {
          await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${mdp}' CREATEROLE BYPASSRLS NOINHERIT NOSUPERUSER NOCREATEDB NOREPLICATION`);
        } else {
          await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${mdp}' CREATEROLE BYPASSRLS NOINHERIT NOSUPERUSER NOCREATEDB NOREPLICATION`);
        }
      }
      await admin.query('GRANT tracefab_migrator TO tracefab_admin WITH ADMIN TRUE, SET FALSE, INHERIT FALSE');
      // `tracefab_worker` est un objet de CLUSTER : il peut preexister, cree par
      // une autre suite du meme banc ou par une execution precedente. Son
      // grantor n'est alors pas l'administrateur fraichement cree, qui n'en
      // detient aucune option, et le runner refuse — a juste titre — de fournir
      // un bail qu'il ne peut pas accorder. On delegue donc ADMIN depuis la
      // session d'administration, ADMIN SEUL, comme le fait la CI.
      const workerDejaLa = (await admin.query(
        'SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1', ['tracefab_worker'])).rows.length > 0;
      await admin.query(`
        DO $worker$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker') THEN
            EXECUTE 'CREATE ROLE tracefab_worker NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION';
          END IF;
        END
        $worker$`);
      // Un role de CLUSTER qui POSSEDE des objets dans la base courante ne peut
      // pas etre supprime par cette suite : il appartient a l'etat du banc, pas
      // a elle. Mesure du 2026-11-12 : `tracefab_worker` possede le schema
      // `public` et 11 fonctions de `tracefab_test` apres une application de la
      // chaine. Ni `DROP ROLE` (dependances) ni `DROP OWNED BY` (destruction
      // silencieuse, erreur avalee par `.catch`) ne sont acceptables : le role
      // est donc CONSERVE et l'assertion R7 ne le compte plus.
      if (workerDejaLa || (await admin.query(
        `SELECT 1 FROM pg_catalog.pg_roles r
          WHERE r.rolname = 'tracefab_worker'
            AND (EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend d
                          WHERE d.refobjid = r.oid AND d.deptype = 'o'
                            AND d.dbid = (SELECT oid FROM pg_catalog.pg_database
                                           WHERE datname = pg_catalog.current_database()))
              OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
                          WHERE m.member = r.oid OR m.roleid = r.oid))`)).rows.length > 0) {
        rolesPreexistants.add('tracefab_worker');
      }
      await admin.query('GRANT tracefab_worker TO tracefab_admin WITH ADMIN TRUE, SET FALSE, INHERIT FALSE');
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
    const urlAdminRunner = new URL(urlBase.toString());
    urlAdminRunner.username = 'tracefab_admin';
    urlAdminRunner.password = motDePasseAdmin;
    const urlMigrator = new URL(urlBase.toString());
    urlMigrator.username = 'tracefab_migrator';
    urlMigrator.password = motDePasseMigrateur;
    chaine = spawnSync(process.execPath, ['scripts/migrer_fidelement.mjs'], {
      env: {
        ...process.env,
        DATABASE_URL: urlMigrator.toString(),
        TF_ADMIN_URL: urlAdminRunner.toString(),
        TF_ALLOW_WRITE: 'oui',
      },
      encoding: 'utf8',
    });
  }
  const sortie = `${chaine.stdout || ''}${chaine.stderr || ''}`.trim().split('\n');
  ok(chaine.status === 0, 'R6 le runner applique la chaîne avec admin et migrateur non-SUPERUSER',
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
        WHERE r.rolname='tracefab_admin' AND w.rolname='tracefab_migrator'
          AND (m.set_option OR m.inherit_option)
      ) AS actif`)).rows[0].actif;
    ok(bailAdminActif === false,
      'R7 aucun bail SET/INHERIT du migrateur ne subsiste sur la session administrative');

    const adminWorkerRows = (await client.query(
      `SELECT admin_option, set_option, inherit_option
         FROM pg_catalog.pg_auth_members m
         JOIN pg_catalog.pg_roles r ON r.oid=m.member
         JOIN pg_catalog.pg_roles w ON w.oid=m.roleid
        WHERE r.rolname='tracefab_admin' AND w.rolname='tracefab_worker'`
    )).rows;
    ok(adminWorkerRows.length === 1 && adminWorkerRows.every((r) =>
      r.admin_option && !r.set_option && !r.inherit_option),
      'R7 le runner conserve ADMIN-only sur tracefab_worker, sans SET ni INHERIT');

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
    await admin.query('REVOKE tracefab_worker FROM tracefab_admin').catch(() => {});
    await admin.query('REVOKE tracefab_migrator FROM tracefab_admin').catch(() => {});
    // PAS de `DROP OWNED BY` ici. Cette suite ne CREE d'objets que dans
    // `baseTravail`, detruite juste au-dessus : ses roles n'ont donc plus rien
    // a eux. En revanche `DROP OWNED BY` s'applique a la base COURANTE
    // (`tracefab_test`) et effacerait les objets d'un role PREEXISTANT — mesure
    // du 2026-11-12 : le schema `public` et 11 fonctions appartiennent a
    // `tracefab_worker` dans la base de test, et l'instruction les detruisait
    // silencieusement (erreur avalee par `.catch(() => {})`), avant d'echouer
    // sur `DROP ROLE`. Le nettoyage est donc limite aux roles CREES ici.
    if (rolesPreexistants.has('tracefab_worker')) {
      console.log('  info  tracefab_worker preexistait ou possede des objets : conserve');
    } else {
      await admin.query('DROP ROLE IF EXISTS tracefab_worker').catch((e) => {
        console.error(`  info  nettoyage tracefab_worker : ${e.message}`);
      });
    }
    for (const role of ['tracefab_migrator', 'tracefab_admin']) {
      if (rolesPreexistants.has(role)) {
        console.log(`  info  ${role} preexistait : conserve (il n appartient pas a cette suite)`);
        continue;
      }
      await admin.query(`DROP ROLE IF EXISTS ${role}`).catch((e) => {
        console.error(`  info  nettoyage ${role} : ${e.message}`);
      });
    }
    await admin.query('DROP ROLE IF EXISTS tracefab_app').catch((e) => {
      console.error(`  info  nettoyage tracefab_app : ${e.message}`);
    });
    // Seuls les roles CREES par cette suite doivent avoir disparu ; un role
    // preexistant n'a jamais ete a elle.
    const jetables = ['tracefab_migrator', 'tracefab_worker', 'tracefab_admin', 'tracefab_app'];
    const attendusSupprimes = jetables.filter((r) => !rolesPreexistants.has(r));
    const rolesRestants = (await admin.query(
      'SELECT count(*)::int AS n FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])',
      [attendusSupprimes])).rows[0].n;
    ok(rolesRestants === 0, 'R7 les rôles jetables CREES par la suite sont supprimés',
      `${rolesRestants} restant(s) sur ${attendusSupprimes.length} créé(s)`
      + (rolesPreexistants.size ? ` ; préexistants conservés : ${[...rolesPreexistants].join(', ')}` : ''));
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
