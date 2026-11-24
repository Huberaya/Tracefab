#!/usr/bin/env node
/**
 * Répétition bout en bout sur PostgreSQL (PGlite) de la réconciliation et de
 * l'activation stricte P10.7 / P12 sur la chaîne de 100 migrations.
 *
 * Ce banc exécute sur un vrai moteur PostgreSQL (sans toucher aucune base
 * distante) l'intégralité de la séquence opérateur décrite dans
 * `docs/security/2026-11-02-p107-plan-activation-stricte.md` :
 *
 *   1. Reconstitution de l'état Production mesuré (56 migrations attestées dans
 *      `_prisma_migrations`), sous une topologie fidèle à Neon (`neondb_owner`,
 *      `tracefab_migrator` NOSUPERUSER BYPASSRLS, `tracefab_app` NOSUPERUSER
 *      NOBYPASSRLS).
 *   2. Exécution en lecture seule du préflight du registre (`84` fonctions
 *      historiques présentes, `missing_functions = 0`, `wrong_owner_count = 0`)
 *      et de la sonde P10.7 (`sonde_p107_etat_cible.mjs`) sur l'état avant
 *      réconciliation.
 *   3. Application transactionnelle dans l'ordre lexicographique strict des 44
 *      migrations restantes (10 historiques absentes + 34 nouvelles = 100 au
 *      total), avec baux `tracefab_worker` bornés aux seules 7 migrations de
 *      `MIGRATIONS_AVEC_WORKER_TEMPORAIRE`.
 *   4. Vérification des postconditions en lecture seule après la 100e migration :
 *      - `100` migrations terminées, `0` en échec, `9/9` jalons P10.5→P12 présents ;
 *      - `93` fonctions dans `tracefab_runtime_function_registry` (`missing_post_chain_functions = 0`) ;
 *      - `mode_identite = 'permissif'` et `mode_identite_systeme = 'permissif'` ;
 *      - `13` opérations système gardées, `0` non gardée, prédicat système fermé à `tracefab_app` ;
 *      - `tracefab_migrator` a `EXECUTE` sur `tracefab_current_user_email()` (P12) et n'est membre d'aucun worker ;
 *      - politique `organizations_worker_update` présente sur `public.organizations`.
 *   5. Provisionnement d'une clé HMAC v1, preuve d'aller-retour cryptographique
 *      via les vrais signeurs TypeScript (`signerIdentite` et `signerIdentiteSysteme`),
 *      bascule séquentielle `systeme_strict = true` puis `strict = true`, preuve
 *      fail-closed des appels non signés / d'usage croisé (`tracefab_identity`
 *      vs `tracefab_system`) et succès des appels signés (y compris archivage
 *      d'organisation sous `FORCE ROW LEVEL SECURITY`).
 *   6. Rotation sans coupure vers une clé v2 (chevauchement v1+v2), désactivation
 *      de v1 (rejet immédiat des jetons v1, maintien des jetons v2), puis retour
 *      arrière R1a (`systeme_strict = false`) et R1b (`strict = false`).
 *
 * Commande :
 *   npm run test:p107:rehearsal-100
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { ECARTS } from './lib/ecarts_migrations.mjs';
import { MIGRATIONS_AVEC_WORKER_TEMPORAIRE, exigeBailWorker } from './lib/migrations_worker_temporaire.mjs';
import { propriétairesInjoignables } from './lib/preflight_proprietaires.mjs';
import { RUNTIME_FUNCTION_NAMES } from './lib/tracefab_runtime_functions.mjs';
import { CHEMIN_SONDE, decouperSonde, executerSonde } from './sonde_p107_etat_cible.mjs';
import { signerIdentite } from '../api/_lib/identite-jeton.ts';
import { signerIdentiteSysteme } from '../api/_lib/identite-systeme.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = path.join(ROOT, 'prisma/migrations');
const FICHIER_SONDE_REGISTRE = path.join(ROOT, 'docs/security/2026-11-11-p107-production-registry-preflight.sql');

let PGlite, pgcrypto, uuid_ossp;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto'));
  ({ uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp'));
} catch {
  console.error('ECHEC  @electric-sql/pglite introuvable — executer `npm ci`.');
  process.exit(1);
}

let assertions = 0;
let echecs = 0;
function ok(condition, libelle, detail = '') {
  assertions += 1;
  if (condition) {
    console.log(`  ok    ${libelle}`);
  } else {
    echecs += 1;
    console.error(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
  }
}

function adapterPglite(pglite) {
  return {
    async query(sql, params) {
      const res = await pglite.query(sql, params);
      return { rows: res.rows, rowCount: res.rows.length };
    },
  };
}

function sha256Fichier(chemin) {
  return crypto.createHash('sha256').update(fs.readFileSync(chemin)).digest('hex');
}

const tousDossiers = fs.readdirSync(MIGRATIONS_DIR).filter((d) => /^\d{14}_/.test(d)).sort();
const dixAbsentes = Object.entries(ECARTS)
  .filter(([, meta]) => meta.historique === 'ABSENTE')
  .map(([nom]) => nom)
  .sort();
const nouvelles = tousDossiers.filter((d) => d > '20261028150000_reconcile_plm_erp_sync_job_policies');
const enAttente = [...dixAbsentes, ...nouvelles].sort();
const cinquanteSixAppliquees = tousDossiers.filter((d) => !enAttente.includes(d));
const totalAttendu = cinquanteSixAppliquees.length + enAttente.length;

console.log(`\n  0. Arithmetique de la chaine de ${totalAttendu} migrations`);
ok(tousDossiers.length >= 100 && tousDossiers.length === totalAttendu,
  `le depot porte une chaine coherente dans prisma/migrations (${tousDossiers.length})`, `${tousDossiers.length}`);
ok(cinquanteSixAppliquees.length === 56, '56 migrations attestees en Production constituent la base de depart', `${cinquanteSixAppliquees.length}`);
ok(dixAbsentes.length === 10, '10 migrations historiques absentes du journal Production', `${dixAbsentes.length}`);
ok(nouvelles.length >= 34 && nouvelles.length === tousDossiers.length - 66,
  `${nouvelles.length} migrations nouvelles posterieures au releve`, `${nouvelles.length}`);
ok(enAttente.length === dixAbsentes.length + nouvelles.length,
  `${enAttente.length} migrations a appliquer dans l ordre lexicographique strict (56 + ${enAttente.length} = ${totalAttendu})`,
  `${enAttente.length}`);
ok(MIGRATIONS_AVEC_WORKER_TEMPORAIRE.length === 7, '7 migrations exigent un bail temporaire tracefab_worker', `${MIGRATIONS_AVEC_WORKER_TEMPORAIRE.length}`);
ok(RUNTIME_FUNCTION_NAMES.length === 93, 'le registre runtime canonique compte 93 fonctions', `${RUNTIME_FUNCTION_NAMES.length}`);

/* ==========================================================================
   1. Topologie Neon fidèle et reconstitution des 56 migrations Production
   ========================================================================== */

