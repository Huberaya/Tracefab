#!/usr/bin/env node
/**
 * TRACEFAB — provisionnement utilisateur sous RLS réelle.
 *
 * CE QUE CE TEST PROUVE
 *   `requireClerkUser` (api/_lib/auth.ts) provisionne l'utilisateur interne par
 *   un `user.upsert` exécuté sur le rôle de connexion de l'application. Or
 *   `users` ne peut pas porter de politique INSERT « soi-même » — on ne peut pas
 *   être soi-même avant d'exister. La seule politique INSERT est
 *   `users_insert_worker`, armée par `tracefab.worker_context`.
 *
 *   Le défaut : sans ce contexte, la PREMIÈRE connexion d'un utilisateur échoue
 *   en 42501 dès que l'application tourne avec un rôle sans BYPASSRLS. Il restait
 *   invisible parce que le rôle de production (`neondb_owner`) porte BYPASSRLS,
 *   donc aucune politique n'était évaluée.
 *
 *   Un utilisateur déjà provisionné, lui, passait : son SELECT et son UPDATE
 *   tombent sur `users_select_self` / `users_update_self`. D'où l'obligation de
 *   tester les DEUX cas — tester seulement le second aurait déclaré sain un
 *   chemin qui casse pour tout nouvel utilisateur.
 *
 * DEUX PARTIES, PARCE QUE L'UNE SANS L'AUTRE NE SUFFIT PAS
 *   A. exécution contre PostgreSQL avec le rôle runtime réel, sans BYPASSRLS ;
 *   B. garde statique : le upsert est bien enveloppé dans le contexte worker.
 *   La partie A prouve ce que PostgreSQL autorise ; la partie B attache cette
 *   preuve au code qui tourne vraiment. Sans B, on pourrait « corriger » auth.ts
 *   en retirant le contexte et voir A rester vert.
 *
 *   node scripts/test_auth_rls_provisioning.mjs
 *   requiert DATABASE_URL (propriétaire) et TF_RLS_APP_URL (rôle sans BYPASSRLS)
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const URL_PROPRIO = process.env.DATABASE_URL;
const URL_APP = process.env.TF_RLS_APP_URL;

let checks = 0;
let failures = 0;
const ok = (name) => { checks++; console.log(`  ok    ${name}`); };
const ko = (name, detail) => { failures++; console.error(`  FAIL  ${name}\n        ${detail}`); };

if (!URL_PROPRIO || !URL_APP) {
  console.log('  NON EXECUTE — il manque DATABASE_URL et/ou TF_RLS_APP_URL.');
  console.log('  TF_RLS_APP_URL doit pointer un role SANS BYPASSRLS (ex. tracefab_app).');
  process.exit(2);
}

const owner = new pg.Client({ connectionString: URL_PROPRIO });
const app = new pg.Client({ connectionString: URL_APP });

/** Identifiant déterministe : rejouer le test ne duplique rien. */
const PROBE_CLERK_ID = 'clerk_probe_provisioning';

/* ------------------------------------------------------------------ A ----- */
console.log('\nA. Permissions réelles, exécutées contre PostgreSQL');

await owner.connect();
await app.connect();

const moi = await app.query(
  'select current_user as r, (select rolbypassrls from pg_roles where rolname = current_user) as bypass',
);
if (moi.rows[0].bypass) {
  ko(`le rôle « ${moi.rows[0].r} » porte BYPASSRLS`,
    'aucune politique ne serait évaluée, le reste du test ne mesurerait rien');
} else {
  ok(`rôle runtime « ${moi.rows[0].r} », BYPASSRLS=false`);
}

/* Nettoyage d'une exécution précédente, côté propriétaire. */
await owner.query('delete from users where clerk_user_id = $1', [PROBE_CLERK_ID]);

/* --- A.1 première connexion : l'INSERT que fait requireClerkUser ----------- */
let insertAnonymeRefuse = null;
await app.query('BEGIN');
try {
  await app.query(
    `insert into users (clerk_user_id, email, full_name) values ($1, 'probe@provisioning.test', 'Sonde')`,
    [PROBE_CLERK_ID],
  );
  insertAnonymeRefuse = false;
} catch (e) {
  insertAnonymeRefuse = e.code;
}
await app.query('ROLLBACK');

if (insertAnonymeRefuse === false) {
  ko('un INSERT sur users sans contexte est autorisé',
    'cela signifierait qu aucune politique INSERT ne s applique — le test ne mesurerait rien');
} else {
  ok(`première connexion sans contexte worker : refusée (${insertAnonymeRefuse})`);
}

/* --- A.2 le même INSERT en contexte worker -------------------------------- */
let creeEnContexteWorker = null;
await app.query('BEGIN');
try {
  await app.query("select set_config('tracefab.worker_context','true',true)");
  const r = await app.query(
    `insert into users (clerk_user_id, email, full_name) values ($1, 'probe@provisioning.test', 'Sonde') returning id`,
    [PROBE_CLERK_ID],
  );
  creeEnContexteWorker = r.rows[0].id;
} catch (e) {
  creeEnContexteWorker = `REFUSE:${e.code}`;
}
await app.query('COMMIT');

if (creeEnContexteWorker && !String(creeEnContexteWorker).startsWith('REFUSE')) {
  ok('provisionnement en contexte worker : autorisé (le chemin de requireClerkUser)');
} else {
  ko('le provisionnement en contexte worker échoue', String(creeEnContexteWorker));
}

