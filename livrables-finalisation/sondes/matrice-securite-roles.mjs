#!/usr/bin/env node
/**
 * MATRICE DE SÉCURITÉ SOUS RÔLES RÉELS — app, worker et migrator.
 *
 * POURQUOI CE SCRIPT EXISTE
 *
 * Les autres contrôles de cette mission s'exécutent sous `postgres`, c'est-à-dire
 * avec un rôle SUPERUTILISATEUR qui CONTOURNE la RLS et l'ACL. Conclure sur la
 * sécurité applicative depuis ces contrôles serait faux. Ce script mesure ce que
 * chaque rôle peut RÉELLEMENT faire.
 *
 * COMMENT L'IDENTITÉ EST ENDOSSÉE — ET POURQUOI PAS `SET ROLE`
 *
 * Première version de ce script : `SET ROLE tracefab_app` depuis la connexion
 * d'administration. Mesure : `SET ROLE tracefab_worker` était ensuite ACCEPTÉ.
 * Ce n'est pas une faille de la base, c'est un défaut de la mesure : le
 * `session_user` reste `postgres` (superutilisateur), et PostgreSQL autorise un
 * superutilisateur à endosser n'importe quel rôle. Une session réelle
 * `tracefab_app` n'a pas ce privilège.
 *
 * La mesure correcte est `SET SESSION AUTHORIZATION tracefab_app`, qui abandonne
 * définitivement les privilèges du superutilisateur sur la connexion. C'est
 * l'équivalent d'une connexion authentifiée sous ce rôle, sans mot de passe
 * (le rôle du banc en a un, synthétique, jamais journalisé ni réutilisé ici).
 *
 * CE QUI EST MESURÉ
 *
 * Sous `tracefab_app` (NOBYPASSRLS) — A1 à A10
 * Sous `tracefab_worker`   — W1 à W6
 * Sous `tracefab_migrator` — M0 à M4 (session authentifiée)
 * Chemins Clerk (SECURITY DEFINER) appelés depuis `tracefab_app` — C1 à C6
 *
 * Chaque écart est MESURÉ, jamais supposé. Les faits de conception qui ne sont
 * pas des écarts sont imprimés comme tels (« conception »), pour qu'on ne les
 * confonde pas avec des anomalies.
 *
 * Écrit uniquement dans la base jetable de DATABASE_URL. Nettoyage déterministe.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL requis.');
  process.exit(2);
}
let hoteCible = '';
try { hoteCible = new URL(url).hostname; } catch { /* refus ci-dessous */ }
if (!/^(localhost|127\\.0\\.0\\.1|::1|\\[::1\\])$/.test(hoteCible)) {
  console.error(`REFUS — la matrice écrit dans une base jetable locale uniquement (cible : ${hoteCible || 'URL illisible'}).`);
  process.exit(3);
}
const pg = (await import(process.env.TF_PG_MODULE || 'pg')).default;
const admin = new pg.Client({ connectionString: url });
await admin.connect();

const ORG_A = '00000000-0000-4000-8000-0000000000d1';
const ORG_B = '00000000-0000-4000-8000-0000000000d2';
const USER_A = '00000000-0000-4000-8000-0000000000d3';
const USER_B = '00000000-0000-4000-8000-0000000000d4';
const PROD_A = '00000000-0000-4000-8000-0000000000d5';
const DOC_A = '00000000-0000-4000-8000-0000000000d6';
const CLERK_ORG = 'sonde_clerk_org_1';

