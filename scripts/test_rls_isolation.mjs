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
// Neon impose TLS ; un Postgres jetable de CI n'en a pas. Demander du TLS a
// un serveur qui n'en fait pas echoue a la connexion, donc on suit l'URL.
const cli = (u) => new pg.Client({
  connectionString: u,
  ssl: /sslmode=(require|verify-full|verify-ca)/.test(u) ? { rejectUnauthorized: false } : false,
});

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
// On enumere TOUTES les tables, pas seulement celles deja marquees RLS.
// Filtrer sur relrowsecurity rendrait le test aveugle a la seule chose qu'il
// doit attraper : une table a qui on retire la RLS sortirait de la liste et
// cesserait d'etre surveillee, en silence, sans faire rougir quoi que ce soit.
const inventaire = (await proprio.query(`
  select c.relname, c.relrowsecurity from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
  order by c.relname`)).rows;

const tables = inventaire.map((r) => r.relname);
const sansRls = inventaire.filter((r) => !r.relrowsecurity && !REFERENCE.has(r.relname)).map((r) => r.relname);
if (sansRls.length) ko(`${sansRls.length} table(s) de locataire sans ROW LEVEL SECURITY : ${sansRls.join(' · ')}`);
else ok(`${tables.length} tables inventoriees, toutes les tables de locataire portent la RLS`);

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

// Les tables porteuses d'un identifiant : on releve QUELLES lignes sont
// visibles, pas combien. Comparer des cardinalites est un piege — deux
// locataires symetriques voient le meme nombre de lignes tout en etant
// parfaitement cloisonnes, et le test conclurait a tort a une absence
// d'isolation. Ce sont les identites qui tranchent.
const avecId = new Set((await proprio.query(`
  select table_name from information_schema.columns
  where table_schema = 'public' and column_name = 'id'`)).rows.map((r) => r.table_name));

