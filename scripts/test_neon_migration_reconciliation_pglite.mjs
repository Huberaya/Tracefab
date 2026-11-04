#!/usr/bin/env node
/**
 * Simulation PGlite de la séquence Neon mesurée au 04/11/2026.
 *
 * Baseline : les 56 migrations qui ont une ligne terminée dans Production et
 * Préproduction (dont les 5 exécutées hors bande). Cible : les 13 migrations
 * historiques absentes, puis les corrections forward post-snapshot. Les deux
 * tentatives rolled_back ont aussi une ligne réussie et font partie du baseline.
 *
 * IMPORTANT : le SQL PLM utilisé ici est celui du dépôt courant. Son checksum
 * exact en Production n'a pas été retrouvé ; cette simulation valide la
 * cohérence de schéma, pas une égalité octet pour octet avec le SQL historique.
 * Le comportement de prisma migrate deploy face à cet écart est éprouvé par
 * un test PostgreSQL distinct ; aucune réécriture de l'historique n'est admise.
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
const newNames = dossiers.filter((d) => !PRODUCTION_APPLIED[d] && !ECARTS[d]);
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
ok('70 dossiers de migration dans le dépôt', dossiers.length === 70, String(dossiers.length));
ok('56 migrations terminées dans les deux bases', baselineNames.length === 56);
ok('13 migrations réellement en attente', pendingNames.length === 13);
ok('5 migrations hors bande incluses dans le baseline', outOfBandNames.length === 5);
ok('les 2 tentatives annulées ont aussi une ligne réussie',
  ROLLED_BACK_ATTEMPTS.length === 2 && ROLLED_BACK_ATTEMPTS.every((x) => PRODUCTION_APPLIED[x.name]));
ok('aucun nom annulé n’est classé pending', ROLLED_BACK_ATTEMPTS.every((x) => !ECARTS[x.name]));
ok('une correction forward est postérieure au snapshot',
  newNames.length === 1 && newNames[0] === '20261104090000_plm_integrations_and_gs1_constraints', JSON.stringify(newNames));
ok('toutes les migrations du dépôt sont classées',
  baselineNames.length + pendingNames.length + newNames.length === dossiers.length);

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

console.log('\n  3. Application séquentielle des 13 migrations historiques absentes');
const results = [];
for (const name of pendingNames) {
  const result = await jouer(baseline.db, name);
  results.push({ name, ...result });
  console.log(`  ${result.ok ? 'ok   ' : 'ECHEC'} ${name}${result.ok ? '' : ` — ${result.message}`}`);
}
ok('les 13 migrations historiques pending s’appliquent dans l’ordre',
  results.length === 13 && results.every((r) => r.ok),
  JSON.stringify(results.filter((r) => !r.ok)));

console.log('\n  4. Reproduction du catalogue Neon et correction forward PLM/GS1');
await baseline.db.exec(`
  ALTER TABLE public.plm_erp_integrations DROP CONSTRAINT plm_erp_integrations_system_type_check;
  ALTER TABLE public.plm_erp_integrations DROP CONSTRAINT plm_erp_integrations_name_check;
  ALTER TABLE public.plm_erp_integrations DROP CONSTRAINT plm_erp_integrations_auth_type_check;
  ALTER TABLE public.plm_erp_integrations DROP CONSTRAINT plm_erp_integrations_status_check;
  ALTER TABLE public.product_identifiers DROP CONSTRAINT product_identifiers_identifier_type_check;
  ALTER TABLE public.product_identifiers
    ADD CONSTRAINT product_identifiers_identifier_type_check
    CHECK (identifier_type IN ('gtin', 'ean', 'upc', 'internal', 'gs1_digital_link', 'gln')) NOT VALID;
  ALTER TABLE public.product_identifiers VALIDATE CONSTRAINT product_identifiers_identifier_type_check;
`);
const missingPlmChecks = await scalar(baseline.db, `
  SELECT count(*)::int AS value FROM pg_constraint
  WHERE conrelid='public.plm_erp_integrations'::regclass
    AND conname IN ('plm_erp_integrations_system_type_check','plm_erp_integrations_name_check',
                    'plm_erp_integrations_auth_type_check','plm_erp_integrations_status_check')
`);
const oldIdentifierCheck = await scalar(baseline.db, `
  SELECT pg_get_constraintdef(oid) AS value FROM pg_constraint
  WHERE conrelid='public.product_identifiers'::regclass
    AND conname='product_identifiers_identifier_type_check'
`);
ok('fixture : quatre CHECK PLM absents comme sur Neon', missingPlmChecks === 0, String(missingPlmChecks));
ok('fixture : CHECK GS1 historique sans GPC', !oldIdentifierCheck.includes('gpc'), oldIdentifierCheck);
const forwardResults = [];
for (const name of newNames) {
  const result = await jouer(baseline.db, name);
  forwardResults.push({ name, ...result });
  console.log(`  ${result.ok ? 'ok   ' : 'ECHEC'} ${name}${result.ok ? '' : ` — ${result.message}`}`);
}
ok('la correction forward post-snapshot s’applique', forwardResults.length === 1 && forwardResults.every((r) => r.ok),
  JSON.stringify(forwardResults.filter((r) => !r.ok)));
const repairedPlmChecks = await scalar(baseline.db, `
  SELECT count(*)::int AS value FROM pg_constraint
  WHERE conrelid='public.plm_erp_integrations'::regclass
    AND contype='c' AND convalidated
    AND conname IN ('plm_erp_integrations_system_type_check','plm_erp_integrations_name_check',
                    'plm_erp_integrations_auth_type_check','plm_erp_integrations_status_check')
`);
const repairedIdentifierCheck = await scalar(baseline.db, `
  SELECT pg_get_constraintdef(oid) AS value FROM pg_constraint
  WHERE conrelid='public.product_identifiers'::regclass
    AND conname='product_identifiers_identifier_type_check'
`);
ok('les quatre CHECK PLM sont présents et validés', repairedPlmChecks === 4, String(repairedPlmChecks));
ok('la contrainte GS1 accepte désormais GPC', repairedIdentifierCheck.includes('gpc'), repairedIdentifierCheck);
const forwardReplay = await jouer(baseline.db, newNames[0]);
ok('la correction forward est idempotente', forwardReplay.ok, forwardReplay.message);

console.log('\n  5. Contrôles du catalogue après application');
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

console.log('\n  6. Dépendance du worker au registre runtime');
const dependency = await construireBaseline();
const workerBeforeRegistry = await jouer(dependency.db, '20261028120100_worker_identity_not_forgeable');
ok('28120100 échoue si 28120000 n’a pas été appliquée', !workerBeforeRegistry.ok, workerBeforeRegistry.message);
const registryFirst = await jouer(dependency.db, '20261028120000_runtime_function_registry');
ok('28120000 passe lorsqu’elle est appliquée en premier', registryFirst.ok, registryFirst.message);
const workerAfterRegistry = await jouer(dependency.db, '20261028120100_worker_identity_not_forgeable');
ok('28120100 passe après le registre', workerAfterRegistry.ok, workerAfterRegistry.message);
await dependency.db.close();

console.log('\n  7. Limite de rejeu et checksum non résolu');
const replay = await jouer(baseline.db, '20261028120000_runtime_function_registry');
ok('28120000 n’est pas rejouable après création du registre', !replay.ok
  && /already exists|exists|existe/i.test(replay.message), replay.message);
console.log("  info  le checksum PLM reste divergent et visible ; son exception exacte ne modifie jamais l'historique, et le test Prisma dédié prouve le comportement de migrate deploy.");
await baseline.db.close();

console.log('\n  --------------------------------------------');
if (echecs) {
  console.error(`  ${echecs} échec(s) sur ${verifies}.`);
  process.exit(1);
}
console.log(`  ${verifies} vérifications passées — baseline 56, pending historiques 13 + 1 correction forward PLM/GS1, 1 écart PLM documenté, aucun resolve ni réécriture de checksum.`);