const resultats = [];
let code = 0;
function verifier(nom, condition, detail) {
  resultats.push({ nom, ok: condition, detail });
  if (!condition) code = 1;
  console.log(`${condition ? 'OK  ' : 'ECHEC'} ${nom}${detail ? ` — ${detail}` : ''}`);
}
function fait(nom, detail) {
  console.log(`     (conception) ${nom}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Ouvre une connexion dont l'identité est RÉELLEMENT `role`, puis exécute `sql`.
 *
 * DEUX MÉTHODES, ET LA SECONDE N'EST QU'UN REPLI
 *
 * 1. SESSION AUTHENTIFIÉE (TF_APP_MDP fourni) — la mesure de référence.
 *    La connexion est authentifiée sous `tracefab_app` : c'est exactement ce
 *    que fait le serveur en production. Le `session_user` initial est
 *    `tracefab_app`, donc aucun privilège de superutilisateur ne subsiste.
 *
 * 2. `SET SESSION AUTHORIZATION` — repli quand aucun mot de passe n'est fourni.
 *    ATTENTION, LIMITE MESURÉE : PostgreSQL n'autorise le changement de
 *    `session_user` que si l'utilisateur authentifié INITIAL était
 *    superutilisateur. Ici l'authentification initiale est `postgres` : la
 *    session peut donc encore endosser `tracefab_worker` en A11, ce qui n'est
 *    PAS un chemin ouvert en production. A11 n'est donc concluant qu'en mode 1.
 *
 * Rend { ok, rows, rowCount, sqlstate, message } — aucune exception ne remonte.
 */
const MDP_APP = process.env.TF_APP_MDP;
const MDP_MIGRATOR = process.env.TF_MIGRATOR_MDP;

function urlMigrator() {
  const u = new URL(url);
  u.username = 'tracefab_migrator';
  u.password = MDP_MIGRATOR;
  return u.toString();
}

async function sousMigrator(sql, params = []) {
  if (!MDP_MIGRATOR) return { ok: false, sqlstate: 'TF_MIGRATOR_MDP_ABSENT', message: 'session migrator authentifiée obligatoire' };
  const c = new pg.Client({ connectionString: urlMigrator() });
  await c.connect();
  try {
    try {
      const r = await c.query(sql, params);
      return { ok: true, rows: r.rows, rowCount: r.rowCount };
    } catch (e) {
      return { ok: false, sqlstate: e.code, message: e.message.split('\\n')[0] };
    }
  } finally { await c.end(); }
}

function urlApp() {
  const u = new URL(url);
  u.username = 'tracefab_app';
  u.password = MDP_APP;
  return u.toString();
}

async function sous(role, sql, params = [], contexte = {}) {
  const authentifie = role === 'tracefab_app' && MDP_APP;
  const c = new pg.Client({ connectionString: authentifie ? urlApp() : url });
  await c.connect();
  try {
    for (const [cle, valeur] of Object.entries(contexte)) {
      await c.query('SELECT set_config($1, $2, false)', [cle, valeur]);
    }
    if (!authentifie) await c.query(`SET SESSION AUTHORIZATION ${role}`);
    try {
      const r = await c.query(sql, params);
      return { ok: true, rows: r.rows, rowCount: r.rowCount };
    } catch (e) {
      return { ok: false, sqlstate: e.code, message: e.message.split('\n')[0] };
    }
  } finally {
    await c.end();
  }
}

try {
  // ------------------------------------------------------------- préparation
  await admin.query(
    `INSERT INTO public.organizations (id, type, legal_name, country_code) VALUES
       ($1,'brand','Sonde Secu A','FR'), ($2,'brand','Sonde Secu B','FR')
     ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);
  await admin.query(
    `INSERT INTO public.users (id, clerk_user_id, email, full_name) VALUES
       ($1,'sonde_secu_a','sonde-a@example.invalid','Sonde A'),
       ($2,'sonde_secu_b','sonde-b@example.invalid','Sonde B')
     ON CONFLICT (id) DO NOTHING`, [USER_A, USER_B]);
  await admin.query(
    `INSERT INTO public.organization_memberships (organization_id, user_id, role, status)
     VALUES ($1,$2,'owner','active')
     ON CONFLICT (organization_id, user_id) DO UPDATE SET role='owner', status='active'`, [ORG_A, USER_A]);
  await admin.query(
    `INSERT INTO public.tracefab_products (id, brand_organization_id, reference, name, status)
     VALUES ($1,$2,'SONDE-SECU-A','Produit secu','active') ON CONFLICT (id) DO NOTHING`, [PROD_A, ORG_A]);
  await admin.query(
    `INSERT INTO public.documents (id, owner_organization_id, storage_bucket, storage_path, original_filename, content_type, byte_size)
     VALUES ($1,$2,'tracefab-private',$3 || '/secu/doc.pdf','doc.pdf','application/pdf',512)
     ON CONFLICT (id) DO NOTHING`, [DOC_A, ORG_A, ORG_A]);

  const ctx = { 'tracefab.user_id': USER_A, 'tracefab.active_organization_id': ORG_A };

  // ============================================================ tracefab_app
  console.log('--- tracefab_app (SESSION AUTHORIZATION, pas SET ROLE)');

  const a0 = await sous('tracefab_app', 'SELECT session_user AS s, current_user AS c');
  verifier('A0 identite reellement endossee',
    a0.ok && a0.rows[0].s === 'tracefab_app' && a0.rows[0].c === 'tracefab_app',
    `${a0.ok ? `session_user=${a0.rows[0].s} current_user=${a0.rows[0].c}` : a0.sqlstate}`
    + ` [${MDP_APP ? 'session authentifiee' : 'SET SESSION AUTHORIZATION, repli'}]`);

  const a1 = await sous('tracefab_app',
    'SELECT count(*)::int AS n FROM public.organizations WHERE id = $1', [ORG_A], ctx);
  verifier('A1 lecture de sa propre organisation', a1.ok && a1.rows[0].n === 1,
    a1.ok ? `${a1.rows[0].n} ligne(s)` : `${a1.sqlstate} ${a1.message}`);

  const a2 = await sous('tracefab_app',
    'SELECT count(*)::int AS n FROM public.organizations WHERE id = $1', [ORG_B], ctx);
  verifier('A2 lecture d une autre organisation refusee (RLS)', a2.ok && a2.rows[0].n === 0,
    a2.ok ? `${a2.rows[0].n} ligne(s)` : `${a2.sqlstate} ${a2.message}`);

  const a3 = await sous('tracefab_app',
    `UPDATE public.documents SET status = 'available' WHERE id = $1`, [DOC_A], ctx);
  verifier('A3 ecriture d une colonne reservee de document refusee',
    !a3.ok && a3.sqlstate === '42501', a3.ok ? 'ECRITURE ACCEPTEE' : a3.sqlstate);

  const a4 = await sous('tracefab_app',
    `INSERT INTO public.documents (owner_organization_id, storage_bucket, storage_path, original_filename, content_type, byte_size)
     VALUES ($1,'tracefab-private',$2 || '/secu/x.pdf','x.pdf','application/pdf',10)`, [ORG_A, ORG_A], ctx);
  verifier('A4 INSERT direct dans documents refuse', !a4.ok && a4.sqlstate === '42501',
    a4.ok ? 'INSERT ACCEPTE' : a4.sqlstate);

  const a5 = await sous('tracefab_app',
    `UPDATE public.tracefab_products SET name = 'Produit secu modifie' WHERE id = $1`,
    [PROD_A], ctx);
  verifier('A5 ecriture du perimetre runtime autorisee', a5.ok && a5.rowCount === 1,
    a5.ok ? `${a5.rowCount} ligne(s)` : `${a5.sqlstate} ${a5.message}`);

  const a6 = await sous('tracefab_app',
    `UPDATE public.tracefab_products SET version = 99 WHERE id = $1`, [PROD_A], ctx);
  verifier('A6 ecriture d un champ calcule refusee', !a6.ok && a6.sqlstate === '42501',
    a6.ok ? 'ECRITURE ACCEPTEE' : a6.sqlstate);

  const a7 = await sous('tracefab_app',
    'SELECT public.tracefab_validate_supply_chain_node()', [], ctx);
  verifier('A7 execution d une fonction hors registre refusee',
    !a7.ok && a7.sqlstate === '42501', a7.ok ? 'EXECUTION ACCEPTEE' : a7.sqlstate);

  const a8 = await sous('tracefab_app',
    'CREATE TABLE public.sonde_creation_interdite(id int)', [], ctx);
  verifier('A8 creation d objet dans public refusee', !a8.ok && a8.sqlstate === '42501',
    a8.ok ? 'CREATION ACCEPTEE' : a8.sqlstate);

  const a9 = await sous('tracefab_app',
    `SELECT pg_catalog.pg_has_role('tracefab_app','tracefab_worker','MEMBER') AS membre`);
  verifier('A9 tracefab_app n est pas membre de tracefab_worker',
    a9.ok && a9.rows[0].membre === false, `membre=${a9.rows[0]?.membre}`);

  const a10 = await sous('tracefab_app', 'SET ROLE tracefab_worker');
  verifier('A10 SET ROLE tracefab_worker refuse (session applicative reelle)',
    !a10.ok && a10.sqlstate === '42501',
    a10.ok ? 'SET ROLE ACCEPTE' : a10.sqlstate);

  const a11 = await sous('tracefab_app', 'SET SESSION AUTHORIZATION tracefab_worker');
  verifier('A11 SET SESSION AUTHORIZATION tracefab_worker refuse',
    !a11.ok && a11.sqlstate === '42501',
    a11.ok ? 'ENDOSSEMENT ACCEPTE' : a11.sqlstate);

  // ========================================================= tracefab_worker
  console.log('--- tracefab_worker');
  const w1 = await admin.query(
    `SELECT count(*)::int AS n FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
      WHERE r.rolname = 'tracefab_worker'`);
  verifier('W1 huit fonctions appartiennent au worker', w1.rows[0].n === 8,
    `${w1.rows[0].n} fonction(s)`);

  const w2 = await sous('tracefab_worker', 'SELECT count(*)::int AS n FROM public.tracefab_notification_outbox_health()');
  verifier('W2 execution d une fonction systeme possedee par le worker', w2.ok,
    w2.ok ? `${w2.rows[0].n} ligne(s)` : `${w2.sqlstate} ${w2.message}`);

  const w3 = await sous('tracefab_worker', 'CREATE TABLE public.sonde_worker_interdite(id int)');
  verifier('W3 creation d objet dans public refusee', !w3.ok && w3.sqlstate === '42501',
    w3.ok ? 'CREATION ACCEPTEE' : w3.sqlstate);

  const w4 = await admin.query(
    `SELECT rolcanlogin, rolbypassrls, rolsuper, rolcreaterole FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_worker'`);
  const attrs = w4.rows[0];
  verifier('W4 attributs du worker (NOLOGIN, NOBYPASSRLS, NOSUPERUSER, NOCREATEROLE)',
    attrs.rolcanlogin === false && attrs.rolbypassrls === false
    && attrs.rolsuper === false && attrs.rolcreaterole === false, JSON.stringify(attrs));

  const w5 = await sous('tracefab_worker',
    `SELECT pg_catalog.has_function_privilege('tracefab_worker',
        'public.tracefab_ingest_plm_erp_payload(uuid,text,jsonb,uuid)','EXECUTE') AS ok`);
  verifier('W5 worker sans EXECUTE sur une fonction d ingestion de l allowlist', w5.ok && w5.rows[0].ok === false,
    `ok=${w5.rows[0]?.ok}`);

  const w6 = await sous('tracefab_worker',
    `SELECT pg_catalog.pg_has_role('tracefab_worker','tracefab_app','SET') AS peut_app,
            pg_catalog.pg_has_role('tracefab_app','tracefab_worker','SET') AS app_peut_worker`);
  verifier('W6 isolation bidirectionnelle app <-> worker',
    w6.ok && w6.rows[0].peut_app === false && w6.rows[0].app_peut_worker === false,
    `worker->app=${w6.rows[0]?.peut_app} app->worker=${w6.rows[0]?.app_peut_worker}`);

  // L'isolation n'est pas la seule garantie : le worker est NOLOGIN, donc aucune
  // session ne peut se présenter sous cette identité sans un SET ROLE d'un membre.
  const w7 = await admin.query(
    `SELECT count(*)::int AS n FROM pg_catalog.pg_auth_members m
       JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
      WHERE r.rolname = 'tracefab_worker' AND m.member = 0`);
  verifier('W7 worker non accorde a PUBLIC', w7.rows[0].n === 0, `${w7.rows[0].n} octroi(s) PUBLIC`);

  // ========================================================= tracefab_migrator
  console.log('--- tracefab_migrator (session authentifiée)');
  const m0 = await sousMigrator('SELECT session_user AS s, current_user AS c');
  verifier('M0 session réellement authentifiée sous tracefab_migrator',
    m0.ok && m0.rows[0].s === 'tracefab_migrator' && m0.rows[0].c === 'tracefab_migrator',
    m0.ok ? `session_user=${m0.rows[0].s} current_user=${m0.rows[0].c}` : `${m0.sqlstate} ${m0.message}`);
  const m1 = await sousMigrator(
    `SELECT pg_catalog.pg_has_role(current_user, 'tracefab_worker', 'MEMBER') AS membre`);
  verifier('M1 migrator non membre du worker après la chaîne',
    m1.ok && m1.rows[0].membre === false, m1.ok ? `membre=${m1.rows[0].membre}` : `${m1.sqlstate} ${m1.message}`);
  const m2 = await sousMigrator('SET ROLE tracefab_worker');
  verifier('M2 migrator ne peut pas endosser tracefab_worker',
    !m2.ok && m2.sqlstate === '42501', m2.ok ? 'SET ROLE ACCEPTÉ' : `${m2.sqlstate} ${m2.message}`);
  const m3 = await sousMigrator('SET SESSION AUTHORIZATION tracefab_worker');
  verifier('M3 migrator ne peut pas changer la session en worker',
    !m3.ok && m3.sqlstate === '42501', m3.ok ? 'SET SESSION AUTHORIZATION ACCEPTÉ' : `${m3.sqlstate} ${m3.message}`);
  const m4 = await sousMigrator(
    `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
       JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
       JOIN pg_catalog.pg_roles u ON u.oid = m.member
      WHERE r.rolname = 'tracefab_worker' AND u.rolname = 'tracefab_migrator'
        AND m.admin_option IS TRUE) AS admin_option`);
  verifier('M4 aucune ADMIN OPTION directe sur worker',
    m4.ok && m4.rows[0].admin_option === false,
    m4.ok ? `admin_option=${m4.rows[0].admin_option}` : `${m4.sqlstate} ${m4.message}`);

  // ================================================================= Clerk
  console.log('--- chemins Clerk (SECURITY DEFINER), depuis une session tracefab_app');
  const c1 = await sous('tracefab_app',
    `SELECT to_jsonb(public.tracefab_sync_clerk_organization($1,'Sonde Clerk SARL','Sonde Clerk','brand')) AS o`,
    [CLERK_ORG], ctx);
  verifier('C1 synchronisation d organisation Clerk', c1.ok,
    c1.ok ? `id=${String(c1.rows[0].o.id).slice(0, 8)}…` : `${c1.sqlstate} ${c1.message}`);
  const orgClerk = c1.ok ? c1.rows[0].o.id : null;

  // Deux utilisateurs DISTINCTS : `tracefab_sync_clerk_membership` retrouve une
  // adhésion existante par (organisation, utilisateur) et la réécrit. Utiliser le
  // même utilisateur pour l'owner et le viewer ne crée pas deux adhésions : cela
  // en modifie une seule. Mesuré sur une version antérieure de ce script.
  const c2 = orgClerk ? await sous('tracefab_app',
    `SELECT to_jsonb(public.tracefab_sync_clerk_membership($1,$2,$3,'owner')) AS m`,
    ['sonde_clerk_member_owner', orgClerk, USER_A], ctx) : { ok: false, sqlstate: 'SKIP', message: 'C1 en echec' };
  verifier('C2 synchronisation d adhesion Clerk (OWNER, creation)', c2.ok,
    c2.ok ? `id=${String(c2.rows[0].m.id).slice(0, 8)}…` : `${c2.sqlstate} ${c2.message}`);

  const c2b = orgClerk ? await sous('tracefab_app',
    `SELECT to_jsonb(public.tracefab_sync_clerk_membership($1,$2,$3,'viewer')) AS m`,
    ['sonde_clerk_member_viewer', orgClerk, USER_B], ctx) : { ok: false, sqlstate: 'SKIP', message: 'C1 en echec' };
  verifier('C2b synchronisation d adhesion Clerk (VIEWER, creation)', c2b.ok,
    c2b.ok ? 'creee' : `${c2b.sqlstate} ${c2b.message}`);

  const nbAdhesions = await admin.query(
    `SELECT count(*)::int AS n FROM public.organization_memberships WHERE organization_id = $1`, [orgClerk]);
  verifier('C2c deux adhesions distinctes en base', nbAdhesions.rows[0].n === 2,
    `${nbAdhesions.rows[0].n} adhesion(s)`);

  const c4 = orgClerk ? await sous('tracefab_app',
    `SELECT to_jsonb(public.tracefab_sync_clerk_organization($1,'Sonde Clerk SARL','Sonde Clerk','brand')) AS o`,
    [CLERK_ORG], ctx) : { ok: false, sqlstate: 'SKIP', message: 'C1 en echec' };
  const nbOrgsClerk = await admin.query(
    'SELECT count(*)::int AS n FROM public.organizations WHERE clerk_organization_id = $1', [CLERK_ORG]);
  verifier('C4 re-synchronisation idempotente (une seule organisation)',
    c4.ok && nbOrgsClerk.rows[0].n === 1, `${nbOrgsClerk.rows[0].n} organisation(s)`);

  const c3 = await sous('tracefab_app',
    `SELECT public.tracefab_revoke_clerk_membership($1)`, ['sonde_clerk_member_viewer'], ctx);
  const membreApres = await admin.query(
    `SELECT status FROM public.organization_memberships WHERE clerk_membership_id = $1`, ['sonde_clerk_member_viewer']);
  verifier('C3 revocation d adhesion Clerk (VIEWER, statut non actif)',
    c3.ok && ['revoked', 'suspended'].includes(membreApres.rows[0]?.status),
    c3.ok ? `statut=${membreApres.rows[0]?.status}` : `${c3.sqlstate} ${c3.message}`);

  // Garde-fou métier : revoquer le dernier OWNER doit rester REFUSÉ. Un transfert
  // de propriété qui court-circuiterait cette règle serait une perte de garantie.
  const c3b = await sous('tracefab_app',
    `SELECT public.tracefab_revoke_clerk_membership($1)`, ['sonde_clerk_member_owner'], ctx);
  verifier('C3b garde-fou : revocation du dernier OWNER refusee',
    !c3b.ok && /last_owner_membership_required/.test(`${c3b.message}`),
    c3b.ok ? 'REVOCATION ACCEPTEE' : `${c3b.sqlstate} ${c3b.message}`);

  // L'audit doit être écrit par ces fonctions. S'il ne l'était pas, le transfert
  // de propriété aurait fait disparaître la trace des adhésions en silence.
  const audit = await admin.query(
    `SELECT count(*)::int AS n FROM public.audit_logs WHERE organization_id = $1`, [orgClerk]);
  verifier('C4b audit ecrit par les fonctions Clerk', audit.rows[0].n >= 1,
    `${audit.rows[0].n} ligne(s) d audit`);

  // C6 : l'autorisation vient du rôle, pas du GUC. Un GUC falsifié ne doit rien
  // changer au résultat de l'appel.
  const c6 = await sous('tracefab_app',
    `SELECT to_jsonb(public.tracefab_sync_clerk_membership($1,$2,$3,'viewer')) AS m`,
    ['sonde_clerk_member_2', orgClerk, USER_B],
    { 'tracefab.user_id': '00000000-0000-4000-8000-0000000000ff' });
  verifier('C6 contexte falsifie : autorisation = role de session, pas le GUC',
    c6.ok, c6.ok ? 'appel reussi malgre un tracefab.user_id falsifie' : `${c6.sqlstate} ${c6.message}`);

  const c5 = await admin.query(
    `SELECT p.proname, pg_catalog.has_function_privilege('tracefab_worker', p.oid, 'EXECUTE') AS worker
       FROM pg_catalog.pg_proc p
      WHERE p.proname IN ('tracefab_sync_clerk_membership','tracefab_revoke_clerk_membership')`);
  fait('le worker possede ces fonctions, donc il peut les executer (privilege du proprietaire)',
    c5.rows.map((r) => `${r.proname}=${r.worker}`).join(' '));
  fait('mais le worker est NOLOGIN et jamais assumable par tracefab_app (A10, A11, W6)',
    'aucun chemin applicatif ne l atteint');
} finally {
  await admin.query('DROP TABLE IF EXISTS public.sonde_creation_interdite').catch(() => {});
  await admin.query('DROP TABLE IF EXISTS public.sonde_worker_interdite').catch(() => {});
  await admin.query(
    `DELETE FROM public.organization_memberships
      WHERE user_id = ANY($1)
         OR organization_id IN (SELECT id FROM public.organizations WHERE clerk_organization_id = $2)`,
    [[USER_A, USER_B], CLERK_ORG]).catch(() => {});
  await admin.query(
    `DELETE FROM public.audit_logs
      WHERE organization_id IN (SELECT id FROM public.organizations WHERE clerk_organization_id = $1)`,
    [CLERK_ORG]).catch(() => {});
  await admin.query('DELETE FROM public.documents WHERE id = $1', [DOC_A]).catch(() => {});
  await admin.query('DELETE FROM public.tracefab_products WHERE id = $1', [PROD_A]).catch(() => {});
  await admin.query('DELETE FROM public.organizations WHERE id = ANY($1) OR clerk_organization_id = $2',
    [[ORG_A, ORG_B], CLERK_ORG]).catch(() => {});
  await admin.query('DELETE FROM public.users WHERE id = ANY($1)', [[USER_A, USER_B]]).catch(() => {});
  await admin.end();
}

console.log(`\nechecs : ${resultats.filter((r) => !r.ok).length}/${resultats.length}`);
console.log(code === 0 ? 'VERDICT : matrice de securite conforme' : 'VERDICT : ecart de securite mesure');
process.exit(code);
