#!/usr/bin/env node
/**
 * P10.8 — Harnais outbox sur PostgreSQL 17.11 REEL.
 *
 * TOUTES les operations metier (claim, complete, SELECT sur l'outbox, health,
 * tentative d'elevation) sont executees par de VERITABLES connexions
 * `tracefab_app` : session_user = current_user = tracefab_app, NOSUPERUSER,
 * NOBYPASSRLS. Aucune operation metier n'est faite avec le superutilisateur du
 * cluster jetable. Celui-ci sert uniquement a : creer la base, appliquer la
 * chaine de migrations, inserer les fixtures d'administration, modeliser le
 * proprietaire non superutilise, et simuler un crash (backdate de locked_at).
 *
 * `SET ROLE` n'est JAMAIS utilise pour simuler une session applicative ; un
 * scenario mesure explicitement la difference entre SET ROLE et vraie session.
 *
 * Sortie : docs/security/2026-11-07-p108-outbox-scenarios.json
 */
import { randomBytes, createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  PG_URL, REFS, CORRECTIF_NOM, CORRECTIF_CHEMIN, composer, sha256,
  baseVierge, appliquer, MODELISATION_PROPRIETAIRE, MODELISATION_PROPRIETE_PLEINE, fixtures, jetonSysteme,
  jetonUtilisateur, IDS, identiteSession, etatRLS, connecter,
} from './lib/p108_pg17.mjs';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';

// Garde de cible : le harnais ne doit JAMAIS etre pointe vers une base
// distante. Sans variable, la cible par defaut est le cluster JETABLE local.
process.env.TF_P108_PG_URL ||= 'postgresql://postgres@127.0.0.1:55432/postgres';
requireThrowawayDb({ variables: ['TF_P108_PG_URL'], purpose: 'harnais P10.8 — PostgreSQL 17.11 jetable' });

const ROOT = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
const SORTIE = path.join(ROOT, 'docs/security/2026-11-07-p108-outbox-scenarios.json');
const CORRECTIF = { nom: CORRECTIF_NOM, ref: 'HEAD (nouvelle migration P10.8)', texte: fs.readFileSync(path.join(ROOT, CORRECTIF_CHEMIN), 'utf8') };

const resultats = [];
let dbCounter = 0;

function dbUnique(prefix) {
  dbCounter += 1;
  return `p108_${prefix}_${dbCounter}`;
}

/** Pose le contexte de session sur une connexion metier. */
async function contexte(c, { systeme = '', utilisateur = '', org = '', userId = '', local = false } = {}) {
  const t = local ? 'true' : 'false';
  await c.query(`SELECT set_config('tracefab.identity_systeme',$1,${t}),
                       set_config('tracefab.identity',$2,${t}),
                       set_config('tracefab.active_organization_id',$3,${t}),
                       set_config('tracefab.user_id',$4,${t})`,
    [systeme, utilisateur, org, userId]);
}

/** Mesure un scenario : connexion metier reelle, SQLSTATE, session, RLS. */
async function mesurer(db, o) {
  const c = await connecter(db, o.role || 'tracefab_app');
  let erreur = null;
  let brut = null;
  try {
    if (o.setup) await o.setup(c);
    brut = await o.exec(c);
  } catch (e) {
    erreur = { sqlstate: e.code || null, message: String(e.message).slice(0, 320) };
  }
  let session = null, rls = null;
  try { session = await identiteSession(c); rls = await etatRLS(c); } catch { /* catalogue illisible : consigne tel quel */ }
  try { await c.end(); } catch { /* ignore */ }
  let verdict;
  try { verdict = o.verifier(brut, erreur); }
  catch (e) { verdict = { ok: false, attendu: String(o.attendu || ''), observe: `verificateur en erreur : ${e.message}` }; }
  const ligne = {
    id: o.id, libelle: o.libelle, sql: o.sql, role_actif: o.role || 'tracefab_app',
    session, rls, attendu: verdict.attendu, observe: verdict.observe,
    sqlstate: erreur?.sqlstate ?? null, message_erreur: erreur?.message ?? null,
    preuve_absence_elevation: !!session && session.super === false && session.bypassrls === false && session.su === session.cu,
    preuve_rls_active: !!rls && rls.rls === true && rls.force === true,
    statut: verdict.ok ? 'PASS' : 'FAIL',
  };
  resultats.push(ligne);
  console.log(`${ligne.statut.padEnd(5)} ${o.id.padEnd(34)} ${String(verdict.observe).slice(0, 96)}`);
  return ligne;
}

function ok(cond, attendu, observe) { return { ok: !!cond, attendu, observe }; }

/** Monte une base vierge : chaine, fixtures, modelisation du proprietaire. */
async function monter(nom, refs, avecCorrectif) {
  const c = await baseVierge(nom);
  const chaine = composer(refs, avecCorrectif ? [CORRECTIF] : []);
  const a = await appliquer(c, chaine);
  if (a.echec) { await c.end(); throw new Error(`${nom} : ${a.echec.nom} ${a.echec.sqlstate} ${a.echec.message}`); }
  const cle = randomBytes(32);
  await fixtures(c, cle);
  // Fixture d'identite d'un utilisateur de l'organisation A, pour mesurer
  // l'isolement inter-tenant par une vraie session tracefab_app.
  await c.query(`INSERT INTO public.users(id,clerk_user_id,email,full_name)
    VALUES ($1,'user_p108_a','a@example.test','Utilisateur A') ON CONFLICT (id) DO NOTHING`, [IDS.A]);
  await c.query(`INSERT INTO public.organization_memberships(id,organization_id,user_id,role,status)
    VALUES ($1,$2,$3,'owner','active') ON CONFLICT (organization_id,user_id) DO NOTHING`,
    [IDS.REL, IDS.A, IDS.A]);
  await c.query(MODELISATION_PROPRIETAIRE);
  return { admin: c, cle, chaine: a, entrees: chaine };
}

