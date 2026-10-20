import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { launchTestBrowser } from './lib/launch_chromium.mjs';

/**
 * Brand Console — un tenant reel vide ne doit jamais ressembler a la demo.
 *
 * Le test monte trois situations :
 *
 *   1. tenant reel vide  : toutes les routes repondent vide. Chaque
 *      indicateur doit valoir 0, « inconnu » ou « non calcule » selon sa
 *      semantique — jamais un chiffre de demonstration. La verification
 *      parcourt toutes les vues du routeur, pas seulement celles que
 *      quelqu'un a pense a lister.
 *   2. mode demonstration : ?demo=1 affiche les chiffres de demo, et ils sont
 *      declares par le bandeau et les marqueurs [data-tf-demo].
 *   3. panne d'API       : une route en erreur laisse l'ecran en erreur de
 *      configuration, sans repli silencieux sur le jeu de demonstration.
 *
 * Le test est fail-closed : toute route non declaree fait echouer la page.
 */

const port = 4174;
const base = `http://127.0.0.1:${port}`;
const ORG_ID = '11111111-1111-4111-8111-111111111111';

const server = spawn(process.execPath, ['scripts/dev_static_server.mjs', '--port', String(port)], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});

const EMPTY_TENANT = {
  '/api/me': {
    user: { id: 'user_test', fullName: 'Test Owner', email: 'owner@example.com' },
    memberships: [{
      organization_id: ORG_ID,
      role: 'owner',
      organizations: {
        id: ORG_ID,
        type: 'brand',
        display_name: 'Empty Brand',
        legal_name: 'Empty Brand SAS',
        country_code: 'FR',
        status: 'active',
      },
    }],
  },
  '/api/organizations': {
    organizations: [{
      id: ORG_ID,
      type: 'brand',
      display_name: 'Empty Brand',
      legal_name: 'Empty Brand SAS',
      country_code: 'FR',
      status: 'active',
    }],
  },
  '/api/suppliers': { suppliers: [] },
  '/api/materials': { materials: [] },
  '/api/products': { products: [], nextCursor: null },
  '/api/data-requests': { requests: [] },
  '/api/questionnaires': { questionnaires: [] },
  '/api/catalog/schemas': { schemas: [] },
  '/api/mass-balance/certificates': { certificates: [], count: 0 },
  '/api/dpp/portfolio': {
    profileKey: 'textile_readiness_mvp',
    profileVersion: '1.0',
    totalProducts: 0,
    computedProducts: 0,
    uncomputedProducts: 0,
    blockedProducts: 0,
    readinessScore: 0,
    statusCounts: {},
    gaps: [],
    lastComputedAt: null,
    scoreIsReadinessIndicatorOnly: true,
  },
};

// Chiffres et libelles qui n'existent que dans le jeu de demonstration.
// « CIRPASS » en est absent : le mot apparait dans la copie reelle de la vue
// Intelligence. Le badge de demo, lui, est verifie a part sur la vue d'ensemble.
const DEMO_MARKERS = ['1,248', '98.4', '97.6', '1,098', 'Tier 3', 'GRADE A', 'ISO 22095', 'Atelier Demo'];

const CLERK_STUB = `window.Clerk = {
  status: 'ready',
  user: { id: 'user_test', fullName: 'Test Owner', primaryEmailAddress: { emailAddress: 'owner@example.com' } },
  session: { tokenCalls: 0, async getToken() { this.tokenCalls += 1; return 'test-token'; } },
  async load() { this.status = 'ready'; },
  addListener() {},
  mountSignIn(element) { element.dataset.clerkMounted = 'true'; },
};`;

function routeKey(url) {
  return new URL(url).pathname;
}

async function stubClerk(page) {
  await page.route('**/api/config', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ publishableKey: 'pk_test_ZW1wdHkudGVuYW50JA==', proxyUrl: `${base}/__clerk` }),
  }));
  await page.route('https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js', (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: CLERK_STUB,
  }));
}

