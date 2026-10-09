#!/usr/bin/env node
/**
 * Isolation RLS — preuve par execution.
 *
 * POURQUOI CE TEST EXISTE
 *
 * Les tests d'isolation precedents comptaient des drapeaux : combien de
 * tables portent ENABLE, combien portent FORCE. Un inventaire de catalogue.
 * Il ne prouve rien, et il a affiche « 46 ENABLE / 46 FORCE » pendant des
 * mois sur une base ou AUCUNE politique n'etait jamais evaluee — parce que
 * le role de connexion, `neondb_owner`, porte BYPASSRLS.
 *
 * BYPASSRLS prime sur ENABLE comme sur FORCE. FORCE ne leve que l'exemption
 * du proprietaire de table ; il ne touche pas celle du role.
 *
 * Ce test se connecte avec un role REELLEMENT soumis a la RLS et regarde ce
 * qu'il voit. C'est la seule mesure qui prouve quelque chose.
 *
 * Ce qu'il a trouve au premier passage : `materials` etait inexecutable
 * (« infinite recursion detected in policy »), cycle materials <->
 * product_materials. La politique n'etait pas trop permissive, elle etait
 * cassee. Personne ne pouvait le voir sans role non-bypass.
 *
 * CE QU'IL VERIFIE
 *
 *   A. Le role de test n'a pas BYPASSRLS — sinon tout le reste est vide de
 *      sens, et le test le dit au lieu de passer au vert.
 *   B. Aucune table ne leve d'erreur de politique (recursion, droit manquant).
 *   C. Sans contexte arme, aucune table de locataire ne laisse voir une ligne.
 *   D. Les tables de reference restent lisibles sans contexte, sinon les
 *      routes publiques (DPP, passeport, wallet) tombent.
 *   E. Deux utilisateurs d'organisations differentes ne voient pas la meme
 *      chose : il existe au moins une ligne visible par l'un et pas l'autre.
 *
 * IL NE PASSE PAS QUAND IL NE PEUT PAS S'EXECUTER
 *
 * Sans identifiants, il sort en code 2 avec un message explicite. Un test
 * qui n'a pas tourne n'est pas un test qui passe — c'est precisement ce
 * qu'il est venu corriger.
 */
import pg from 'pg';

const URL_PROPRIO = process.env.DATABASE_URL;
const URL_APP = process.env.TF_RLS_APP_URL;

if (!URL_PROPRIO || !URL_APP) {
  console.log('  NON EXECUTE — il manque DATABASE_URL et/ou TF_RLS_APP_URL.');
  console.log('  TF_RLS_APP_URL doit pointer un role SANS BYPASSRLS (ex. tracefab_app).');
  console.log('  Un test qui ne tourne pas ne vaut pas un test qui passe : sortie 2.');
  process.exit(2);
}

const REFERENCE = new Set(['pef_emission_factors', 'green_claims_rules', 'tracefab_schema_catalog',
  'dpp_requirement_profiles', 'rate_limit_counters', '_prisma_migrations']);

let echecs = 0;
const ko = (m) => { console.log(`  ECHEC ${m}`); echecs += 1; };
const ok = (m) => console.log(`  ok    ${m}`);
const cli = (u) => new pg.Client({ connectionString: u, ssl: { rejectUnauthorized: false } });

const proprio = cli(URL_PROPRIO);
await proprio.connect();
const app = cli(URL_APP);
await app.connect();

/* --- A. le role de test doit etre soumis a la RLS ------------------------- */
const moi = await app.query(
  'select current_user as r, (select rolbypassrls from pg_roles where rolname = current_user) as bypass');
if (moi.rows[0].bypass) {
  ko(`le role de test « ${moi.rows[0].r} » porte BYPASSRLS — aucune politique ne sera evaluee, le reste du test ne mesurerait rien`);
  console.log(`\n${echecs} echec(s).`);
  process.exit(1);
}
ok(`role de test « ${moi.rows[0].r} », BYPASSRLS=false`);

/* --- inventaire ----------------------------------------------------------- */
const tables = (await proprio.query(`
  select c.relname from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
  order by c.relname`)).rows.map((r) => r.relname);

const total = {};
for (const t of tables) {
  total[t] = (await proprio.query(`select count(*)::int n from "${t}"`)).rows[0].n;
}

const compter = async (t) => {
  await app.query('savepoint s');
  try {
    const n = (await app.query(`select count(*)::int n from "${t}"`)).rows[0].n;
    await app.query('release savepoint s');
    return n;
  } catch (e) {
    await app.query('rollback to savepoint s');
    return { erreur: e.message.split('\n')[0].slice(0, 70) };
  }
};