const voirAvecContexte = async (userId, email) => {
  await app.query('begin');
  await app.query('select set_config($1,$2,true)', ['tracefab.user_id', userId]);
  await app.query('select set_config($1,$2,true)', ['tracefab.user_email', email.toLowerCase()]);
  const vues = {};
  for (const t of tables) {
    if (REFERENCE.has(t)) continue;
    await app.query('savepoint s');
    try {
      const r = avecId.has(t)
        ? await app.query(`select id::text from "${t}"`)
        : await app.query(`select count(*)::int n from "${t}"`);
      await app.query('release savepoint s');
      vues[t] = avecId.has(t)
        ? new Set(r.rows.map((x) => x.id))
        : new Set(r.rows[0].n > 0 ? [`anonyme:${r.rows[0].n}`] : []);
    } catch {
      await app.query('rollback to savepoint s');
      vues[t] = null;
    }
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
  const taille = (v) => Object.values(v).reduce((n, s) => n + (s ? s.size : 0), 0);
  const candidats = [];
  for (const d of duo.slice(0, 12)) {
    const vues = await voirAvecContexte(d.user_id, d.email);
    if (taille(vues) > 0) candidats.push({ ...d, vues });
    if (candidats.length === 2) break;
  }
  if (candidats.length < 2) {
    ko('impossible de trouver deux locataires porteurs de donnees — epreuve differentielle non concluante');
  } else {
    const [a, b] = candidats;
    const tenant = tables.filter((t) => !REFERENCE.has(t));
    const memeEnsemble = (x, y) => x && y && x.size === y.size && [...x].every((i) => y.has(i));

    const ecarts = tenant.filter((t) => !memeEnsemble(a.vues[t], b.vues[t]));
    couvert = tenant.filter((t) => (a.vues[t]?.size || 0) + (b.vues[t]?.size || 0) > 0).length;
    differencie = ecarts.length > 0;

    console.log(`        locataire 1 : ${a.email} — ${taille(a.vues)} ligne(s) visibles`);
    console.log(`        locataire 2 : ${b.email} — ${taille(b.vues)} ligne(s) visibles`);

    if (differencie) ok(`les deux locataires voient des lignes differentes sur ${ecarts.length} table(s) : ${ecarts.slice(0, 5).join(' · ')}`);
    else ko('les deux locataires voient exactement les memes lignes partout — l isolation ne discrimine rien');

    // Une ligne visible des deux cotes n'est pas forcement une fuite (une
    // relation marque-fournisseur est legitimement partagee), mais si AUCUNE
    // table ne les separe, le cloisonnement est illusoire.
    const communes = tenant
      .map((t) => [t, [...(a.vues[t] || [])].filter((i) => b.vues[t]?.has(i)).length])
      .filter(([, n]) => n > 0);
    console.log(`        lignes visibles des deux cotes : ${communes.reduce((n, [, c]) => n + c, 0)}`
      + (communes.length ? ` (${communes.map(([t, n]) => `${t}:${n}`).join(' · ')})` : ''));

    const toutVu = tenant.filter((t) => total[t] > 0 && a.vues[t]?.size === total[t]);
    if (toutVu.length) ko(`${toutVu.length} table(s) entierement visibles par un seul locataire : ${toutVu.join(' · ')}`);
    else ok('aucune table de locataire n est integralement visible par un seul utilisateur');
  }
}

/* --- E. la lecture publique : ouverte juste assez ------------------------- */
//
// Le DPP public et le Digital Link GS1 sont anonymes. Ils ne peuvent pas poser
// de tracefab.user_email. La barriere n'est donc pas « qui es-tu » mais « ce
// produit est-il publie ». Ces verifications echouent dans les deux sens :
// si le public ne voit rien le produit est casse, s'il voit trop il y a fuite.

console.log('\n  E. lecture publique (contexte tracefab.public_context)');

const nPublies = Number((await proprio.query(
  'SELECT count(*) n FROM tracefab_products WHERE public_slug IS NOT NULL')).rows[0].n);
const nBrouillons = Number((await proprio.query(
  "SELECT count(*) n FROM tracefab_products WHERE public_slug IS NULL")).rows[0].n);

if (nPublies === 0) {
  ko('aucun produit publie : la lecture publique ne peut pas etre prouvee');
} else {
  // E1. sans le drapeau, rien ne sort — c'est l'etat par defaut
  const muet = Number((await app.query('SELECT count(*) n FROM tracefab_products')).rows[0].n);
  if (muet === 0) ok('sans contexte public, tracefab_products ne rend aucune ligne');
  else ko(`sans contexte public, tracefab_products rend ${muet} ligne(s) — la barriere ne tient pas`);

  // E2. avec le drapeau, exactement les produits publies, ni plus ni moins
  await app.query('BEGIN');
  await app.query("SELECT set_config('tracefab.public_context','true',true)");
  const vus = await app.query('SELECT id, public_slug FROM tracefab_products');
  const fuite = vus.rows.filter((r) => !r.public_slug).length;
  if (vus.rows.length === nPublies && fuite === 0) {
    ok(`en contexte public, exactement les ${nPublies} produit(s) publie(s) sont lisibles`);
  } else {
    ko(`en contexte public : ${vus.rows.length} produit(s) lisibles pour ${nPublies} publie(s), `
      + `dont ${fuite} sans public_slug`);
  }

  // E2b. oracle INDEPENDANT du predicat de la politique.
  //
  // E2 ci-dessus compare ce que voit l'application a « public_slug IS NOT NULL »,
  // c'est-a-dire au predicat que la politique applique elle-meme : elle ne peut
  // donc detecter qu'une politique cassee, jamais une publication abusive. Le
  // statut editorial est une source independante : rien de publie ne doit etre
  // un brouillon. Une mutation de test l'a prouve en publiant un brouillon sans
  // faire rougir E2.
  const statuts = vus.rows.length
    ? (await proprio.query(
        'SELECT status, count(*)::int n FROM tracefab_products WHERE id = ANY($1) GROUP BY status',
        [vus.rows.map((r) => r.id)])).rows
    : [];
  const nonActifs = statuts.filter((r) => r.status !== 'active');
  if (!nonActifs.length) {
    ok(`tout produit lisible publiquement est en statut actif (${vus.rows.length})`);
  } else {
    ko(`${nonActifs.reduce((n, r) => n + r.n, 0)} produit(s) lisibles publiquement ne sont pas actifs : `
      + nonActifs.map((r) => `${r.status}:${r.n}`).join(' · '));
  }

  // E3. un brouillon reste invisible meme nomme explicitement
  if (nBrouillons > 0) {
    const brouillon = (await proprio.query(
      'SELECT id FROM tracefab_products WHERE public_slug IS NULL LIMIT 1')).rows[0].id;
    const t = await app.query('SELECT count(*) n FROM tracefab_products WHERE id = $1', [brouillon]);
    if (Number(t.rows[0].n) === 0) ok(`un brouillon interroge par son id reste invisible (${nBrouillons} brouillon(s))`);
    else ko('un brouillon est lisible publiquement quand on l interroge par son id');
  }

  // E4. organizations ne doit JAMAIS s'ouvrir : RLS filtre des lignes, pas des
  // colonnes, et la table porte legal_name et registration_number.
  const orgs = Number((await app.query('SELECT count(*) n FROM organizations')).rows[0].n);
  if (orgs === 0) ok('organizations reste totalement fermee meme en contexte public');
  else ko(`organizations expose ${orgs} ligne(s) en contexte public — legal_name et registration_number fuient`);

  // E5. la marque passe par une fonction qui ne projette que deux colonnes
  const marque = await app.query(
    'SELECT * FROM tracefab_public_brand((SELECT brand_organization_id FROM tracefab_products WHERE public_slug IS NOT NULL LIMIT 1))');
  const colonnes = marque.fields.map((c) => c.name).sort();
  if (marque.rows.length === 1 && colonnes.join(',') === 'country_code,display_name') {
    ok(`tracefab_public_brand ne rend que ${colonnes.join(' + ')}`);
  } else {
    ko(`tracefab_public_brand rend ${marque.rows.length} ligne(s) et les colonnes [${colonnes.join(', ')}]`);
  }
  await app.query('ROLLBACK');

  // E6. le drapeau est local a la transaction : il ne doit pas survivre au
  // ROLLBACK ci-dessus, sinon une connexion poolee le transporterait d'une
  // requete anonyme vers la suivante.
  const apres = Number((await app.query('SELECT count(*) n FROM tracefab_products')).rows[0].n);
  if (apres === 0) ok('le contexte public ne survit pas a la transaction (connexion poolee sure)');
  else ko(`le contexte public a survecu a la transaction : ${apres} ligne(s) encore visibles`);
}

await app.end();
await proprio.end();

console.log(`\n  ${tables.length} tables sous RLS · ${couvert} portant des donnees visibles par au moins un des deux locataires`);
console.log(echecs ? `\n${echecs} echec(s).` : '\nIsolation prouvee par execution, pas par inventaire.');
process.exit(echecs ? 1 : 0);
