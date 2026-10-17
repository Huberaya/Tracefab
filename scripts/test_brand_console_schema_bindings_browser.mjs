#!/usr/bin/env node
/**
 * Fiche produit Brand Console — le 504 de /api/schema-bindings ne doit plus
 * masquer la fiche. Reproduction navigateur de l'incident Production du
 * 2026-10-17 (tenant « Tracefab Recette Production »).
 *
 * POURQUOI CE TEST EXISTE
 *
 * Le 2026-10-17, cliquer « Ouvrir » sur un produit déclenchait
 * GET /api/schema-bindings?subjectType=product&subjectId=… → HTTP 504, et
 * openProduct() rejetait TOUT le chargement : la fiche restait invisible.
 * La cause racine était côté route : la branche GET ne renvoyait PAS de
 * réponse HTTP (tableau nu retourné au routeur central, qui ignore les valeurs
 * de retour), donc la passerelle timait en 504 sur chaque appel.
 *
 * Ce test prouve, en navigateur réel (page réelle, vrai JavaScript applicatif,
 * seules les réponses HTTP sont simulées au niveau du réseau), que :
 *
 *   1. UN 504 de schema-bindings n'empêche plus la fiche de s'afficher :
 *      panneau « état dégradé » explicite, code d'erreur apparent (rien n'est
 *      masqué ni transformé en « aucune liaison »), et bouton « Réessayer ».
 *   2. Le réessai refait VRAIMENT la requête : tant que la route répond 504,
 *      l'état dégradé persiste ; dès qu'elle répond, le panneau passe à
 *      l'état chargé — le bouton n'est pas décoratif.
 *   3. Succès réel : la route répond { bindings: […] } et la fiche affiche
 *      les liaisons, sans aucun état dégradé.
 *   4. Contrôle multi-tenant : deux organisations, deux produits. Chaque
 *      fiche interroge SON subjectId et n'affiche QUE les liaisons de SON
 *      locataire — l'état d'un locataire ne fuit pas sur l'autre. Le jeton
 *      Clerk est bien porté par l'appel (le cloisonnement réel est appliqué
 *      par la RLS côté serveur, prouvé par scripts/test_neon_cross_tenant.mjs).
 *   5. « Corriger dans Produits » (DPP) ouvre la fiche du produit visé,
 *      et non plus le simple catalogue.
 *
 * Usage : node scripts/run_browser_test.mjs scripts/test_brand_console_schema_bindings_browser.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { launchTestBrowser } from './lib/launch_chromium.mjs';

const port = 4179;
// On sert via dev_static_server.mjs, seul serveur local qui applique les
// reecritures de vercel.json : le routage teste est celui de production.
const server = spawn(process.execPath, ['scripts/dev_static_server.mjs', '--port', String(port)], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});

/* ------------------------------------------------------------- fixtures */
// Deux locataires reels : le tenant de recette production et un second, pour
// le controle multi-tenant. Les UUID respectent le format attendu par la
// validation d'entree de la route (isUuid).
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const PROD_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const PROD_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const USER_ID = '99999999-9999-4999-8999-999999999999';
const CLERK_TOKEN = 'recette-production-test-token';

const org = (id, legal, display) => ({ id, type: 'brand', legal_name: legal, display_name: display, status: 'active' });
const membership = (o) => ({ organization_id: o.id, role: 'owner', status: 'active', organizations: o });

const product = (id, orgId, reference, name) => ({
  id,
  brandOrganizationId: orgId,
  reference,
  sku: null,
  name,
  category: 'shirt',
  status: 'draft',
  version: 1,
  publicSlug: null,
  createdBy: USER_ID,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  description: null,
  productFamily: null,
  colorName: null,
  sizeRange: [],
  countryOfDesign: null,
  countryOfManufacture: null,
  weightGrams: null,
  careInstructions: null,
  dataReadiness: 'in_progress',
  dataCompletion: '10',
  dataReadyAt: null,
  lastDataUpdatedBy: null,
});

const PRODUCTS = [
  product(PROD_A, ORG_A, 'TF-RP-001', 'Chemise Recette Production'),
  product(PROD_B, ORG_B, 'TF-RS-002', 'Tee-shirt Second Tenant'),
];