/** Remet les trois evenements en etat initial (operation d'administration). */
async function reinitialiser(admin) {
  await admin.query(`UPDATE public.tracefab_notification_outbox
    SET status='pending', attempts=0, locked_at=NULL, sent_at=NULL,
        available_at=now(), provider_id=NULL, last_error=NULL
    WHERE id IN ($1,$2,$3)`, [IDS.OUT, IDS.OUT2, IDS.OUT3]);
}

const S = (cle, d = 60) => jetonSysteme(cle, d);
/** Jeton systeme avec une expiration EXPRIMEE DANS L'HORLOGE DE LA BASE. */
function jetonExp(cle, exp) {
  const corps = `v1|tracefab_system|tracefab_worker|${exp}`;
  return `${corps}.${createHmac('sha256', cle).update(corps).digest('hex')}`;
}
async function horlogeBase(admin) {
  const r = await admin.query('SELECT extract(epoch FROM pg_catalog.now())::bigint n');
  return Number(r.rows[0].n);
}
const U = (cle, org = IDS.A) => jetonUtilisateur(cle, IDS.A, org, 60);

// ---------------------------------------------------------------------------
// 1. REPRODUCTION AVANT / APRES CORRECTION (chaine canonique + variantes)
// ---------------------------------------------------------------------------
const reproductions = [];
const variants = [
  { id: 'S1_114_seule', refs: ['main', '#114'], correctif: false, attendu: '42501' },
  { id: 'S2_111_et_114', refs: ['#111', '#114'], correctif: false, attendu: 'PASS' },
  { id: 'S3_canonique_sans_correctif', refs: ['main', '#113', '#114'], correctif: false, attendu: '42501' },
  { id: 'S3b_canonique_avec_correctif', refs: ['main', '#113', '#114'], correctif: true, attendu: 'PASS' },
];
for (const v of variants) {
  const db = dbUnique('repro');
  const m = await monter(db, v.refs, v.correctif);
  const ligne = await mesurer(db, {
    id: v.id,
    libelle: `claim reel avec jeton systeme valide — ${v.correctif ? 'AVEC' : 'SANS'} correctif`,
    sql: "SELECT set_config('tracefab.identity_systeme', <jeton valide>, false); SELECT * FROM public.tracefab_claim_notification_outbox(1);",
    setup: c => contexte(c, { systeme: S(m.cle) }),
    exec: c => c.query('SELECT * FROM public.tracefab_claim_notification_outbox(1)'),
    verifier: (b, e) => v.attendu === '42501'
      ? ok(e?.sqlstate === '42501', 'SQLSTATE 42501 (permission denied for function tracefab_identite_systeme)', e ? `${e.sqlstate} ${e.message.slice(0, 120)}` : `claim reussi (${b?.rowCount} ligne(s))`)
      : ok(!e && b.rowCount >= 1, 'claim >= 1 ligne, sans erreur', e ? `${e.sqlstate} ${e.message.slice(0, 120)}` : `${b.rowCount} ligne(s), status=${b.rows[0]?.status}`),
  });
  reproductions.push({
    id: v.id, refs: v.refs, correctif_applique: v.correctif,
    migrations_appliquees: m.chaine.appliquees.length,
    empreintes: m.chaine.appliquees.map(x => `${x.nom}:${x.sha256.slice(0, 12)}`),
    resultat: ligne.statut, sqlstate: ligne.sqlstate, observe: ligne.observe,
  });
  await m.admin.end();
}

// -- 1 bis. SECONDE CAUSE RACINE, modele de propriete pleine ----------------
// Le 42501 ci-dessus n'est pas la seule dependance : quand le predicat EST
// executable (proprietaire commun a toutes les fonctions, forme d'une base
// managee), la politique RLS FORCEE `notification_outbox_update_trusted`
// exige `current_user = 'tracefab_worker'`. Sans le correctif, claim rend
// 0 ligne SANS erreur : defaut silencieux, plus dangereux qu'une exception.
const causesRacines = [];
for (const v of [
  { id: 'R1_rls_sans_worker', correctif: false, attendu: '0' },
  { id: 'R2_rls_avec_worker', correctif: true, attendu: '1' },
]) {
  const db = dbUnique('racine');
  const admin = await baseVierge(db);
  const chaine = composer(['main', '#113', '#114'], v.correctif ? [CORRECTIF] : []);
  const a = await appliquer(admin, chaine);
  if (a.echec) { await admin.end(); throw new Error(`${v.id} : ${a.echec.nom} ${a.echec.sqlstate}`); }
  const cle = randomBytes(32);
  await fixtures(admin, cle);
  await admin.query(MODELISATION_PROPRIETE_PLEINE);
  const c = await connecter(db, 'tracefab_app');
  let erreur = null, lignes = null, session = null, rls = null;
  try {
    await contexte(c, { systeme: S(cle) });
    const r = await c.query('SELECT * FROM public.tracefab_claim_notification_outbox(1)');
    lignes = r.rowCount;
    session = await identiteSession(c);
    rls = await etatRLS(c);
  } catch (e) { erreur = { sqlstate: e.code, message: String(e.message).slice(0, 260) }; }
  await c.end(); await admin.end();
  const okR = v.attendu === '0'
    ? !erreur && lignes === 0
    : !erreur && lignes === 1;
  const ligne = {
    id: v.id, libelle: v.correctif
      ? 'Propriete pleine + correctif : claim revendique 1 ligne (current_user=tracefab_worker)'
      : 'Propriete pleine SANS correctif : predicat executable mais RLS UPDATE exige worker -> 0 ligne silencieuse',
    sql: "SELECT * FROM public.tracefab_claim_notification_outbox(1); -- politique: (CURRENT_USER = 'tracefab_worker')",
    role_actif: 'tracefab_app', session, rls,
    attendu: `${v.attendu} ligne(s), ${v.correctif ? 'sans erreur' : 'sans erreur (defaut SILENCIEUX)'}`,
    observe: erreur ? `${erreur.sqlstate} ${erreur.message}` : `${lignes} ligne(s)`,
    sqlstate: erreur?.sqlstate ?? null, message_erreur: erreur?.message ?? null,
    preuve_absence_elevation: !!session && session.super === false && session.bypassrls === false,
    preuve_rls_active: !!rls && rls.rls === true && rls.force === true,
    statut: okR ? 'PASS' : 'FAIL',
  };
  resultats.push(ligne);
  causesRacines.push({ ...ligne, correctif_applique: v.correctif, modele: 'propriete_pleine_migrateur', migrations: a.appliquees.length });
  console.log(`${ligne.statut.padEnd(5)} ${ligne.id.padEnd(34)} ${ligne.observe.slice(0, 90)}`);
}

