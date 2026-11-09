#!/usr/bin/env node
/**
 * P10.7 — migration corrective RLS du role worker sur Preview P11.
 * Preflight strictement en lecture seule; postflight teste l'archivage dans
 * une transaction annulee. Aucune ecriture ne persiste.
 */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';

const MIGRATION = '20261109190000_p107_worker_organizations_update';
const EXPECTED_ENDPOINT = 'ep-lively-field-b1wicg4v';
const WORKER_READ_ONLY_EXCEPTION = 'tracefab_current_user_email';

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log('OK  ' + message);
}

const mode = process.argv[2] || 'preflight';
if (!['preflight', 'postflight'].includes(mode)) {
  throw new Error('Mode attendu : preflight ou postflight.');
}
const rawUrl = (process.env.DATABASE_URL || '').trim();
if (!rawUrl) throw new Error('DATABASE_URL absente : aucune connexion tentee.');
const parsed = new URL(rawUrl);
assert(parsed.hostname.startsWith(EXPECTED_ENDPOINT + '.'), 'endpoint Neon Preview P11 attendu');
assert(!parsed.hostname.includes('-pooler'), 'connexion directe Neon (non pooler)');
if (mode === 'postflight') {
  const options = parsed.searchParams.get('options');
  if (!/(?:^|\\s)-c\\s+role=tracefab_migrator(?:\\s|$)/.test(options || '')) {
    parsed.searchParams.set('options', [options, '-c role=tracefab_migrator'].filter(Boolean).join(' '));
  }
}
const connectionUrl = parsed.toString();
const client = new pg.Client({
  connectionString: connectionUrl,
  ssl: sslDepuisUrl(connectionUrl),
  application_name: 'tracefab-p107-worker-rls-verification',
});

try {
  await client.connect();
  const identity = (await client.query(
    'SELECT current_database() AS database, current_user AS role, session_user AS session_role'
  )).rows[0];
  assert(identity.database === 'neondb', 'base cible neondb');
  if (mode === 'preflight') {
    assert(identity.role === 'neondb_owner', 'connexion preflight neondb_owner');
  } else {
    assert(identity.role === 'tracefab_migrator' && identity.session_role === 'neondb_owner',
      'postflight sous tracefab_migrator via neondb_owner');
  }

  const history = (await client.query(
    'SELECT migration_name, finished_at, rolled_back_at FROM public._prisma_migrations ORDER BY migration_name'
  )).rows;
  const unfinished = history.filter((row) => !row.finished_at && !row.rolled_back_at);
  if (mode === 'preflight') {
    assert(unfinished.length <= 1 && unfinished.every((row) => row.migration_name === MIGRATION),
      'seule tentative echouee eventuelle = ' + MIGRATION);
  } else {
    assert(unfinished.length === 0, 'aucune migration inachevee non annulee apres deploy');
  }
  const applied = new Set(history.filter((row) => row.finished_at && !row.rolled_back_at).map((row) => row.migration_name));
  const dirs = fs.readdirSync(path.resolve('prisma/migrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const pending = dirs.filter((name) => !applied.has(name));

  const strict = (await client.query(
    'SELECT systeme_strict FROM public.tracefab_identity_politique WHERE singleton'
  )).rows[0]?.systeme_strict;
  assert(strict === false, 'systeme_strict reste false pendant le postflight');

  const roles = (await client.query(
    "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('tracefab_app','tracefab_worker','tracefab_migrator','neondb_owner')"
  )).rows;
  const worker = roles.find((role) => role.rolname === 'tracefab_worker');
  assert(worker && worker.rolsuper === false && worker.rolbypassrls === false,
    'tracefab_worker ne possede ni SUPERUSER ni BYPASSRLS');
  const appWorkerMembership = (await client.query(
    "SELECT pg_has_role('tracefab_app', 'tracefab_worker', 'MEMBER') AS member"
  )).rows[0]?.member;
  assert(appWorkerMembership === false, 'tracefab_app ne peut pas assumer tracefab_worker');

  const unguarded = (await client.query(
    "SELECT p.proname FROM pg_proc p WHERE p.proowner = 'tracefab_worker'::regrole AND p.prosecdef AND p.pronamespace = 'public'::regnamespace AND p.proname <> $1 AND position('tracefab_identite_systeme()' in pg_get_functiondef(p.oid)) = 0 ORDER BY p.proname",
    [WORKER_READ_ONLY_EXCEPTION]
  )).rows;
  assert(unguarded.length === 0, 'toutes les fonctions SECURITY DEFINER d ecriture du worker sont gardees HMAC');

  const archiveOwner = (await client.query(
    "SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid='public.tracefab_archive_clerk_organization(text)'::regprocedure"
  )).rows[0]?.owner;
  assert(archiveOwner === 'tracefab_worker', 'fonction d archivage executee sous tracefab_worker');

  const policy = (await client.query(
    "SELECT qual, with_check FROM pg_policies WHERE schemaname='public' AND tablename='organizations' AND policyname='organizations_worker_update' AND cmd='UPDATE'"
  )).rows[0];

  if (mode === 'preflight') {
    assert(pending.length === 1 && pending[0] === MIGRATION,
      'seule migration en attente = ' + MIGRATION + ' (trouvees: ' + pending.join(', ') + ')');
    assert(!policy, 'la politique corrective organizations_worker_update est encore absente');
  } else {
    assert(pending.length === 0, 'aucune migration Prisma en attente apres deploy');
    assert(applied.has(MIGRATION), MIGRATION + ' est enregistree comme appliquee');
    assert(policy && /tracefab_worker/.test(policy.qual || '') && /tracefab_worker/.test(policy.with_check || ''),
      'la politique RLS limite UPDATE au role tracefab_worker');

    const probeId = 'org_p107_worker_rls_probe_' + randomBytes(8).toString('hex');
    await client.query('BEGIN');
    try {
      await client.query(
        "SELECT public.tracefab_sync_clerk_organization($1, 'TraceFab P10.7 RLS probe', 'TraceFab P10.7 RLS probe', 'brand'::organization_type)",
        [probeId]
      );
      const archive = (await client.query(
        'SELECT public.tracefab_archive_clerk_organization($1) AS archived',
        [probeId]
      )).rows[0];
      assert(archive?.archived === true, 'archivage effectif sous RLS forcee (creation puis archivage dans la meme transaction)');
      const persisted = (await client.query(
        'SELECT status FROM public.organizations WHERE clerk_organization_id = $1',
        [probeId]
      )).rows[0];
      assert(persisted?.status === 'archived', 'statut archived persiste reellement sous RLS forcee');
    } finally {
      await client.query('ROLLBACK');
    }
  }
  console.log('P10.7 worker RLS ' + mode + ' : OK');
} finally {
  await client.end().catch(() => {});
}