console.log('\n  1. Reconstitution des 56 migrations Production sous roles non-superusers');

const pg = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
await pg.waitReady;

await pg.exec(`
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  CREATE EXTENSION IF NOT EXISTS pgcrypto;

  DO $$
  DECLARE r record;
  BEGIN
    FOR r IN
      SELECT p.oid::regprocedure AS sig
        FROM pg_depend d
        JOIN pg_extension e ON e.oid = d.refobjid
        JOIN pg_proc p ON p.oid = d.objid
       WHERE d.classid = 'pg_proc'::regclass
         AND d.deptype = 'e'
         AND e.extname IN ('pgcrypto', 'uuid-ossp')
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.sig);
    END LOOP;
  END $$;

  CREATE ROLE neondb_owner NOLOGIN NOSUPERUSER NOCREATEDB CREATEROLE BYPASSRLS;
  CREATE ROLE tracefab_migrator LOGIN PASSWORD 'm' NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
  CREATE ROLE tracefab_app LOGIN PASSWORD 'a' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

  ALTER SCHEMA public OWNER TO tracefab_migrator;
  GRANT USAGE, CREATE ON SCHEMA public TO tracefab_migrator;
  GRANT USAGE ON SCHEMA public TO tracefab_app;
  GRANT USAGE ON SCHEMA public TO neondb_owner;

  DO $$
  DECLARE r record;
  BEGIN
    FOR r IN
      SELECT p.oid::regprocedure AS sig
        FROM pg_depend d
        JOIN pg_extension e ON e.oid = d.refobjid
        JOIN pg_proc p ON p.oid = d.objid
       WHERE d.classid = 'pg_proc'::regclass
         AND d.deptype = 'e'
         AND e.extname IN ('pgcrypto', 'uuid-ossp')
    LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO tracefab_migrator, neondb_owner', r.sig);
    END LOOP;
  END $$;

  SET ROLE tracefab_migrator;
  CREATE TABLE public._prisma_migrations (
    id                      varchar(36) PRIMARY KEY,
    checksum                varchar(64) NOT NULL,
    finished_at             timestamptz,
    migration_name          varchar(255) NOT NULL,
    logs                    text,
    rolled_back_at          timestamptz,
    started_at              timestamptz NOT NULL DEFAULT now(),
    applied_steps_count     integer NOT NULL DEFAULT 0
  );
  RESET ROLE;
`);