// ---------------------------------------------------------------------------
// 2. SUITE COMPLETE DES SCENARIOS SUR LA CHAINE CANONIQUE CORRIGEE
// ---------------------------------------------------------------------------
const DB = dbUnique('outbox');
const M = await monter(DB, ['main', '#113', '#114'], true);
const A = M.admin;
const J = S(M.cle);
const chaineCanonique = M.chaine;

const SQL = {
  claim: 'SELECT * FROM public.tracefab_claim_notification_outbox(1)',
  complete: "SELECT * FROM public.tracefab_complete_notification_outbox($1,'sent','p108-provider',NULL,now())",
  health: 'SELECT * FROM public.tracefab_notification_outbox_health()',
};

// -- 2.1 etat de la base et creation de l'outbox ----------------------------
await mesurer(DB, {
  id: 'C1_creation_outbox', libelle: 'Outbox creee, RLS active ET forcee, 3 politiques intactes',
  sql: "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='public.tracefab_notification_outbox'::regclass; SELECT policyname,cmd FROM pg_policies WHERE tablename='tracefab_notification_outbox';",
  exec: c => c.query(`SELECT relrowsecurity rls, relforcerowsecurity force,
      (SELECT count(*)::int FROM pg_catalog.pg_policies WHERE tablename='tracefab_notification_outbox') pol
      FROM pg_catalog.pg_class WHERE oid='public.tracefab_notification_outbox'::regclass`),
  verifier: b => ok(b.rows[0].rls && b.rows[0].force && b.rows[0].pol === 3,
    'rls=true, force=true, 3 politiques', JSON.stringify(b.rows[0])),
});

await mesurer(DB, {
  id: 'C2_insertion_evennement_autorise', libelle: 'Injection de 3 evenements par la voie d administration, health worker lisible',
  sql: SQL.health,
  setup: c => contexte(c, { systeme: J }),
  exec: c => c.query(SQL.health),
  verifier: (b, e) => ok(!e && b.rowCount === 1, 'health accessible au runtime avec jeton systeme, sans erreur', e ? `${e.sqlstate} ${e.message.slice(0, 120)}` : JSON.stringify(b.rows[0])),
});

// -- 2.2 claim autorise -----------------------------------------------------
await mesurer(DB, {
  id: 'C3_claim_autorise', libelle: 'Claim par le role applicatif prevu, avec contexte systeme valide',
  sql: SQL.claim,
  setup: c => contexte(c, { systeme: J }),
  exec: c => c.query('SELECT * FROM public.tracefab_claim_notification_outbox(5)'),
  verifier: (b, e) => ok(!e && b.rowCount === 3 && b.rows.every(r => r.status === 'processing' && r.attempts === 1),
    '3 lignes processing, attempts=1', e ? `${e.sqlstate} ${e.message.slice(0, 160)}` : `${b.rowCount} lignes ; ${b.rows.map(r => `${r.status}/${r.attempts}`).join(',')}`),
});

// -- 2.3 claim concurrent : deux workers / deux transactions ----------------
await reinitialiser(A);
const conc = await (async () => {
  const c1 = await connecter(DB, 'tracefab_app');
  const c2 = await connecter(DB, 'tracefab_app');
  let erreur = null, r1 = null, r2 = null;
  const sessions = [];
  try {
    for (const c of [c1, c2]) await contexte(c, { systeme: J });
    await c1.query('BEGIN');
    await c2.query('BEGIN');
    r1 = await c1.query('SELECT * FROM public.tracefab_claim_notification_outbox(1)');
    r2 = await c2.query('SELECT * FROM public.tracefab_claim_notification_outbox(1)');
    await c1.query('COMMIT');
    await c2.query('COMMIT');
    sessions.push(await identiteSession(c1), await identiteSession(c2));
  } catch (e) { erreur = { sqlstate: e.code, message: String(e.message).slice(0, 300) }; try { await c1.query('ROLLBACK'); await c2.query('ROLLBACK'); } catch { /* */ } }
  const rls = await etatRLS(c1).catch(() => null);
  await c1.end(); await c2.end();
  const id1 = r1?.rows[0]?.id, id2 = r2?.rows[0]?.id;
  const attendu = 'deux transactions concurrentes : 2 lignes distinctes revendiquees (FOR UPDATE SKIP LOCKED), une seule revendication par ligne';
  const observe = erreur ? `${erreur.sqlstate} ${erreur.message}` : `T1=${id1 ?? 'aucune'} T2=${id2 ?? 'aucune'}`;
  const ligne = {
    id: 'C4_claim_concurrent_2_workers', libelle: 'Deux workers / deux transactions concurrentes : une seule revendication par ligne',
    sql: "BEGIN; SELECT * FROM tracefab_claim_notification_outbox(1); -- T1 et T2 en parallele, FOR UPDATE SKIP LOCKED",
    role_actif: 'tracefab_app (2 connexions)', session: sessions, rls,
    attendu, observe, sqlstate: erreur?.sqlstate ?? null, message_erreur: erreur?.message ?? null,
    preuve_absence_elevation: sessions.length === 2 && sessions.every(s => s.super === false && s.bypassrls === false && s.su === s.cu),
    preuve_rls_active: !!rls && rls.rls && rls.force,
    statut: !erreur && id1 && id2 && id1 !== id2 ? 'PASS' : 'FAIL',
  };
  resultats.push(ligne);
  console.log(`${ligne.statut.padEnd(5)} ${ligne.id.padEnd(34)} ${observe.slice(0, 90)}`);
  return ligne;
})();

