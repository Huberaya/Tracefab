#!/usr/bin/env node
/**
 * Isolation inter-organisations — preuve par exécution, écritures comprises.
 *
 * POURQUOI CE TEST EXISTE
 *
 * test_rls_isolation.mjs prouve la lecture : deux locataires ne voient pas
 * les mêmes lignes. Mais une isolation qui ne tiendrait qu'en lecture serait
 * une passoire — il faut aussi prouver qu'on ne peut ni créer, ni modifier,
 * ni supprimer chez le voisin, et que les fonctions SECURITY DEFINER (qui
 * contournent la RLS par construction) refusent le locataire d'à côté.
 *
 * Ce test fabrique deux organisations complètes (utilisateur propriétaire,
 * fournisseur, produit brouillon), puis se connecte avec le rôle applicatif
 * `tracefab_app` — SANS BYPASSRLS — armé du contexte du locataire A, et
 * tente de franchir la frontière dans tous les sens.
 *
 * CE QU'IL VÉRIFIE — 12 assertions
 *
 *    1. Le rôle de test ne porte pas BYPASSRLS (sinon rien n'est mesuré).
 *    2-4.   SELECT : A ne voit que ses organisations, fournisseurs, produits.
 *    5-6.   INSERT cross-org : refusé chez B (fournisseur et produit).
 *    7-8.   UPDATE cross-org : 0 ligne touchée chez B.
 *    9-10.  DELETE cross-org : 0 ligne touchée chez B.
 *    11-12. Fonctions SECURITY DEFINER : tracefab_can_access_org vaut true
 *           pour sa propre organisation, false pour celle du voisin.
 *
 * Les produits sont des brouillons sans public_slug : la lecture publique
 * (tracefab.public_context) ne peut donc pas expliquer une visibilité.
 *
 * IL NE PASSE PAS QUAND IL NE PEUT PAS S'EXÉCUTER : sans DATABASE_URL
 * (propriétaire, pour la fixture) ou TF_RLS_APP_URL (rôle soumis à la RLS),
 * sortie 2. Un test qui n'a pas tourné n'est pas un test qui passe.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const URL_PROPRIO = process.env.DATABASE_URL;
const URL_APP = process.env.TF_RLS_APP_URL;

if (!URL_PROPRIO || !URL_APP) {
  console.log('  NON EXECUTE — il manque DATABASE_URL et/ou TF_RLS_APP_URL.');
  console.log('  TF_RLS_APP_URL doit pointer un role SANS BYPASSRLS (ex. tracefab_app).');
  console.log('  Un test qui ne tourne pas ne vaut pas un test qui passe : sortie 2.');
  process.exit(2);
}

const cli = (u) => new pg.Client({
  connectionString: u,
  ssl: /sslmode=(require|verify-full|verify-ca)/.test(u) ? { rejectUnauthorized: false } : false,
});

let echecs = 0;
const ko = (m) => { console.log(`  ECHEC ${m}`); echecs += 1; };
const ok = (m) => console.log(`  ok    ${m}`);

const suffixe = randomUUID().slice(0, 8);
const userA = randomUUID(); const userB = randomUUID();
const orgA = randomUUID(); const orgB = randomUUID();
const supA = randomUUID(); const supB = randomUUID();
const prodA = randomUUID(); const prodB = randomUUID();

const proprio = cli(URL_PROPRIO);
await proprio.connect();
const app = cli(URL_APP);
await app.connect();

try {
  /* --- fixture : deux locataires porteurs de données (via le propriétaire) */
  await proprio.query(
    `insert into users (id, clerk_user_id, email, full_name) values
       ($1, $3, $4, 'Locataire A'), ($2, $5, $6, 'Locataire B')`,
    [userA, userB, `ct_a_${suffixe}`, `ct-a-${suffixe}@example.test`,
     `ct_b_${suffixe}`, `ct-b-${suffixe}@example.test`]);
  await proprio.query(
    `insert into organizations (id, type, legal_name, display_name, status, created_by) values
       ($1, 'brand', 'CrossTenant A', 'CT A', 'active', $3),
       ($2, 'brand', 'CrossTenant B', 'CT B', 'active', $4)`,
    [orgA, orgB, userA, userB]);
  await proprio.query(
    `insert into organization_memberships (organization_id, user_id, role, status) values
       ($1, $3, 'owner', 'active'), ($2, $4, 'owner', 'active')`,
    [orgA, orgB, userA, userB]);
  await proprio.query(
    'insert into suppliers (id, organization_id, onboarding_status) values ($1, $3, $5), ($2, $4, $5)',
    [supA, supB, orgA, orgB, 'in_progress']);
  await proprio.query(
    `insert into tracefab_products (id, brand_organization_id, reference, name, status) values
       ($1, $3, $5, 'Produit A', 'draft'), ($2, $4, $6, 'Produit B', 'draft')`,
    [prodA, prodB, orgA, orgB, `CTA-${suffixe}`, `CTB-${suffixe}`]);

  /* --- 1. le rôle de test est réellement soumis à la RLS ------------------- */
  const moi = await app.query(
    'select current_user as r, (select rolbypassrls from pg_roles where rolname = current_user) as bypass');
  if (moi.rows[0].bypass) {
    ko(`le role « ${moi.rows[0].r} » porte BYPASSRLS — le reste ne mesurerait rien`);
  } else {
    ok(`role de test « ${moi.rows[0].r} », BYPASSRLS=false`);
  }

  await app.query('begin');
  await app.query("select set_config('tracefab.user_id', $1, true)", [userA]);
  await app.query("select set_config('tracefab.user_email', $1, true)", [`ct-a-${suffixe}@example.test`]);

  // Une tentative refusée (RLS) avorte la transaction : savepoint avant
  // chaque écriture cross-org pour pouvoir continuer les assertions.
  const tenter = async (sql, params) => {
    await app.query('savepoint tentative');
    try {
      const r = await app.query(sql, params);
      await app.query('release savepoint tentative');
      return { rowCount: r.rowCount };
    } catch {
      await app.query('rollback to savepoint tentative');
      return { refuse: true };
    }
  };

  /* --- 2-4. SELECT -------------------------------------------------------- */
  const orgs = (await app.query('select id from organizations')).rows.map((r) => r.id);
  if (orgs.includes(orgA) && !orgs.includes(orgB)) ok('SELECT organizations : A voit la sienne, pas celle de B');
  else ko(`SELECT organizations : A voit [${orgs.join(', ')}]`);

  const sups = (await app.query('select id from suppliers')).rows.map((r) => r.id);
  if (sups.includes(supA) && !sups.includes(supB)) ok('SELECT suppliers : A voit le sien, pas celui de B');
  else ko(`SELECT suppliers : A voit [${sups.join(', ')}]`);

  const prods = (await app.query('select id from tracefab_products')).rows.map((r) => r.id);
  if (prods.includes(prodA) && !prods.includes(prodB)) ok('SELECT tracefab_products : A voit le sien, pas celui de B');
  else ko(`SELECT tracefab_products : A voit [${prods.join(', ')}]`);

  /* --- 5-6. INSERT cross-org ---------------------------------------------- */
  const insSup = await tenter(
    'insert into suppliers (id, organization_id) values ($1, $2)', [randomUUID(), orgB]);
  if (insSup.refuse) ok('INSERT suppliers chez B : refusé');
  else ko('INSERT suppliers chez B : accepté — frontière franchie en création');

  const insProd = await tenter(
    'insert into tracefab_products (id, brand_organization_id, reference, name, status) values ($1, $2, $3, $4, $5)',
    [randomUUID(), orgB, `CTX-${suffixe}`, 'Intrusion', 'draft']);
  if (insProd.refuse) ok('INSERT tracefab_products chez B : refusé');
  else ko('INSERT tracefab_products chez B : accepté — frontière franchie en création');

  /* --- 7-8. UPDATE cross-org ---------------------------------------------- */
  const updSup = await tenter(
    "update suppliers set onboarding_status = 'completed' where id = $1", [supB]);
  if (!updSup.refuse && updSup.rowCount === 0) ok('UPDATE suppliers chez B : 0 ligne touchée');
  else ko(`UPDATE suppliers chez B : ${updSup.refuse ? 'erreur inattendue' : `${updSup.rowCount} ligne(s) touchée(s)`}`);

  const updProd = await tenter(
    "update tracefab_products set name = 'Détourné' where id = $1", [prodB]);
  if (!updProd.refuse && updProd.rowCount === 0) ok('UPDATE tracefab_products chez B : 0 ligne touchée');
  else ko(`UPDATE tracefab_products chez B : ${updProd.refuse ? 'erreur inattendue' : `${updProd.rowCount} ligne(s) touchée(s)`}`);

  /* --- 9-10. DELETE cross-org ----------------------------------------------- */
  const delSup = await tenter('delete from suppliers where id = $1', [supB]);
  if (!delSup.refuse && delSup.rowCount === 0) ok('DELETE suppliers chez B : 0 ligne touchée');
  else ko(`DELETE suppliers chez B : ${delSup.refuse ? 'erreur inattendue' : `${delSup.rowCount} ligne(s) touchée(s)`}`);

  const delProd = await tenter('delete from tracefab_products where id = $1', [prodB]);
  if (!delProd.refuse && delProd.rowCount === 0) ok('DELETE tracefab_products chez B : 0 ligne touchée');
  else ko(`DELETE tracefab_products chez B : ${delProd.refuse ? 'erreur inattendue' : `${delProd.rowCount} ligne(s) touchée(s)`}`);

  /* --- 11-12. Fonctions SECURITY DEFINER ------------------------------------ */
  const accesB = (await app.query('select tracefab_can_access_org($1) as acces', [orgB])).rows[0].acces;
  if (accesB === false) ok('SECURITY DEFINER tracefab_can_access_org(B) = false pour A');
  else ko('SECURITY DEFINER tracefab_can_access_org(B) = true pour A — contournement possible');

  const accesA = (await app.query('select tracefab_can_access_org($1) as acces', [orgA])).rows[0].acces;
  if (accesA === true) ok('SECURITY DEFINER tracefab_can_access_org(A) = true pour A');
  else ko('SECURITY DEFINER tracefab_can_access_org(A) = false pour A — fonction cassée, pas seulement fermée');

  await app.query('rollback');
} finally {
  await proprio.query('delete from tracefab_products where id = any($1)', [[prodA, prodB]]).catch(() => {});
  await proprio.query('delete from suppliers where id = any($1)', [[supA, supB]]).catch(() => {});
  await proprio.query('delete from organizations where id = any($1)', [[orgA, orgB]]).catch(() => {});
  await proprio.query('delete from users where id = any($1)', [[userA, userB]]).catch(() => {});
  await app.end();
  await proprio.end();
}

console.log(echecs ? `\n  ${echecs} echec(s) — isolation inter-organisations non prouvée.` : '\n  12/12 assertions — isolation inter-organisations prouvée en lecture, écriture et fonctions.');
process.exit(echecs ? 1 : 0);