async function appliquerMigrationFidele(nomMigration) {
  const cheminSql = path.join(MIGRATIONS_DIR, nomMigration, 'migration.sql');
  const sql = fs.readFileSync(cheminSql, 'utf8');
  const checksum = sha256Fichier(cheminSql);
  const bailDeclare = exigeBailWorker(nomMigration);

  // Même préflight D6 que `scripts/migrer_fidelement.mjs` : toute fonction cible
  // dont le propriétaire actuel est `tracefab_worker` ouvre un bail transactionnel
  // borné (révoqué immédiatement après), tandis que tout autre propriétaire
  // injoignable déclenche un refus immédiat.
  const ecartsProp = await propriétairesInjoignables(
    adapterPglite(pg),
    'tracefab_migrator',
    [{ nom: nomMigration, sql }],
  );
  const autresInjoignables = ecartsProp.filter((e) => e.proprietaire !== 'tracefab_worker');
  if (autresInjoignables.length > 0) {
    throw new Error(`Refus D6 sur ${nomMigration} : ${JSON.stringify(autresInjoignables)}`);
  }
  const bail = bailDeclare || ecartsProp.length > 0;

  const workerExiste = (await pg.query(
    `SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker'`,
  )).rows.length > 0;

  if (bail && !workerExiste) {
    // 20261028120100 cree tracefab_worker si absent ; sous un migrateur NOSUPERUSER NOCREATEROLE,
    // le preflight operateur cree d'abord le role minimal NOLOGIN NOINHERIT comme sur Neon.
    await pg.exec(`
      CREATE ROLE tracefab_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT;
      GRANT USAGE ON SCHEMA public TO tracefab_worker;
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT p.oid::regprocedure AS sig
            FROM pg_depend d
            JOIN pg_extension e ON e.oid = d.refobjid
            JOIN pg_proc p ON p.oid = d.objid
           WHERE d.classid = 'pg_proc'::regclass
             AND d.deptype = 'e'
             AND e.extname IN ('pgcrypto', 'uuid-ossp')
        LOOP
          EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO tracefab_worker', r.sig);
        END LOOP;
      END $$;
    `);
  }

  if (bail) {
    await pg.exec(`GRANT tracefab_worker TO tracefab_migrator WITH ADMIN FALSE, INHERIT TRUE, SET TRUE;`);
  }

  try {
    await pg.exec('BEGIN');
    await pg.exec('SET LOCAL ROLE tracefab_migrator');
    if (bailDeclare) {
      await pg.exec(`SELECT set_config('tracefab.worker_membership_managed', 'true', true)`);
    }
    await pg.exec(sql);
    await pg.query(
      `INSERT INTO public._prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count)
       VALUES ($1, $2, clock_timestamp(), $3, 1)`,
      [crypto.randomUUID(), checksum, nomMigration],
    );
    await pg.exec('COMMIT');
  } catch (err) {
    await pg.exec('ROLLBACK').catch(() => {});
    throw new Error(`Migration ${nomMigration} en echec : ${err.message}`);
  } finally {
    if (bail) {
      await pg.exec(`REVOKE tracefab_worker FROM tracefab_migrator;`);
    }
  }
  return { bail, bailDeclare, bailD6: !bailDeclare && ecartsProp.length > 0 };
}

