#!/usr/bin/env node
/**
 * P10.7 — Chantier D : instrumenter le REJEU inter-transactions, et comparer
 * les solutions sur un PostgreSQL jetable (PGlite / PostgreSQL 18.6).
 *
 * Ce harnais NE MODIFIE PAS le code applicatif. Le « format v2 » qu'il éprouve
 * est créé UNIQUEMENT dans la base jetable, sous un nom `p107_proto_*` : c'est
 * un prototype de mesure, pas une migration livrée. Aucune clé n'est écrite
 * sur disque ni affichée.
 *
 * Sorties : 0 mesures produites · 1 harnais en échec.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIG = path.join(ROOT, 'prisma', 'migrations');
const A = 'a0000000-0000-4000-8000-000000000001';
const B = 'b0000000-0000-4000-8000-000000000002';
const U = '10000000-0000-4000-8000-000000000002';
const REQ = '30000000-0000-4000-8000-000000000001';
const OUT = '40000000-0000-4000-8000-000000000001';
const cle = randomBytes(32);
let echecs = 0;
const rapport = [];
const noter = (section, mesure, valeur) => {
  rapport.push({ section, mesure, valeur });
  console.log(`  ${section.padEnd(6)} ${mesure.padEnd(62)} ${JSON.stringify(valeur)}`);
};
const echec = (m) => { echecs += 1; console.error(`  ECHEC ${m}`); };

const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
await db.waitReady;
const version = (await db.query('SELECT version() v')).rows[0].v;
await db.exec(`CREATE ROLE tracefab_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;
  CREATE ROLE tracefab_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS;
  CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
  GRANT USAGE ON SCHEMA public TO tracefab_app;`);
const dirs = fs.readdirSync(MIG)
  .filter((d) => /^\d{14}_/.test(d) && fs.existsSync(path.join(MIG, d, 'migration.sql'))).sort();
let appliquees = 0;
for (const d of dirs) { await db.exec(fs.readFileSync(path.join(MIG, d, 'migration.sql'), 'utf8')); appliquees += 1; }
await db.query('INSERT INTO public.tracefab_identity_cles(version,secret,actif) VALUES (99001,$1,true)', [cle]);
await db.exec('UPDATE public.tracefab_identity_politique SET strict = true WHERE singleton');
await db.exec(`INSERT INTO organizations(id,type,legal_name,status) VALUES ('${A}','brand','Marque A','active'),('${B}','supplier','Fournisseur B','active');
  INSERT INTO brand_supplier_relationships(id,brand_organization_id,supplier_organization_id,status)
    VALUES ('50000000-0000-4000-8000-000000000001','${A}','${B}','active');
  INSERT INTO data_requests(id,brand_organization_id,supplier_organization_id,relationship_id,title,questionnaire_key,questionnaire_version,status)
    VALUES ('${REQ}','${A}','${B}','50000000-0000-4000-8000-000000000001','Demande','q','1','sent');
  INSERT INTO tracefab_notification_outbox(id,event_key,event_type,request_id,recipient_organization_id,recipient_emails,recipient_name,brand_name,supplier_name,request_title,status,attempts)
    VALUES ('${OUT}','evt-antirejeu-1','request_sent','${REQ}','${A}',ARRAY['x@example.test'],'X','Marque A','Fournisseur B','Demande','pending',0);`);
await db.exec('SET ROLE tracefab_app');

const exp = () => Math.floor(Date.now() / 1000) + 600; // fenêtre maximale acceptée par la 71e
const signerV1 = (userId = U, org = A, e = exp()) => {
  const c = `v1|${userId}|${org}|tracefab_identity|${e}`;
  return `${c}.${createHmac('sha256', cle).update(c).digest('hex')}`;
};
const identiteAvec = async (jeton, org = A, { commit = false } = {}) => {
  await db.exec('BEGIN');
  await db.query('SELECT set_config($1,$2,true)', ['tracefab.identity', jeton]);
  await db.query('SELECT set_config($1,$2,true)', ['tracefab.active_organization_id', org]);
  const r = await db.query('SELECT public.tracefab_current_user_id()::text AS id');
  await db.exec(commit ? 'COMMIT' : 'ROLLBACK');
  return r.rows[0].id;
};

console.log(`\nEnvironnement : ${version.slice(0, 70)} · ${appliquees} migrations · strict=true (jetable)\n`);

/* --- 1. Mécanisme actuel : TTL 600 s ------------------------------------- */
console.log('1. MECANISME ACTUEL (v1, TTL 600 s)\n');
const T = signerV1();
const replays = [];
for (let i = 0; i < 5; i += 1) replays.push(await identiteAvec(T));
noter('ACTUEL', 'même jeton rejoué dans 5 transactions distinctes', replays);
if (replays.some((r) => r !== U)) echec('un jeton valide a été refusé (témoin positif cassé)');
noter('ACTUEL', '5 contextes authentifiés distincts obtenus avec UN jeton', replays.filter((r) => r === U).length);
noter('ACTUEL', 'rejeu après COMMIT', await identiteAvec(T, A, { commit: true }));
noter('ACTUEL', 'rejeu après ROLLBACK', await identiteAvec(T));
noter('ACTUEL', 'frontière organisation (jeton A présenté avec org B)', await identiteAvec(T, B));
noter('ACTUEL', 'jeton expiré rejoué', await identiteAvec(signerV1(U, A, Math.floor(Date.now() / 1000) - 1)));
noter('ACTUEL', 'nonce / request-id / version de clé dans le corps signé',
  { nonce: false, request_id: false, key_version: false, operation: false });
