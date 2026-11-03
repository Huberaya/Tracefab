#!/usr/bin/env node
/**
 * P10.7 — preuves PostgreSQL du comportement FAIL-CLOSED de la sonde.
 *
 * PGlite exécute ici un vrai PostgreSQL jetable en WebAssembly, localement.
 * Aucun accès réseau, Neon ou distant. Les scénarios couvrent le parcours
 * normal, les relations/rôles absents, l'erreur initiale 42P01, le refus 25006,
 * la transaction abortée 25P02, l'écriture acceptée et les ROLLBACK.
 */
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import {
  CHEMIN_SONDE,
  decouperSonde,
  executerSonde,
} from './sonde_p107_etat_cible.mjs';

let assertions = 0;
let echecs = 0;
const ok = (condition, libelle, detail = '') => {
  assertions += 1;
  console.log(`  ${condition ? 'ok   ' : 'ECHEC'} ${libelle}${detail ? ` — ${detail}` : ''}`);
  if (!condition) echecs += 1;
};

const entrees = decouperSonde(readFileSync(CHEMIN_SONDE, 'utf8'));
const clientDe = (db) => ({ query: (sql) => db.query(sql) });
const executer = (db, options = {}) => executerSonde({
  client: options.client || clientDe(db),
  entrees: options.entrees || entrees,
  roleRuntime: 'tracefab_app',
});

async function creerBase({ migrations = true, hmac = true, app = true } = {}) {
  const db = new PGlite();
  await db.waitReady;
  await db.query('CREATE ROLE tracefab_worker NOLOGIN NOSUPERUSER NOBYPASSRLS');
  await db.query('CREATE ROLE tracefab_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS');
  if (app) await db.query('CREATE ROLE tracefab_app NOLOGIN NOSUPERUSER NOBYPASSRLS');

  if (migrations) {
    await db.query(`CREATE TABLE public._prisma_migrations (
      id text PRIMARY KEY,
      checksum text NOT NULL,
      finished_at timestamptz,
      migration_name text NOT NULL,
      logs text,
      rolled_back_at timestamptz,
      started_at timestamptz NOT NULL DEFAULT now(),
      applied_steps_count integer NOT NULL DEFAULT 0
    )`);
    await db.query(`INSERT INTO public._prisma_migrations
      (id, checksum, finished_at, migration_name) VALUES
      ('m68', 'test', now(), '20261031120000_identite_hmac_liee_au_contexte'),
      ('m69', 'test', now(), '20261102120000_identite_stricte_email_et_rotation')`);
  }

  if (hmac) {
    await db.query('CREATE TABLE public.tracefab_identity_politique (strict boolean NOT NULL)');
    await db.query('INSERT INTO public.tracefab_identity_politique VALUES (false)');
    await db.query('CREATE TABLE public.tracefab_identity_cles (actif boolean NOT NULL)');
    await db.query('INSERT INTO public.tracefab_identity_cles VALUES (true)');
  }

  const fonctions = [
    'tracefab_current_user_id',
    'tracefab_current_user_email',
    'tracefab_register_transaction_certificate',
    'tracefab_allocate_tc_quantity',
    'tracefab_reconcile_mass_balance',
  ];
  for (const nom of fonctions) {
    await db.query(`CREATE FUNCTION public.${nom}() RETURNS integer
      LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public
      AS $fonction$ SELECT 1 $fonction$`);
    await db.query(`REVOKE EXECUTE ON FUNCTION public.${nom}() FROM PUBLIC`);
  }
  if (hmac) {
    await db.query(`CREATE FUNCTION public.tracefab_identity_jeton_utilisateur(text)
      RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public
      AS $fonction$ SELECT true $fonction$`);
    await db.query('REVOKE EXECUTE ON FUNCTION public.tracefab_identity_jeton_utilisateur(text) FROM PUBLIC');
    if (app) {
      await db.query('GRANT EXECUTE ON FUNCTION public.tracefab_identity_jeton_utilisateur(text) TO tracefab_app');
    }
  }
  return db;
}

async function avecBase(options, scenario) {
  const db = await creerBase(options);
  try {
    await scenario(db);
  } finally {
    await db.close();
  }
}

async function verifierAbsenceEcriture(db, libelle) {
  const r = await db.query("SELECT to_regclass('public.tracefab_readonly_probe')::text AS relation");
  ok(r.rows[0].relation === null, libelle, `to_regclass=${r.rows[0].relation}`);
}