for (const d of cinquanteSixAppliquees) {
  await appliquerMigrationFidele(d);
}
ok(true, 'les 56 migrations de depart s appliquent sous tracefab_migrator (NOSUPERUSER)');

/* ==========================================================================
   2. Sondes de préflight en lecture seule sur l'état 56 migrations
   ========================================================================== */

console.log('\n  2. Preflight en lecture seule avant reconciliation (etat 56 migrations)');

const entreesSonde = decouperSonde(fs.readFileSync(CHEMIN_SONDE, 'utf8'));
const sqlRegistre = fs.readFileSync(FICHIER_SONDE_REGISTRE, 'utf8');
const lancerSonde = (db) => executerSonde({
  client: adapterPglite(db),
  entrees: entreesSonde,
  roleRuntime: 'tracefab_app',
});

await pg.exec('SET ROLE tracefab_migrator');
const sondeAvant = await lancerSonde(pg);
const regAvant = (await pg.query(sqlRegistre)).rows[0];
await pg.exec('RESET ROLE');

// Avant reconciliation (56 migrations, P10.5 pas encore appliquee), la sonde P10.7
// DOIT refuser la bascule stricte (codeSortie === 1) parce que les tables/verificateur
// HMAC et la fermeture PUBLIC de uuid-ossp n'existent pas encore, tout en prouvant
// la lecture seule SQLSTATE 25006 sans erreur SQL.
ok(sondeAvant.codeSortie === 1 && sondeAvant.rapport.lecture_seule_prouvee === '25006',
  'avant reconciliation (56/100), sonde_p107_etat_cible prouve 25006 et bloque la bascule stricte tant que P10.5 n est pas joue',
  JSON.stringify(sondeAvant.rapport.arrets));
ok(sondeAvant.rapport.b1_historique.terminees === 56 && sondeAvant.rapport.b1_historique.en_echec === 0,
  'B1 releve 56 migrations terminees et 0 en echec avant reconciliation');
ok(sondeAvant.rapport.b7_identite.mode_identite === 'ABSENTE'
  && sondeAvant.rapport.b7_identite.mode_identite_systeme === 'ABSENTE',
  'B7 indique proprement ABSENTE pour les deux modes avant P10.5/P10.7 (aucun crash 42703)');
ok(Number(regAvant.registered_expected) === 84 && Number(regAvant.missing_functions) === 0
  && Number(regAvant.overloaded_names) === 0 && Number(regAvant.wrong_owner_count) === 0,
  'preflight du registre : 84 fonctions historiques presentes, 0 manquante, 0 surchargee, 0 mauvais proprietaire',
  JSON.stringify(regAvant));

/* ==========================================================================
   3. Application des migrations restantes jusqu'à l'état cible complet
   ========================================================================== */

console.log(`\n  3. Reconciliation des ${enAttente.length} migrations en attente (jusqu a ${totalAttendu}/${totalAttendu})`);

let bauxDeclares = 0;
let bauxD6 = 0;
for (const d of enAttente) {
  const res = await appliquerMigrationFidele(d);
  if (res.bailDeclare) bauxDeclares += 1;
  if (res.bailD6) bauxD6 += 1;
}
ok(bauxDeclares === 7 && bauxD6 >= 1,
  `les ${enAttente.length} migrations s appliquent sans echec (7 baux worker declares + baux D6 auto-detectes sur fonctions worker)`,
  `declares=${bauxDeclares}, d6=${bauxD6}`);