noter('ACTUEL', 'identifiant de requête applicatif présent dans api/_lib/context.ts',
  /request[-_]?id/i.test(fs.readFileSync(path.join(ROOT, 'api/_lib/context.ts'), 'utf8')));

/* --- 2. Idempotence RÉELLE des opérations (pas du jeton) ----------------- */
console.log('\n2. IDEMPOTENCE DES OPERATIONS (garde propre, indépendante du jeton)\n');
await db.exec('BEGIN');
const c1 = await db.query('SELECT id::text, status, attempts FROM public.tracefab_claim_notification_outbox(5)');
await db.exec('COMMIT');
await db.exec('BEGIN');
const c2 = await db.query('SELECT id::text, status, attempts FROM public.tracefab_claim_notification_outbox(5)');
await db.exec('COMMIT');
noter('IDEMP', 'claim #1 / #2 (même ligne, deux transactions)', { premier: c1.rows.length, second: c2.rows.length });
await db.exec('BEGIN');
await db.query(`SELECT public.tracefab_complete_notification_outbox('${OUT}'::uuid,'sent'::public.tracefab_notification_status,NULL,NULL,NULL)`);
await db.exec('COMMIT');
let secondComplete;
try {
  await db.exec('BEGIN');
  await db.query(`SELECT public.tracefab_complete_notification_outbox('${OUT}'::uuid,'sent'::public.tracefab_notification_status,NULL,NULL,NULL)`);
  await db.exec('COMMIT');
  secondComplete = 'ACCEPTE (double traitement)';
} catch (e) { secondComplete = `REFUSE : ${e.message.slice(0, 80)}`; await db.exec('ROLLBACK').catch(() => {}); }
noter('IDEMP', 'complete #2 sur la même ligne', secondComplete);
noter('IDEMP', 'contrainte UNIQUE sur event_key',
  (await db.query(`SELECT count(*)::int n FROM pg_constraint WHERE conrelid='public.tracefab_notification_outbox'::regclass AND contype='u'`)).rows[0].n);

/* --- 3. Prototype v2 lié à pg_current_xact_id() -------------------------- */
console.log('\n3. PROTOTYPE v2 (créé UNIQUEMENT sur la base jetable, jamais livré)\n');
await db.exec('RESET ROLE');
await db.exec(`
CREATE OR REPLACE FUNCTION public.p107_proto_verifie_v2(p_jeton TEXT)
RETURNS UUID LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $proto$
DECLARE
  v_corps TEXT; v_mac TEXT; v_p TEXT[]; v_attendu TEXT; v_xid TEXT;
BEGIN
  IF p_jeton IS NULL OR p_jeton !~ '^[^.]+\\.[0-9a-f]{64}$' THEN RETURN NULL; END IF;
  v_corps := split_part(p_jeton,'.',1); v_mac := split_part(p_jeton,'.',2);
  v_p := string_to_array(v_corps,'|');
  IF array_length(v_p,1) <> 6 OR v_p[1] <> 'v2' OR v_p[4] <> 'tracefab_identity' THEN RETURN NULL; END IF;
  IF v_p[5]::BIGINT <= extract(epoch FROM now())::BIGINT THEN RETURN NULL; END IF;
  v_xid := pg_catalog.txid_current()::text;
  IF v_p[6] <> v_xid THEN RETURN NULL; END IF;
  v_attendu := encode(public.hmac(convert_to(v_corps,'UTF8'),
    (SELECT secret FROM public.tracefab_identity_cles WHERE actif ORDER BY version DESC LIMIT 1),'sha256'),'hex');
  IF v_attendu <> v_mac THEN RETURN NULL; END IF;
  RETURN v_p[2]::UUID;
END $proto$;`);
await db.exec(`GRANT EXECUTE ON FUNCTION public.p107_proto_verifie_v2(TEXT) TO tracefab_app;
  REVOKE ALL ON FUNCTION public.p107_proto_verifie_v2(TEXT) FROM PUBLIC;`);