/* --- B et C. sans contexte ------------------------------------------------ */
await app.query('begin');
const erreurs = [];
const fuites = [];
const refCassees = [];
for (const t of tables) {
  const vu = await compter(t);
  if (vu && typeof vu === 'object') { erreurs.push(`${t} : ${vu.erreur}`); continue; }
  if (REFERENCE.has(t)) { if (total[t] > 0 && vu === 0) refCassees.push(`${t} (0/${total[t]})`); }
  else if (vu > 0) fuites.push(`${t} (${vu}/${total[t]})`);
}
await app.query('rollback');

if (erreurs.length) { ko(`${erreurs.length} table(s) levent une erreur de politique :`); erreurs.forEach((e) => console.log(`         ${e}`)); }
else ok(`${tables.length} tables interrogees, aucune erreur de politique`);

if (fuites.length) { ko(`${fuites.length} table(s) de locataire visibles sans contexte : ${fuites.join(' · ')}`); }
else ok(`sans contexte arme, aucune table de locataire ne laisse voir une ligne`);

if (refCassees.length) { ko(`${refCassees.length} table(s) de reference devenues illisibles — les routes publiques tombent : ${refCassees.join(' · ')}`); }
else ok(`tables de reference lisibles sans contexte (routes publiques preservees)`);

/* --- E. deux locataires ne voient pas la meme chose ----------------------- */
const duo = (await proprio.query(`
  select distinct on (m.organization_id) m.user_id, m.organization_id, u.email
  from organization_memberships m join users u on u.id = m.user_id
  order by m.organization_id, m.created_at`)).rows;

const voirAvecContexte = async (userId, email) => {
  await app.query('begin');
  await app.query('select set_config($1,$2,true)', ['tracefab.user_id', userId]);
  await app.query('select set_config($1,$2,true)', ['tracefab.user_email', email.toLowerCase()]);
  const vues = {};
  for (const t of tables) {
    if (REFERENCE.has(t)) continue;
    const v = await compter(t);
    vues[t] = (v && typeof v === 'object') ? -1 : v;
  }
  await app.query('rollback');
  return vues;
};

let differencie = false;
let couvert = 0;
if (duo.length < 2) {
  ko('moins de deux organisations avec un membre : l epreuve differentielle est impossible');
} else {
  // Deux locataires qui possedent effectivement des lignes, sinon comparer
  // deux ensembles vides ne demontre rien.
  const candidats = [];
  for (const d of duo.slice(0, 12)) {
    const vues = await voirAvecContexte(d.user_id, d.email);
    const somme = Object.values(vues).filter((n) => n > 0).reduce((a, b) => a + b, 0);
    if (somme > 0) candidats.push({ ...d, vues, somme });
    if (candidats.length === 2) break;
  }
  if (candidats.length < 2) {
    ko('impossible de trouver deux locataires porteurs de donnees — epreuve differentielle non concluante');
  } else {
    const [a, b] = candidats;
    const ecarts = tables.filter((t) => !REFERENCE.has(t) && a.vues[t] !== b.vues[t]);
    couvert = tables.filter((t) => !REFERENCE.has(t) && (a.vues[t] > 0 || b.vues[t] > 0)).length;
    differencie = ecarts.length > 0;
    console.log(`        locataire 1 : ${a.email} — ${a.somme} ligne(s) visibles`);
    console.log(`        locataire 2 : ${b.email} — ${b.somme} ligne(s) visibles`);
    if (differencie) ok(`les deux locataires voient des ensembles differents sur ${ecarts.length} table(s) : ${ecarts.slice(0, 5).join(' · ')}`);
    else ko('les deux locataires voient exactement la meme chose partout — l isolation ne discrimine rien');
    const toutVu = tables.filter((t) => !REFERENCE.has(t) && (a.vues[t] === total[t] && total[t] > 0));
    if (toutVu.length) ko(`${toutVu.length} table(s) entierement visibles par un seul locataire : ${toutVu.join(' · ')}`);
    else ok('aucune table de locataire n est integralement visible par un seul utilisateur');
  }
}

await app.end();
await proprio.end();

console.log(`\n  ${tables.length} tables sous RLS · ${couvert} portant des donnees visibles par au moins un des deux locataires`);
console.log(echecs ? `\n${echecs} echec(s).` : '\nIsolation prouvee par execution, pas par inventaire.');
process.exit(echecs ? 1 : 0);