async function stubEmptyTenant(page, overrides = {}) {
  const seen = new Set();
  const unexpected = [];
  const materialWrites = [];
  const nodeWrites = [];
  const linkWrites = [];
  await page.route('**/api/**', (route) => {
    const key = routeKey(route.request().url());
    if (key === '/api/config') return route.fallback();
    seen.add(key);
    if (key === '/api/materials' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      materialWrites.push({ body, tenant: route.request().headers()['x-tracefab-organization-id'] });
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ material: { id: 'material-created', ...body, createdAt: new Date().toISOString() } }),
      });
    }
    if (/^\/api\/products\/[^/]+\/supply-chain\/nodes$/.test(key) && route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      nodeWrites.push({ body, tenant: route.request().headers()['x-tracefab-organization-id'] });
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ node: { id: nodeWrites.length === 1 ? '22222222-2222-4222-8222-222222222222' : '44444444-4444-4444-8444-444444444444', node_type: body.nodeType, label: body.label, process_code: body.processCode, status: 'declared' } }),
      });
    }
    if (/^\/api\/products\/[^/]+\/supply-chain\/links$/.test(key) && route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      linkWrites.push({ body, tenant: route.request().headers()['x-tracefab-organization-id'] });
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ link: { id: '55555555-5555-4555-8555-555555555555', source_node_id: body.sourceNodeId, target_node_id: body.targetNodeId, link_type: body.linkType, status: 'declared' } }),
      });
    }
    const override = overrides[key];
    if (override) return route.fulfill({
      status: override.status || 200,
      contentType: 'application/json',
      body: JSON.stringify(override.body ?? {}),
    });
    // Fail-closed : une route que ce test ne connait pas fait echouer le
    // scenario au lieu de laisser le navigateur appeler un vrai backend.
    const body = EMPTY_TENANT[key];
    if (!body) {
      unexpected.push(key);
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: `unexpected_route_${key}` }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return { seen, unexpected, materialWrites, nodeWrites, linkWrites };
}

async function openConsole(browser, path, overrides = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await stubClerk(page);
  const state = await stubEmptyTenant(page, overrides);
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
  return { page, ...state };
}

async function appText(page) {
  return page.locator('#app').innerText();
}

