#!/usr/bin/env node
/**
 * P10.8 — Harnais AUTONOME, sans ref Git externe, executable en CI sur le
 * service `postgres:17` (PostgreSQL 17.11 exactement).
 *
 * Contrairement a `p108:chaines` / `p108:outbox` qui comparent les branches
 * #110/#111/#112/#114 via des refs d'audit LOCALES, ce harnais n'utilise QUE
 * le contenu du checkout : `prisma/migrations/<nom>/migration.sql` dans l'ordre
 * lexicographique, c'est-a-dire exactement ce que `prisma migrate deploy`
 * appliquera. Il est donc reproductible dans un checkout vierge.
 *
 * Base : `TF_P108_PG_URL` (defaut : cluster jetable local 127.0.0.1:55432).
 * En CI : TF_P108_PG_URL=$DATABASE_URL et TF_APP_PASSWORD sont deja definis.
 * Aucune base distante, aucun secret, aucune ecriture hors du cluster jetable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  PG_URL, sha256, baseVierge, appliquer,
  MODELISATION_PROPRIETAIRE, fixtures, jetonSysteme, IDS,
  identiteSession, etatRLS, connecter,
} from './lib/p108_pg17.mjs';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';

// Garde de cible : le harnais ne doit JAMAIS etre pointe vers une base
// distante. Sans variable, la cible par defaut est le cluster JETABLE local.
process.env.TF_P108_PG_URL ||= 'postgresql://postgres@127.0.0.1:55432/postgres';
requireThrowawayDb({ variables: ['TF_P108_PG_URL'], purpose: 'harnais P10.8 — PostgreSQL 17.11 jetable' });

const ROOT = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
// En CI, ecrire dans le depot salirait `git status --porcelain` et ferait
// echouer `test:garde-fous:neon` (code 2 : scenarios de revision NON JOUES).
// La cible est donc configurable ; le workflow pose TF_P108_CI_SORTIE dans
// runner.temp. Le rapport reste imprime dans le journal CI dans tous les cas.
const SORTIE = process.env.TF_P108_CI_SORTIE
  || path.join(ROOT, 'docs/security/2026-11-07-p108-ci-mesures.json');

function chaineLocale() {
  const base = path.join(ROOT, 'prisma/migrations');
  return fs.readdirSync(base, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name).sort()
    .map(nom => {
      const f = path.join(base, nom, 'migration.sql');
      if (!fs.existsSync(f)) throw new Error(`migration sans migration.sql : ${nom}`);
      return { nom, ref: 'checkout', texte: fs.readFileSync(f, 'utf8') };
    });
}

const scenarios = [];
function consigner(id, libelle, attendu, observe, ok, extra = {}) {
  scenarios.push({ id, libelle, attendu, observe, statut: ok ? 'PASS' : 'FAIL', ...extra });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id.padEnd(38)} ${String(observe).slice(0, 100)}`);
}

const DB = `p108_ci_${process.env.GITHUB_RUN_ID || 'local'}`.replace(/[^a-z0-9_]/gi, '_');
const entrees = chaineLocale();
const ROLE_NAMES = ['tracefab_app', 'tracefab_worker', 'tracefab_migrator'];
const identifiant = (value) => '"' + String(value).replace(/"/g, '""') + '"';

// Les rôles PostgreSQL sont des objets de CLUSTER, pas de base. baseVierge()
// les normalise pour simuler Neon ; sans restauration, ce harnais laisse
// tracefab_app en NOINHERIT et tracefab_migrator en NOBYPASSRLS, puis casse
// les suites suivantes du même job (P10.5). On photographie les seuls attributs
// qu'il modifie et les appartenances qui touchent ces rôles, sans lire les mots
// de passe ni aucune donnée métier.
const avantClient = await connecter('postgres');
const rolesAvant = (await avantClient.query(`
  SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit
    FROM pg_catalog.pg_roles
   WHERE rolname = ANY($1::text[])
`, [ROLE_NAMES])).rows;
const appartenancesAvant = (await avantClient.query(`
  SELECT granted.rolname AS role_accorde, member.rolname AS membre,
         m.admin_option, m.inherit_option, m.set_option
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = m.member
   WHERE granted.rolname = ANY($1::text[]) OR member.rolname = ANY($1::text[])
`, [ROLE_NAMES])).rows;
await avantClient.end();

async function restaurerEtatCluster() {
  const maintenance = await connecter('postgres');
  let detail = '';
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);

    // Retirer d'abord toutes les appartenances créées ou modifiées par le
    // harnais ; on rétablit ensuite exactement les relations préexistantes.
    const courantes = (await maintenance.query(`
      SELECT granted.rolname AS role_accorde, member.rolname AS membre
        FROM pg_catalog.pg_auth_members m
        JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid
        JOIN pg_catalog.pg_roles member ON member.oid = m.member
       WHERE granted.rolname = ANY($1::text[]) OR member.rolname = ANY($1::text[])
    `, [ROLE_NAMES])).rows;
    for (const m of courantes) {
      await maintenance.query(`REVOKE ${identifiant(m.role_accorde)} FROM ${identifiant(m.membre)}`);
    }

    const avantParNom = new Map(rolesAvant.map(r => [r.rolname, r]));
    for (const nom of ROLE_NAMES) {
      const original = avantParNom.get(nom);
      if (!original) {
        // Ce rôle n'existait pas avant le test : le harnais est son seul
        // créateur. La base ayant été détruite, sa suppression est sûre.
        await maintenance.query(`DROP OWNED BY ${identifiant(nom)}`).catch(() => {});
        await maintenance.query(`DROP ROLE IF EXISTS ${identifiant(nom)}`);
      } else {
        const attributs = [
          original.rolcanlogin ? 'LOGIN' : 'NOLOGIN',
          original.rolsuper ? 'SUPERUSER' : 'NOSUPERUSER',
          original.rolbypassrls ? 'BYPASSRLS' : 'NOBYPASSRLS',
          original.rolcreaterole ? 'CREATEROLE' : 'NOCREATEROLE',
          original.rolcreatedb ? 'CREATEDB' : 'NOCREATEDB',
          original.rolinherit ? 'INHERIT' : 'NOINHERIT',
        ].join(' ');
        await maintenance.query(`ALTER ROLE ${identifiant(nom)} WITH ${attributs}`);
      }
    }

    // Restaurer les options de chaque appartenance préexistante (PostgreSQL 16+).
    for (const m of appartenancesAvant) {
      await maintenance.query(`GRANT ${identifiant(m.role_accorde)} TO ${identifiant(m.membre)} WITH ADMIN ${m.admin_option ? 'TRUE' : 'FALSE'}`);
      await maintenance.query(`GRANT ${identifiant(m.role_accorde)} TO ${identifiant(m.membre)} WITH INHERIT ${m.inherit_option ? 'TRUE' : 'FALSE'}`);
      await maintenance.query(`GRANT ${identifiant(m.role_accorde)} TO ${identifiant(m.membre)} WITH SET ${m.set_option ? 'TRUE' : 'FALSE'}`);
    }

    // Vérification indépendante : existence et attributs des trois rôles,
    // puis appartenance exacte. Aucun secret n'est sélectionné ou journalisé.
    const apres = (await maintenance.query(`
      SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit
        FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])
    `, [ROLE_NAMES])).rows;
    const normaliser = rows => rows.map(r => [
      r.rolname, r.rolcanlogin, r.rolsuper, r.rolbypassrls,
      r.rolcreaterole, r.rolcreatedb, r.rolinherit,
    ]).sort((a,b) => a[0].localeCompare(b[0]));
    const rolesRestaures = JSON.stringify(normaliser(apres)) === JSON.stringify(normaliser(rolesAvant));
    const liensRestaures = (await maintenance.query(`
      SELECT granted.rolname AS role_accorde, member.rolname AS membre,
             m.admin_option, m.inherit_option, m.set_option
        FROM pg_catalog.pg_auth_members m
        JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid
        JOIN pg_catalog.pg_roles member ON member.oid = m.member
       WHERE granted.rolname = ANY($1::text[]) OR member.rolname = ANY($1::text[])
       ORDER BY 1,2
    `, [ROLE_NAMES])).rows;
    const trierLiens = rows => rows.map(m => [
      m.role_accorde,m.membre,m.admin_option,m.inherit_option,m.set_option,
    ]).sort((a,b) => (a[0]+a[1]).localeCompare(b[0]+b[1]));
    const appartenancesRestaures = JSON.stringify(trierLiens(liensRestaures))
      === JSON.stringify(trierLiens(appartenancesAvant));
    const ok = rolesRestaures && appartenancesRestaures;
    detail = `roles=${rolesRestaures ? 'restaures' : 'ECHEC'} appartenances=${appartenancesRestaures ? 'restaurees' : 'ECHEC'}`;
    consigner('CI10_etat_cluster_restaure',
      'Le harnais ne laisse aucun changement de rôles ou d’appartenances dans le cluster partagé',
      'état initial exactement restauré', detail, ok);
  } catch (e) {
    detail = `${e.code || ''} ${String(e.message).slice(0,180)}`;
    consigner('CI10_etat_cluster_restaure',
      'Le harnais ne laisse aucun changement de rôles ou d’appartenances dans le cluster partagé',
      'état initial exactement restauré', detail, false);
  } finally {
    await maintenance.end();
  }
}

const admin = await baseVierge(DB);
const version = (await admin.query('SELECT version() v')).rows[0].v;

const a = await appliquer(admin, entrees, async (migration) => {
  // Les migrations 20261108120100..120600 utilisent le role worker pour
  // finaliser les proprietaires et ACL. Le grant du harnais est temporaire :
  // le retirer apres la derniere migration de provisioning, juste avant la
  // garde terminale 20261108120700.
  if (migration.nom === '20261108120600_lecture_orders_requise_par_le_runtime') {
    const membership = await admin.query(
      "SELECT pg_catalog.pg_has_role('tracefab_migrator','tracefab_worker','MEMBER') AS membre"
    );
    if (membership.rows[0]?.membre === true) {
      await admin.query('REVOKE tracefab_worker FROM tracefab_migrator');
    }
  }
});
consigner('CI01_chaine_appliquee', 'Toutes les migrations du checkout appliquees depuis une base vierge',
  `${entrees.length}/${entrees.length} sans echec`,
  a.echec ? `${a.appliquees.length}/${entrees.length} — ${a.echec.nom} ${a.echec.sqlstate} ${a.echec.message}` : `${a.appliquees.length}/${entrees.length}`,
  !a.echec);
if (a.echec) {
  await admin.end();
  await restaurerEtatCluster();
  fs.writeFileSync(SORTIE, JSON.stringify({ version_postgresql: version, scenarios }, null, 2));
  process.exit(1);
}

consigner('CI02_version_postgresql', 'PostgreSQL 17.11 exactement (pas PGlite 18.6, pas une image non mesuree)',
  /PostgreSQL 17\.11/.test(version), version, /PostgreSQL 17\.11/.test(version));
const membershipFinal = await admin.query(
  "SELECT pg_catalog.pg_has_role('tracefab_migrator','tracefab_worker','MEMBER') AS membre"
);
const terminalePresente = entrees.some(e => e.nom === '20261108120700_assert_worker_membership_revoked');
consigner('CI03_worker_membership_revoked', 'La garde terminale est présente et le migrateur n’est plus membre du worker',
  'terminal=true member=false',
  `terminal=${terminalePresente} member=${membershipFinal.rows[0]?.membre}`,
  terminalePresente && membershipFinal.rows[0]?.membre === false);

const cle = randomBytes(32);
await fixtures(admin, cle);
await admin.query(`INSERT INTO public.users(id,clerk_user_id,email,full_name)
  VALUES ($1,'user_p108_ci','a@example.test','Utilisateur A') ON CONFLICT (id) DO NOTHING`, [IDS.A]);
await admin.query(MODELISATION_PROPRIETAIRE);

const proprietaire = await admin.query(`SELECT p.proname, pg_get_userbyid(p.proowner) owner
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN
    ('tracefab_claim_notification_outbox','tracefab_complete_notification_outbox','tracefab_enqueue_due_data_request_reminders')`);
const tousWorker = proprietaire.rows.length === 3 && proprietaire.rows.every(r => r.owner === 'tracefab_worker');
consigner('CI04_proprietaire_outbox', 'claim / complete / enqueue_due possedes par tracefab_worker',
  '3/3 tracefab_worker', proprietaire.rows.map(r => `${r.proname}=${r.owner}`).join(', '), tousWorker);

const acl = await admin.query(`SELECT
  has_table_privilege('tracefab_app','public.tracefab_notification_outbox','UPDATE') app_update,
  has_table_privilege('tracefab_app','public.tracefab_identity_cles','SELECT') app_cles,
  has_table_privilege('tracefab_worker','public.tracefab_notification_outbox','UPDATE') worker_update,
  (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='public.tracefab_notification_outbox'::regclass) rls,
  (SELECT count(*)::int FROM pg_policies WHERE tablename='tracefab_notification_outbox') pol`);
consigner('CI05_acl_et_rls', 'RLS active/forcee, 3 politiques, runtime sans UPDATE ni lecture des cles',
  'app_update=false app_cles=false worker_update=true rls=true pol=3', JSON.stringify(acl.rows[0]),
  acl.rows[0].app_update === false && acl.rows[0].app_cles === false && acl.rows[0].worker_update === true && acl.rows[0].rls === true && acl.rows[0].pol === 3);

const J = jetonSysteme(cle);
async function affaire(fn) {
  const c = await connecter(DB, 'tracefab_app');
  try {
    await c.query(`SELECT set_config('tracefab.identity_systeme',$1,false)`, [J]);
    return await fn(c);
  } finally { await c.end(); }
}

let erreur = null, claim = null, complete = null, session = null, rls = null;
try {
  const r = await affaire(async c => {
    session = await identiteSession(c);
    rls = await etatRLS(c);
    const cl = await c.query('SELECT * FROM public.tracefab_claim_notification_outbox(1)');
    claim = cl.rows[0];
    const co = await c.query("SELECT * FROM public.tracefab_complete_notification_outbox($1,'sent','p108-ci',NULL,now())", [cl.rows[0].id]);
    complete = co.rows[0];
    return true;
  });
} catch (e) { erreur = { sqlstate: e.code, message: String(e.message).slice(0, 260) }; }
consigner('CI06_claim_complete_reels', 'claim puis complete par une VRAIE session tracefab_app non superutilisee',
  'claim processing/1 puis complete sent, aucune erreur',
  erreur ? `${erreur.sqlstate} ${erreur.message}` : `claim=${claim?.status}/${claim?.attempts} complete=${complete?.status}`,
  !erreur && claim?.status === 'processing' && complete?.status === 'sent',
  { session, rls });
consigner('CI07_session_non_elevee', 'session_user=current_user=tracefab_app, NOSUPERUSER, NOBYPASSRLS',
  'cu=su=tracefab_app, super=false, bypassrls=false', JSON.stringify(session),
  !!session && session.cu === 'tracefab_app' && session.su === 'tracefab_app' && session.super === false && session.bypassrls === false);
consigner('CI08_rls_active', 'RLS active et forcee, 3 politiques lues depuis la session applicative',
  'rls=true force=true pol=3', JSON.stringify(rls), !!rls && rls.rls === true && rls.force === true && rls.politiques === 3);

// Controle negatif : aucun jeton systeme => refus. #114 (branche distincte,
// pas dans ce checkout) injecte la garde `tracefab_identite_systeme()` dans
// claim. Sur la branche seule, la garde n'existe pas encore : le controle est
// alors NOT APPLICABLE, jamais transforme en PASS. La preuve complete AVEC la
// garde est fournie par `p108:outbox` (C9) sur PostgreSQL 17.11 reel.
const garde = await admin.query(`SELECT position('tracefab_identite_systeme()' IN
  pg_get_functiondef('public.tracefab_claim_notification_outbox(integer)'::regprocedure)) > 0 presente`);
if (garde.rows[0].presente) {
  let sansJeton = null;
  {
    const c = await connecter(DB, 'tracefab_app');
    try {
      await c.query(`SELECT set_config('tracefab.identity_systeme','',false)`);
      await c.query('SELECT * FROM public.tracefab_claim_notification_outbox(1)');
      sansJeton = 'ACCEPTE';
    } catch (e) { sansJeton = `${e.code} ${String(e.message).slice(0, 90)}`; }
    await c.end();
  }
  consigner('CI09_fail_closed', 'Claim sans identite systeme signee : refuse',
    '42501 authentication_required', sansJeton, sansJeton.startsWith('42501') && sansJeton.includes('authentication_required'));
} else {
  scenarios.push({
    id: 'CI09_fail_closed', libelle: 'Claim sans identite systeme signee : refuse',
    attendu: '42501 authentication_required',
    observe: 'garde #114 absente du checkout (branche seule) : controle non applicable ici, mesure en C9 du harnais p108:outbox avec #114',
    statut: 'NOT APPLICABLE',
  });
  console.log(`N/A  CI09_fail_closed                      garde #114 absente du checkout — voir C9 (p108:outbox)`);
}

await admin.end();
// Rangement du cluster partagé : base jetable, puis rôles et appartenances
// restaurés à l'état exact mesuré avant le harnais.
await restaurerEtatCluster();

const pass = scenarios.filter(s => s.statut === 'PASS').length;
const fail = scenarios.filter(x => x.statut === 'FAIL' || x.statut === 'BLOCKED').length;
const artefact = {
  schema: 'tracefab-p108-ci-mesures-v1',
  date: new Date().toISOString(),
  version_postgresql: version,
  url_administration: PG_URL.replace(/\/\/[^@]*@/, '//<jetable>@'),
  environnement: 'cluster PostgreSQL jetable : service postgres:17 en CI, ou scripts/p108_pg17_demarrer.sh en local',
  chaine: entrees.map(e => ({ nom: e.nom, sha256: sha256(e.texte) })),
  scenarios,
  agregats: { total: scenarios.length, PASS: pass, FAIL: fail },
};
fs.mkdirSync(path.dirname(SORTIE), { recursive: true });
fs.writeFileSync(SORTIE, JSON.stringify(artefact, null, 2) + '\n');
console.log(`\nP10.8 CI : ${pass} PASS / ${fail} FAIL — ${version}`);
console.log(`Artefact : ${SORTIE}`);
if (fail > 0) process.exit(1);
