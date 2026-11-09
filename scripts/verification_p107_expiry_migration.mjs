#!/usr/bin/env node
/**
 * Preflight/postflight strictement cible pour la correction de borne TTL P10.7.
 * L'application reste exclusivement realisee par prisma migrate deploy.
 */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';

const MIGRATION = '20261109170000_p107_expiration_floor';
const P107 = '20261106130000_identite_systeme_signee';
const ENDPOINT = 'ep-lively-field-b1wicg4v';
const mode = process.argv[2] || 'preflight';
if (!['preflight', 'postflight'].includes(mode)) throw new Error('Mode invalide.');

function assert(ok, message) {
  if (!ok) throw new Error(message);
  console.log('OK  ' + message);
}

const rawUrl = (process.env.DATABASE_URL || '').trim();
if (!rawUrl) throw new Error('DATABASE_URL absente.');
const parsed = new URL(rawUrl);
assert(parsed.hostname.startsWith(ENDPOINT + '.'), 'endpoint Neon Preview P11 exact');
assert(!parsed.hostname.includes('-pooler'), 'connexion directe non pooler');

if (mode === 'postflight') {
  const options = parsed.searchParams.get('options');
  if (!/(?:^|\s)-c\s+role=tracefab_migrator(?:\s|$)/.test(options || '')) {
    parsed.searchParams.set('options', [options, '-c role=tracefab_migrator'].filter(Boolean).join(' '));
  }
}
const url = parsed.toString();
const client = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url), application_name: 'tracefab-p107-expiry-guard' });
await client.connect();

try {
  const identity = (await client.query('SELECT current_database() AS db, current_user AS role, session_user AS session_role')).rows[0];
  assert(identity.db === 'neondb', 'base neondb');
  if (mode === 'preflight') {
    assert(identity.role === 'neondb_owner' && identity.session_role === 'neondb_owner', 'connexion admin initiale');
    const history = (await client.query('SELECT migration_name, finished_at, rolled_back_at FROM public._prisma_migrations')).rows;
    assert(history.some(r => r.migration_name === P107 && r.finished_at && !r.rolled_back_at), 'migration P10.7 initiale deja appliquee');
    assert(!history.some(r => r.migration_name === MIGRATION), 'migration de correction jamais tentee');
    const dirs = fs.readdirSync(path.resolve('prisma/migrations'), { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name);
    const applied = new Set(history.filter(r => r.finished_at && !r.rolled_back_at).map(r => r.migration_name));
    const missing = dirs.filter(name => !applied.has(name));
    assert(missing.length === 1 && missing[0] === MIGRATION, 'seule migration en attente = ' + MIGRATION);
  } else {
    assert(identity.role === 'tracefab_migrator' && identity.session_role === 'neondb_owner', 'postflight sous tracefab_migrator');
    const row = (await client.query('SELECT finished_at, rolled_back_at FROM public._prisma_migrations WHERE migration_name=$1 ORDER BY started_at DESC LIMIT 1', [MIGRATION])).rows[0];
    assert(row && row.finished_at && !row.rolled_back_at, 'migration de correction enregistree comme appliquee');
  }

  const policy = (await client.query('SELECT systeme_strict FROM public.tracefab_identity_politique WHERE singleton')).rows[0];
  assert(policy && policy.systeme_strict === false, 'mode strict reste desactive');
  const membership = (await client.query("SELECT pg_has_role('tracefab_migrator','tracefab_worker','MEMBER') AS member")).rows[0];
  assert(membership.member === false, 'aucune appartenance temporaire migrator/worker');
  const verifier = (await client.query("SELECT pg_get_userbyid(p.proowner) AS owner, pg_get_functiondef(p.oid) AS definition FROM pg_proc p WHERE p.oid='public.tracefab_identite_systeme_jeton_valide(text)'::regprocedure")).rows[0];
  assert(verifier.owner === 'tracefab_migrator', 'fonction de verification reste possedee par tracefab_migrator');
  if (mode === 'preflight') {
    assert(verifier.definition.includes('v_maintenant := extract(epoch FROM pg_catalog.now())::BIGINT;')
      && !verifier.definition.includes('floor(extract(epoch FROM pg_catalog.now()))::BIGINT'),
      'version actuelle identifiee : conversion arrondie a corriger');
  } else {
    assert(verifier.definition.includes('floor(extract(epoch FROM pg_catalog.now()))::BIGINT'),
      'borne temporelle utilise un arrondi inferieur strict');
  }

  if (mode === 'preflight') {
    const roleUrl = new URL(rawUrl);
    const options = roleUrl.searchParams.get('options');
    roleUrl.searchParams.set('options', [options, '-c role=tracefab_migrator'].filter(Boolean).join(' '));
    const migrationUrl = roleUrl.toString();
    const roleClient = new pg.Client({ connectionString: migrationUrl, ssl: sslDepuisUrl(migrationUrl), application_name: 'tracefab-p107-expiry-role-check' });
    try {
      await roleClient.connect();
      const role = (await roleClient.query('SELECT current_user AS role, session_user AS session_role')).rows[0];
      assert(role.role === 'tracefab_migrator' && role.session_role === 'neondb_owner', 'Prisma peut endosser tracefab_migrator');
    } finally {
      await roleClient.end();
    }
    if (!process.env.GITHUB_ENV) throw new Error('GITHUB_ENV absent.');
    fs.appendFileSync(process.env.GITHUB_ENV, 'DATABASE_URL=' + migrationUrl + '\n');
    process.stdout.write('::add-mask::' + migrationUrl + '\n');
  }
  console.log(mode.toUpperCase() + ' OK — correction P10.7 controlee, mode strict inchange.');
} finally {
  await client.end();
}
