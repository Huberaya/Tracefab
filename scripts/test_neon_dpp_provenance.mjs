/**
 * Preuve par execution — chantier 1A-C : les donnees DPP/Wallet ne sont plus
 * fictives.
 *
 * Ce test EST le critere de validation : « chaque donnee affichee dans un DPP
 * ou un Wallet est reliee a une source identifiable, ou clairement signalee
 * comme indisponible. Aucun fallback fictif ne peut etre confondu avec une
 * donnee reelle. »
 *
 * Il s'execute sur PostgreSQL avec le role runtime reel (`tracefab_app`, sans
 * BYPASSRLS), via le contexte public limite. Scenarios :
 *   P1 publie avec des donnees PARTIELLES (il manque pays, poids, sku,
 *      category, entretien) : chaque trou doit rendre un etat explicite, et
 *      surtout PAS les anciennes valeurs de substitution ;
 *   P2 actif + slug SANS etat publie (le cas du backfill de 20261009) : ne
 *      doit resoudre nulle part ;
 *   P3 brouillon : idem ;
 *   P4 publie mais vide : presentation 'empty', tous les champs en etat.
 *
 * Sortie 2 si la base n'est pas disponible : un test qui ne tourne pas ne
 * vaut pas un test qui passe.
 */
import assert from 'node:assert/strict';
import pg from 'pg';
import { createTestPrisma, injectPrismaSingleton } from './lib/test_prisma_client.mjs';

const URL_PROPRIO = process.env.DATABASE_URL;
const URL_APP = process.env.TF_RLS_APP_URL;

if (!URL_PROPRIO || !URL_APP) {
  console.error('  NON EXECUTE — il manque DATABASE_URL et/ou TF_RLS_APP_URL.');
  console.error('  TF_RLS_APP_URL doit pointer le role runtime reel (tracefab_app).');
  process.exit(2);
}

let echecs = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const ko = (m) => { console.log(`  ECHEC ${m}`); echecs += 1; };

/* ------------------------------------------------- fixtures (role proprietaire) */

const proprio = new pg.Client({ connectionString: URL_PROPRIO });
await proprio.connect();

const U = {
  org: '11111111-1111-4111-8111-111111111111',
  org2: '22222222-2222-4222-8222-222222222222',
  user: '33333333-3333-4333-8333-333333333333',
  p1: '44444444-4444-4444-8444-444444444444',
  p2: '55555555-5555-4555-8555-555555555555',
  p3: '66666666-6666-4666-8666-666666666666',
  p4: '77777777-7777-4777-8777-777777777777',
  matCoton: '88888888-8888-4888-8888-888888888888',
  matPoly: '99999999-9999-4999-8999-999999999999',
  dpp1: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  dpp4: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  site: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  node: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  pef: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
};

const { calculateGs1CheckDigit } = await import('../api/_lib/plm-erp/gtin-engine.ts');
const GTIN_PAYLOAD = '376012345678';
const GTIN = GTIN_PAYLOAD + calculateGs1CheckDigit(GTIN_PAYLOAD);

await proprio.query(`DELETE FROM dpp_records WHERE product_id = ANY($1)`, [[U.p1, U.p2, U.p3, U.p4]]);
await proprio.query(`DELETE FROM product_pef_assessments WHERE product_id = ANY($1)`, [[U.p1, U.p2, U.p3, U.p4]]);
await proprio.query(`DELETE FROM supply_chain_nodes WHERE product_id = ANY($1)`, [[U.p1, U.p2, U.p3, U.p4]]);
await proprio.query(`DELETE FROM product_identifiers WHERE product_id = ANY($1)`, [[U.p1, U.p2, U.p3, U.p4]]);
await proprio.query(`DELETE FROM product_materials WHERE product_id = ANY($1)`, [[U.p1, U.p2, U.p3, U.p4]]);
await proprio.query(`DELETE FROM tracefab_products WHERE id = ANY($1)`, [[U.p1, U.p2, U.p3, U.p4]]);
await proprio.query(`DELETE FROM materials WHERE id = ANY($1)`, [[U.matCoton, U.matPoly]]);
await proprio.query(`DELETE FROM supplier_sites WHERE id = $1`, [U.site]);
await proprio.query(`DELETE FROM organization_memberships WHERE user_id = $1`, [U.user]);
await proprio.query(`DELETE FROM users WHERE id = $1`, [U.user]);
await proprio.query(`DELETE FROM organizations WHERE id = ANY($1)`, [[U.org, U.org2]]);

