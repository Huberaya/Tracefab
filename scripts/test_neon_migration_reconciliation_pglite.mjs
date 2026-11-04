#!/usr/bin/env node
/**
 * Simulation PGlite de la séquence Neon mesurée au 04/11/2026.
 *
 * Baseline : les 56 migrations qui ont une ligne terminée dans Production et
 * Préproduction (dont les 5 exécutées hors bande). Cible : les 13 migrations
 * réellement absentes. Les deux tentatives rolled_back ont aussi une ligne
 * réussie : elles font donc partie du baseline, jamais de la liste pending.
 *
 * IMPORTANT : le SQL PLM utilisé ici est celui du dépôt courant. Son checksum
 * exact en Production n'a pas été retrouvé ; cette simulation valide la
 * cohérence de schéma, PAS l'autorisation de lancer prisma migrate deploy.
 * Le plan opérationnel reste bloqué par le test de checksum.
 */
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRODUCTION_APPLIED, ROLLED_BACK_ATTEMPTS, ECARTS, HORS_BANDE, SNAPSHOT_DATE,
} from './lib/ecarts_migrations.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'prisma', 'migrations');
const dossiers = readdirSync(migrationsDir).filter((d) => /^\d{14}_/.test(d)).sort();
const lire = (name) => readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8');
const baselineNames = Object.keys(PRODUCTION_APPLIED).sort();
const pendingNames = Object.keys(ECARTS).sort();
const outOfBandNames = Object.keys(HORS_BANDE).sort();

let verifies = 0;
let echecs = 0;
const ok = (label, condition, detail = '') => {
  verifies += 1;
  if (condition) console.log(`  ok    ${label}`);
  else { echecs += 1; console.error(`  ECHEC ${label}${detail ? ` — ${detail}` : ''}`); }
};

async function nouvelleBase() {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  await db.waitReady;
  await db.exec(`
    CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime'
      NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
    GRANT USAGE ON SCHEMA public TO tracefab_app;
  `);
  return db;
}

async function jouer(db, name) {
  try {
    await db.exec('BEGIN');
    await db.exec(lire(name));
    await db.exec('COMMIT');
    return { ok: true };
  } catch (error) {
    const message = String(error.message || error).split('\n')[0];
    try { await db.exec('ROLLBACK'); } catch { /* transaction déjà annulée */ }
    return { ok: false, message };
  }
}

async function construireBaseline() {
  const db = await nouvelleBase();
  let count = 0;
  for (const name of dossiers.filter((d) => PRODUCTION_APPLIED[d])) {
    const result = await jouer(db, name);
    if (!result.ok) throw new Error(`baseline impossible à ${name}: ${result.message}`);
    count += 1;
  }
  return { db, count };
}

async function scalar(db, sql, params = []) {
  const result = await db.query(sql, params);
  return result.rows[0]?.value;
}

console.log(`\n  1. Snapshot Neon ${SNAPSHOT_DATE} — cohérence des catégories`);
ok('69 dossiers de migration dans le dépôt', dossiers.length === 69, String(dossiers.length));
ok('56 migrations terminées dans les deux bases', baselineNames.length === 56);
ok('13 migrations réellement en attente', pendingNames.length === 13);
ok('5 migrations hors bande incluses dans le baseline', outOfBandNames.length === 5);
ok('les 2 tentatives annulées ont aussi une ligne réussie',
  ROLLED_BACK_ATTEMPTS.length === 2 && ROLLED_BACK_ATTEMPTS.every((x) => PRODUCTION_APPLIED[x.name]));
ok('aucun nom annulé n’est classé pending', ROLLED_BACK_ATTEMPTS.every((x) => !ECARTS[x.name]));
ok('toutes les migrations du dépôt sont classées',
  baselineNames.length + pendingNames.length === dossiers.length);

console.log('\n  2. Reconstruction du baseline des 56 migrations réussies');
const baseline = await construireBaseline();
ok('les 56 migrations du baseline s’appliquent dans l’ordre', baseline.count === 56, String(baseline.count));
for (const [migration, objects] of Object.entries(HORS_BANDE)) {
  for (const object of objects) {
    const present = await scalar(baseline.db,
      'SELECT to_regclass($1) IS NOT NULL AS value', [`public.${object}`]);
    ok(`${migration.slice(0,14)} : ${object} présent dans le baseline`, present === true);
  }
}
const policiesBefore = await baseline.db.query(`
  SELECT polname FROM pg_catalog.pg_policy
   WHERE polrelid = 'public.plm_erp_sync_jobs'::regclass ORDER BY polname`);
ok('baseline PLM : exactement deux politiques canoniques',
  policiesBefore.rows.length === 2
  && policiesBefore.rows.some((r) => r.polname === 'plm_sync_jobs_insert_brand')
  && policiesBefore.rows.some((r) => r.polname === 'plm_sync_jobs_select_org'),
  JSON.stringify(policiesBefore.rows));
ok('le registre runtime est absent avant 28120000',
  await scalar(baseline.db, "SELECT to_regclass('public.tracefab_runtime_function_registry') IS NULL AS value") === true);

