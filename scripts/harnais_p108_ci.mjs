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
  PG_URL, CORRECTIF_NOM, sha256, baseVierge, appliquer,
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
const admin = await baseVierge(DB);
const version = (await admin.query('SELECT version() v')).rows[0].v;

const a = await appliquer(admin, entrees, async (migration) => {
  // 20261107120000 doit endosser tracefab_worker pendant ALTER OWNER.
  // Une fois la migration de transfert terminee, le droit est temporaire :
  // la migration terminale 20261108120700 doit le constater revoque.
  if (migration.nom === CORRECTIF_NOM) {
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
if (a.echec) { fs.writeFileSync(SORTIE, JSON.stringify({ version_postgresql: version, scenarios }, null, 2)); await admin.end(); process.exit(1); }

consigner('CI02_version_postgresql', 'PostgreSQL 17.11 exactement (pas PGlite 18.6, pas une image non mesuree)',
  /PostgreSQL 17\.11/.test(version), version, /PostgreSQL 17\.11/.test(version));
consigner('CI03_correctif_present', 'La migration corrective P10.8 est dans le checkout et trie en dernier',
  entrees.at(-1).nom === CORRECTIF_NOM, entrees.at(-1).nom, entrees.at(-1).nom === CORRECTIF_NOM);

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
await admin.end();
// Rangement : le cluster de CI est detruit avec le runner, mais un harnais
// jetable ne doit laisser aucune base derriere lui, y compris en local.
try {
  const maintenance = await connecter('postgres');
  await maintenance.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await maintenance.end();
  console.log(`Base jetable ${DB} detruite.`);
} catch (e) {
  console.log(`Base jetable ${DB} non detruite (${String(e.message).slice(0, 120)}) — le cluster reste jetable.`);
}
if (fail > 0) process.exit(1);
