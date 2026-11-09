#!/usr/bin/env node
/**
 * Garde de migration P10.7 sur Neon Preview P11.
 * Lecture seule avant/apres l'unique mecanisme autorise : prisma migrate deploy.
 */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
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

const mode = process.argv[2] || 'preflight';
if (!['preflight', 'postflight'].includes(mode)) {
  throw new Error('Mode attendu : preflight ou postflight.');
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
    'SELECT current_database() AS database, current_user AS role, session_user AS session_role'
  )).rows[0];
  assert(identity.database === 'neondb', 'base cible neondb');
  if (mode === 'preflight') {
    assert(identity.role === 'neondb_owner', 'connexion initiale neondb_owner');
  } else {
    assert(identity.role === 'tracefab_migrator' && identity.session_role === 'neondb_owner',
      'postflight execute sous tracefab_migrator via neondb_owner');
  }

  const historyRows = (await client.query(
    'SELECT migration_name, finished_at, rolled_back_at FROM public._prisma_migrations ORDER BY migration_name'
  )).rows;
  const unfinished = historyRows.filter((r) => !r.finished_at && !r.rolled_back_at
    && r.migration_name !== MIGRATION);
  assert(unfinished.length === 0, 'aucune autre migration inachevee non annulee');
  const p107Rows = historyRows.filter((r) => r.migration_name === MIGRATION);
  assert(p107Rows.every((r) => !r.finished_at)
    && p107Rows.filter((r) => !r.rolled_back_at).length <= 1,
    'aucune application P10.7 terminee et au plus une tentative echouee non resolue');

  if (mode === 'preflight') {
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
    assert(p107Rows.every((r) => !r.finished_at)
      && p107Rows.filter((r) => !r.rolled_back_at).length <= 1,
      'aucune application precedente de P10.7; historique echoue entierement annule ou tentative recuperable unique');

    const partial = (await client.query([
      'SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=\'public\' AND table_name=\'tracefab_identity_politique\' AND column_name=\'systeme_strict\') AS system_mode_column,',
      'to_regprocedure(\'public.tracefab_identite_systeme_jeton_valide(text)\') IS NOT NULL AS verifier_function,',
      'to_regprocedure(\'public.tracefab_sec_probe_identite_systeme()\') IS NOT NULL AS probe_function'
    ].join(' '))).rows[0];
    assert(partial.system_mode_column === false && partial.verifier_function === false && partial.probe_function === false,
      'aucun effet partiel P10.7 a recuperer dans le schema');

    const prerequisites = (await client.query([
      'SELECT to_regclass(\'public.tracefab_identity_politique\') IS NOT NULL AS policy_table,',
      'to_regclass(\'public.tracefab_identity_cles\') IS NOT NULL AS keys_table,',
      'to_regclass(\'public.tracefab_runtime_function_registry\') IS NOT NULL AS registry_table,',
      '(SELECT count(*)::int FROM public.tracefab_identity_cles WHERE actif) AS active_keys,',
      'EXISTS (SELECT 1 FROM pg_roles WHERE rolname=\'tracefab_app\') AS app_role,',
      'EXISTS (SELECT 1 FROM pg_roles WHERE rolname=\'tracefab_worker\') AS worker_role,',
      'EXISTS (SELECT 1 FROM pg_roles WHERE rolname=\'tracefab_migrator\') AS migrator_role'
    ].join(' '))).rows[0];
    assert(prerequisites.policy_table && prerequisites.keys_table && prerequisites.registry_table,
      'tables de prerequis P10.5/P10.6 presentes');
    assert(prerequisites.active_keys > 0, 'au moins une cle HMAC active deja provisionnee');
    assert(prerequisites.app_role && prerequisites.worker_role && prerequisites.migrator_role,
      'roles app, worker et migrator presents');

    const functions = (await client.query(
      'SELECT p.proname, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=\'public\' AND p.proname = ANY($1::text[])',
      [SYSTEM_FUNCTIONS]
    )).rows;
    assert(functions.length === SYSTEM_FUNCTIONS.length && functions.every((f) => f.prosecdef),
      '13 operations systeme presentes et SECURITY DEFINER');

    const acl = (await client.query([
      'SELECT has_table_privilege(\'tracefab_app\',\'public.tracefab_identity_cles\',\'SELECT\') AS app_reads_keys,',
      'has_function_privilege(\'tracefab_app\',\'public.tracefab_identity_jeton_utilisateur(text)\',\'EXECUTE\') AS app_checks_user_identity'
    ].join(' '))).rows[0];
    assert(acl.app_reads_keys === false, 'tracefab_app ne lit pas les cles HMAC');
    assert(acl.app_checks_user_identity === true, 'validation de l identite utilisateur toujours accordee');

    const owner = (await client.query([
      'SELECT pg_has_role(\'neondb_owner\', \'tracefab_migrator\', \'MEMBER\') AS can_set_migrator,',
      '(SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace',
      ' WHERE n.nspname=\'public\' AND c.relname=\'tracefab_identity_politique\') AS policy_owner'
    ].join(' '))).rows[0];
    assert(owner.can_set_migrator === true && owner.policy_owner === 'tracefab_migrator',
      'neondb_owner peut endosser le role proprietaire tracefab_migrator');

    const migrationUrl = new URL(url);
    const previousOptions = migrationUrl.searchParams.get('options');
    migrationUrl.searchParams.set('options', [previousOptions, '-c role=tracefab_migrator'].filter(Boolean).join(' '));
    const migrationConnection = migrationUrl.toString();
    const migratorClient = new pg.Client({
      connectionString: migrationConnection,
      ssl: sslDepuisUrl(migrationConnection),
      application_name: 'tracefab-p107-preview-migrator-role-check',
    });
    try {
      await migratorClient.connect();
      const effective = (await migratorClient.query(
        'SELECT current_database() AS database, current_user AS role, session_user AS session_role'
      )).rows[0];
      assert(effective.database === 'neondb' && effective.role === 'tracefab_migrator'
        && effective.session_role === 'neondb_owner',
      'connexion Prisma preparee sous tracefab_migrator, session neondb_owner');
    } finally {
      await migratorClient.end();
    }

    const githubEnv = process.env.GITHUB_ENV;
    if (!githubEnv) throw new Error('GITHUB_ENV absent : impossible de preparer le role de migration sans exposer la connexion.');
    fs.appendFileSync(githubEnv,
      'DATABASE_URL=' + migrationConnection + '\n'
      + 'TRACEFAB_P11_NEEDS_RESOLVE=' + (p107Rows.some((r) => !r.rolled_back_at) ? 'true' : 'false') + '\n');
    process.stdout.write('::add-mask::' + migrationConnection + '\n');
    console.log('PREFLIGHT OK — cible P11, aucun effet partiel; role proprietaire prepare; recuperation Prisma conditionnelle.');
  } else {
    const row = historyRows.find((r) => r.migration_name === MIGRATION && r.finished_at && !r.rolled_back_at);
    assert(row, 'migration P10.7 enregistree comme appliquee');

    const policy = (await client.query(
      'SELECT systeme_strict FROM public.tracefab_identity_politique WHERE singleton'
    )).rows[0];
    assert(policy && policy.systeme_strict === false,
      'mode systeme reste permissif apres migration (activation separee)');

    const acl = (await client.query([
      'SELECT has_function_privilege(\'tracefab_app\',\'public.tracefab_identite_systeme_jeton_valide(text)\',\'EXECUTE\') AS app_can_verify,',
      'has_function_privilege(\'tracefab_app\',\'public.tracefab_identite_systeme()\',\'EXECUTE\') AS app_can_call_predicate,',
      'has_function_privilege(\'tracefab_worker\',\'public.tracefab_identite_systeme()\',\'EXECUTE\') AS worker_can_call_predicate,',
      'has_function_privilege(\'tracefab_migrator\',\'public.tracefab_identite_systeme()\',\'EXECUTE\') AS migrator_can_call_predicate,',
      'has_table_privilege(\'tracefab_app\',\'public.tracefab_identity_cles\',\'SELECT\') AS app_reads_keys'
    ].join(' '))).rows[0];
    assert(acl.app_can_verify === true, 'tracefab_app peut verifier un jeton systeme');
    assert(acl.app_can_call_predicate === false, 'tracefab_app ne peut pas appeler le predicat interne');
    assert(acl.worker_can_call_predicate === true, 'tracefab_worker peut appeler le predicat');
    assert(acl.migrator_can_call_predicate === true, 'tracefab_migrator peut appeler le predicat');
    assert(acl.app_reads_keys === false, 'tracefab_app ne lit toujours pas les cles');

    const functions = (await client.query(
      'SELECT p.proname, p.prosecdef, position(\'tracefab_identite_systeme()\' in pg_get_functiondef(p.oid)) > 0 AS guarded FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=\'public\' AND p.proname = ANY($1::text[])',
      [SYSTEM_FUNCTIONS]
    )).rows;
    assert(functions.length === SYSTEM_FUNCTIONS.length
      && functions.every((f) => f.prosecdef && f.guarded),
      'les 13 operations systeme portent toutes la garde d origine');

    const probe = (await client.query('SELECT * FROM public.tracefab_sec_probe_identite_systeme()')).rows[0];
    assert(Number(probe.operations_systeme_gardees) === 13, 'sonde catalogue : 13 operations gardees');
    assert(Number(probe.operations_systeme_non_gardees) === 0, 'sonde catalogue : aucune operation non gardee');
    assert(probe.runtime_lit_les_cles === false, 'sonde catalogue : runtime sans lecture des cles');

    const keys = (await client.query(
      'SELECT version, encode(secret, \'hex\') AS secret_hex FROM public.tracefab_identity_cles WHERE actif ORDER BY version DESC'
    )).rows;
    assert(keys.length > 0, 'au moins une cle active apres migration');
    const now = Number((await client.query(
      'SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS epoch'
    )).rows[0].epoch);

    for (const key of keys) {
      const secret = Buffer.from(key.secret_hex, 'hex');
      const sign = (expiration) => {
        const body = 'v1|tracefab_system|tracefab_worker|' + expiration;
        const mac = createHmac('sha256', secret).update(body).digest('hex');
        return body + '.' + mac;
      };
      let expiry = now + 60;
      let validToken = sign(expiry);
      while (!/[a-f]/.test(validToken.split('.')[1]) && expiry < now + 120) {
        expiry += 1;
        validToken = sign(expiry);
      }
      const mac = validToken.split('.')[1];
      const invalidMac = (mac[0] === '0' ? '1' : '0') + mac.slice(1);
      const invalidToken = validToken.split('.')[0] + '.' + invalidMac;
      const upperToken = validToken.split('.')[0] + '.' + mac.toUpperCase();
      const expiredToken = sign(now - 1);
      const tooLongToken = sign(now + 601);
      const ambiguousToken = validToken + '.extra';
      const checks = (await client.query(
        'SELECT public.tracefab_identite_systeme_jeton_valide($1) AS valid, ' +
        'public.tracefab_identite_systeme_jeton_valide($2) AS bad_mac, ' +
        'public.tracefab_identite_systeme_jeton_valide($3) AS uppercase_mac, ' +
        'public.tracefab_identite_systeme_jeton_valide($4) AS expired, ' +
        'public.tracefab_identite_systeme_jeton_valide($5) AS over_ttl, ' +
        'public.tracefab_identite_systeme_jeton_valide($6) AS ambiguous',
        [validToken, invalidToken, upperToken, expiredToken, tooLongToken, ambiguousToken]
      )).rows[0];
      assert(checks.valid === true, 'HMAC valide accepte pour cle v' + key.version);
      assert(checks.bad_mac === false, 'MAC falsifie refuse pour cle v' + key.version);
      assert(checks.uppercase_mac === false, 'MAC non canonique refuse pour cle v' + key.version);
      assert(checks.expired === false, 'jeton expire refuse pour cle v' + key.version);
      assert(checks.over_ttl === false, 'jeton au-dela du TTL refuse pour cle v' + key.version);
      assert(checks.ambiguous === false, 'jeton a serialization ambigue refuse pour cle v' + key.version);
    }
    console.log('POSTFLIGHT OK — migration et verificateur HMAC mesures; systeme_strict reste false.');
  }
} finally {
  await client.end();
}
