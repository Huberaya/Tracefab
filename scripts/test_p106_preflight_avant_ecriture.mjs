#!/usr/bin/env node
/**
 * P10.8 — LE PRÉFLIGHT D6 REFUSE-T-IL AVANT TOUTE ÉCRITURE, SUR UNE BASE DE
 * FORME PRODUCTION ?
 *
 * POURQUOI CE TEST EXISTE
 *
 * P10.6 a livré un préflight de propriété (D6) qui refuse qu'une migration
 * remplace une fonction dont l'exécutant ne peut pas endosser le propriétaire
 * (`CREATE OR REPLACE FUNCTION` exige la propriété, mesuré : 42501).
 *
 * P10.7 l'a rendu PAR MIGRATION, parce qu'un contrôle global refusait à tort la
 * chaîne au rang 60 — la propriété change EN COURS de chaîne.
 *
 * Ce que personne n'avait figé dans un test : sur l'état EXACT de la
 * production — 67 migrations appliquées, fonctions détenues par un autre rôle,
 * deux migrations en attente — le refus tombe-t-il AVANT la première écriture,
 * ou au milieu ?
 *
 * La différence n'est pas académique :
 *
 *   - refus AVANT  : la base est intacte, on corrige la propriété, on rejoue ;
 *   - refus AU MILIEU : une ligne d'échec dans `_prisma_migrations`, une
 *     migration à moitié appliquée, et une chaîne qu'on ne peut plus rejouer
 *     sans intervention manuelle.
 *
 * CE QUE CE TEST MESURE (pas ce qu'il suppose)
 *
 *   E1  la chaîne, jouée par le PROPRIÉTAIRE jusqu'au rang 67, s'applique —
 *       c'est le contrôle POSITIF : le préflight ne refuse pas quand
 *       l'exécutant est propriétaire ;
 *   E2  sur cet état, `tracefab_current_user_id()` appartient bien au
 *       propriétaire et NON au rôle de migration ;
 *   E3  rejouée par `tracefab_migrator`, la chaîne s'arrête en code 3 avec un
 *       REFUS nommé, qui cite la migration et le propriétaire ;
 *   E4  le registre `_prisma_migrations` n'a PAS bougé : même nombre de lignes,
 *       aucune ligne pour la migration refusée ;
 *   E5  rien de partiel n'a été laissé : la fonction que la migration refusée
 *       crée (`tracefab_identity_jeton_utilisateur`) n'existe pas ;
 *   E6  le refus n'est pas contournable par un drapeau : la migration n'est pas
 *       déclarée assistée, et sans `TF_ALLOW_ELEVATION` aucune élévation n'est
 *       tentée ;
 *   E7  la base de travail est détruite.
 *
 * Aucune écriture hors de la base jetable. Aucun secret affiché : le mot de
 * passe du rôle de migration n'apparaît que dans l'URL passée au processus
 * fils, jamais dans une sortie.
 *
 * Sortie : 0 conforme · 1 régression · 2 non exécuté · 3 refus de cible.
 */
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { verrouillerCluster } from './lib/ephemeral-db.mjs';
import { exigeAssistance } from './lib/migrations_assistees.mjs';

const MIGRATION_ATTENDUE = '20261031120000_identite_hmac_liee_au_contexte';
// Rang 66 : l'état exact de la production au 02/11/2026 — tout est appliqué
// SAUF les deux migrations P10.5/P10.6. C'est ce qui rend le refus mesurable
// sur la PREMIÈRE migration en attente, donc avant toute écriture.
const DERNIERE_APPLIQUEE = '20261030140000_ingest_payload_role_guard_and_acl';

const urlAdmin = (process.env.DATABASE_URL || '').trim();
if (!urlAdmin) {
  console.error('  NON EXECUTE — DATABASE_URL est requise.');
  process.exit(2);
}
const hote = (() => { try { return new URL(urlAdmin).hostname; } catch { return ''; } })();
if (!/^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(hote)) {
  console.error(`  REFUS — cible non locale (${hote || 'illisible'}). Ce test crée une base.`);
  process.exit(3);
}

const url = new URL(urlAdmin);
const roleProprietaire = decodeURIComponent(url.username) || 'postgres';
const motDePasseMigrator = process.env.TF_MIGRATOR_PASSWORD || 'isolation_ci_jetable';