// -- 2.4 complete autorise --------------------------------------------------
await reinitialiser(A);
await mesurer(DB, {
  id: 'C5_complete_autorise', libelle: 'Complete par le role applicatif avec jeton systeme valide',
  sql: "SELECT * FROM tracefab_claim_notification_outbox(1); SELECT * FROM tracefab_complete_notification_outbox(<id>,'sent','p108-provider',NULL,now());",
  setup: c => contexte(c, { systeme: J }),
  exec: async c => {
    const cl = await c.query('SELECT * FROM public.tracefab_claim_notification_outbox(1)');
    const co = await c.query("SELECT * FROM public.tracefab_complete_notification_outbox($1,'sent','p108-provider',NULL,now())", [cl.rows[0].id]);
    return { claim: cl.rows[0], complete: co.rows[0] };
  },
  verifier: (b, e) => ok(!e && b.complete?.status === 'sent', "complete -> status='sent', sent_at renseigne", e ? `${e.sqlstate} ${e.message.slice(0, 150)}` : `status=${b.complete?.status} provider=${b.complete?.provider_id}`),
});

// -- 2.5 complete par un role non autorise ---------------------------------
await mesurer(DB, {
  id: 'C6_complete_role_non_autorise', libelle: 'Complete par tracefab_migrator (non superutilisateur) : refuse',
  sql: SQL.complete, role: 'tracefab_migrator',
  exec: c => c.query("SELECT * FROM public.tracefab_complete_notification_outbox($1,'sent','x',NULL,now())", [IDS.OUT2]),
  verifier: (b, e) => ok(e?.sqlstate === '42501', 'SQLSTATE 42501 permission denied for function tracefab_complete_notification_outbox', e ? `${e.sqlstate} ${e.message.slice(0, 150)}` : 'complete accepte (FAIL)'),
});

// -- 2.6 modification directe interdite ------------------------------------
await mesurer(DB, {
  id: 'C7_modification_directe_interdite', libelle: 'UPDATE direct de l outbox par tracefab_app : refuse',
  sql: "UPDATE public.tracefab_notification_outbox SET status='sent' WHERE id=<id>",
  exec: c => c.query("UPDATE public.tracefab_notification_outbox SET status='sent' WHERE id=$1", [IDS.OUT3]),
  verifier: (b, e) => ok(e?.sqlstate === '42501', 'SQLSTATE 42501 permission denied for table tracefab_notification_outbox', e ? `${e.sqlstate} ${e.message.slice(0, 150)}` : `${b.rowCount} ligne(s) modifiee(s) (FAIL)`),
});

// -- 2.7 acces inter-tenant -------------------------------------------------
await mesurer(DB, {
  id: 'C8_acces_inter_tenant', libelle: 'Session du tenant A : ligne A visible, ligne B invisible (RLS)',
  sql: "SELECT set_config('tracefab.user_id', <user A>, false); SELECT id FROM tracefab_notification_outbox WHERE recipient_organization_id IN (<A>,<B>);",
  setup: c => contexte(c, { userId: IDS.A }),
  exec: c => c.query(`SELECT id, recipient_organization_id org FROM public.tracefab_notification_outbox WHERE id IN ($1,$2)`, [IDS.OUT, IDS.OUT2]),
  verifier: (b, e) => ok(!e && b.rows.length === 1 && b.rows[0].org === IDS.A,
    '1 seule ligne (organisation A), aucune ligne de B', e ? `${e.sqlstate} ${e.message.slice(0, 140)}` : `${b.rowCount} ligne(s) : ${b.rows.map(r => r.org).join(',')}`),
});

// -- 2.8 sans contexte / avec contexte -------------------------------------
await mesurer(DB, {
  id: 'C9_sans_contexte_refuse', libelle: 'Claim sans jeton systeme en mode systeme_strict : refuse',
  sql: "SELECT set_config('tracefab.identity_systeme','',false); SELECT * FROM tracefab_claim_notification_outbox(1);",
  setup: c => contexte(c, { systeme: '' }),
  exec: c => c.query('SELECT * FROM public.tracefab_claim_notification_outbox(1)'),
  verifier: (b, e) => ok(e?.sqlstate === '42501' && /authentication_required/.test(e?.message || ''),
    'SQLSTATE 42501 authentication_required', e ? `${e.sqlstate} ${e.message.slice(0, 150)}` : `${b.rowCount} ligne(s) (FAIL)`),
});

await mesurer(DB, {
  id: 'C10_avec_contexte_passe', libelle: 'Claim avec jeton systeme valide : accepte',
  sql: SQL.claim,
  setup: c => contexte(c, { systeme: J }),
  exec: c => c.query('SELECT * FROM public.tracefab_claim_notification_outbox(1)'),
  verifier: (b, e) => ok(!e && b.rowCount === 1, '1 ligne processing', e ? `${e.sqlstate} ${e.message.slice(0, 140)}` : `${b.rowCount} ligne(s) status=${b.rows[0]?.status}`),
});