const productDetail = (p) => ({ product: p, identifiers: [], materials: [] });

// Liaisons par locataire : A en porte deux, B une seule, avec des cles
// distinctes — pour prouver qu'aucune liste ne recouvre l'autre.
const BINDINGS_A = [
  { id: '33333333-3333-4333-8333-333333333331', schemaKey: 'product-data-core', schemaVersion: '1.0', subjectType: 'product', subjectId: PROD_A, boundBy: USER_ID, createdAt: '2026-10-02T10:00:00.000Z' },
  { id: '33333333-3333-4333-8333-333333333332', schemaKey: 'gs1-product', schemaVersion: '2.0', subjectType: 'product', subjectId: PROD_A, boundBy: USER_ID, createdAt: '2026-10-03T10:00:00.000Z' },
];
const BINDINGS_B = [
  { id: '44444444-4444-4444-8444-444444444441', schemaKey: 'other-tenant-schema', schemaVersion: '9.9', subjectType: 'product', subjectId: PROD_B, boundBy: USER_ID, createdAt: '2026-10-04T10:00:00.000Z' },
];

const DPP_PORTFOLIO = {
  status: 'ok',
  scoreIsReadinessIndicatorOnly: true,
  profileKey: 'textile_readiness_mvp',
  profileVersion: '1.0',
  totalProducts: 2,
  computedProducts: 2,
  uncomputedProducts: 0,
  blockedProducts: 1,
  readinessScore: 55.6,
  statusCounts: { in_progress: 2 },
  gaps: [
    {
      key: 'product.description',
      label: 'Description détaillée (min. 30 caractères)',
      blocking: true,
      products: [{ id: PROD_A, reference: 'TF-RP-001', name: 'Chemise Recette Production' }],
      productCount: 1,
    },
  ],
  lastComputedAt: '2026-10-10T08:00:00.000Z',
};

const DPP_PRODUCT = {
  dpp: {
    id: null,
    productId: PROD_A,
    productVersion: 1,
    profileKey: 'textile_readiness_mvp',
    profileVersion: '1.0',
    readinessStatus: 'in_progress',
    statusLabel: 'Données incomplètes',
    completionScore: 77,
    totalRequirements: 9,
    metRequirements: 7,
    blockingCount: 1,
    missingFields: [
      { key: 'product.description', label: 'Description détaillée (min. 30 caractères)', blocking: true },
      { key: 'product.category', label: 'Catégorie textile définie', blocking: false },
    ],
    blockingIssues: [
      { key: 'product.description', label: 'Description détaillée (min. 30 caractères)', reason: 'missing' },
    ],
    pillars: {},
    canMarkReadyToPublish: false,
    isReadyToPublish: false,
    computedAt: '2026-10-10T08:00:00.000Z',
    reviewedAt: null,
    reviewedBy: null,
    inputFingerprint: null,
  },
};

/* ------------------------------------------------- reseau simule (fetch) */
/**
 * Installe l'ensemble des interceptions reseau de la session recette.
 *
 * `schemaBindings` est un objet mutable : { mode: 'ok' | '504' } — le test le
 * fait basculer pour prouver que le bouton « Réessayer » refait la requete.
 * Chaque appel a /api/schema-bindings est journalise (URL + presence du jeton)
 * pour les assertions multi-tenant.
 */