let echecs = 0;
let assertions = 0;
function ok(condition, etiquette, detail) {
  assertions += 1;
  if (condition) {
    console.log(`    ok    ${etiquette}`);
  } else {
    echecs += 1;
    console.log(`    ECHEC ${etiquette}${detail === undefined ? '' : ` — observé : ${detail}`}`);
  }
}

console.log('\n  PRÉFLIGHT D6 — le refus tombe-t-il avant la première écriture ?');

const baseTravail = `tf_p106_d6_${randomBytes(3).toString('hex')}`;
const urlBase = new URL(urlAdmin);
urlBase.pathname = `/${baseTravail}`;
/**
 * L'exécutant du refus, choisi à l'exécution.
 *
 * Le scénario veut un rôle NON superuser, NON membre du propriétaire : c'est la
 * seule propriété dont le préflight dépend. `tracefab_migrator` est le rôle réel
 * de la production, mais il n'existe pas forcément sur un cluster de CI qui ne
 * l'a pas provisionné — et un test qui suppose son existence échoue pour une
 * raison qui n'a rien à voir avec le préflight (constaté en CI le 03/11).
 *
 * On l'essaie donc, et à défaut on crée un rôle JETABLE borné `tf_d6_*`, détruit
 * à la fin. Les deux modes mesurent la même chose ; le mode employé est écrit
 * dans la sortie, pour qu'on ne puisse pas confondre « le rôle réel a refusé »
 * avec « un rôle de sonde a refusé ».
 */
const roleReel = 'tracefab_migrator';
let roleExecutant = roleReel;
let urlMigrator = null;
let roleJetableCree = null;

function urlPour(role, motDePasse) {
  const u = new URL(urlBase.toString());
  u.username = role;
  u.password = motDePasse;
  return u;
}

const admin = new pg.Client({ connectionString: urlAdmin, ssl: sslDepuisUrl(urlAdmin) });
await admin.connect();

let verrou = null;
let registreAvant = null;
// Administrateur de banc : declare ici parce que le nettoyage vit dans le
// `finally` EXTERIEUR, hors de la portee du `try` de mesure.
let adminBancs = null;
let mdpAdminBancs = null;
let adminBancsCree = false;

