// Banc local P10.8. A exécuter uniquement dans le checkout de test #113 + #114,
// sous PostgreSQL 17 privé jetable : les helpers créent et modifient une base.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { randomBytes, createHmac } from 'node:crypto';
import { baseVierge, appliquer, connecter } from '../scripts/lib/p108_pg17.mjs';
import { requireThrowawayDb } from '../scripts/lib/require-throwaway-db.mjs';

requireThrowawayDb({ variables: ['TF_P108_PG_URL'], purpose: 'banc P10.8 isolé' });
const name = 'p108_clerk_candidate';
const db = await baseVierge(name);
let app;
try {
  const migrations = readdirSync('prisma/migrations', { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d/.test(d.name))
    .map((d) => ({ nom: d.name, ref: 'fixture', texte: readFileSync(`prisma/migrations/${d.name}/migration.sql`, 'utf8') }))
    .sort((a, b) => a.nom.localeCompare(b.nom));
  const chain = await appliquer(db, migrations);
  if (chain.echec) throw new Error(`chaîne SQL ${chain.appliquees.length}/${migrations.length}: ${JSON.stringify(chain.echec)}`);
  console.log(`OK chaîne SQL #113 + #114 : ${chain.appliquees.length}/${migrations.length} (pas Prisma)`);
  const acl = async () => (await db.query(`SELECT c.table_name, c.column_name, p.privilege,
      has_column_privilege('tracefab_app', format('%I.%I',c.table_schema,c.table_name), c.column_name,p.privilege) AS granted
    FROM information_schema.columns c CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE']) p(privilege)
    WHERE c.table_schema='public' AND c.table_name IN ('organizations','organization_memberships','audit_logs')
    ORDER BY 1,2,3`)).rows;
  const before = await acl();
  await db.query(readFileSync('livrables-prioritaire/candidat-p108-droits-clerk.sql','utf8'));
  assert.deepEqual(await acl(), before, 'les privilèges app ne doivent pas changer');
  const mode = (await db.query('SELECT systeme_strict FROM public.tracefab_identity_politique WHERE singleton')).rows[0].systeme_strict;
  assert.equal(mode, false, 'fixture : strict système non activé');
  const key = randomBytes(32);
  await db.query('INSERT INTO public.tracefab_identity_cles (version,secret,actif) VALUES (90101,$1,true)', [key]);
  const seconds = Number((await db.query('SELECT extract(epoch FROM now())::bigint AS n')).rows[0].n);
  const token = (expiry, k = key) => { const body = `v1|tracefab_system|tracefab_worker|${expiry}`; return `${body}.${createHmac('sha256', k).update(body).digest('hex')}`; };
  app = await connecter(name,'tracefab_app');
  const callOrg = () => app.query("SELECT id FROM public.tracefab_sync_clerk_organization('local_org_p108','Nom local','Nom local','brand')");
  const setToken = (t) => app.query("SELECT set_config('tracefab.identity_systeme',$1,false)",[t]);
  async function refused(t, label) {
    await setToken(t);
    try { await callOrg(); throw new Error(`${label}: accepté à tort`); }
    catch (e) { assert.equal(e.code, '42501', `${label}: ${e.code} ${e.message}`); }
    console.log(`OK ${label} : refus 42501`);
  }
  await refused('', 'jeton absent');
  await refused(token(seconds+60, randomBytes(32)), 'MAC incorrect');
  await refused(token(seconds-1), 'jeton expiré');
  await setToken(token(seconds+60));
  const user = await app.query("SELECT id FROM public.tracefab_upsert_clerk_user('local_p108_user','p108@example.invalid','Sonde')");
  const org = await callOrg();
  const membership = await app.query("SELECT id FROM public.tracefab_sync_clerk_membership('local_p108_member',$1,$2,'owner')", [org.rows[0].id,user.rows[0].id]);
  assert.equal(user.rowCount,1); assert.equal(org.rowCount,1); assert.equal(membership.rowCount,1);
  const againOrg = await callOrg();
  const againMember = await app.query("SELECT id FROM public.tracefab_sync_clerk_membership('local_p108_member',$1,$2,'owner')", [org.rows[0].id,user.rows[0].id]);
  assert.equal(againOrg.rows[0].id, org.rows[0].id);
  assert.equal(againMember.rows[0].id, membership.rows[0].id);
  const audits = await db.query("SELECT count(*)::int n FROM public.audit_logs WHERE entity_id=$1",[membership.rows[0].id]);
  assert.equal(audits.rows[0].n,2);
  await assert.rejects(app.query("SELECT public.tracefab_revoke_clerk_membership('local_p108_member')"),
    (e) => e.code === 'P0001' && e.message === 'last_owner_membership_required');
  const user2 = await app.query("SELECT id FROM public.tracefab_upsert_clerk_user('local_p108_user2','p108-2@example.invalid','Sonde 2')");
  const member2 = await app.query("SELECT id FROM public.tracefab_sync_clerk_membership('local_p108_member2',$1,$2,'contributor')", [org.rows[0].id,user2.rows[0].id]);
  await app.query("SELECT public.tracefab_revoke_clerk_membership('local_p108_member2')");
  const revoked = await db.query('SELECT status FROM public.organization_memberships WHERE id=$1', [member2.rows[0].id]);
  assert.equal(revoked.rows[0].status, 'revoked');
  console.log('OK jeton valide : création, mise à jour, révocation et audits ; dernier propriétaire protégé');
  await app.query("SELECT set_config('tracefab.user_id',$1,false), set_config('tracefab.active_organization_id',$2,false), set_config('tracefab.worker_context','true',false)",[user.rows[0].id,org.rows[0].id]);
  await refused('', 'GUC utilisateur et worker forgés sans jeton');
  await assert.rejects(app.query('SET ROLE tracefab_worker'), (e) => e.code === '42501');
  await assert.rejects(app.query("INSERT INTO public.organizations(clerk_organization_id,type,legal_name) VALUES ('local_direct','brand','Interdit')"), (e) => e.code === '42501');
  console.log('OK runtime : SET ROLE worker et INSERT direct refusés');
  console.log('Périmètre : candidate non intégrée, #113+#114, cluster local ; aucun strict ni environnement distant modifié.');
} finally {
  if (app) await app.end();
  await db.end();
}