console.log('\n  3. Application séquentielle des 13 migrations absentes');
const results = [];
for (const name of pendingNames) {
  const result = await jouer(baseline.db, name);
  results.push({ name, ...result });
  console.log(`  ${result.ok ? 'ok   ' : 'ECHEC'} ${name}${result.ok ? '' : ` — ${result.message}`}`);
}
ok('les 13 migrations pending s’appliquent dans l’ordre',
  results.length === 13 && results.every((r) => r.ok),
  JSON.stringify(results.filter((r) => !r.ok)));

console.log('\n  4. Contrôles du catalogue après application');
const registry = await scalar(baseline.db, "SELECT to_regclass('public.tracefab_runtime_function_registry') IS NOT NULL AS value");
ok('registre runtime créé', registry === true);
const workerRole = await baseline.db.query(`
  SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
    FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker'`);
ok('worker existe et reste NOLOGIN / NOSUPERUSER / NOBYPASSRLS',
  workerRole.rows.length === 1 && workerRole.rows[0].rolcanlogin === false
    && workerRole.rows[0].rolsuper === false && workerRole.rows[0].rolbypassrls === false,
  JSON.stringify(workerRole.rows));
const appWorkerMembership = await scalar(baseline.db, `
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = m.member
    WHERE granted.rolname = 'tracefab_worker' AND member.rolname = 'tracefab_app'
  ) AS value`);
ok('tracefab_app n’est pas membre de tracefab_worker', appWorkerMembership === false);
const docsUpdate = await scalar(baseline.db,
  "SELECT has_table_privilege('tracefab_app','public.documents','UPDATE') AS value");
ok('tracefab_app ne peut plus UPDATE documents', docsUpdate === false);
for (const column of ['data_readiness','data_completion','data_ready_at','version']) {
  const privilege = await scalar(baseline.db,
    `SELECT has_column_privilege('tracefab_app','public.tracefab_products',${'$'}1,'UPDATE') AS value`, [column]);
  ok(`tracefab_app ne peut pas UPDATE tracefab_products.${column}`, privilege === false);
}
const policyCount = await scalar(baseline.db,
  "SELECT count(*)::int AS value FROM pg_catalog.pg_policy WHERE polrelid='public.plm_erp_sync_jobs'::regclass");
ok('deux politiques PLM canoniques après normalisation', policyCount === 2, String(policyCount));
const ingestDef = await scalar(baseline.db,
  "SELECT pg_get_functiondef('public.tracefab_ingest_plm_erp_payload(uuid,text,jsonb,uuid)'::regprocedure) AS value");
ok('ingestion PLM/ERP vérifie le rôle de session', ingestDef.includes('session_user') && ingestDef.includes('ingest_role_not_allowed'));
const invitationDef = await scalar(baseline.db,
  "SELECT pg_get_functiondef('public.tracefab_validate_member_invitation_role()'::regprocedure) AS value");
ok('invitation fournisseur vérifie le rattachement et le statut de relation',
  invitationDef.includes('relationship_id') && invitationDef.includes('supplier_organization_id')
  && invitationDef.includes('ended'));
const identityPolicy = await baseline.db.query('SELECT strict FROM public.tracefab_identity_politique WHERE singleton');
ok('le mode HMAC strict reste désactivé', identityPolicy.rows.length === 1 && identityPolicy.rows[0].strict === false);
ok('la table des clés HMAC existe mais ne contient aucune clé provisionnée',
  await scalar(baseline.db, 'SELECT count(*)::int = 0 AS value FROM public.tracefab_identity_cles') === true);

console.log('\n  5. Dépendance du worker au registre runtime');
const dependency = await construireBaseline();
const workerBeforeRegistry = await jouer(dependency.db, '20261028120100_worker_identity_not_forgeable');
ok('28120100 échoue si 28120000 n’a pas été appliquée', !workerBeforeRegistry.ok, workerBeforeRegistry.message);
const registryFirst = await jouer(dependency.db, '20261028120000_runtime_function_registry');
ok('28120000 passe lorsqu’elle est appliquée en premier', registryFirst.ok, registryFirst.message);
const workerAfterRegistry = await jouer(dependency.db, '20261028120100_worker_identity_not_forgeable');
ok('28120100 passe après le registre', workerAfterRegistry.ok, workerAfterRegistry.message);
await dependency.db.close();

console.log('\n  6. Limite de rejeu et checksum non résolu');
const replay = await jouer(baseline.db, '20261028120000_runtime_function_registry');
ok('28120000 n’est pas rejouable après création du registre', !replay.ok
  && /already exists|exists|existe/i.test(replay.message), replay.message);
console.log('  info  le checksum PLM historique reste un bloqueur distinct ; ce test ne l’autorise pas à être réécrit.');
await baseline.db.close();

console.log('\n  --------------------------------------------');
if (echecs) {
  console.error(`  ${echecs} échec(s) sur ${verifies}.`);
  process.exit(1);
}
console.log(`  ${verifies} vérifications passées — baseline 56, pending 13, aucune autorisation de deploy tant que le checksum PLM reste non résolu.`);