await proprio.query(
  `INSERT INTO organizations (id, type, legal_name, display_name, country_code) VALUES
   ($1, 'brand', 'Maison Preuve SARL', 'Maison Preuve', 'FR'),
   ($2, 'brand', 'Autre Maison SARL', 'Autre Maison', 'PT')`,
  [U.org, U.org2]);
await proprio.query(
  `INSERT INTO users (id, clerk_user_id, email, full_name) VALUES ($1, 'clerk_preuve_c', 'c@preuve.test', 'Relectrice Preuve')`,
  [U.user]);
await proprio.query(
  `INSERT INTO organization_memberships (id, organization_id, user_id, role, status)
   VALUES ('ffffffff-ffff-4fff-8fff-ffffffffffff', $1, $2, 'owner', 'active')`,
  [U.org, U.user]);

// P1 : publie, donnees partielles — il manque VOLONTAIREMENT sku, category,
// pays de fabrication, poids, consignes d entretien.
await proprio.query(
  `INSERT INTO tracefab_products (id, brand_organization_id, reference, name, status, public_slug,
     country_of_design, care_instructions)
   VALUES ($1, $2, 'PRE-001', 'Chemise Preuve', 'active', 'pre-001', 'FR', '{}')`,
  [U.p1, U.org]);
await proprio.query(
  `INSERT INTO materials (id, owner_organization_id, material_type, name, normalized_name)
   VALUES ($1, $2, 'fiber', 'Coton', 'coton'), ($3, $2, 'fiber', 'Polyester', 'polyester')`,
  [U.matCoton, U.org, U.matPoly]);
await proprio.query(
  `INSERT INTO product_materials (product_id, material_id, material_role, percentage, unit)
   VALUES ($1, $2, 'shell', 60, 'percent'), ($1, $3, 'lining', 40, 'percent')`,
  [U.p1, U.matCoton, U.matPoly]);
await proprio.query(
  `INSERT INTO product_identifiers (id, product_id, identifier_type, identifier_value, is_primary)
   VALUES ('00000002-0000-4000-8000-000000000001', $1, 'gtin', $2, true)`,
  [U.p1, GTIN]);
// PEF declare (non verifie) — les valeurs sont celles-ci et PAS 78/B/3.42.
await proprio.query(
  `INSERT INTO product_pef_assessments (id, product_id, product_version, brand_organization_id,
     carbon_footprint_kg_co2e, water_scarcity_m3, circularity_score, pef_eco_score, pef_grade, status)
   VALUES ($1, $2, 1, $3, 1.23, 0.44, 61, 55, 'C', 'declared')`,
  [U.pef, U.p1, U.org]);
// Noeud de chaine de fabrication, declare (non verifie).
await proprio.query(
  `INSERT INTO supplier_sites (id, supplier_id, name, country_code)
   SELECT $1, s.id, 'Site Confection Preuve', 'TN' FROM suppliers s WHERE s.organization_id = $2 LIMIT 1`,
  [U.site, U.org]);
// Le trigger tracefab_validate_supply_chain_node impose EXACTEMENT une
// reference parmi (organization_id, supplier_site_id, product_id, material_id,
// process_code) : ce noeud porte donc le seul product_id.
await proprio.query(
  `INSERT INTO supply_chain_nodes (id, node_type, product_id, label, status)
   VALUES ($1, 'product', $2, 'Confection Preuve', 'declared')`,
  [U.node, U.p1]);
// Publication explicite : dpp_records publie et RELU, puis slug.
await proprio.query(
  `INSERT INTO dpp_records (id, product_id, product_version, requirement_profile_key,
     requirement_profile_version, readiness_status, reviewed_at, reviewed_by)
   VALUES ($1, $2, 1, 'espr-textile', '1', 'published', '2026-10-02', $3)`,
  [U.dpp1, U.p1, U.user]);

// P2 : actif + slug, SANS etat publie — le cas du backfill.
await proprio.query(
  `INSERT INTO tracefab_products (id, brand_organization_id, reference, name, status, public_slug)
   VALUES ($1, $2, 'PRE-002', 'Pantalon Backfill', 'active', 'pre-002')`,
  [U.p2, U.org]);
// P3 : brouillon, sans slug, MAIS avec un GTIN enregistre (ne doit pas resoudre).
await proprio.query(
  `INSERT INTO tracefab_products (id, brand_organization_id, reference, name, status)
   VALUES ($1, $2, 'PRE-003', 'Veste Brouillon', 'draft')`,
  [U.p3, U.org]);
await proprio.query(
  `INSERT INTO product_identifiers (id, product_id, identifier_type, identifier_value, is_primary)
   VALUES ('00000002-0000-4000-8000-000000000003', $1, 'gtin', $2, true)`,
  [U.p3, '400638133393' + calculateGs1CheckDigit('400638133393')]);