/* S0 — contrôle statique et ordre de la chaîne. */
ok(entrees.length === 13, 'S0 les 13 requêtes sont découpées dans leur ordre exact', `${entrees.length}`);
ok(entrees.every((e) => /^(select|with)\b/i.test(e.requete)),
  'S0 toutes les requêtes commencent par SELECT ou WITH');
ok(entrees.findIndex((e) => /^B0\./.test(e.titre)) < entrees.findIndex((e) => /^B1\./.test(e.titre)),
  'S0 B0 mesure les présences avant B1');
const source = readFileSync(CHEMIN_SONDE, 'utf8');
ok(/aclexplode/i.test(source) && /acldefault\('f'/i.test(source) && /acl\.grantee = 0/.test(source),
  'S0 B5 développe les ACL explicites et par défaut avec PUBLIC = grantee 0');
ok(!/has_function_privilege\('public'/i.test(source),
  'S0 B5 ne passe plus le pseudo-rôle public à has_function_privilege');

/* S1 — exécution normale et refus 25006 dans une transaction distincte. */
await avecBase({}, async (db) => {
  const requetes = [];
  const client = {
    query: (sql) => {
      requetes.push(sql);
      return db.query(sql);
    },
  };
  const { rapport: r, codeSortie } = await executer(db, { client });
  const sequenceAttendue = [
    'BEGIN',
    'SET TRANSACTION READ ONLY',
    ...entrees.map((e) => e.requete),
    'ROLLBACK',
    'BEGIN',
    'SET TRANSACTION READ ONLY',
    'CREATE TABLE public.tracefab_readonly_probe (x integer)',
    'ROLLBACK',
  ];
  ok(JSON.stringify(requetes) === JSON.stringify(sequenceAttendue),
    'S1 les 13 mesures puis le contrôle sont exécutés dans l ordre exact de deux transactions');
  ok(codeSortie === 0 && r.verdict === 'AUCUN_ARRET_DETECTE',
    'S1 exécution normale : aucun arrêt', `code=${codeSortie} verdict=${r.verdict}`);
  ok(r.erreur_initiale === null, 'S1 aucune erreur SQL initiale');
  ok(r.contexte?.version_postgresql?.includes('PostgreSQL'),
    'S1 toutes les fonctions sont compatibles avec le PostgreSQL jetable', r.contexte?.version_postgresql?.split(' on ')[0]);
  ok(r.b0_relations?.migrations_presentes === true
      && r.b0_relations?.cles_presentes === true
      && r.b0_relations?.politique_presente === true,
    'S1 B0 mesure les relations présentes');
  ok(r.b1_historique?.terminees === 2 && r.b4_proprietaires?.length === 6,
    'S1 B1 à B4 sont réellement exécutés');
  ok(r.b5_hygiene?.executables_par_public === 0 && r.b5_hygiene?.definer_sans_search_path === 0,
    'S1 B5 ne signale pas les fonctions dont PUBLIC a été révoqué');
  ok(r.test_lecture_seule.verdict === 'TENTATIVE_ECRITURE_REFUSEE'
      && r.test_lecture_seule.sqlstate === '25006'
      && r.lecture_seule_prouvee === '25006',
    'S1 le CREATE TABLE de contrôle est refusé précisément en 25006');
  ok(r.rollback_mesures_effectue === true && r.test_lecture_seule.rollback_effectue === true,
    'S1 les deux transactions distinctes sont annulées');
  await verifierAbsenceEcriture(db, 'S1 aucune table de contrôle ne persiste');
});

/* S2 — ACL par défaut puis ACL explicite : PUBLIC n'est pas deviné. */
await avecBase({}, async (db) => {
  await db.query(`CREATE FUNCTION public.f_acl_temoin() RETURNS integer
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public
    AS $fonction$ SELECT 1 $fonction$`);
  const aclAvant = await db.query(`SELECT p.proacl IS NULL AS acl_par_defaut
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'f_acl_temoin'`);
  ok(aclAvant.rows[0].acl_par_defaut === true, 'S2 le témoin commence bien avec proacl NULL');
  const avecDefaut = await executer(db);
  ok(avecDefaut.rapport.b5_hygiene?.executables_par_public === 1
      && avecDefaut.codeSortie === 1,
    'S2 acldefault détecte EXECUTE PUBLIC lorsque proacl est NULL');

  await db.query('REVOKE EXECUTE ON FUNCTION public.f_acl_temoin() FROM PUBLIC');
  const apresRevoke = await executer(db);
  ok(apresRevoke.rapport.b5_hygiene?.executables_par_public === 0
      && apresRevoke.codeSortie === 0,
    'S2 la révocation explicite de PUBLIC est mesurée sans faux positif');

  await db.query('GRANT EXECUTE ON FUNCTION public.f_acl_temoin() TO PUBLIC');
  const apresGrant = await executer(db);
  ok(apresGrant.rapport.b5_hygiene?.executables_par_public === 1
      && apresGrant.codeSortie === 1,
    'S2 aclexplode détecte aussi le GRANT PUBLIC explicite');
  await verifierAbsenceEcriture(db, 'S2 les contrôles ACL ne laissent aucune écriture');
});

/* S3 — relation _prisma_migrations absente : arrêt explicite, pas 42P01 masqué. */
await avecBase({ migrations: false }, async (db) => {
  const ancienneB1 = await db.query('SELECT count(*) FROM public._prisma_migrations').catch((e) => e);
  ok(ancienneB1.code === '42P01',
    'S3 reproduction directe : la relation absente lève bien 42P01');
  const { rapport: r, codeSortie } = await executer(db);
  ok(codeSortie === 1 && r.verdict === 'ARRET' && r.erreur_initiale === null,
    'S3 relation absente : ARRÊT contrôlé sans exception SQL');
  ok(r.b0_relations?.migrations_presentes === false && r.b1_historique === null,
    'S3 la relation absente est mesurée et son historique reste NULL');
  ok(r.sections_ignorees.filter((s) => s.raison === 'PUBLIC__PRISMA_MIGRATIONS_ABSENTE').length === 3,
    'S3 B1, B2 et B3 sont ignorés explicitement');
  ok(r.arrets.some((a) => a.startsWith('B1') && a.includes('absente')),
    'S3 le verdict motive l arrêt par la relation absente');
  ok(r.test_lecture_seule.sqlstate === '25006',
    'S3 le contrôle READ ONLY reste valide dans sa transaction distincte');
  await verifierAbsenceEcriture(db, 'S3 aucune écriture persistée');
});

/* S4 — rôle absent : NULL non mesurable + ARRÊT, jamais un faux privilège false. */
await avecBase({ app: false }, async (db) => {
  const ancienneB8 = await db.query(`SELECT pg_catalog.has_table_privilege(
    'tracefab_app', 'public.tracefab_identity_cles', 'SELECT')`).catch((e) => e);
  ok(ancienneB8.code === '42704',
    'S4 reproduction directe : l ancien B8 avec rôle absent lève bien 42704');
  const { rapport: r, codeSortie } = await executer(db);
  ok(codeSortie === 1 && r.verdict === 'ARRET' && r.erreur_initiale === null,
    'S4 rôle tracefab_app absent : ARRÊT contrôlé, pas de 42704');
  ok(r.b8_portee_de_la_cle?.app_present === false
      && r.b8_portee_de_la_cle?.app_lit_les_cles === null
      && r.b8_portee_de_la_cle?.app_ecrit_les_cles === null
      && r.b8_portee_de_la_cle?.app_peut_verifier === null,
    'S4 les privilèges non mesurables sont NULL');
  ok(r.arrets.some((a) => a.startsWith('B8') && a.includes('absent')),
    'S4 le verdict B8 nomme le rôle absent');
  ok(r.test_lecture_seule.sqlstate === '25006',
    'S4 le refus d écriture reste précisément 25006');
  await verifierAbsenceEcriture(db, 'S4 aucune écriture persistée');
});

/* S5 — reproduction de la cause racine : sans aiguillage B0, B7 lève 42P01. */
await avecBase({ hmac: false }, async (db) => {
  const entreesSansB0 = entrees.filter((e) => !/^B0\./.test(e.titre));
  const { rapport: r, codeSortie } = await executer(db, { entrees: entreesSansB0 });
  ok(codeSortie === 2 && r.verdict === 'ERREUR_SQL_INITIALE',
    'S5 la première erreur produit ERREUR_SQL_INITIALE et le code 2');
  ok(r.erreur_initiale?.sqlstate === '42P01'
      && r.erreur_initiale?.section === 'B7'
      && r.erreur_initiale?.message.includes('public.tracefab_identity_politique'),
    'S5 SQLSTATE 42P01 et message B7 sont conservés',
    `${r.erreur_initiale?.sqlstate} ${r.erreur_initiale?.message}`);
  ok(r.test_lecture_seule.verdict === 'NON_EXECUTE_APRES_ERREUR_INITIALE'
      && r.test_lecture_seule.tentative_effectuee === false,
    'S5 aucun CREATE TABLE n est tenté après l erreur initiale');
  ok(r.rollback_mesures_effectue === true && r.lecture_seule_prouvee === 'NON_PROUVEE',
    'S5 ROLLBACK effectué et lecture seule non déclarée prouvée');
  await verifierAbsenceEcriture(db, 'S5 aucune écriture persistée après l erreur');
  const apres = await db.query('SELECT 1 AS session_reutilisable');
  ok(apres.rows[0].session_reutilisable === 1,
    'S5 le ROLLBACK rend la session réutilisable après 42P01');
});

/* S6 — avec B0, le même état HMAC absent devient un ARRÊT motivé, sans 42P01. */
await avecBase({ hmac: false }, async (db) => {
  const { rapport: r, codeSortie } = await executer(db);
  ok(codeSortie === 1 && r.verdict === 'ARRET' && r.erreur_initiale === null,
    'S6 relations HMAC absentes : ARRÊT contrôlé au lieu de 42P01');
  ok(r.sections_ignorees.some((s) => s.section === 'B7' && s.raison === 'RELATIONS_HMAC_ABSENTES'),
    'S6 B7 est explicitement ignoré après le constat B0');
  ok(r.b7_identite?.cles_total === null && r.b7_identite?.cles_actives === null,
    'S6 les compteurs non lus restent NULL, pas zéro');
  ok(r.arrets.some((a) => a.startsWith('B7')),
    'S6 l impossibilité de mesurer l identité est un arrêt');
  await verifierAbsenceEcriture(db, 'S6 aucune écriture persistée');
});

/* S7 — 25P02 réel pendant le contrôle : jamais transformé en refus 25006. */
await avecBase({}, async (db) => {
  const client = {
    query: async (sql) => {
      if (sql.startsWith('CREATE TABLE public.tracefab_readonly_probe')) {
        await db.query('SELECT * FROM public.relation_qui_avorte_le_controle').catch(() => {});
      }
      return db.query(sql);
    },
  };
  const { rapport: r, codeSortie } = await executer(db, { client });
  ok(codeSortie === 2 && r.verdict === 'TRANSACTION_ABORTEE',
    'S7 25P02 produit TRANSACTION_ABORTEE et le code 2');
  ok(r.test_lecture_seule.sqlstate === '25P02'
      && r.test_lecture_seule.verdict === 'TRANSACTION_ABORTEE'
      && r.lecture_seule_prouvee === 'NON_PROUVEE',
    'S7 25P02 n est jamais interprété comme 25006');
  ok(r.test_lecture_seule.rollback_effectue === true,
    'S7 ROLLBACK après la transaction abortée');
  await verifierAbsenceEcriture(db, 'S7 aucune écriture persistée après 25P02');
});

/* S8 — si le garde READ ONLY est perdu, l écriture acceptée est un ARRÊT. */
await avecBase({}, async (db) => {
  let appelsSet = 0;
  const client = {
    query: (sql) => {
      if (sql === 'SET TRANSACTION READ ONLY') {
        appelsSet += 1;
        if (appelsSet === 2) return db.query('SET TRANSACTION READ WRITE');
      }
      return db.query(sql);
    },
  };
  const { rapport: r, codeSortie } = await executer(db, { client });
  ok(codeSortie === 1 && r.verdict === 'ECRITURE_VALIDEE'
      && r.test_lecture_seule.ecriture_validee === true,
    'S8 un CREATE TABLE accepté produit ECRITURE_VALIDEE et le code 1');
  ok(r.lecture_seule_prouvee === 'ECRITURE_VALIDEE'
      && r.test_lecture_seule.sqlstate === null,
    'S8 aucun faux refus 25006 n est fabriqué après une écriture acceptée');
  ok(r.test_lecture_seule.rollback_effectue === true,
    'S8 ROLLBACK systématique même après écriture acceptée');
  await verifierAbsenceEcriture(db, 'S8 l écriture acceptée ne persiste pas après ROLLBACK');
});

console.log('');
if (echecs === 0) {
  console.log(`  Sonde P10.7 fail-closed : ${assertions} assertions PostgreSQL — toutes conformes.`);
  process.exit(0);
}
console.error(`  ${echecs} ÉCHEC sur ${assertions} assertions.`);
process.exit(1);