// -- 2.9 complete repete / reutilisation idempotente -----------------------
await mesurer(DB, {
  id: 'C11_complete_repete', libelle: 'Complete repete sur une ligne deja envoyee : refuse explicitement',
  sql: "SELECT * FROM tracefab_complete_notification_outbox(<deja sent>,'sent','x',NULL,now());",
  setup: c => contexte(c, { systeme: J }),
  exec: c => c.query("SELECT * FROM public.tracefab_complete_notification_outbox($1,'sent','x',NULL,now())", [IDS.OUT]),
  verifier: (b, e) => ok(e?.sqlstate === 'P0001' && /not_processing/.test(e?.message || ''),
    'SQLSTATE P0001 notification_outbox_item_not_processing', e ? `${e.sqlstate} ${e.message.slice(0, 150)}` : 'complete repete accepte (FAIL)'),
});

// -- 2.10 rollback apres claim ---------------------------------------------
await reinitialiser(A);
await mesurer(DB, {
  id: 'C12_rollback_apres_claim', libelle: 'Rollback apres claim : la ligne reste pending, attempts inchange',
  sql: "BEGIN; SELECT * FROM tracefab_claim_notification_outbox(1); ROLLBACK; SELECT status,attempts FROM tracefab_notification_outbox WHERE id=<id>;",
  setup: c => contexte(c, { systeme: J }),
  exec: async c => {
    await c.query('BEGIN');
    const cl = await c.query('SELECT * FROM public.tracefab_claim_notification_outbox(1)');
    await c.query('ROLLBACK');
    // Lecture d'etat par la voie METIER autorisee (fonction worker-owned) :
    // un SELECT direct serait filtre par RLS et ne prouverait rien.
    const h = await c.query('SELECT * FROM public.tracefab_notification_outbox_health()');
    return { claim: cl.rowCount, apres: { pending: h.rows[0].pending, processing: h.rows[0].processing } };
  },
  verifier: (b, e) => ok(!e && b.claim === 1 && b.apres.pending === 3 && b.apres.processing === 0,
    'apres ROLLBACK : 3 pending, 0 processing, attempts inchange', e ? `${e.sqlstate} ${e.message.slice(0, 140)}` : JSON.stringify(b.apres)),
});

// -- 2.11 crash entre claim et complete + retry apres timeout ---------------
await reinitialiser(A);
await mesurer(DB, {
  id: 'C13_crash_entre_claim_et_complete', libelle: 'Crash simule entre claim et complete : claim COMMIT, aucun complete, ligne processing',
  sql: "SELECT * FROM tracefab_claim_notification_outbox(1); COMMIT; -- puis crash, aucun complete",
  setup: c => contexte(c, { systeme: J }),
  exec: async c => {
    await c.query('BEGIN');
    const cl = await c.query('SELECT * FROM public.tracefab_claim_notification_outbox(1)');
    await c.query('COMMIT');
    return { rows: cl.rows.map(r => ({ status: r.status, attempts: r.attempts, locked_at: r.locked_at !== null })) };
  },
  verifier: (b, e) => ok(!e && b.rows.length === 1 && b.rows[0].status === 'processing' && b.rows[0].locked_at === true,
    '1 ligne processing, verrou horodate, aucun complete', e ? `${e.sqlstate} ${e.message.slice(0, 140)}` : JSON.stringify(b.rows[0])),
});
// Le crash est simule cote administration : locked_at repousse au-dela du bail
// de 15 minutes. Ce n'est PAS une operation metier.
await A.query(`UPDATE public.tracefab_notification_outbox SET locked_at = now() - interval '16 minutes' WHERE id=$1`, [IDS.OUT]);
await mesurer(DB, {
  id: 'C14_retry_apres_timeout', libelle: 'Reprise apres expiration du bail : reclaim de la ligne expiree, attempts incremente',
  sql: "ADMIN: UPDATE ... SET locked_at=now()-interval '16 minutes'; SELECT * FROM tracefab_claim_notification_outbox(1);",
  setup: c => contexte(c, { systeme: J }),
  exec: c => c.query('SELECT * FROM public.tracefab_claim_notification_outbox(1)'),
  verifier: (b, e) => ok(!e && b.rowCount >= 1 && Number(b.rows[0].attempts) >= 2,
    'ligne reclamable apres expiration, attempts >= 2', e ? `${e.sqlstate} ${e.message.slice(0, 140)}` : `${b.rowCount} ligne(s) attempts=${b.rows[0]?.attempts}`),
});

// -- 2.12 reprise apres echec ----------------------------------------------
await A.query(`UPDATE public.tracefab_notification_outbox SET status='failed', attempts=2, locked_at=NULL, available_at=now() - interval '1 second' WHERE id=$1`, [IDS.OUT2]);
await mesurer(DB, {
  id: 'C15_reprise_apres_echec', libelle: 'Reprise apres echec (status=failed, attempts=2, available_at echue)',
  sql: "ADMIN: status='failed', attempts=2 ; SELECT * FROM tracefab_claim_notification_outbox(5);",
  setup: c => contexte(c, { systeme: J }),
  exec: c => c.query('SELECT * FROM public.tracefab_claim_notification_outbox(5)'),
  verifier: (b, e) => {
    const l = b?.rows.find(r => r.id === IDS.OUT2);
    return ok(!e && l && Number(l.attempts) === 3, 'ligne en echec reclamable, attempts=3', e ? `${e.sqlstate} ${e.message.slice(0, 140)}` : JSON.stringify(b?.rows.map(r => ({ id: r.id, a: r.attempts }))));
  },
});

// -- 2.13 doublon d evenement ----------------------------------------------
await mesurer(DB, {
  id: 'C16_doublon_evenement', libelle: 'Doublon de event_key : contrainte unique, refuse',
  sql: 'INSERT INTO tracefab_notification_outbox(... event_key = <deja present> ...)',
  role: 'postgres',
  exec: c => c.query(`INSERT INTO public.tracefab_notification_outbox
    (event_key,event_type,request_id,recipient_organization_id,recipient_emails,recipient_name,brand_name,supplier_name,request_title,status,attempts)
    VALUES ('evt-p108-1','request_sent',$1,$2,ARRAY['x@example.test'],'X','Marque A','Fournisseur B','Demande','pending',0)`,
    [IDS.REQ, IDS.A]),
  verifier: (b, e) => ok(e?.sqlstate === '23505', 'SQLSTATE 23505 unique_violation (event_key)', e ? `${e.sqlstate} ${e.message.slice(0, 150)}` : 'doublon accepte (FAIL)'),
});