/* ==========================================================================
   4. Postflight complet après la dernière migration
   ========================================================================== */

console.log(`\n  4. Postflight en lecture seule apres la ${totalAttendu}e migration`);

await pg.exec('SET ROLE tracefab_migrator');
const sondeApres = await lancerSonde(pg);
const regApres = (await pg.query(sqlRegistre)).rows[0];
await pg.exec('RESET ROLE');

const cat = sondeApres.rapport;
ok(sondeApres.codeSortie === 0 && cat.verdict === 'AUCUN_ARRET_DETECTE' && cat.lecture_seule_prouvee === '25006',
  `sonde_p107_etat_cible : AUCUN_ARRET_DETECTE apres les ${totalAttendu} migrations`,
  JSON.stringify(cat.arrets));
ok(cat.b1_historique.terminees === totalAttendu && cat.b1_historique.en_echec === 0,
  `B1 : ${totalAttendu} migrations terminees, 0 en echec`, JSON.stringify(cat.b1_historique));
ok(cat.b2_migrations_p105_p106.length === 9 && cat.b2_migrations_p105_p106.every((m) => m.appliquee === true && m.en_echec === false),
  'B2 : les 9 migrations jalons P10.5 -> P12 sont toutes appliquees', JSON.stringify(cat.b2_migrations_p105_p106));
ok(cat.b5_hygiene.definer_sans_search_path === 0 && cat.b5_hygiene.executables_par_public === 0,
  'B5 : 0 SECURITY DEFINER sans search_path et 0 executable par PUBLIC');
ok(cat.b6_droits_migration.migrator_superuser === false
  && cat.b6_droits_migration.migrator_membre_worker === false
  && cat.b6_droits_migration.app_membre_worker === false
  && cat.b6_droits_migration.neon_worker_swap_requis === false,
  'B6 : tracefab_migrator et tracefab_app hors de tracefab_worker, aucun swap Neon requis');
ok(cat.b7_identite.mode_identite === 'permissif' && cat.b7_identite.mode_identite_systeme === 'permissif',
  'B7 : strict et systeme_strict sortent tous deux en mode permissif des migrations',
  JSON.stringify(cat.b7_identite));
ok(cat.b8_portee_de_la_cle.operations_systeme_gardees === 13
  && cat.b8_portee_de_la_cle.operations_systeme_non_gardees === 0
  && cat.b8_portee_de_la_cle.app_lit_les_cles === false
  && cat.b8_portee_de_la_cle.app_ecrit_les_cles === false
  && cat.b8_portee_de_la_cle.app_peut_verifier === true
  && cat.b8_portee_de_la_cle.app_peut_verifier_systeme === true
  && cat.b8_portee_de_la_cle.app_appelle_predicat_systeme === false
  && cat.b8_portee_de_la_cle.migrator_execute_email_helper === true,
  'B8 : 13 operations systeme gardees, cles et predicat inaccessibles a tracefab_app, helper email ouvert a tracefab_migrator',
  JSON.stringify(cat.b8_portee_de_la_cle));
ok(Number(regApres.registered_final_expected) === 93
  && Number(regApres.missing_post_chain_functions) === 0
  && Number(regApres.overloaded_final_names) === 0
  && Number(regApres.unregistered_policy_functions) === 0
  && Number(regApres.security_definer_public_executor_count) === 0,
  'postflight du registre : 93/93 fonctions presentes, 0 fonction de politique hors registre, 0 DEFINER PUBLIC',
  JSON.stringify(regApres));

const polWorkerOrg = await pg.query(
  `SELECT polname FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.organizations'::regclass
      AND polname = 'organizations_worker_update'`,
);
ok(polWorkerOrg.rows.length === 1, 'la politique organizations_worker_update est en place sur public.organizations');

/* ==========================================================================
   5. Provisionnement clé HMAC + activation systeme_strict puis strict
   ========================================================================== */