// P4 : publie mais entierement vide.
await proprio.query(
  `INSERT INTO tracefab_products (id, brand_organization_id, reference, name, status, public_slug)
   VALUES ($1, $2, 'PRE-004', 'Echarpe Vide', 'active', 'pre-004')`,
  [U.p4, U.org]);
await proprio.query(
  `INSERT INTO dpp_records (id, product_id, product_version, requirement_profile_key,
     requirement_profile_version, readiness_status, reviewed_at, reviewed_by)
   VALUES ($1, $2, 1, 'espr-textile', '1', 'published', '2026-10-02', $3)`,
  [U.dpp4, U.p4, U.user]);

console.log(`  fixtures en place (GTIN P1 = ${GTIN})`);

/* ------------------------------------------------- assertions (role runtime) */

// Ordre important : le singleton de api/_lib/prisma.js doit etre injecte
// AVANT tout import de l'API qui en depend (context.ts, routes).
const prisma = await createTestPrisma(URL_APP);
injectPrismaSingleton(prisma);

const { resolveDppPassData, resolveDppPassDataByGtin } = await import('../api/_lib/wallet/dpp-data-resolver.ts');
const { buildPassJson } = await import('../api/_lib/wallet/apple-pass-generator.ts');
const { generateGoogleWalletPass } = await import('../api/_lib/wallet/google-wallet-generator.ts');
const { withTracefabPublicContext } = await import('../api/_lib/context.ts');
const { fieldDisplay } = await import('../api/_lib/wallet/types.ts');


console.log('\n  A. resolution en contexte public — role sans BYPASSRLS');

const p1 = await withTracefabPublicContext((tx) => resolveDppPassData(tx, U.p1));
if (p1) ok('P1 (publie) resout en contexte public');
else { ko('P1 ne resout pas — la barriere de publication est trop forte ou le contexte manque'); }

if (p1) {
  const s = (champ) => champ && champ.status;
  const v = (champ) => champ && champ.value;

  assert.equal(v(p1.productName), 'Chemise Preuve'); assert.equal(s(p1.productName), 'sourced');
  assert.ok(p1.productName.source, 'productName porte sa source');
  assert.equal(s(p1.sku), 'not_filled');
  assert.equal(v(p1.gtin), GTIN);
  assert.equal(s(p1.category), 'not_filled');
  assert.equal(s(p1.countryOfManufacture), 'not_filled');
  assert.equal(v(p1.countryOfDesign), 'FR');
  assert.equal(s(p1.weightGrams), 'not_filled');
  ok('champs absents = etat « non renseigne », jamais une valeur par defaut');

  assert.equal(s(p1.composition), 'sourced');
  assert.ok(String(v(p1.composition)).includes('60% Coton'), 'composition issue des lignes reelles');
  assert.ok(String(v(p1.composition)).includes('40% Polyester'), 'composition issue des lignes reelles');
  assert.equal(p1.materials.length, 2);
  ok('composition = exactement les materiaux de la base');

  assert.equal(s(p1.supplyChainSummary), 'unverified');
  assert.ok(String(v(p1.supplyChainSummary)).includes('Confection Preuve'));
  ok('chaine de fabrication = noeuds reels, marquee « non verifie » (statut declared)');

  assert.equal(s(p1.pefScore), 'unverified');
  assert.equal(v(p1.pefScore), 55);
  assert.equal(v(p1.pefGrade), 'C');
  assert.equal(v(p1.carbonFootprintKgCo2e), 1.23);
  ok('PEF = evaluation reelle declaree, marquee « non verifie » — ni 78, ni B, ni 3.42');

  assert.equal(s(p1.careInstructions), 'not_filled');
  assert.equal(s(p1.recyclingInstructions), 'unavailable');
  assert.equal(v(p1.verificationDate), '2026-10-02');
  assert.equal(s(p1.transactionCertificateNumber), 'not_filled');
  assert.equal(v(p1.transactionCertificateNumber), null);
  ok('TC absent = « non renseigne » — aucun numero fabrique');

  assert.ok(String(v(p1.digitalLinkUri)).includes(GTIN), 'digital link derive du GTIN reel');
  assert.equal(v(p1.brandName), 'Maison Preuve');

  const empreinte = JSON.stringify(p1);
  const interdits = [
    '100% Coton peigné', 'Atelier Demo', 'Tracefab Brand', 'Filature ➔ Tissage',
    'TC-VERIFIED-MB', 'Machine wash', 'Single-material', '3.42', '250', 'PT',
    'Essentiel Coton', 'Régénératif', 'auditée',
  ];
  for (const interdit of interdits) {
    if (empreinte.includes(interdit)) ko(`substitution servie comme reelle : « ${interdit} »`);
  }
  ok('aucune des anciennes valeurs de substitution dans les donnees servies');

  // Cartes : les etats explicites y sont presents, les substitutions absentes.
  const carte = JSON.stringify(buildPassJson(p1)) + JSON.stringify(generateGoogleWalletPass(p1).passObject);
  if (carte.includes('Non renseigné') && carte.includes('Indisponible')) {
    ok('les cartes Apple/Google affichent les etats explicites');
  } else ko('les cartes n affichent pas les etats explicites attendus');
  for (const interdit of ['Coton peigné', 'Atelier Demo', 'ESPR CONFORME', 'Fibres certifiées', 'GOTS/GRS', 'auditée']) {
    if (carte.includes(interdit)) ko(`substitution servie dans les cartes : « ${interdit} »`);
  }
  ok('aucune substitution dans les cartes Apple/Google');

  assert.equal(fieldDisplay(p1.sku), 'Non renseigné');
  assert.equal(fieldDisplay(p1.weightGrams), 'Non renseigné');
  assert.equal(fieldDisplay(p1.recyclingInstructions), 'Indisponible');
  ok('fieldDisplay rend les libelles attendus');
}