// -- 2.14 evenements de deux organisations ---------------------------------
await reinitialiser(A);
await mesurer(DB, {
  id: 'C17_deux_organisations', libelle: 'Claim de 2 evenements appartenant a 2 organisations differentes',
  sql: 'SELECT * FROM tracefab_claim_notification_outbox(5);',
  setup: c => contexte(c, { systeme: J }),
  exec: c => c.query('SELECT id, recipient_organization_id org FROM public.tracefab_claim_notification_outbox(5)'),
  verifier: (b, e) => ok(!e && new Set(b.rows.map(r => r.org)).size === 2,
    'au moins 2 organisations distinctes revendiquees par le worker', e ? `${e.sqlstate} ${e.message.slice(0, 140)}` : `${b.rowCount} lignes, orgs=${[...new Set(b.rows.map(r => r.org))].join(',')}`),
});

// -- 2.15 RLS active + absence d elevation ---------------------------------
await mesurer(DB, {
  id: 'C18_rls_active', libelle: 'RLS active et forcee, 3 politiques, aucun superutilisateur metier',
  sql: "SELECT relrowsecurity, relforcerowsecurity FROM pg_class ...; SELECT count(*) FROM pg_policies ...",
  exec: c => c.query(`SELECT relrowsecurity rls, relforcerowsecurity force,
    (SELECT count(*)::int FROM pg_catalog.pg_policies WHERE tablename='tracefab_notification_outbox') pol
    FROM pg_catalog.pg_class WHERE oid='public.tracefab_notification_outbox'::regclass`),
  verifier: b => ok(b.rows[0].rls && b.rows[0].force && b.rows[0].pol === 3,
    'rls=true, force=true, 3 politiques', JSON.stringify(b.rows[0])),
});

await mesurer(DB, {
  id: 'C19_elevation_refusee', libelle: 'Tentative SET ROLE tracefab_worker par le runtime : refusee',
  sql: 'SET ROLE tracefab_worker;',
  exec: c => c.query('SET ROLE tracefab_worker'),
  verifier: (b, e) => ok(e?.sqlstate === '42501', 'SQLSTATE 42501 permission denied to set role', e ? `${e.sqlstate} ${e.message.slice(0, 150)}` : 'elevation acceptee (FAIL)'),
});

await mesurer(DB, {
  id: 'C20_set_role_vs_vraie_session', libelle: 'SET ROLE nest PAS une session applicative : session_user reste postgres',
  sql: "SET ROLE tracefab_app; SELECT current_user, session_user;",
  role: 'postgres',
  exec: async c => {
    await c.query('SET ROLE tracefab_app');
    const r = await c.query('SELECT current_user::text cu, session_user::text su');
    await c.query('RESET ROLE');
    return r.rows[0];
  },
  verifier: b => ok(b.cu === 'tracefab_app' && b.su === 'postgres',
    "current_user=tracefab_app mais session_user=postgres (insuffisant)", JSON.stringify(b)),
});

await mesurer(DB, {
  id: 'C21_cles_illisibles_runtime', libelle: 'Secret HMAC illisible par tracefab_app (RLS + privileges)',
  sql: 'SELECT version,secret FROM public.tracefab_identity_cles;',
  exec: c => c.query('SELECT version, secret FROM public.tracefab_identity_cles'),
  verifier: (b, e) => ok(e?.sqlstate === '42501' || (!e && b.rowCount === 0),
    'aucun secret lisible (42501 ou 0 ligne RLS)', e ? `${e.sqlstate} ${e.message.slice(0, 150)}` : `${b.rowCount} ligne(s) visibles (FAIL si > 0)`),
});

// -- 2.16 HMAC : non-regression sur PG 17.11 reel --------------------------
const HORLOGE = await horlogeBase(A);
const HMAC = [
  { id: 'H1_forme_canonique_suffixe', jeton: c => `${S(c)}.extra`, attendu: false, libelle: 'Suffixe ajoutee : jeton a deux points refuse' },
  { id: 'H2_majuscules_mac', jeton: c => { const t = S(c); const [k, m] = t.split('.'); return `${k}.${m.toUpperCase()}`; }, attendu: false, libelle: 'MAC en majuscules refuse (forme canonique minuscule)' },
  { id: 'H3_expiration_600s', jeton: c => jetonExp(c, HORLOGE + 601), attendu: false, libelle: 'Expiration a now()+601 s refusee (horloge de la base)' },
  { id: 'H4_mac_falsifie', jeton: c => { const t = S(c); return `${t.slice(0, -1)}${t.endsWith('a') ? 'b' : 'a'}`; }, attendu: false, libelle: 'MAC falsifie refuse' },
  { id: 'H5_expire', jeton: c => S(c, -60), attendu: false, libelle: 'Jeton expire refuse' },
  { id: 'H6_valide', jeton: c => S(c), attendu: true, libelle: 'Jeton canonique valide accepte' },
  { id: 'H6b_borne_599s', jeton: c => jetonExp(c, HORLOGE + 599), attendu: true, libelle: 'Expiration a now()+599 s acceptee (borne inferieure du plafond)' },
];
for (const h of HMAC) {
  await mesurer(DB, {
    id: h.id, libelle: `HMAC systeme : ${h.libelle}`,
    sql: 'SELECT public.tracefab_identite_systeme_jeton_valide(<jeton>);',
    setup: c => contexte(c, { systeme: '' }),
    exec: c => c.query('SELECT public.tracefab_identite_systeme_jeton_valide($1) v', [h.jeton(M.cle)]),
    verifier: (b, e) => ok(!e && b.rows[0].v === h.attendu, `verificateur = ${h.attendu}`, e ? `${e.sqlstate} ${e.message.slice(0, 140)}` : String(b.rows[0].v)),
  });
}