function installNetwork(page, schemaBindings) {
  const json = (route, status, body) => route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  });

  return Promise.all([
    page.route('**/api/config', (route) => json(route, 200, {
      publishableKey: `pk_live_${Buffer.from('clerk.tracefab.example$').toString('base64')}`,
      proxyUrl: `http://127.0.0.1:${port}/__clerk`,
    })),
    page.route('https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js', (route) => route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
        window.Clerk = {
          status: 'loading',
          user: { id: 'user_recette', firstName: 'Recette', lastName: 'Production' },
          session: { getToken: async () => ${JSON.stringify(CLERK_TOKEN)} },
          async load() {
            const script = document.querySelector('script[data-clerk-publishable-key]');
            const proxyUrl = script && script.getAttribute('data-clerk-proxy-url');
            if (proxyUrl !== ${JSON.stringify(`http://127.0.0.1:${port}/__clerk`)}) throw new Error('clerk_proxy_url_not_configured');
            const response = await fetch(proxyUrl + '/v1/client?__clerk_api_version=2026-08-01');
            if (!response.ok) throw new Error('clerk_proxy_request_failed');
            this.status = 'ready';
          },
          addListener() {},
          mountSignIn() {},
        };`,
    })),
    page.route(`http://127.0.0.1:${port}/__clerk/**`, (route) => json(route, 200, { client: {} })),
    page.route('**/api/me', (route) => json(route, 200, {
      user: { id: USER_ID, clerkUserId: 'user_recette', email: 'recette@example.test', fullName: 'Recette Production' },
      memberships: [membership(org(ORG_A, 'Tracefab Recette Production', 'Tracefab Recette Production')), membership(org(ORG_B, 'Second Tenant', 'Second Tenant'))],
    })),
    page.route('**/api/organizations', (route) => json(route, 200, {
      organizations: [membership(org(ORG_A, 'Tracefab Recette Production', 'Tracefab Recette Production')), membership(org(ORG_B, 'Second Tenant', 'Second Tenant'))],
    })),
    page.route('**/api/suppliers', (route) => json(route, 200, { suppliers: [] })),
    page.route('**/api/materials', (route) => json(route, 200, { materials: [] })),
    page.route('**/api/data-requests', (route) => json(route, 200, { requests: [] })),
    page.route('**/api/questionnaires', (route) => json(route, 200, { questionnaires: [] })),
    page.route('**/api/catalog/schemas**', (route) => json(route, 200, {
      schemas: [{ key: 'product-data-core', version: '1.0', title: 'Product data core', subjectTypes: ['product', 'data_request'] }],
    })),
    page.route('**/api/mass-balance/certificates', (route) => json(route, 200, { certificates: [] })),
    page.route('**/api/dpp/portfolio**', (route) => json(route, 200, DPP_PORTFOLIO)),
    // Une seule interception pour /api/products/** : le detail produit et son
    // DPP partagent le meme prefixe, et deux motifs distincts rendraient le
    // resultat dependant de l'ordre d'enregistrement des routes Playwright.
    // Le dispatch se fait sur le chemin reellement demande.
    page.route('**/api/products/**', (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const segments = pathname.replace(/^\/api\/products\/?/, '').split('/').filter(Boolean);
      if (segments.length === 2 && segments[1] === 'dpp') {
        return json(route, 200, DPP_PRODUCT);
      }
      if (segments.length === 1) {
        const found = PRODUCTS.find((p) => p.id === segments[0]);
        if (!found) return json(route, 404, { error: 'product_not_found' });
        return json(route, 200, productDetail(found));
      }
      return json(route, 404, { error: 'route_not_found' });
    }),
    page.route('**/api/products', (route) => json(route, 200, { products: PRODUCTS })),
    page.route('**/api/schema-bindings**', (route) => {
      const url = new URL(route.request().url());
      schemaBindings.requests.push({
        subjectType: url.searchParams.get('subjectType'),
        subjectId: url.searchParams.get('subjectId'),
        authorized: route.request().headers().authorization === `Bearer ${CLERK_TOKEN}`,
      });
      if (schemaBindings.mode === '504') {
        // La reponse d'une passerelle qui timeout : 504 sans corps JSON
        // exploitable — le client remonte alors request_failed_504, exactement
        // le code observe sur l'incident Production.
        return route.fulfill({ status: 504, contentType: 'text/plain', body: 'Gateway Timeout' });
      }
      const subjectId = url.searchParams.get('subjectId');
      const bindings = subjectId === PROD_A ? BINDINGS_A : subjectId === PROD_B ? BINDINGS_B : [];
      return json(route, 200, { bindings });
    }),
  ]);
}

const openProductFromCatalogue = async (page, productId) => {
  await page.locator('button[data-view="products"]').first().click();
  await page.locator(`[data-product-id="${productId}"]`).first().waitFor();
  await page.locator(`[data-product-id="${productId}"]`).first().click();
};