console.log('\n  5. Provisionnement HMAC, preuves signees et bascule systeme_strict puis strict');

const cleV1Hex = crypto.randomBytes(32).toString('hex');
const cleV2Hex = crypto.randomBytes(32).toString('hex');

await pg.exec('SET ROLE tracefab_migrator');
await pg.query(
  `INSERT INTO public.tracefab_identity_cles (version, secret, actif)
   VALUES (1, decode($1, 'hex'), true)`,
  [cleV1Hex],
);
await pg.exec('RESET ROLE');

// Creer une organisation et un utilisateur de test via les fonctions officielles en mode permissif
await pg.exec('BEGIN');
await pg.exec('SET LOCAL ROLE tracefab_app');
const userRow = (await pg.query(
  `SELECT id FROM public.tracefab_upsert_clerk_user('user_rehearsal_100', 'rehearsal100@tracefab.example', 'Rehearsal Operator')`,
)).rows[0];
const orgRow = (await pg.query(
  `SELECT id FROM public.tracefab_sync_clerk_organization('org_rehearsal_100', 'Maison Rehearsal 100', 'maison-rehearsal-100', 'brand'::public.organization_type)`,
)).rows[0];
await pg.query(
  `SELECT * FROM public.tracefab_sync_clerk_membership('mem_rehearsal_100', $1::uuid, $2::uuid, 'owner'::public.membership_role)`,
  [orgRow.id, userRow.id],
);
await pg.exec('COMMIT');

const userId = userRow.id;
const orgId = orgRow.id;
ok(Boolean(userId && orgId), 'provisionnement initial Clerk (user + org + membership) reussi en mode permissif');

// Bascule 5a : systeme_strict = true (pendant que strict reste false)
await pg.exec(`
  SET ROLE tracefab_migrator;
  UPDATE public.tracefab_identity_politique SET systeme_strict = true, modifie_le = now() WHERE singleton;
  RESET ROLE;
`);

// Appel systeme SANS jeton sous tracefab_app -> doit etre refuse en 42501
let codeSansJetonSysteme = null;
await pg.exec('BEGIN');
try {
  await pg.exec('SET LOCAL ROLE tracefab_app');
  await pg.query(`SELECT public.tracefab_notification_outbox_health()`);
} catch (err) {
  codeSansJetonSysteme = err.code;
} finally {
  await pg.exec('ROLLBACK');
}
ok(codeSansJetonSysteme === '42501', 'systeme_strict=true : une operation systeme sans jeton est refusee en 42501', String(codeSansJetonSysteme));

// Un jeton UTILISATEUR injecte dans tracefab.identity_systeme doit aussi etre refuse (separation d usage)
const jetonUserPourConfusion = signerIdentite({ userId, organizationId: orgId, cle: cleV1Hex });
let codeConfusionUsage = null;
await pg.exec('BEGIN');
try {
  await pg.exec('SET LOCAL ROLE tracefab_app');
  await pg.query(`SELECT set_config('tracefab.identity_systeme', $1, true)`, [jetonUserPourConfusion.jeton]);
  await pg.query(`SELECT public.tracefab_notification_outbox_health()`);
} catch (err) {
  codeConfusionUsage = err.code;
} finally {
  await pg.exec('ROLLBACK');
}
ok(codeConfusionUsage === '42501', 'separation d usage : un jeton tracefab_identity ne passe pas pour tracefab_system', String(codeConfusionUsage));

// Appel systeme AVEC jeton systeme signe valide (y compris archivage d organisation sous FORCE RLS)
const jetonSysV1 = signerIdentiteSysteme({ cle: cleV1Hex });
await pg.exec('BEGIN');
await pg.exec('SET LOCAL ROLE tracefab_app');
await pg.query(`SELECT set_config('tracefab.identity_systeme', $1, true)`, [jetonSysV1.jeton]);
const healthOk = await pg.query(`SELECT * FROM public.tracefab_notification_outbox_health()`);
const orgTemp = (await pg.query(
  `SELECT id FROM public.tracefab_sync_clerk_organization('org_archive_100', 'Org Archive Test', 'org-archive-test', 'brand'::public.organization_type)`,
)).rows[0];
const archiveRows = (await pg.query(
  `SELECT * FROM public.tracefab_archive_clerk_organization('org_archive_100')`,
)).rows;
await pg.exec('ROLLBACK');
ok(healthOk.rows.length === 1 && archiveRows.length === 1,
  'systeme_strict=true : un jeton tracefab_system valide autorise l outbox et l archivage d organisation sous FORCE RLS');