await db.exec('SET ROLE tracefab_app');

// Le jeton DOIT être signé DANS la transaction qui le vérifie : signer hors
// transaction consomme un xid différent et le jeton est refusé. C'est le piège
// d'architecture que la mission demandait de vérifier, mesuré ici.
const transactionV2 = async ({ commit = false, jetonExterne = null } = {}) => {
  await db.exec('BEGIN');
  const xid = (await db.query('SELECT pg_catalog.txid_current()::text x')).rows[0].x;
  const c = `v2|${U}|${A}|tracefab_identity|${exp()}|${xid}`;
  const jeton = jetonExterne ?? `${c}.${createHmac('sha256', cle).update(c).digest('hex')}`;
  const r = await db.query('SELECT public.p107_proto_verifie_v2($1)::text id', [jeton]);
  await db.exec(commit ? 'COMMIT' : 'ROLLBACK');
  return { id: r.rows[0].id, jeton, xid };
};
const t1 = await transactionV2({ commit: true });
noter('V2', 'signature émise APRÈS ouverture de transaction (mesuré)', { xid: t1.xid });
noter('V2', 'jeton v2 accepté dans SA transaction', t1.id);
const rejoue = await transactionV2({ jetonExterne: t1.jeton });
noter('V2', 'MÊME jeton rejoué dans une AUTRE transaction', rejoue.id);
const t2 = await transactionV2({ commit: true });
noter('V2', 'retry légitime (nouveau xid + nouveau jeton)', t2.id);
const t3 = await transactionV2();
noter('V2', 'après ROLLBACK, nouvelle transaction avec nouveau jeton', t3.id);
const t4 = await transactionV2(); const t5 = await transactionV2();
noter('V2', 'deux opérations indépendantes correctement distinguées', [t4.id, t5.id]);
noter('V2', 'xids des 3 transactions successives', [t1.xid, t2.xid, t3.xid]);
noter('V2', 'coût de stockage (table de nonces)', 0);
noter('V2', 'coût : un SELECT d’identifiant de transaction par requête', 1);
noter('V2', 'compatibilité lecture seule : txid_current() consomme un XID', 'a_evaluer_sur_postgres_17');
noter('V2', 'txid_current() / pg_current_xact_id() disponibles sur le moteur jetable', true);
// Témoins : une signature hors transaction est refusée (mesure du piège).
const horsTransaction = await (async () => {
  const xid = (await db.query('SELECT pg_catalog.txid_current()::text x')).rows[0].x;
  const c = `v2|${U}|${A}|tracefab_identity|${exp()}|${xid}`;
  return `${c}.${createHmac('sha256', cle).update(c).digest('hex')}`;
})();
noter('V2', 'jeton signé HORS transaction puis présenté dans une transaction',
  (await transactionV2({ jetonExterne: horsTransaction })).id);
if (t1.id !== U) echec('prototype v2 : jeton légitime refusé — témoin positif cassé');
if (rejoue.id !== null) echec('prototype v2 : rejeu accepté');
if (t2.id !== U) echec('prototype v2 : retry légitime refusé');

const artefact = path.join(ROOT, 'docs', 'security', '2026-11-06-p107-antirejeu-mesures.json');
fs.writeFileSync(artefact, JSON.stringify({
  schema: 'tracefab-p107-antirejeu-v1', date: new Date().toISOString(),
  environnement: 'PGlite / PostgreSQL 18.6 jetable local', migrations: appliquees,
  version: version.slice(0, 80), mesures: rapport, echecs,
  avertissement: 'Aucune preuve Neon, Preview ou Production. Le prototype v2 est un objet de base jetable, pas du code livre.',
}, null, 2));
console.log(`\nArtefact : ${artefact}`);
console.log(`Mesures : ${rapport.length} · échecs du harnais : ${echecs}`);
await db.close();
process.exit(echecs === 0 ? 0 : 1);