console.log('\n  B. barriere de publication');

const p2 = await withTracefabPublicContext((tx) => resolveDppPassData(tx, U.p2));
if (p2 === null) ok('P2 (actif + slug, sans etat publie) ne resout pas');
else ko('P2 resout alors qu il n a pas d etat de publication explicite');

const p2slug = await withTracefabPublicContext((tx) => resolveDppPassData(tx, 'pre-002'));
if (p2slug === null) ok('P2 ne resout meme pas par son slug');
else ko('P2 resout par son slug sans etat publie');

const p3 = await withTracefabPublicContext((tx) => resolveDppPassData(tx, U.p3));
if (p3 === null) ok('P3 (brouillon) ne resout pas');
else ko('P3 (brouillon) resout');

const p3gtin = await withTracefabPublicContext((tx) => resolveDppPassDataByGtin(tx, '400638133393' + calculateGs1CheckDigit('400638133393')));
if (p3gtin === null) ok('le GTIN d un brouillon ne resout pas (pas de fiche par defaut)');
else ko('le GTIN d un brouillon resout');

console.log('\n  C. resolution GTIN stricte');

const parGtin = await withTracefabPublicContext((tx) => resolveDppPassDataByGtin(tx, GTIN));
if (parGtin && parGtin.productId === U.p1) ok('GTIN valide de produit publie : resolu');
else ko('GTIN valide de produit publie : non resolu');

const cleFausse = await withTracefabPublicContext((tx) => resolveDppPassDataByGtin(tx, '3760123456785'));
if (cleFausse === null) ok('GTIN invalide (cle modulo-10) : rejeté');
else ko('GTIN invalide resout malgre tout');

const inconnu = await withTracefabPublicContext((tx) => resolveDppPassDataByGtin(tx, '400638133393' + calculateGs1CheckDigit('400638133393')));
// Ce GTIN est celui de P3 (brouillon) : deja teste ci-dessus ; ici un autre.
const inconnu2 = await withTracefabPublicContext((tx) => resolveDppPassDataByGtin(tx, '123456789012' + calculateGs1CheckDigit('123456789012')));
if (inconnu2 === null) ok('GTIN valide mais inconnu : null, jamais une fiche de substitution');
else ko('GTIN inconnu renvoie une fiche');

console.log('\n  D. produit publie sans donnees : presentation honnete');

const p4 = await withTracefabPublicContext((tx) => resolveDppPassData(tx, U.p4));
if (!p4) ko('P4 (publie, vide) devrait resoudre');
else {
  assert.equal(p4.presentation.source, 'empty');
  assert.equal(s_(p4.composition), 'not_filled');
  assert.equal(s_(p4.pefScore), 'unavailable');
  assert.equal(s_(p4.supplyChainSummary), 'not_filled');
  if (JSON.stringify(p4).includes('Coton peigné')) ko('P4 vide contient des substitutions');
  else ok('P4 vide : presentation « empty », tous les champs en etat explicite, zero substitution');
}

function s_(champ) { return champ && champ.status; }

console.log('\n  E. routes Wallet consommateur et produit (handlers reels)');