// Bascule 5b : strict = true (les deux modes sont maintenant stricts)
await pg.exec(`
  SET ROLE tracefab_migrator;
  UPDATE public.tracefab_identity_politique SET strict = true, modifie_le = now() WHERE singleton;
  RESET ROLE;
`);

await pg.exec('SET ROLE tracefab_migrator');
const sondeDoubleStrict = await lancerSonde(pg);
await pg.exec('RESET ROLE');
ok(sondeDoubleStrict.codeSortie === 0
  && sondeDoubleStrict.rapport.b7_identite.mode_identite === 'strict'
  && sondeDoubleStrict.rapport.b7_identite.mode_identite_systeme === 'strict'
  && Number(sondeDoubleStrict.rapport.b7_identite.cles_actives) === 1,
  'sonde_p107_etat_cible confirme le double mode strict (strict + systeme_strict) avec 1 cle active',
  JSON.stringify(sondeDoubleStrict.rapport.b7_identite));

// Usurpation GUC sans jeton utilisateur -> tracefab_current_user_id() rend NULL
await pg.exec('BEGIN');
await pg.exec('SET LOCAL ROLE tracefab_app');
await pg.query(`SELECT set_config('tracefab.user_id', $1, true)`, [userId]);
await pg.query(`SELECT set_config('tracefab.active_organization_id', $1, true)`, [orgId]);
const usurpation = (await pg.query(
  `SELECT public.tracefab_current_user_id() AS uid,
          public.tracefab_has_org_role($1::uuid, ARRAY['viewer'::public.membership_role]) AS acces`,
  [orgId],
)).rows[0];
await pg.exec('ROLLBACK');
ok(usurpation.uid === null && usurpation.acces === false,
  'strict=true : un GUC tracefab.user_id sans jeton HMAC rend uid=NULL et refuse l acces tenant');

// Jeton utilisateur valide lie a (userId, orgId) -> identite et role reconnus, mais refuse sur une autre organisation
const jetonUserV1 = signerIdentite({ userId, organizationId: orgId, cle: cleV1Hex });
const autreOrgUuid = '00000000-0000-4000-8000-000000000099';
await pg.exec('BEGIN');
await pg.exec('SET LOCAL ROLE tracefab_app');
await pg.query(`SELECT set_config('tracefab.user_id', $1, true)`, [userId]);
await pg.query(`SELECT set_config('tracefab.active_organization_id', $1, true)`, [orgId]);
await pg.query(`SELECT set_config('tracefab.identity', $1, true)`, [jetonUserV1.jeton]);
const legitime = (await pg.query(
  `SELECT public.tracefab_current_user_id() AS uid,
          public.tracefab_has_org_role($1::uuid, ARRAY['owner'::public.membership_role]) AS est_owner`,
  [orgId],
)).rows[0];
await pg.query(`SELECT set_config('tracefab.active_organization_id', $1, true)`, [autreOrgUuid]);
const mauvaisContexte = (await pg.query(`SELECT public.tracefab_current_user_id() AS uid`)).rows[0];
await pg.exec('ROLLBACK');
ok(legitime.uid === userId && legitime.est_owner === true && mauvaisContexte.uid === null,
  'strict=true : un jeton HMAC valide authentifie le locataire cible et echoue si active_organization_id change');

/* ==========================================================================
   6. Rotation de clé sans coupure (v1 + v2 -> v2 seule) et retour arrière R1
   ========================================================================== */

console.log('\n  6. Rotation de cle sans coupure (v1 -> v2) et retour arriere R1a / R1b');

