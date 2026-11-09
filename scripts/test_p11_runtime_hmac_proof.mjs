#!/usr/bin/env node
/**
 * P11 one-shot deployment proof: the actual Vercel Preview environment
 * signs identities with the configured secret and PostgreSQL verifies them
 * through the tracefab_app connection. Read-only; every probe rolls back.
 */
import process from 'node:process';
import pg from 'pg';
import { signerIdentite, cleIdentite, identiteSigneeConfiguree } from '../api/_lib/identite-jeton.js';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';

const url = (process.env.DATABASE_URL || '').trim();
if (!url || !identiteSigneeConfiguree()) throw new Error('P11 runtime HMAC configuration absent or invalid');
const user = 'b0000000-0000-0000-0000-000000000002';
const orgA = 'dc90cd7a-ee4a-4a3c-adae-5d96f2a48780';
const orgB = '2729c0b1-bcf5-44c4-9fe4-679c1adba1f8';
const db = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url), application_name: 'tracefab-p11-runtime-hmac-proof' });
await db.connect();
let assertions = 0;
function ok(condition, label) {
  assertions++;
  if (!condition) throw new Error('FAIL: ' + label);
  console.log('PASS: ' + label);
}
async function resolve(token, activeOrg, forgedUser = '') {
  await db.query('BEGIN');
  try {
    await db.query("SELECT set_config('tracefab.active_organization_id',$1,true)", [activeOrg]);
    await db.query("SELECT set_config('tracefab.user_id',$1,true)", [forgedUser]);
    await db.query("SELECT set_config('tracefab.identity',$1,true)", [token]);
    return (await db.query('SELECT public.tracefab_current_user_id()::text AS user_id')).rows[0].user_id;
  } finally { await db.query('ROLLBACK'); }
}
try {
  const identity = (await db.query("SELECT current_user AS role,current_database() AS db,current_setting('neon.branch_id',true) AS branch")).rows[0];
  ok(identity.role === 'tracefab_app' && identity.db === 'neondb' && identity.branch === 'br-square-bread-b1gu7jk7', 'runtime connected to P11 as tracefab_app');
  ok(cleIdentite() && identiteSigneeConfiguree(), 'Vercel runtime HMAC key is present and valid');
  const key = cleIdentite();
  const valid = signerIdentite({ userId:user, organizationId:orgA, cle:key });
  ok(Boolean(valid?.jeton) && await resolve(valid.jeton,orgA) === user, 'application signer token accepted by PostgreSQL');
  ok(await resolve(valid.jeton,orgB) === null, 'signed token bound to tenant A rejected in tenant B');
  const forged = await resolve('',orgA,user);
  ok(forged === null, 'forged user GUC without token rejected in strict mode');
  const bad = valid.jeton.slice(0,-1) + (valid.jeton.endsWith('0') ? '1' : '0');
  ok(await resolve(bad,orgA) === null, 'tampered HMAC rejected');
  const expired = signerIdentite({ userId:user, organizationId:orgA, cle:key, maintenant:Math.floor(Date.now()/1000)-3600 });
  ok(Boolean(expired?.jeton) && await resolve(expired.jeton,orgA) === null, 'expired signed token rejected');
  const acl = (await db.query("SELECT has_table_privilege('tracefab_app','public.tracefab_identity_cles','SELECT') AS can_read")).rows[0];
  ok(acl.can_read === false, 'runtime cannot read the HMAC key table');
  console.log('P11_RUNTIME_HMAC_PROOF=' + assertions + '/8');
} finally { await db.end(); }