// Rotation : nouvelle cle active + ancienne cle toujours acceptee, sans sortie
// anticipee. Operation d'administration sur la base jetable.
const cle2 = randomBytes(32);
await A.query('INSERT INTO public.tracefab_identity_cles(version,secret,actif) VALUES (99002,$1,true)', [cle2]);
await mesurer(DB, {
  id: 'H7_rotation_sans_coupure', libelle: 'Rotation : jeton signe par ANCIENNE cle accepte pendant le chevauchement',
  sql: 'ADMIN: INSERT cle v99002 active ; SELECT tracefab_identite_systeme_jeton_valide(<jeton ancienne cle>);',
  setup: c => contexte(c, { systeme: '' }),
  exec: c => c.query('SELECT public.tracefab_identite_systeme_jeton_valide($1) v', [S(M.cle)]),
  verifier: (b, e) => ok(!e && b.rows[0].v === true, 'true (ancienne cle active)', e ? `${e.sqlstate} ${e.message.slice(0, 140)}` : String(b.rows[0].v)),
});
await A.query('UPDATE public.tracefab_identity_cles SET actif=false WHERE version=99001');
await mesurer(DB, {
  id: 'H8_revocation_immediate', libelle: 'Revocation : jeton de la cle revoquee refuse immediatement',
  sql: 'ADMIN: UPDATE ... SET actif=false ; SELECT tracefab_identite_systeme_jeton_valide(<jeton revoque>);',
  setup: c => contexte(c, { systeme: '' }),
  exec: c => c.query('SELECT public.tracefab_identite_systeme_jeton_valide($1) v', [S(M.cle)]),
  verifier: (b, e) => ok(!e && b.rows[0].v === false, 'false', e ? `${e.sqlstate} ${e.message.slice(0, 140)}` : String(b.rows[0].v)),
});
await mesurer(DB, {
  id: 'H9_fail_closed_et_nouvelle_cle', libelle: 'Apres revocation, seule la nouvelle cle valide ; claim sans jeton toujours refuse',
  sql: "SELECT tracefab_identite_systeme_jeton_valide(<nouvelle cle>); SELECT * FROM tracefab_claim_notification_outbox(1) sans jeton;",
  setup: c => contexte(c, { systeme: '' }),
  exec: async c => {
    const v = await c.query('SELECT public.tracefab_identite_systeme_jeton_valide($1) v', [S(cle2)]);
    let refus = null;
    try { await c.query('SELECT * FROM public.tracefab_claim_notification_outbox(1)'); }
    catch (e) { refus = e.code; }
    return { valide: v.rows[0].v, refus };
  },
  verifier: (b, e) => ok(!e && b.valide === true && b.refus === '42501', 'nouvelle cle=true ET claim sans jeton=42501', e ? `${e.sqlstate} ${e.message.slice(0, 140)}` : JSON.stringify(b)),
});

