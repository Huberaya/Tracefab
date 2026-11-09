#!/usr/bin/env node
/**
 * Garde de migration P10.7 sur Neon Preview P11.
 * Ne modifie rien : preflight en lecture seule avant prisma migrate deploy.
 */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';

const MIGRATION = '20261106130000_identite_systeme_signee';
const EXPECTED_ENDPOINT = 'ep-lively-field-b1wicg4v';
const SYSTEM_FUNCTIONS = [
  'tracefab_sync_clerk_membership',
  'tracefab_sync_clerk_organization',
  'tracefab_revoke_clerk_membership',
  'tracefab_upsert_clerk_user',
  'tracefab_ensure_clerk_user',
  'tracefab_soft_delete_clerk_user',
  'tracefab_archive_clerk_organization',
  'tracefab_clerk_organization_uuid',
  'tracefab_notification_outbox_health',
  'tracefab_claim_notification_outbox',
  'tracefab_complete_notification_outbox',
  'tracefab_enqueue_due_data_request_reminders',
  'tracefab_enqueue_manual_data_request_reminder',
];

function assert(ok, message) {
  if (!ok) throw new Error(message);
  console.log('OK  ' + message);
}

const url = (process.env.DATABASE_URL || '').trim();
if (!url) throw new Error('DATABASE_URL absente : aucune connexion tentee.');
const parsed = new URL(url);
assert(parsed.hostname.startsWith(EXPECTED_ENDPOINT + '.'), 'endpoint Neon Preview P11 attendu');
assert(!parsed.hostname.includes('-pooler'), 'connexion directe Neon (non pooler)');
const client = new pg.Client({
  connectionString: url,
  ssl: sslDepuisUrl(url),
  application_name: 'tracefab-p107-preview-migration-guard',
});

await client.connect();
try {
  const identity = (await client.query(
    'SELECT current_database() AS database, current_user AS role'
  )).rows[0];
  assert(identity.database === 'neondb', 'base cible neondb');
  assert(identity.role === 'neondb_owner', 'role de migration neondb_owner');

  const historyRows = (await client.query(
    'SELECT migration_name, finished_at, rolled_back_at FROM public._prisma_migrations ORDER BY migration_name'
  )).rows;
  const unfinished = historyRows.filter((r) => !r.finished_at && !r.rolled_back_at);
  assert(unfinished.length === 0, 'aucune migration inachevee non annulee');

  const dirs = fs.readdirSync(path.resolve('prisma/migrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const applied = new Set(historyRows
    .filter((r) => r.finished_at && !r.rolled_back_at)
    .map((r) => r.migration_name));
  const missing = dirs.filter((name) => !applied.has(name));
  assert(missing.length === 1 && missing[0] === MIGRATION,
    'seule migration en attente = ' + MIGRATION);

  const existingP107 = historyRows.filter((r) => r.migration_name === MIGRATION);
  assert(existingP107.length === 0, 'migration P10.7 absente de l historique');

  const prerequisites = (await client.query(
    \`SELECT
       to_regclass('public.tracefab_identity_politique') IS NOT NULL AS policy_table,
       to_regclass('public.tracefab_identity_cles') IS NOT NULL AS keys_table,
       to_regclass('public.tracefab_runtime_function_registry') IS NOT NULL AS registry_table,
       (SELECT count(*)::int FROM public.tracefab_identity_cles WHERE actif) AS active_keys,
       EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tracefab_app') AS app_role,
       EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tracefab_worker') AS worker_role,
       EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tracefab_migrator') AS migrator_role\`
  )).rows[0];
  assert(prerequisites.policy_table && prerequisites.keys_table && prerequisites.registry_table,
    'tables de prerequis P10.5/P10.6 presentes');
  assert(prerequisites.active_keys > 0, 'au moins une cle HMAC active deja provisionnee');
  assert(prerequisites.app_role && prerequisites.worker_role && prerequisites.migrator_role,
    'roles app, worker et migrator presents');

  const functions = (await client.query(
    \`SELECT p.proname, p.prosecdef
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname = ANY($1::text[])\`,
    [SYSTEM_FUNCTIONS]
  )).rows;
  assert(functions.length === SYSTEM_FUNCTIONS.length && functions.every((f) => f.prosecdef),
    '13 operations systeme presentes et SECURITY DEFINER');

  const acl = (await client.query(
    \`SELECT
       has_table_privilege('tracefab_app','public.tracefab_identity_cles','SELECT') AS app_reads_keys,
       has_function_privilege('tracefab_app','public.tracefab_identite_jeton_valide(text)','EXECUTE') AS app_checks_user_identity\`
  )).rows[0];
  assert(acl.app_reads_keys === false, 'tracefab_app ne lit pas les cles HMAC');
  console.log('PREFLIGHT OK — aucune ecriture effectuee; migration officielle autorisee.');
} finally {
  await client.end();
}