function mockRes() {
  let statusCode = 200; const headers = {}; let body = null; let sent = false;
  return {
    status(c) { statusCode = c; return this; },
    setHeader(k, val) { headers[k.toLowerCase()] = val; return this; },
    getHeader(k) { return headers[k.toLowerCase()]; },
    send(d) { body = d; sent = true; return this; },
    json(d) { body = d; sent = true; return this; },
    end() { sent = true; return this; },
    get headersSent() { return sent; },
    get writableEnded() { return sent; },
    _get() { return { statusCode, headers, body }; },
  };
}
function mockReq({ url, query, headers = {} }) {
  return { method: 'GET', url, query, headers, socket: { remoteAddress: '127.0.0.1' } };
}

const appleConsumer = (await import('../api/_routes/dpp/[gtin]/apple-wallet.ts')).default;
const googleConsumer = (await import('../api/_routes/dpp/[gtin]/google-wallet.ts')).default;
const appleProduit = (await import('../api/_routes/products/[productId]/wallet/apple.ts')).default;
const googleProduit = (await import('../api/_routes/products/[productId]/wallet/google.ts')).default;
const dppRoute = (await import('../api/_routes/dpp/[gtin].ts')).default;

let res = mockRes();
await appleConsumer(mockReq({ url: `/api/dpp/${GTIN}/apple-wallet`, query: { gtin: GTIN } }), res);
if (res._get().statusCode === 200 && res._get().headers['content-type'] === 'application/vnd.apple.pkpass') {
  ok('route Apple consommateur par GTIN publie : 200 + pkpass');
} else ko(`route Apple consommateur par GTIN publie : ${res._get().statusCode}`);

res = mockRes();
await appleConsumer(mockReq({ url: '/api/dpp/3760123456789/apple-wallet', query: { gtin: '3760123456789' } }), res);
if (res._get().statusCode === 404) ok('l ancien GTIN demo 3760123456789 : 404 — plus de fiche « Atelier Demo »');
else ko(`GTIN demo : ${res._get().statusCode} au lieu de 404 — une fiche de substitution est servie`);

res = mockRes();
await appleConsumer(mockReq({ url: '/api/dpp/123/apple-wallet', query: { gtin: '123' } }), res);
if (res._get().statusCode === 404) ok('GTIN invalide : 404');
else ko(`GTIN invalide : ${res._get().statusCode}`);

res = mockRes();
await googleConsumer(mockReq({ url: `/api/dpp/${GTIN}/google-wallet`, query: { gtin: GTIN } }), res);
if (res._get().statusCode === 200) ok('route Google consommateur par GTIN publie : 200');
else ko(`route Google consommateur : ${res._get().statusCode}`);

res = mockRes();
await googleConsumer(mockReq({ url: '/api/dpp/3760123456789/google-wallet', query: { gtin: '3760123456789' } }), res);
if (res._get().statusCode === 404) ok('Google : GTIN demo = 404');
else ko(`Google : GTIN demo = ${res._get().statusCode}`);

res = mockRes();
await appleProduit(mockReq({ url: `/api/products/${U.p1}/wallet/apple`, query: { productId: U.p1 } }), res);
if (res._get().statusCode === 200) ok('route Apple par produit publie : 200');
else ko(`route Apple par produit publie : ${res._get().statusCode}`);

res = mockRes();
await appleProduit(mockReq({ url: `/api/products/${U.p2}/wallet/apple`, query: { productId: U.p2 } }), res);
if (res._get().statusCode === 404) ok('route Apple par produit sans etat publie : 404');
else ko(`route Apple par produit sans etat publie : ${res._get().statusCode}`);

res = mockRes();
await googleProduit(mockReq({ url: `/api/products/${U.p3}/wallet/google`, query: { productId: U.p3 } }), res);
if (res._get().statusCode === 404) ok('route Google par brouillon : 404');
else ko(`route Google par brouillon : ${res._get().statusCode}`);

res = mockRes();
await dppRoute(mockReq({ url: `/api/dpp/${GTIN}`, query: { gtin: GTIN } }), res);
const corps = res._get().body;
if (res._get().statusCode === 200 && corps && corps.dpp && corps.dpp.productId === U.p1) {
  ok('API /api/dpp/:gtin : 200, donnees du produit reel');
  if (corps.dpp.presentation && corps.dpp.presentation.source !== 'live') {
    ok(`presentation = '${corps.dpp.presentation.source}' (pas 'live' tant que des champs manquent)`);
  }
} else ko('API /api/dpp/:gtin inattendue');

/* ------------------------------------------------- resultat */

await prisma.$disconnect();
await proprio.end();

if (echecs) {
  console.log(`\n  ${echecs} echec(s).`);
  process.exit(1);
}
console.log('\nChaque donnee servie est sourcee ou explicitement absente. Aucune substitution.');