await mesurer(DB, {
  id: 'H10_guc_transactionnel', libelle: 'GUC transactionnel : jeton pose en SET LOCAL ne survit pas au COMMIT',
  sql: "BEGIN; SELECT set_config('tracefab.identity_systeme',<jeton>,true); COMMIT; SELECT * FROM tracefab_claim_notification_outbox(1);",
  setup: c => contexte(c, { systeme: '' }),
  exec: async c => {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('tracefab.identity_systeme',$1,true)`, [S(cle2)]);
    await c.query('COMMIT');
    let refus = null;
    try { await c.query('SELECT * FROM public.tracefab_claim_notification_outbox(1)'); } catch (e) { refus = e.code; }
    return { refus };
  },
  verifier: (b, e) => ok(!e && b.refus === '42501', 'apres COMMIT : 42501 authentication_required', e ? `${e.sqlstate} ${e.message.slice(0, 140)}` : JSON.stringify(b)),
});

await mesurer(DB, {
  id: 'H11_jeton_utilisateur_lie_org', libelle: 'Jeton utilisateur signe pour A refuse quand le contexte org est B',
  sql: "SELECT tracefab_identity_jeton_utilisateur(<jeton org A>) avec tracefab.active_organization_id=<B>;",
  setup: c => contexte(c, { org: IDS.B }),
  exec: c => c.query('SELECT public.tracefab_identity_jeton_utilisateur($1) u', [U(M.cle, IDS.A)]),
  verifier: (b, e) => ok(!e && b.rows[0].u === null, 'NULL (jeton non lie au contexte)', e ? `${e.sqlstate} ${e.message.slice(0, 140)}` : String(b.rows[0].u)),
});

// ---------------------------------------------------------------------------
// 3. IDEMPOTENCE DE LA MIGRATION CORRECTIVE
// ---------------------------------------------------------------------------
{
  const db = dbUnique('idem');
  const c = await baseVierge(db);
  const chaine = composer(['main', '#113', '#114'], [CORRECTIF]);
  const a1 = await appliquer(c, chaine);
  let echec2 = null, a2 = null;
  try { a2 = await c.query(CORRECTIF.texte); } catch (e) { echec2 = { sqlstate: e.code, message: String(e.message).slice(0, 240) }; }
  const post = await c.query(`SELECT count(*)::int transferees FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prosecdef AND p.proname IN ('tracefab_claim_notification_outbox','tracefab_complete_notification_outbox','tracefab_enqueue_due_data_request_reminders')
      AND pg_get_userbyid(p.proowner)='tracefab_worker'`);
  await c.end();
  const ligne = {
    id: 'I1_correctif_idempotent', libelle: 'Reapplication de la migration corrective sur la meme base : SQL reussi, postconditions conservees',
    sql: 'RE-EXECUTION de 20261107120000_p108_outbox_proprietaire_et_dependances/migration.sql',
    role_actif: 'postgres (application de migration, cluster jetable)', session: null, rls: null,
    attendu: 'aucune erreur, 3/3 fonctions outbox toujours possedees par tracefab_worker',
    observe: echec2 ? `${echec2.sqlstate} ${echec2.message}` : `SQL REUSSI ; transferees=${post.rows[0].transferees}/3 ; 1er passage=${a1.appliquees.length} migrations`,
    sqlstate: echec2?.sqlstate ?? null, message_erreur: echec2?.message ?? null,
    preuve_absence_elevation: false, preuve_rls_active: false,
    statut: !echec2 && !a1.echec && post.rows[0].transferees === 3 ? 'PASS' : 'FAIL',
  };
  resultats.push(ligne);
  console.log(`${ligne.statut.padEnd(5)} ${ligne.id.padEnd(34)} ${ligne.observe.slice(0, 90)}`);
}

// ---------------------------------------------------------------------------
// 4. APPLICATION DE LA MIGRATION PAR UN ROLE DE MIGRATION NON SUPERUTILISATEUR
// ---------------------------------------------------------------------------
{
  const db = dbUnique('migr');
  const admin = await baseVierge(db);
  const chaine = composer(['main', '#113', '#114'], []);
  const a = await appliquer(admin, chaine);
  const cle = randomBytes(32);
  await fixtures(admin, cle);
  await admin.query(MODELISATION_PROPRIETE_PLEINE);
  const mig = await connecter(db, 'tracefab_migrator');
  let erreur = null, session = null;
  try {
    await mig.query(CORRECTIF.texte);
    session = await identiteSession(mig);
  } catch (e) { erreur = { sqlstate: e.code, message: String(e.message).slice(0, 260) }; session = await identiteSession(mig).catch(() => null); }
  const post = await mig.query(`SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prosecdef AND pg_get_userbyid(p.proowner)='tracefab_worker'
      AND p.proname IN ('tracefab_claim_notification_outbox','tracefab_complete_notification_outbox','tracefab_enqueue_due_data_request_reminders')`).catch(() => ({ rows: [{ n: -1 }] }));
  await mig.end(); await admin.end();
  const ligne = {
    id: 'I2_correctif_par_role_non_superutilisateur', libelle: 'Correctif applique par tracefab_migrator (NOSUPERUSER/NOBYPASSRLS) : reussi sans elevation permanente',
    sql: 'EXECUTION de la migration corrective via une connexion tracefab_migrator',
    role_actif: 'tracefab_migrator', session, rls: null,
    attendu: 'SQL reussi, 3/3 fonctions outbox possedees par tracefab_worker, session non superutilisee',
    observe: erreur ? `${erreur.sqlstate} ${erreur.message}` : `SQL REUSSI ; ${post.rows[0].n}/3 ; chaine=${a.appliquees.length} migrations`,
    sqlstate: erreur?.sqlstate ?? null, message_erreur: erreur?.message ?? null,
    preuve_absence_elevation: !!session && session.super === false && session.bypassrls === false,
    preuve_rls_active: false,
    statut: !erreur && post.rows[0].n === 3 && session.super === false ? 'PASS' : 'FAIL',
  };
  resultats.push(ligne);
  console.log(`${ligne.statut.padEnd(5)} ${ligne.id.padEnd(34)} ${ligne.observe.slice(0, 90)}`);
}

await A.end();

// ---------------------------------------------------------------------------
// 5. AGREGATS ET ARTEFACT
// ---------------------------------------------------------------------------
const pass = resultats.filter(r => r.statut === 'PASS').length;
const fail = resultats.filter(r => r.statut === 'FAIL').length;
const artefact = {
  mission: 'P10.8 — preuves outbox sur PostgreSQL 17.11 reel',
  genere_le: new Date().toISOString(),
  url_administration: PG_URL.replace(/\/\/[^@]*@/, '//<jetable>@'),
  methode: 'Connexions metier REELLES tracefab_app (session_user=current_user), jamais SET ROLE pour simuler une session ; superutilisateur reserve a la creation de la base, aux migrations, aux fixtures et a la simulation de crash.',
  chaine_canonique: {
    refs: ['main', '#113', '#114', 'HEAD (correctif P10.8)'],
    migrations: chaineCanonique.appliquees.map(x => ({ nom: x.nom, ref: x.ref, sha256: x.sha256 })),
    total: chaineCanonique.appliquees.length,
  },
  reproductions,
  causes_racines: causesRacines,
  scenarios: resultats,
  agregats: { total: resultats.length, PASS: pass, FAIL: fail, BLOCKED: 0, NOT_RUN: 0 },
  preuve_superutilisateur_jamais_metier: resultats
    .filter(r => !r.id.startsWith('I') && r.role_actif !== 'postgres')
    .every(r => r.session && (Array.isArray(r.session) ? r.session.every(s => s.super === false && s.bypassrls === false) : (r.session.super === false && r.session.bypassrls === false))),
  preuve_rls_active: resultats.filter(r => r.preuve_rls_active).length,
};
fs.mkdirSync(path.dirname(SORTIE), { recursive: true });
fs.writeFileSync(SORTIE, JSON.stringify(artefact, null, 2) + '\n');
console.log(`\nArtefact : ${SORTIE}`);
console.log(`Scenarios : ${pass} PASS / ${fail} FAIL / ${resultats.length} total`);
console.log(`Reproductions : ${reproductions.map(r => `${r.id}=${r.resultat}(${r.sqlstate ?? 'aucun'})`).join(' · ')}`);
if (fail > 0) process.exitCode = 1;