try {
  await delay(400);
  const browser = await launchTestBrowser();

  /* ---------------------------------------------------------------
     1. Tenant reel vide : aucun chiffre de demonstration.
     --------------------------------------------------------------- */
  const { page, unexpected, materialWrites } = await openConsole(browser, '/brand-console/?lang=en');
  await page.waitForFunction(() => window.tracefabBrandConsole?.state?.loading === false);
  await page.locator('h1.mc-headline').waitFor();

  // Une route que le test ne connait pas doit se voir tout de suite : sinon le
  // scenario echouerait plus loin sur un symptome au lieu de la cause.
  assert.deepEqual(unexpected, [], `routes non prevues par le test : ${unexpected.join(', ')}`);

  assert.equal(await page.evaluate(() => window.tracefabBrandConsole.state.demo), false);
  assert.equal(await page.evaluate(() => window.Clerk.session.tokenCalls), 1, 'les appels initiaux doivent partager une seule résolution du jeton Clerk');
  assert.equal(await page.locator('.demo-banner').count(), 0, 'aucun bandeau demo hors ?demo=1');
  assert.equal(await page.locator('[data-tf-demo]').count(), 0, 'aucun marqueur demo hors ?demo=1');

  const emptyText = await appText(page);
  for (const marker of DEMO_MARKERS) {
    assert.ok(!emptyText.includes(marker), `chiffre de demonstration visible sur un tenant vide : ${marker}`);
  }
  assert.ok(!emptyText.includes('CIRPASS 1.2'), 'le badge CIRPASS de la demo ne doit pas apparaitre hors demo');

  // Chaque indicateur sans source reelle se dit, au lieu de valoir zero ou un
  // chiffre de vitrine. Les libelles viennent du catalogue anglais.
  const indicateur = (label) => page.locator('.mc-stat-subitem', { hasText: label }).first().innerText();
  for (const label of [
    'Average product completeness',
    'Fibre-to-garment lineage',
    'Mass balance reconciled',
    'AGEC Art. 13 compliance',
    'PEF calculations validated',
    'DPP readiness',
  ]) {
    assert.match(await indicateur(label), /Not computed/, `${label} doit valoir « non calcule »`);
  }
  // GS1 n'a aucune route de resolution en lot : la valeur est inconnue, pas 0.
  assert.match(await indicateur('GS1 resolution active'), /Unknown/, 'GS1 doit valoir « inconnu »');
  // Un tenant sans fournisseur a zero site et zero certificat, pas « inconnu ».
  assert.match(await indicateur('Audited sites & facilities'), /0/, 'zero site doit etre mesure');
  assert.match(await indicateur('Certificates on record'), /0/, 'aucun certificat doit etre compte');

  // Quatre pastilles d'attention, toutes a zero.
  const pastilles = await page.locator('.mc-attention-num').allInnerTexts();
  assert.equal(pastilles.length, 4);
  assert.ok(pastilles.every((t) => t.trim() === '0'), `pastilles attendues a 0 : ${pastilles.join('|')}`);

  // Le CTA matière doit exécuter la vraie API dans un tenant réel. Il ne doit
  // jamais tomber dans le placeholder « indisponible en mode démonstration ».
  await page.locator('button[data-view="materials"]').first().click();
  await page.locator('button[data-action="new-material"]').click();
  await page.locator('#create-material-form input[name="name"]').fill('Synthetic test material — not real');
  await page.locator('#create-material-form input[name="materialType"]').fill('other');
  await page.locator('#create-material-form button[type="submit"]').click();
  await page.locator('td', { hasText: 'Synthetic test material — not real' }).waitFor();
  assert.equal(materialWrites.length, 1, 'la création matière doit appeler POST /api/materials une fois');
  assert.equal(materialWrites[0].tenant, ORG_ID, 'la création matière doit porter le locataire actif');
  assert.deepEqual(materialWrites[0].body, {
    ownerOrganizationId: ORG_ID,
    materialType: 'other',
    name: 'Synthetic test material — not real',
    composition: {},
    originCountryCode: null,
  }, 'aucune origine, certification ou composition ne doit être inventée');

  // Toutes les vues du routeur sont parcourues : une vue ajoutee plus tard est
  // couverte automatiquement, sans qu'on pense a l'inscrire ici.
  const views = await page.locator('button[data-view]').evaluateAll(
    (els) => [...new Set(els.map((el) => el.dataset.view))],
  );
  assert.ok(views.length >= 10, `vues detectees : ${views.join(', ')}`);
  // Un balayage qui ne trouverait plus qu'une vue passerait le seuil ci-dessus
  // sans rien prouver : on exige nommement les ecrans qui portent les
  // indicateurs de ce chantier.
  for (const attendue of [
    'overview', 'products', 'suppliers', 'documents', 'certifications',
    'quality', 'dpp', 'supplyChain', 'massBalance', 'intelligence',
  ]) {
    assert.ok(views.includes(attendue), `vue « ${attendue} » absente de la navigation : ${views.join(', ')}`);
  }
  for (const view of views) {
    await page.locator(`button[data-view="${view}"]`).first().click();
    await page.waitForTimeout(150);
    const text = await appText(page);
    for (const marker of DEMO_MARKERS) {
      assert.ok(!text.includes(marker), `chiffre de demonstration dans la vue « ${view} » : ${marker}`);
    }
    assert.equal(await page.locator('.demo-banner').count(), 0, `bandeau demo dans la vue « ${view} »`);
    assert.equal(await page.locator('[data-tf-demo]').count(), 0, `marqueur demo dans la vue « ${view} »`);
  }

  await page.locator('button[data-view="documents"]').first().click();
  const documentsText = await appText(page);
  assert.ok(!documentsText.includes('142'), 'aucun inventaire de 142 preuves hors demo');
  assert.match(documentsText, /Not computed/, 'sans route de liste, les compteurs de preuves sont non calcules');

  await page.locator('button[data-view="certifications"]').first().click();
  const certText = await appText(page);
  assert.match(certText, /No certificate declared yet/, 'un tenant vide doit dire « aucun certificat », pas inventer une liste');
  assert.ok(!certText.includes('GOTS 7.0'));

  await page.locator('button[data-view="suppliers"]').first().click();
  const suppliersText = await appText(page);
  assert.ok(!suppliersText.includes('Control Union'));
  assert.ok(!suppliersText.includes('Nhãn Textile'));

  await page.locator('button[data-view="quality"]').first().click();
  const qualityText = await appText(page);
  assert.match(qualityText, /Not computed/, 'sans score qualite, l\'ecran le dit');
  assert.ok(!qualityText.includes('98.4'));
  assert.ok(!qualityText.includes('GRADE A'));

  await page.locator('button[data-view="dpp"]').first().click();
  await page.waitForTimeout(250);
  const dppText = await appText(page);
  assert.match(dppText, /Not computed/, 'aucun produit : la preparation DPP n\'est pas 0 %, elle est non calculee');
  assert.equal(
    await page.locator('.dp-hero-score .uncomputed').count(),
    1,
    'le score de portefeuille DPP affiche « non calcule », pas un pourcentage',
  );
  assert.ok(!/\b88(?:\.0)?\s*%/.test(dppText), 'aucun score DPP de demonstration');
  assert.ok(!dppText.includes('Tier 4'), 'aucun gap de demonstration');
  await page.close();

  /* ---------------------------------------------------------------
     1b. Une modale de graphe rendue dynamiquement ne doit jamais faire une
         soumission HTML native ni renvoyer vers la vue d'ensemble.
     --------------------------------------------------------------- */
  const PRODUCT_ID = '33333333-3333-4333-8333-333333333333';
  const graphPath = `/api/products/${PRODUCT_ID}/supply-chain`;
  const graphScenario = await openConsole(browser, '/brand-console/?lang=en', {
    '/api/products': { body: { products: [{ id: PRODUCT_ID, name: 'Synthetic recipe product', reference: 'RECIPE-TEST', version: 1 }], nextCursor: null } },
    [graphPath]: { body: { product: { id: PRODUCT_ID, name: 'Synthetic recipe product', reference: 'RECIPE-TEST', version: 1 }, graph: { nodes: [], links: [] }, stages: {}, summary: null } },
    [`/api/products/${PRODUCT_ID}/mass-balance`]: { body: { latestReconciliation: null, totalAllocatedKg: null } },
  });
  const graphPage = graphScenario.page;
  await graphPage.waitForFunction(() => window.tracefabBrandConsole?.state?.loading === false);
  await graphPage.locator('button[data-view="supplyChain"]').first().click();
  await graphPage.waitForFunction(() => window.tracefabBrandConsole?.state?.view === 'supplyChain');
  await graphPage.locator('button[data-action="new-chain-node"]').click();
  await graphPage.locator('#chain-node-form input[name="label"]').fill('Declared synthetic step — not verified');
  await graphPage.locator('#chain-node-form select[name="nodeType"]').selectOption('process');
  await graphPage.locator('#chain-node-form button[type="submit"]').click();
  await graphPage.waitForFunction(() => window.tracefabBrandConsole?.state?.modal === null);
  assert.equal(graphScenario.nodeWrites.length, 1, 'le formulaire doit appeler POST nodes exactement une fois');
  assert.equal(graphScenario.nodeWrites[0].tenant, ORG_ID, 'le POST nodes doit porter le tenant actif');
  assert.equal(await graphPage.evaluate(() => window.tracefabBrandConsole.state.supplyChain.graph.nodes.length), 1, 'le nœud isolé créé doit rester visible avant sa première liaison');
  assert.equal(await graphPage.locator('.tc-echelon-card', { hasText: 'Declared synthetic step — not verified' }).count(), 1, 'la réponse POST doit être rendue sans rechargement destructif du graphe');

  await graphPage.locator('button[data-action="new-chain-node"]').click();
  await graphPage.locator('#chain-node-form input[name="label"]').fill('Second declared synthetic step — not verified');
  await graphPage.locator('#chain-node-form select[name="nodeType"]').selectOption('process');
  await graphPage.locator('#chain-node-form select[name="processCode"]').selectOption('other');
  await graphPage.locator('#chain-node-form button[type="submit"]').click();
  await graphPage.waitForFunction(() => window.tracefabBrandConsole?.state?.supplyChain?.graph?.nodes?.length === 2);
  assert.equal(graphScenario.nodeWrites[1].body.processCode, 'other', 'le processus synthétique doit employer le code neutre other, pas un procédé inventé');
  assert.equal(await graphPage.locator('button[data-action="new-chain-link"]').count(), 1, 'deux nœuds doivent rendre la création du premier lien accessible');
  await graphPage.locator('button[data-action="new-chain-link"]').click();
  await graphPage.locator('#chain-link-form select[name="sourceNodeId"]').selectOption('22222222-2222-4222-8222-222222222222');
  await graphPage.locator('#chain-link-form select[name="targetNodeId"]').selectOption('44444444-4444-4444-8444-444444444444');
  await graphPage.locator('#chain-link-form button').last().click();
  await graphPage.waitForFunction(() => window.tracefabBrandConsole?.state?.modal === null);
  assert.equal(graphScenario.linkWrites.length, 1, 'le premier lien doit appeler POST links exactement une fois');
  assert.equal(graphScenario.linkWrites[0].tenant, ORG_ID, 'le POST links doit porter le tenant actif');
  assert.equal(await graphPage.evaluate(() => window.tracefabBrandConsole.state.supplyChain.graph.links.length), 1, 'le lien créé doit rester visible sans GET auxiliaire destructif');
  assert.equal(await graphPage.evaluate(() => window.tracefabBrandConsole.state.view), 'supplyChain', 'la soumission ne doit pas revenir à la vue d’ensemble');
  assert.equal(new URL(graphPage.url()).pathname, '/brand-console/', 'aucune navigation HTML native ne doit avoir lieu');
  assert.equal(new URL(graphPage.url()).searchParams.get('view'), 'supplyChain', 'la vue active doit être inscrite dans l’URL');
  assert.equal(new URL(graphPage.url()).searchParams.get('productId'), PRODUCT_ID, 'le produit actif doit être inscrit dans l’URL');

  await graphPage.reload({ waitUntil: 'domcontentloaded' });
  await graphPage.waitForFunction(() => window.tracefabBrandConsole?.state?.loading === false);
  await graphPage.waitForFunction((id) => window.tracefabBrandConsole?.state?.view === 'supplyChain'
    && window.tracefabBrandConsole?.state?.selectedSupplyChainProduct?.id === id, PRODUCT_ID);
  assert.equal(await graphPage.evaluate(() => window.tracefabBrandConsole.state.view), 'supplyChain', 'un rechargement doit restaurer Traçabilité, pas Vue d’ensemble');
  await graphPage.close();

  /* ---------------------------------------------------------------
     2. Mode demonstration explicite : les chiffres existent et sont
        declares comme tels.
     --------------------------------------------------------------- */
  const demo = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await demo.goto(`${base}/brand-console/?demo=1&lang=en`, { waitUntil: 'domcontentloaded' });
  await demo.locator('h1.mc-headline').waitFor();
  assert.equal(await demo.evaluate(() => window.tracefabBrandConsole.state.demo), true);
  await demo.locator('.demo-banner').waitFor();
  const demoText = await appText(demo);
  for (const marker of ['1,248', '214', '1,098', '97.6', 'Tier 3']) {
    assert.ok(demoText.includes(marker), `le mode demo doit afficher ${marker}`);
  }
  assert.ok(await demo.locator('[data-tf-demo]').count() > 0, 'les chiffres de demo portent [data-tf-demo]');

  // La meme vue DPP est vide en reel et calculee en demo : c'est exactement la
  // difference que ce test protege.
  await demo.locator('button[data-view="dpp"]').first().click();
  await demo.waitForTimeout(250);
  const demoScore = (await demo.locator('.dp-hero-score strong').innerText()).trim();
  assert.match(demoScore, /^\d+(?:\.\d+)?%$/, `la demo calcule un score DPP : ${demoScore}`);
  assert.equal(
    await demo.locator('.dp-hero-score .uncomputed').count(),
    0,
    'la demo n\'affiche pas « non calcule » sur le portefeuille',
  );
  await demo.close();

  /* ---------------------------------------------------------------
     3. Fail-closed : une route en erreur ne bascule pas en demo.
     --------------------------------------------------------------- */
  const broken = await browser.newPage();
  await stubClerk(broken);
  await stubEmptyTenant(broken, {
    '/api/suppliers': { status: 500, body: { error: 'suppliers_unavailable' } },
  });
  await broken.goto(`${base}/brand-console/?lang=en`, { waitUntil: 'domcontentloaded' });
  // On attend l'erreur de chargement elle-meme : `.config-error` sert aussi
  // d'ecran d'attente, s'y arreter validerait le mauvais etat.
  await broken.waitForFunction(() => Boolean(window.tracefabBrandConsole?.state?.configError));
  assert.equal(await broken.evaluate(() => window.tracefabBrandConsole?.state?.demo), false);
  assert.equal(await broken.locator('.demo-banner').count(), 0);
  assert.equal(await broken.locator('.mc-container').count(), 0, 'une panne API ne rend pas la console');
  const brokenText = await appText(broken);
  for (const marker of DEMO_MARKERS) {
    assert.ok(!brokenText.includes(marker), `panne API : chiffre de demo visible (${marker})`);
  }
  await broken.close();

  await browser.close();
  console.log('Brand Console empty tenant passed: real-empty vs explicit demo, fail-closed API');
} finally {
  server.kill('SIGTERM');
}