try {
  await admin.query(`CREATE DATABASE ${baseTravail}`);
  console.log(`\n  base jetable ${baseTravail}`);

  // --- Le rôle applicatif de CLUSTER préexiste : c'est la situation d'une
  //     seconde base, pas celle d'un cluster vierge.
  let bootstrap;
  try {
    verrou = await verrouillerCluster({ urlProprietaire: urlAdmin });
    bootstrap = spawnSync(process.execPath, ['scripts/bootstrap_app_role.mjs'], {
      env: {
        ...process.env,
        DATABASE_URL: urlBase.toString(),
        TF_APP_PASSWORD: process.env.TF_APP_PASSWORD || 'p106_jetable',
      },
      encoding: 'utf8',
    });
  } finally {
    if (verrou) { await verrou.relacher(); verrou = null; }
  }
  ok(bootstrap.status === 0, 'E0 rôle applicatif disponible avant la chaîne',
    (bootstrap.stderr || bootstrap.stdout || '').trim().split('\n').pop() || `code ${bootstrap.status}`);

  // --- E1 : la chaîne jusqu'au rang 67, jouée par `tracefab_migrator` ------
  //
  // E1 la jouait par le PROPRIÉTAIRE (`postgres`). Depuis que la 62e migration
  // n'est plus « assistée » mais PRÉPROVISIONNÉE, le runner refuse une session
  // qui n'est pas le migrateur : `roleExecutant !== 'tracefab_migrator'`, et le
  // contrôle positif s'arrêtait au rang 62. Le scénario ne ressemblait plus à
  // la production, où c'est toujours le migrateur qui applique la chaîne.
  //
  // On lui donne donc le même cadre qu'en production, celui que reproduit
  // `test_p106_rejouabilite_chaine` : un administrateur conforme (CREATEROLE
  // non-superuser, ADMIN sur migrateur et worker), `pgcrypto` installé par
  // l'administration — le migrateur ne reçoit jamais CREATE EXTENSION — et le
  // schéma `public` qui lui appartient.
  adminBancs = 'tf_d6_admin';
  mdpAdminBancs = `adm_${baseTravail.slice(-6)}`;
  // LE MOT DE PASSE DU MIGRATEUR DOIT ETRE POSE DANS LES DEUX CAS.
  //
  // Il est utilise plus bas pour OUVRIR la session du migrateur. Quand
  // `TF_ADMIN_URL` est fourni, le bloc de provisionnement ci-dessous est
  // entierement saute — donc le mot de passe restait celui, inconnu, du role
  // deja present, et la chaine echouait en `auth_failed` AVANT la premiere
  // migration. Mesure du 2026-11-13 : E1 tombait, puis E2 sur « relation
  // _prisma_migrations does not exist » — le symptome, pas la cause.
  //
  // On reprend donc le mot de passe de l'environnement quand il est fourni
  // (c'est celui que le cluster connait), et on le pose avec l'autorite
  // administrative dont on dispose. Le role reste le meme : ce n'est pas une
  // elevation, c'est la session qui doit pouvoir s'ouvrir.
  const mdpMigrateurBancs = (process.env.TF_MIGRATOR_PASSWORD || '').trim()
    || `mig_${baseTravail.slice(-6)}`;
  if (!(process.env.TF_ADMIN_URL || '').trim()) {
    await admin.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${adminBancs}') THEN
          CREATE ROLE ${adminBancs} LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS NOCREATEDB;
        END IF;
      END $$;`);
    await admin.query(`ALTER ROLE ${adminBancs} WITH LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS NOCREATEDB PASSWORD ${admin.escapeLiteral(mdpAdminBancs)}`);
    await admin.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_worker') THEN
          CREATE ROLE tracefab_worker NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION;
        END IF;
      END $$;`);
    await admin.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_migrator') THEN
          CREATE ROLE tracefab_migrator LOGIN CREATEROLE NOCREATEDB BYPASSRLS NOSUPERUSER INHERIT;
        END IF;
      END $$;`);
    await admin.query(`ALTER ROLE tracefab_migrator WITH LOGIN CREATEROLE NOCREATEDB BYPASSRLS NOSUPERUSER INHERIT PASSWORD ${admin.escapeLiteral(mdpMigrateurBancs)}`);
    await admin.query(`GRANT tracefab_worker TO ${adminBancs} WITH ADMIN TRUE, SET FALSE, INHERIT FALSE`);
    await admin.query(`GRANT tracefab_migrator TO ${adminBancs} WITH ADMIN TRUE, SET FALSE, INHERIT FALSE`);
    adminBancsCree = true;
  } else {
    // `TF_ADMIN_URL` fourni : on ne cree aucun role, mais la session du
    // migrateur doit pouvoir s'ouvrir avec le mot de passe qu'on va utiliser.
    // L'administrateur du cluster en est capable (`CREATEROLE`).
    await admin.query(
      `ALTER ROLE tracefab_migrator WITH LOGIN CREATEROLE NOCREATEDB BYPASSRLS NOSUPERUSER INHERIT PASSWORD ${admin.escapeLiteral(mdpMigrateurBancs)}`,
    );
  }
  // Prérequis d'administration que la production installe et que le migrateur
  // ne peut pas poser lui-même.
  {
    const prep = new pg.Client({ connectionString: urlBase.toString(), ssl: sslDepuisUrl(urlBase.toString()) });
    await prep.connect();
    try {
      await prep.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await prep.query(`GRANT CREATE ON DATABASE ${baseTravail} TO tracefab_migrator`);
      await prep.query('ALTER SCHEMA public OWNER TO tracefab_migrator');
      await prep.query(`GRANT CONNECT ON DATABASE ${baseTravail} TO tracefab_migrator`);
    } finally {
      await prep.end();
    }
  }
  const envChaine = {
    ...process.env,
    DATABASE_URL: urlPour('tracefab_migrator', mdpMigrateurBancs).toString(),
    TF_ALLOW_WRITE: 'oui',
    ...(process.env.TF_ADMIN_URL ? {} : {
      TF_ADMIN_URL: `postgresql://${adminBancs}:${mdpAdminBancs}@${new URL(urlAdmin).host}/${baseTravail}`,
    }),
  };
  const jusquA = spawnSync(process.execPath, ['scripts/migrer_fidelement.mjs', '--jusqu-a', DERNIERE_APPLIQUEE], {
    env: envChaine,
    encoding: 'utf8',
  });
  const lignesJusquA = `${jusquA.stdout || ''}${jusquA.stderr || ''}`.trim().split('\n');
  ok(jusquA.status === 0,
    'E1 jouée par le MIGRATEUR, la chaîne s applique jusqu au rang 66 (contrôle positif)',
    jusquA.status === 0
      ? lignesJusquA.filter((l) => /appliquee\(s\)/.test(l)).pop()
      : lignesJusquA.filter((l) => /ECHEC|REFUS/.test(l)).slice(-1)[0]);

  // LA PRÉCONDITION DU SCÉNARIO, rétablie explicitement.
  //
  // D6 existe pour mesurer un refus : « cette migration remplace une fonction
  // dont l'EXÉCUTANT ne peut pas endosser le propriétaire ». Il faut donc que
  // cette fonction appartienne réellement au propriétaire, et non au migrateur.
  //
  // Sur `main`, E1 était jouée par le PROPRIÉTAIRE (`postgres`) : la fonction
  // lui appartenait donc par construction, et la précondition était un effet de
  // bord. Depuis que la 62e migration n'est plus assistée mais préprovisionnée,
  // E1 doit être jouée par le migrateur — et la fonction lui appartient alors,
  // ce qui DISSOUT le scénario : le préflight n'a plus rien à refuser, et E2/E3
  // passaient au vert sans rien mesurer.
  //
  // On rend donc la fonction au propriétaire, comme l'état de production que ce
  // contrôle prétend reproduire. C'est une mise en scène assumée, écrite ici et
  // non déduite d'un effet de bord : la propriété est l'hypothèse testée.
  {
    // `admin` est connecte a la base de CLUSTER (`DATABASE_URL`), pas a la base
    // de travail : c'est sur `baseTravail` que la chaine vient de s'appliquer.
    const surBase = new pg.Client({ connectionString: urlBase.toString(), ssl: sslDepuisUrl(urlBase.toString()) });
    await surBase.connect();
    try {
      await surBase.query(`ALTER FUNCTION public.tracefab_current_user_id() OWNER TO ${roleProprietaire}`);
    } catch (e) {
      console.error(`  info  propriete non rendue au proprietaire : ${e.message.split('\n')[0]}`);
    } finally {
      await surBase.end();
    }
  }

  const client = new pg.Client({ connectionString: urlBase.toString(), ssl: sslDepuisUrl(urlBase.toString()) });
  await client.connect();
  try {
    const etat = (await client.query(
      'SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL')).rows[0].n;
    registreAvant = etat;
    ok(etat >= 60, 'E1 le registre porte l historique jusqu au rang 66', `${etat} migration(s)`);

    // La borne est atteinte, et les DEUX migrations attendues sont absentes :
    // c'est cet etat-là, et pas un autre, qui rend le refus mesurable.
    const noms = (await client.query(
      'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL')).rows
      .map((r) => r.migration_name);
    ok(noms.includes(DERNIERE_APPLIQUEE),
      'E1 la dernière migration déployée est bien appliquée', DERNIERE_APPLIQUEE);
    ok(!noms.includes(MIGRATION_ATTENDUE)
      && !noms.includes('20261102120000_identite_stricte_email_et_rotation'),
      'E1 les deux migrations P10.5/P10.6 sont EN ATTENTE — état de la production',
      noms.filter((n) => n.startsWith('20261031') || n.startsWith('20261102')).join(', ') || 'aucune');

    // --- E2 : la propriété est bien celle du propriétaire, pas du migrator --
    const proprio = (await client.query(
      `SELECT pg_catalog.pg_get_userbyid(p.proowner) AS proprietaire
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'tracefab_current_user_id'`)).rows;
    ok(proprio.length === 1 && proprio[0].proprietaire === roleProprietaire,
      'E2 tracefab_current_user_id appartient au propriétaire, PAS au rôle de migration',
      proprio.map((r) => r.proprietaire).join(', ') || 'fonction absente');

    // --- E6 (première moitié) : la migration n'est pas assistée -------------
    ok(exigeAssistance(MIGRATION_ATTENDUE) === false,
      'E6 la migration refusée n est PAS déclarée assistée — aucune élévation ne la concerne',
      String(exigeAssistance(MIGRATION_ATTENDUE)));

    // La migration en attente est bien celle qu'on croit, et elle remplace
    // effectivement une fonction existante : sans cela le test ne mesurerait
    // rien.
    const sqlRefusee = (await import('node:fs')).readFileSync(
      new URL(`../prisma/migrations/${MIGRATION_ATTENDUE}/migration.sql`, import.meta.url), 'utf8');
    ok(/CREATE OR REPLACE FUNCTION public\.tracefab_current_user_id/.test(sqlRefusee),
      'E2 la migration en attente remplace bien tracefab_current_user_id (le refus est motivé)');
  } finally {
    await client.end();
  }

  // --- Le rôle exécutant : tracefab_migrator s'il existe, sinon un rôle jetable
  {
    const essai = new pg.Client({
      connectionString: urlPour(roleReel, motDePasseMigrator).toString(),
      ssl: sslDepuisUrl(urlBase.toString()),
      connectionTimeoutMillis: 5000,
    });
    let disponible = false;
    try {
      await essai.connect();
      disponible = true;
    } catch {
      disponible = false;
    } finally {
      await essai.end().catch(() => {});
    }
    if (disponible) {
      urlMigrator = urlPour(roleReel, motDePasseMigrator);
      ok(true, `E3 exécutant : ${roleReel} existe sur ce cluster — rôle réel mesuré`);
    } else {
      roleExecutant = `tf_d6_${randomBytes(3).toString('hex')}`;
      const mdp = randomBytes(12).toString('hex');
      // Un rôle est un objet de CLUSTER : même section critique que les autres
      // suites qui provisionnent. Relâché immédiatement après le CREATE.
      try {
        verrou = await verrouillerCluster({ urlProprietaire: urlAdmin });
        await admin.query(
          `CREATE ROLE ${roleExecutant} LOGIN PASSWORD '${mdp}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`);
        roleJetableCree = roleExecutant;
      } finally {
        if (verrou) { await verrou.relacher(); verrou = null; }
      }
      urlMigrator = urlPour(roleExecutant, mdp);
      ok(true, `E3 exécutant : ${roleReel} absent — rôle jetable ${roleExecutant} créé pour la mesure`);
    }
  }

  // Le rôle de migration doit pouvoir TRAVAILLER sur cette base : c'est le cas
  // en production (il possède le registre et écrit dans `public`). Sans ces
  // droits, le test mesurerait un refus de CONNEXION, pas le refus du
  // préflight — et passerait au vert pour la mauvaise raison.
  {
    const prep = new pg.Client({ connectionString: urlBase.toString(), ssl: sslDepuisUrl(urlBase.toString()) });
    await prep.connect();
    try {
      await prep.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${roleExecutant}`);
      await prep.query(`GRANT ALL PRIVILEGES ON TABLE public._prisma_migrations TO ${roleExecutant}`);
      await prep.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${roleExecutant}`);
      await prep.query(`GRANT CONNECT ON DATABASE ${baseTravail} TO ${roleExecutant}`);
    } finally {
      await prep.end();
    }
  }

  // --- E3/E4/E5 : la chaîne rejouée par le rôle de migration REFUSE --------
  const refus = spawnSync(process.execPath, ['scripts/migrer_fidelement.mjs'], {
    env: {
      ...process.env,
      DATABASE_URL: urlMigrator.toString(),
      TF_ALLOW_WRITE: 'oui',
      // Volontairement ABSENT : TF_ADMIN_URL / TF_ALLOW_ELEVATION. Le refus doit
      // tenir sans élévation, et il ne doit pas en réclamer une.
      TF_ALLOW_ELEVATION: '',
      TF_ADMIN_URL: '',
    },
    encoding: 'utf8',
  });
  const sortieRefus = `${refus.stdout || ''}${refus.stderr || ''}`;

  ok(refus.status === 3, `E3 la chaîne rejouée par ${roleExecutant} sort en code 3`, `code ${refus.status}`);
  ok(/REFUS/.test(sortieRefus) && sortieRefus.includes(MIGRATION_ATTENDUE),
    'E3 le refus est NOMMÉ : il cite la migration', sortieRefus.split('\n').filter((l) => /REFUS/.test(l))[0] || 'aucun REFUS');
  ok(new RegExp(`appartient a ${roleProprietaire}`).test(sortieRefus),
    'E3 le refus nomme le propriétaire qu il faudrait endosser',
    sortieRefus.split('\n').filter((l) => /appartient a/.test(l))[0] || 'propriétaire non nommé');
  ok(/Rien n a ete joue/.test(sortieRefus),
    'E3 le refus DÉCLARE n avoir rien joué', sortieRefus.split('\n').slice(-2).join(' ').slice(0, 120));

  const apres = new pg.Client({ connectionString: urlBase.toString(), ssl: sslDepuisUrl(urlBase.toString()) });
  await apres.connect();
  try {
    // --- E4 : le registre n'a pas bougé -----------------------------------
    const n = (await apres.query(
      'SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL')).rows[0].n;
    ok(n === registreAvant, 'E4 le registre est INCHANGÉ — aucune ligne écrite', `${registreAvant} → ${n}`);

    const trace = (await apres.query(
      'SELECT count(*)::int AS n FROM _prisma_migrations WHERE migration_name = $1',
      [MIGRATION_ATTENDUE])).rows[0].n;
    ok(trace === 0, 'E4 aucune ligne d échec pour la migration refusée', `${trace} ligne(s)`);

    // --- E5 : rien de partiel ---------------------------------------------
    const partiel = (await apres.query(
      `SELECT count(*)::int AS n FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
        WHERE ns.nspname = 'public' AND p.proname = 'tracefab_identity_jeton_utilisateur'`)).rows[0].n;
    ok(partiel === 0, 'E5 la fonction créée par la migration refusée n existe PAS (aucun état partiel)', `${partiel}`);

    const table = (await apres.query(
      "SELECT count(*)::int AS n FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'public' AND c.relname = 'tracefab_identity_cles'")).rows[0].n;
    ok(table === 0, 'E5 la table des clés n a PAS été créée (preuve que la migration n a pas commencé)', `${table}`);

    // --- E6 (seconde moitié) : le rôle de migration n'a pas gagné de privilège
    const sup = (await apres.query(
      'SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = $1', [roleExecutant])).rows[0];
    ok(sup && sup.rolsuper === false,
      'E6 le rôle de migration n a reçu AUCUNE élévation résiduelle', `super=${sup?.rolsuper}`);
  } finally {
    await apres.end();
  }
} catch (e) {
  ok(false, 'E le scénario a pu être mesuré', (e.message || '').split('\n')[0].slice(0, 120));
} finally {
  await admin.query(
    `SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity
      WHERE datname = $1 AND pid <> pg_catalog.pg_backend_pid()`, [baseTravail]).catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS ${baseTravail} WITH (FORCE)`).catch((e) => {
    console.error(`  info  destruction de ${baseTravail} : ${e.message}`);
  });
  const restantes = (await admin.query(
    'SELECT count(*)::int AS n FROM pg_database WHERE datname = $1', [baseTravail])).rows[0].n;
  ok(restantes === 0, 'E7 la base de travail est détruite (aucune base résiduelle)', `${restantes} restante(s)`);

  if (roleJetableCree) {
    await admin.query(`DROP ROLE IF EXISTS ${roleJetableCree}`).catch((e) => {
      console.error(`  info  suppression du rôle ${roleJetableCree} : ${e.message}`);
    });
    const reste = (await admin.query(
      'SELECT count(*)::int AS n FROM pg_catalog.pg_roles WHERE rolname = $1', [roleJetableCree])).rows[0].n;
    ok(reste === 0, 'E7 le rôle jetable est détruit (aucun rôle résiduel)', `${reste} restant(s)`);
  }
  // L'administrateur de banc n'existe que si la suite l'a cree.
  if (adminBancsCree) {
    await admin.query(`REVOKE tracefab_worker FROM ${adminBancs}`).catch(() => {});
    await admin.query(`REVOKE tracefab_migrator FROM ${adminBancs}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${adminBancs}`).catch((e) => {
      console.error(`  info  suppression de l administrateur de banc : ${e.message}`);
    });
  }
  if (verrou) await verrou.relacher();
}

await admin.end();

console.log('');
if (echecs === 0) {
  console.log(`  P10.8 preflight avant ecriture : ${assertions} assertions — le refus tombe AVANT la premiere ecriture.`);
  process.exit(0);
}
console.log(`  ${echecs} ÉCHEC sur ${assertions} assertions.`);
process.exit(1);