try {
  await delay(350);
  const browser = await launchTestBrowser();

  /* =====================================================================
   * 1. REPRODUCTION DU 504 — la fiche reste consultable, etat degrade.
   * =================================================================== */
  {
    const schemaBindings = { mode: '504', requests: [] };
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await installNetwork(page, schemaBindings);
    await page.goto(`http://127.0.0.1:${port}/brand-console/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.tracefabBrandConsole?.state.demo === false && window.tracefabBrandConsole?.state.loading === false);

    await openProductFromCatalogue(page, PROD_A);

    // La fiche ESSENTIELLE est visible : titre, formulaire technique.
    await page.getByRole('heading', { name: 'Chemise Recette Production' }).waitFor();
    await page.locator('#product-detail-form').waitFor();

    // Le panneau auxiliaire est en etat degrade EXPLICITE, avec le code
    // d'erreur apparent (l'erreur n'est ni masquee ni maquillee).
    await page.locator('[data-schema-panel="degraded"]').waitFor();
    const degradedText = await page.locator('[data-schema-panel="degraded"]').innerText();
    assert.match(degradedText, /request_failed_504/, "l'etat degrade doit exposer le code d'erreur HTTP");
    // Le bouton de reessai est present dans l'etat degrade.
    await page.locator('[data-schema-panel="degraded"] [data-action="retry-schema-bindings"]').waitFor();
    assert.equal(schemaBindings.requests.length, 1, 'un seul appel schema-bindings a l ouverture');

    // Reessai alors que la route repond toujours 504 : l'erreur persiste
    // honnetement, et la requete a bien ete refaite.
    await page.locator('[data-schema-panel="degraded"] [data-action="retry-schema-bindings"]').click();
    await page.locator('[data-schema-panel="degraded"]').waitFor();
    assert.equal(schemaBindings.requests.length, 2, 'le bouton Reessayer doit refaire la requete');
    assert.match(await page.locator('[data-schema-panel="degraded"]').innerText(), /request_failed_504/);

    // La route retablie : le meme bouton fait passer au panneau charge.
    schemaBindings.mode = 'ok';
    await page.locator('[data-schema-panel="degraded"] [data-action="retry-schema-bindings"]').click();
    await page.locator('[data-schema-panel="loaded"]').waitFor();
    const loadedText = await page.locator('[data-schema-panel="loaded"]').innerText();
    assert.match(loadedText, /product-data-core/, 'la liaison doit apparaitre apres retablissement');
    assert.doesNotMatch(loadedText, /request_failed_504/);
    assert.equal(errors.length, 0, `aucune erreur JS attendue : ${errors[0] || ''}`);
    await page.close();
    console.log('  ok    504 schema-bindings : fiche consultable, etat degrade explicite, reessai effectif');
  }

  /* =====================================================================
   * 2. SUCCES REEL — la route repond, les liaisons s'affichent.
   * =================================================================== */
  {
    const schemaBindings = { mode: 'ok', requests: [] };
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await installNetwork(page, schemaBindings);
    await page.goto(`http://127.0.0.1:${port}/brand-console/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.tracefabBrandConsole?.state.demo === false && window.tracefabBrandConsole?.state.loading === false);

    await openProductFromCatalogue(page, PROD_A);

    await page.locator('[data-schema-panel="loaded"]').waitFor();
    assert.equal(await page.locator('[data-schema-panel="degraded"]').count(), 0, 'aucun etat degrade au succes');
    const panel = await page.locator('[data-schema-panel="loaded"]').innerText();
    assert.match(panel, /product-data-core/);
    assert.match(panel, /gs1-product/);
    assert.equal(await page.locator('[data-schema-panel="loaded"] [data-schema-binding]').count(), 2, 'les deux liaisons du locataire A sont listees');

    // Contrat de la requete : subjectType/subjectId corrects, jeton Clerk porte.
    assert.equal(schemaBindings.requests.length, 1);
    assert.equal(schemaBindings.requests[0].subjectType, 'product');
    assert.equal(schemaBindings.requests[0].subjectId, PROD_A);
    assert.equal(schemaBindings.requests[0].authorized, true, 'le jeton Clerk doit accompagner l appel');
    assert.equal(errors.length, 0, `aucune erreur JS attendue : ${errors[0] || ''}`);
    await page.close();
    console.log('  ok    succes reel : liaisons affichees, requete conforme, jeton Clerk porte');
  }

  /* =====================================================================
   * 3. CONTROLE MULTI-TENANT — chaque fiche ne voit que SON locataire.
   * =================================================================== */
  {
    const schemaBindings = { mode: 'ok', requests: [] };
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await installNetwork(page, schemaBindings);
    await page.goto(`http://127.0.0.1:${port}/brand-console/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.tracefabBrandConsole?.state.demo === false && window.tracefabBrandConsole?.state.loading === false);

    // Locataire A d'abord.
    await openProductFromCatalogue(page, PROD_A);
    await page.locator('[data-schema-panel="loaded"]').waitFor();
    let panelA = await page.locator('[data-schema-panel="loaded"]').innerText();
    assert.match(panelA, /product-data-core/);
    assert.doesNotMatch(panelA, /other-tenant-schema/, 'aucune liaison du locataire B sur la fiche A');

    // Puis le locataire B, depuis le catalogue : l'etat du locataire A ne
    // doit pas rester affiche ni fuiter sur la nouvelle fiche.
    await openProductFromCatalogue(page, PROD_B);
    await page.getByRole('heading', { name: 'Tee-shirt Second Tenant' }).waitFor();
    await page.locator('[data-schema-panel="loaded"]').waitFor();
    const panelB = await page.locator('[data-schema-panel="loaded"]').innerText();
    assert.match(panelB, /other-tenant-schema/);
    assert.doesNotMatch(panelB, /product-data-core/, 'aucune liaison du locataire A sur la fiche B');
    assert.doesNotMatch(panelB, /gs1-product/);

    // Deux appels distincts, chacun avec SON subjectId.
    assert.deepEqual(
      schemaBindings.requests.map((r) => r.subjectId),
      [PROD_A, PROD_B],
      'chaque fiche doit interroger son propre subjectId',
    );
    assert.ok(schemaBindings.requests.every((r) => r.authorized), 'chaque appel porte le jeton Clerk');

    // L'etat degrade du locataire B ne doit pas non plus le rester apres
    // retour vers le locataire A (retablissement du mode ok implicite).
    await openProductFromCatalogue(page, PROD_A);
    await page.getByRole('heading', { name: 'Chemise Recette Production' }).waitFor();
    await page.locator('[data-schema-panel="loaded"]').waitFor();
    panelA = await page.locator('[data-schema-panel="loaded"]').innerText();
    assert.match(panelA, /product-data-core/);
    assert.equal(errors.length, 0, `aucune erreur JS attendue : ${errors[0] || ''}`);
    await page.close();
    console.log('  ok    controle multi-tenant : subjectId par fiche, aucune fuite entre locataires');
  }

  /* =====================================================================
   * 4. « CORRIGER DANS PRODUITS » — la fiche visee s'ouvre.
   * =================================================================== */
  {
    const schemaBindings = { mode: 'ok', requests: [] };
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await installNetwork(page, schemaBindings);
    await page.goto(`http://127.0.0.1:${port}/brand-console/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.tracefabBrandConsole?.state.demo === false && window.tracefabBrandConsole?.state.loading === false);

    // a) Depuis le PORTFEUILLE DPP : l'ecart porte sur le produit A, le
    // bouton doit ouvrir SA fiche — pas le catalogue.
    await page.locator('button[data-view="dpp"]').click();
    await page.locator('.dp-gap').waitFor();
    const portfolioButton = page.locator('[data-action="dp-resolve"][data-dp-target="products"]').first();
    await portfolioButton.waitFor();
    assert.equal(await portfolioButton.getAttribute('data-dp-product'), PROD_A, 'le bouton du portefeuille doit cibler le produit concerne');
    await portfolioButton.click();
    await page.getByRole('heading', { name: 'Chemise Recette Production' }).waitFor();
    await page.locator('#product-detail-form').waitFor();
    assert.equal(await page.evaluate(() => window.tracefabBrandConsole.state.view), 'productDetail', 'la vue doit etre la fiche produit, pas le catalogue');

    // b) Depuis la fiche DPP du produit (missingFields) : meme promesse.
    await page.locator('button[data-view="dpp"]').click();
    await page.locator('.dp-gap').waitFor();
    await page.locator('#dpp-product-select').selectOption(PROD_A);
    await page.locator('[data-action="dp-resolve"][data-dp-target="products"]').first().waitFor();
    await page.locator('[data-action="dp-resolve"][data-dp-target="products"]').first().click();
    await page.getByRole('heading', { name: 'Chemise Recette Production' }).waitFor();
    await page.locator('#product-detail-form').waitFor();
    assert.equal(await page.evaluate(() => window.tracefabBrandConsole.state.view), 'productDetail');
    assert.equal(errors.length, 0, `aucune erreur JS attendue : ${errors[0] || ''}`);
    await page.close();
    console.log('  ok    Corriger dans Produits : la fiche visee s ouvre (portefeuille et fiche DPP)');
  }

  // Product edit contract: real application, network fixtures only (no production writes).
  {
    const page = await browser.newPage();
    await installNetwork(page, { mode: 'ok', requests: [] });
    const patches = [];
    let reject = false;
    await page.route(`**/api/products/${PROD_A}`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      const body = route.request().postDataJSON();
      patches.push(body);
      if (reject) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_product_field', field: 'countryOfManufacture', message: 'countryOfManufacture : Code pays ISO-2 valide attendu (ex. FR).' }) });
      Object.assign(PRODUCTS[0], body);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(productDetail(PRODUCTS[0])) });
    });
    await page.goto(`http://127.0.0.1:${port}/brand-console/`);
    await page.waitForFunction(() => window.tracefabBrandConsole?.state.loading === false);
    await openProductFromCatalogue(page, PROD_A);
    const form = page.locator('#product-detail-form');
    await form.waitFor();
    assert.equal(await form.locator('[name="countryOfSpinning"]').count(), 0);
    for (const key of ['description', 'countryOfManufacture', 'colorName', 'weightGrams']) assert.equal(await form.locator(`[name="${key}"]`).inputValue(), '');
    assert.equal(await page.locator('[data-tf-demo]').count(), 0);
    const description = 'Une description détaillée du produit réel, sans données de démonstration.';
    await form.locator('[name="description"]').fill(description);
    await form.locator('[type="submit"]').click();
    await page.waitForFunction((text) => window.tracefabBrandConsole.state.selectedProductDetail.product.description === text && !window.tracefabBrandConsole.state.loading, description);
    assert.deepEqual(patches[0], { description });
    await form.locator('[name="countryOfManufacture"]').fill('fr');
    await form.locator('[type="submit"]').click();
    await page.waitForFunction(() => window.tracefabBrandConsole.state.selectedProductDetail.product.countryOfManufacture === 'FR' && !window.tracefabBrandConsole.state.loading);
    assert.deepEqual(patches[1], { countryOfManufacture: 'FR' });
    assert.equal(PRODUCTS[0].colorName, null);
    assert.equal(PRODUCTS[0].weightGrams, null);
    assert.equal(PRODUCTS[0].countryOfDesign, null);
    reject = true;
    await form.locator('[name="countryOfManufacture"]').fill('ZZ');
    await form.locator('[type="submit"]').click();
    await page.locator('#product-field-error').filter({ hasText: 'ISO-2 valide' }).waitFor();
    assert.equal(await form.locator('[name="description"]').inputValue(), description, 'failed save preserves edits');
    await page.close();
    console.log('  ok    product edit: description-only, country-only, no demo defaults, nulls preserved, explicit field error');
  }

  await browser.close();
  console.log('Brand Console schema-bindings browser suite passed: 504 degrade + retry, succes reel, controle multi-tenant, Corriger-dans-Produits');
} finally {
  server.kill('SIGTERM');
}