/* --- A.3 le contexte worker ne survit pas à la transaction ---------------- */
const apresWorker = await app.query(
  "select coalesce(current_setting('tracefab.worker_context', true), 'null') as v",
);
if (apresWorker.rows[0].v === 'true') {
  ko('le contexte worker survit hors de sa transaction',
    'une connexion pooled réutiliserait les droits worker : fuite de privilège');
} else {
  ok(`le contexte worker ne survit pas à la transaction (valeur = ${apresWorker.rows[0].v})`);
}

/* --- A.4 utilisateur déjà provisionné : lecture et mise à jour de soi ----- */
const probeId = (await owner.query(
  'select id from users where clerk_user_id = $1', [PROBE_CLERK_ID],
)).rows[0]?.id;

await app.query('BEGIN');
await app.query("select set_config('tracefab.user_id',$1,true)", [probeId]);
const soiMeme = await app.query('select id from users where id = $1', [probeId]);
if (soiMeme.rowCount === 1) ok('utilisateur déjà provisionné : SELECT de soi-même rend 1 ligne');
else ko('utilisateur déjà provisionné : SELECT de soi-même', `${soiMeme.rowCount} ligne(s), attendu 1`);

let majSoi = true;
try {
  await app.query("update users set full_name = 'Sonde mise à jour' where id = $1", [probeId]);
} catch (e) { majSoi = false; ko('UPDATE de soi-même refusé', `${e.code} ${e.message.split('\n')[0]}`); }
if (majSoi) ok('utilisateur déjà provisionné : UPDATE de soi-même autorisé');
await app.query('ROLLBACK');

/* --- A.5 isolation entre utilisateurs ------------------------------------ */
const autre = (await owner.query(
  "select id, full_name from users where clerk_user_id like 'clerk_rls_%' limit 1",
)).rows[0];

if (!autre) {
  console.log('  —     isolation inter-utilisateurs non mesurée : aucun utilisateur clerk_rls_* (lancer seed_rls_fixture.mjs)');
} else {
  await app.query('BEGIN');
  await app.query("select set_config('tracefab.user_id',$1,true)", [probeId]);
  const vu = await app.query('select id from users where id = $1', [autre.id]);
  if (vu.rowCount === 0) ok('un utilisateur ne lit pas un AUTRE utilisateur (0 ligne)');
  else ko('un utilisateur lit un autre utilisateur', `${vu.rowCount} ligne(s), attendu 0`);

  /* Un UPDATE hors politique ne lève pas d'erreur : il n'affecte rien. La
     preuve n'est donc pas l'absence d'exception mais l'état réel de la ligne,
     relu côté propriétaire. */
  await app.query("update users set full_name = 'Pirate' where id = $1", [autre.id]);
  await app.query('ROLLBACK');
  const intact = (await owner.query('select full_name from users where id = $1', [autre.id])).rows[0];
  if (intact.full_name === autre.full_name) {
    ok(`l'UPDATE d'un autre utilisateur n'a rien écrit (${JSON.stringify(intact.full_name)} intact)`);
  } else {
    ko("l'UPDATE d'un autre utilisateur a écrit", `${JSON.stringify(autre.full_name)} -> ${JSON.stringify(intact.full_name)}`);
  }
}

await owner.query('delete from users where clerk_user_id = $1', [PROBE_CLERK_ID]);
await app.end();
await owner.end();

/* ------------------------------------------------------------------ B ----- */
console.log('\nB. Garde statique — le code qui tourne vraiment');

const authSrc = readFileSync(join(ROOT, 'api/_lib/auth.ts'), 'utf8');

if (/withTracefabWorkerContext\s*\(\s*\(tx\)\s*=>\s*tx\.user\.upsert/s.test(authSrc)) {
  ok('requireClerkUser provisionne via withTracefabWorkerContext');
} else {
  ko('requireClerkUser ne provisionne plus en contexte worker',
    "la première connexion échouerait en 42501 sous un rôle sans BYPASSRLS");
}

/* Un upsert sur `user` hors contexte worker réintroduirait le défaut. */
const horsContexte = [...authSrc.matchAll(/prisma\.user\.upsert/g)].length;
if (horsContexte === 0) ok('aucun `prisma.user.upsert` hors contexte worker dans auth.ts');
else ko(`${horsContexte} appel(s) à prisma.user.upsert hors contexte worker`, 'contourne la politique INSERT');

/* Le contexte doit rester borné : s'il enveloppait toute la requête, chaque
   route authentifiée tournerait avec les droits worker. */
const porteeWorker = (authSrc.match(/withTracefabWorkerContext/g) || []).length;
if (porteeWorker === 2) ok('le contexte worker est borné au seul provisionnement (import + appel)');
else ko(`withTracefabWorkerContext apparaît ${porteeWorker} fois dans auth.ts`,
  'attendu 2 (import + appel) : au-delà, le contexte déborde sur la requête');

/* ------------------------------------------------------------------------ */
console.log(`\n${'='.repeat(64)}`);
if (failures) {
  console.error(`test:auth:rls-provisioning FAILED — ${failures} échec(s), ${checks} contrôle(s) réussi(s).`);
  process.exit(1);
}
console.log(`test:auth:rls-provisioning passed — ${checks} contrôles, 0 échec.`);