await pg.exec('SET ROLE tracefab_migrator');
await pg.query(
  `INSERT INTO public.tracefab_identity_cles (version, secret, actif)
   VALUES (2, decode($1, 'hex'), true)`,
  [cleV2Hex],
);
await pg.exec('RESET ROLE');

const jetonUserV2 = signerIdentite({ userId, organizationId: orgId, cle: cleV2Hex });
const jetonSysV2 = signerIdentiteSysteme({ cle: cleV2Hex });

await pg.exec('BEGIN');
await pg.exec('SET LOCAL ROLE tracefab_app');
const chevauchement = (await pg.query(
  `SELECT set_config('tracefab.active_organization_id', $1, true),
          public.tracefab_identity_jeton_utilisateur($2) AS u1,
          public.tracefab_identity_jeton_utilisateur($3) AS u2,
          public.tracefab_identite_systeme_jeton_valide($4) AS s1,
          public.tracefab_identite_systeme_jeton_valide($5) AS s2`,
  [orgId, jetonUserV1.jeton, jetonUserV2.jeton, jetonSysV1.jeton, jetonSysV2.jeton],
)).rows[0];
await pg.exec('ROLLBACK');
ok(chevauchement.u1 === userId && chevauchement.u2 === userId
  && chevauchement.s1 === true && chevauchement.s2 === true,
  'chevauchement v1+v2 : les jetons signes par l ancienne et la nouvelle cle sont tous acceptes');

// Desactiver v1 : v1 rejetee immediatement, v2 toujours valide
await pg.exec(`
  SET ROLE tracefab_migrator;
  UPDATE public.tracefab_identity_cles SET actif = false WHERE version = 1;
  RESET ROLE;
`);

await pg.exec('BEGIN');
await pg.exec('SET LOCAL ROLE tracefab_app');
const apresRetraitV1 = (await pg.query(
  `SELECT set_config('tracefab.active_organization_id', $1, true),
          public.tracefab_identity_jeton_utilisateur($2) AS u1,
          public.tracefab_identity_jeton_utilisateur($3) AS u2,
          public.tracefab_identite_systeme_jeton_valide($4) AS s1,
          public.tracefab_identite_systeme_jeton_valide($5) AS s2`,
  [orgId, jetonUserV1.jeton, jetonUserV2.jeton, jetonSysV1.jeton, jetonSysV2.jeton],
)).rows[0];
await pg.exec('ROLLBACK');
ok(apresRetraitV1.u1 === null && apresRetraitV1.u2 === userId
  && apresRetraitV1.s1 === false && apresRetraitV1.s2 === true,
  'retrait de v1 : les jetons v1 sont refuses immediatement tandis que v2 continue sans coupure');

// Retour arriere R1a + R1b vers permissif
await pg.exec(`
  SET ROLE tracefab_migrator;
  UPDATE public.tracefab_identity_politique
     SET systeme_strict = false, strict = false, modifie_le = now()
   WHERE singleton;
  RESET ROLE;
`);

await pg.exec('BEGIN');
await pg.exec('SET LOCAL ROLE tracefab_app');
await pg.query(`SELECT set_config('tracefab.user_id', $1, true)`, [userId]);
await pg.query(`SELECT set_config('tracefab.active_organization_id', $1, true)`, [orgId]);
const retourPermissif = (await pg.query(
  `SELECT public.tracefab_current_user_id() AS uid,
          (SELECT count(*)::int FROM public.tracefab_notification_outbox_health()) AS outbox_ok`,
)).rows[0];
await pg.exec('ROLLBACK');
ok(retourPermissif.uid === userId && retourPermissif.outbox_ok === 1,
  'retour arriere R1a/R1b : le retour en permissif retablit immediatement les flux sans defaire aucune migration');

await pg.close();

console.log(`\n  ${assertions - echecs}/${assertions} assertions PostgreSQL — ${echecs === 0 ? 'toutes conformes' : `${echecs} en echec`}.\n`);
process.exit(echecs === 0 ? 0 : 1);
