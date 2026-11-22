#!/usr/bin/env node
/**
 * TRACEFAB — garde-fous de la mission UI/UX du 2026-10-26.
 *
 * Ce test couvre les defauts mesures puis corriges : debordement horizontal
 * mobile, barre d'actions qui recouvrait la navigation, liens profonds non
 * hydrates en demonstration, chargement sans fin des donnees structurees,
 * fausse creation de questionnaire, prechargement Clerk inconditionnel et
 * chaines francaises incrustees dans une interface anglaise.
 *
 * Le parcours DPP est execute en mode ?demo=1 : il verifie l'orchestration
 * FRONTEND (etats, transitions, controles bloquants, retours utilisateur).
 * Il ne prouve PAS la persistance cote API — aucune base n'est disponible ici.
 * La persistance reelle reste a valider contre un environnement staging.
 *
 * Usage : npm run test:mission-ui
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { launchTestBrowser } from './lib/launch_chromium.mjs';

const PORT = 4189;
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['scripts/dev_static_server.mjs', '--port', String(PORT)], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});

const results = [];
async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, pass: true, ms: Date.now() - started });
    console.log(`OK   ${name}  (${Date.now() - started} ms)`);
  } catch (error) {
    results.push({ name, pass: false, ms: Date.now() - started, why: error.message });
    console.log(`ECHEC ${name}\n        -> ${error.message}`);
  }
}

const geometry = (page) => page.evaluate(() => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: r.height, width: r.width };
  };
  return {
    scrollWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    sidebar: box('.sidebar'),
    topbar: box('.topbar'),
    actions: box('.top-actions'),
    content: box('.content'),
  };
});

async function goDemo(page, query = '') {
  await page.goto(`${BASE}/brand-console/?demo=1&lang=en${query}`, { waitUntil: 'networkidle' });
  await page.locator('.app').waitFor();
}

let browser;
try {
  await delay(350);
  browser = await launchTestBrowser();

  // ---------------------------------------------------------------- 1. mobile
  await check('Mobile 390 px : aucune vue ne deborde horizontalement', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      for (const view of ['overview', 'products', 'quality', 'dpp', 'supplyChain', 'documents', 'certifications', 'requests', 'settings']) {
        await goDemo(page, `&view=${view}`);
        await page.locator(`.nav button[data-view="${view}"]`).click();
        const g = await geometry(page);
        assert.ok(g.scrollWidth <= g.viewport + 1, `${view}: scrollWidth ${g.scrollWidth} > ${g.viewport}`);
        assert.ok(g.actions.bottom <= g.topbar.bottom + 1, `${view}: les actions debordent de la barre superieure`);
        assert.ok(g.content.top >= g.topbar.bottom - 1, `${view}: la barre superieure recouvre le contenu`);
        assert.ok(g.topbar.top >= g.sidebar.bottom - 1, `${view}: la barre superieure recouvre la navigation`);
      }
    } finally { await page.close(); }
  });

  await check('Tablette 768/820 px : la barre superieure reste dans son bloc', async () => {
    const page = await browser.newPage();
    try {
      for (const width of [768, 820, 1024]) {
        await page.setViewportSize({ width, height: 900 });
        await goDemo(page);
        const g = await geometry(page);
        assert.ok(g.actions.bottom <= g.topbar.bottom + 1, `${width}px: actions hors de la barre`);
        assert.ok(g.scrollWidth <= g.viewport + 1, `${width}px: debordement horizontal`);
      }
    } finally { await page.close(); }
  });

  // --------------------------------------------------- 2. erreurs console / CDN
  await check('Mode demo : aucune erreur console ni requete vers un CDN tiers', async () => {
    const page = await browser.newPage();
    const errors = [];
    const external = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { if (!r.url().startsWith(BASE)) external.push(r.url()); });
    try {
      await goDemo(page);
      assert.deepEqual(errors, [], `erreurs console : ${errors.join(' | ')}`);
      assert.deepEqual(external, [], `requetes externes : ${external.join(' | ')}`);
    } finally { await page.close(); }
  });

  // ---------------------------------------------------------- 3. liens profonds
  await check('Liens profonds demo : fiche, qualite, tracabilite et DPP hydratees', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await goDemo(page, '&view=productDetail&productId=demo-product-1');
      assert.equal((await page.locator('.content h1').first().innerText()).trim(), 'Cotton Essential');
      assert.equal(await page.getByText('Product not found').count(), 0);
      assert.equal(await page.getByText(/Loading structured|Loading/i).count(), 0, 'chargement sans fin');
      assert.ok(await page.evaluate(() => Boolean(window.tracefabBrandConsole.state.selectedProductDetail)));

      await goDemo(page, '&view=dpp');
      assert.match(await page.locator('.content h1').first().innerText(), /What is missing across your catalogue/);
      assert.ok(await page.evaluate(() => Boolean(window.tracefabBrandConsole.state.dppPortfolio)));

      await goDemo(page, '&view=dpp&productId=demo-product-1');
      assert.equal((await page.locator('.content h1').first().innerText()).trim(), 'Cotton Essential');
      assert.equal(await page.evaluate(() => window.tracefabBrandConsole.state.dppScope), 'product');

      await goDemo(page, '&view=quality');
      assert.ok(await page.evaluate(() => Boolean(window.tracefabBrandConsole.state.quality)));
      await goDemo(page, '&view=supplyChain');
      assert.ok(await page.evaluate(() => Boolean(window.tracefabBrandConsole.state.supplyChain)));
    } finally { await page.close(); }
  });

  // ------------------------------------------- 4. donnees structurees en demo
  await check('Donnees structurees : formulaire actif et declaration locale explicite', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const apiCalls = [];
    page.on('request', (r) => { if (/\/api\/.*data-points/.test(r.url())) apiCalls.push(r.url() + ':' + r.method()); });
    try {
      await goDemo(page, '&view=productDetail&productId=demo-product-1');
      const form = page.locator('#product-data-point-form');
      assert.ok(await form.locator('select[name="dataKey"] option').count() >= 5, 'definitions absentes');
      assert.equal(await form.locator('button[type="submit"]').isEnabled(), true, 'formulaire desactive');
      await form.locator('select[name="dataKey"]').selectOption('main_material_percentage');
      await form.locator('input[name="value"]').fill('85');
      await form.locator('button[type="submit"]').click();
      await page.locator('.toast').waitFor();
      assert.match(await page.locator('.toast').innerText(), /demo mode — not saved/i);
      assert.match(await page.locator('.content').innerText(), /main_material_percentage[\s\S]*85/);
      assert.deepEqual(apiCalls, [], 'la demonstration ne doit pas appeler une route tenant-scopee');
    } finally { await page.close(); }
  });

  // ------------------------------------------------ 5. verite du Form Studio
  await check('Form Studio : brouillon local annonce, jamais presente comme publie', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const posts = [];
    page.on('request', (r) => { if (r.method() === 'POST' && /questionnaires/.test(r.url())) posts.push(r.url()); });
    try {
      await goDemo(page, '&view=questionnaires');
      await page.locator('.nav button[data-view="questionnaires"]').click();
      const create = page.locator('.content .page-head .btn-primary').first();
      assert.equal(await create.isEnabled(), true, 'creation demo indisponible');
      await create.click();
      assert.match(await page.locator('.modal .notice').innerText(), /Demonstration only/);
      await page.fill('#questionnaire-builder-form input[name="title"]', 'MISSION TEST protocol');
      await page.fill('#questionnaire-builder-form input[name="key"]', 'mission-test-protocol');
      await page.fill('#questionnaire-builder-form textarea[name="description"]', 'Mission UI regression fixture.');
      await page.locator('#questionnaire-builder-form button[type="submit"]').click();
      await page.locator('.toast').waitFor();
      assert.match(await page.locator('.toast').innerText(), /not saved and not shared/i);
      const first = page.locator('.content .item').first();
      assert.match(await first.innerText(), /Draft[\s\S]*MISSION TEST protocol/);
      assert.equal(await first.locator('button').first().isDisabled(), true, 'un brouillon local ne doit pas lancer une collecte');
      assert.deepEqual(posts, [], 'aucune creation cote serveur ne doit etre simulee');

      // Hors demonstration, la creation est desactivee : aucune API d'ecriture
      // de questionnaire n'existe cote serveur.
      await page.evaluate(() => { window.tracefabBrandConsole.state.demo = false; });
      await page.locator('.nav button[data-view="overview"]').click();
      await page.locator('.nav button[data-view="questionnaires"]').click();
      const realCreate = page.locator('.content .page-head .btn-primary').first();
      assert.equal(await realCreate.isDisabled(), true, 'creation indisponible hors demo doit etre desactivee');
      assert.match(await realCreate.getAttribute('title'), /not available in this version/i);
    } finally { await page.close(); }
  });

  // ------------------------------------------------------- 6. ecran de connexion
  await check('Ecran de connexion : libelles traduits, pas de francais incruste', async () => {
    const page = await browser.newPage();
    const key = `pk_live_${Buffer.from('clerk.tracefab.example$').toString('base64')}`;
    await page.route('**/api/config', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ publishableKey: key, proxyUrl: `${BASE}/__clerk` }),
    }));
    await page.route('https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js', (route) => route.fulfill({
      status: 200, contentType: 'application/javascript',
      body: `window.Clerk = { user: null, session: null, async load() {}, addListener() {},
        mountSignIn(el) { el.dataset.clerkMounted = 'true'; } };`,
    }));
    try {
      await page.goto(`${BASE}/brand-console/?lang=en`, { waitUntil: 'domcontentloaded' });
      await page.locator('#clerk-sign-in[data-clerk-mounted="true"]').waitFor({ state: 'attached' });
      assert.equal((await page.locator('.auth-box h2').innerText()).trim(), 'Sign in');
      assert.equal((await page.locator('.auth-box .eyebrow').textContent()).trim(), 'Brand workspace');
      await page.evaluate(() => window.TF_I18N.setLanguage('fr'));
      await page.waitForTimeout(120);
      assert.equal((await page.locator('.auth-box h2').innerText()).trim(), 'Se connecter');
    } finally { await page.close(); }
  });

  // ---------------------------------------------- 7. parcours DPP (mode demo)
  await check('Parcours DPP demo : produit -> composition -> identifiant -> controles', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('dialog', (d) => d.accept());
    try {
      await goDemo(page, '&view=products');
      await page.locator('[data-action="new-product"]').first().click();
      await page.fill('#product-form input[name="reference"]', 'MISSION-TSHIRT-001');
      await page.fill('#product-form input[name="name"]', 'Mission T-shirt');
      await page.fill('#product-form input[name="category"]', 'T-shirt');
      await page.locator('#product-form button.btn-primary').click();
      await page.locator('.toast').waitFor();
      assert.match(await page.locator('.toast').innerText(), /demo mode — not saved/i);

      await page.locator('tr').filter({ hasText: 'MISSION-TSHIRT-001' }).locator('button[data-product-id]').first().click();
      assert.equal((await page.locator('.content h1').first().innerText()).trim(), 'Mission T-shirt');

      // Composition textile : une matiere et un pourcentage.
      await page.locator('#material-form select[name="materialId"]').selectOption('demo-material-1');
      await page.fill('#material-form input[name="percentage"]', '85');
      await page.locator('#material-form button[type="submit"]').click();
      await page.waitForTimeout(100);
      assert.match(await page.locator('.content').innerText(), /Organic cotton/);

      // Identifiant resolvable : debloque l'apercu du passeport public.
      await page.locator('#identifier-form select[name="identifierType"]').selectOption('gtin');
      await page.fill('#identifier-form input[name="identifierValue"]', '3760123456789');
      await page.locator('#identifier-form button[type="submit"]').click();
      await page.waitForTimeout(100);
      const preview = page.locator('.content .page-head button').filter({ hasText: /Preview DPP/i }).first();
      assert.equal(await preview.isEnabled(), true, 'apercu DPP indisponible sans identifiant');

      // Fiche technique : le message de succes doit etre traduit.
      await page.fill('#product-detail-form textarea[name="description"]', 'Mission UI test product — not a real SKU.');
      await page.locator('#product-detail-form button[type="submit"]').click();
      await page.locator('.toast').waitFor();
      assert.match(await page.locator('.toast').innerText(), /Product data saved/i);

      // Preparation DPP : le calcul produit des exigences et des controles.
      await page.locator('[data-action="product-dpp-from-detail"]').click();
      await page.waitForTimeout(200);
      const st = await page.evaluate(() => ({
        view: window.tracefabBrandConsole.state.view,
        dpp: window.tracefabBrandConsole.state.dpp,
      }));
      assert.equal(st.view, 'dpp');
      assert.equal(await page.evaluate(() => window.tracefabBrandConsole.state.dppScope), 'product',
        'la fiche DPP du produit doit etre affichee, pas le portefeuille');
      assert.ok(st.dpp, 'profil DPP absent');
      assert.ok((st.dpp.totalRequirements || 0) > 0, 'aucune exigence evaluee');
      assert.ok(Array.isArray(st.dpp.missingFields), 'liste des ecarts absente');
      const text = await page.locator('.content').innerText();
      assert.match(text, /Remaining requirements|requirements met/i);
      // La publication n'est propose que si les conditions reelles sont reunies.
      const publishCount = await page.locator('[data-action="publish-dpp"]').count();
      if (st.dpp.canMarkReadyToPublish) assert.ok(publishCount >= 1, 'la validation devrait etre proposee');
      else assert.equal(publishCount, 0, 'validation proposee alors que des exigences bloquantes subsistent');
    } finally { await page.close(); }
  });

  // -------------------------------------------------- 8. validations natives
  await check('Validation : champs obligatoires et format pays ISO-2', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await goDemo(page, '&view=products');
      await page.locator('[data-action="new-product"]').first().click();
      await page.locator('#product-form button.btn-primary').click();
      assert.equal(await page.locator('#product-form').count(), 1, 'un formulaire vide ne doit pas etre soumis');
      assert.equal(await page.locator('#product-form input[name="reference"]').evaluate((el) => el.validity.valueMissing), true);
      await page.locator('[data-action="close-modal"]').first().click();

      await goDemo(page, '&view=productDetail&productId=demo-product-1');
      const pays = page.locator('#product-detail-form input[name="countryOfManufacture"]');
      await pays.fill('F');
      assert.equal(await pays.evaluate((el) => el.validity.patternMismatch || !el.checkValidity()), true,
        'un code pays a une lettre doit etre refuse');
    } finally { await page.close(); }
  });

  // ------------------------------------------- 9. pannes API et acces refuse
  // Ces deux scenarios injectent une panne volontaire : ils verifient la
  // gestion d'erreur du frontend, ils ne simulent PAS une integration reelle.
  await check('Panne API / acces refuse : erreur explicite, jamais de repli demo', async () => {
    const key = `pk_live_${Buffer.from('clerk.tracefab.example$').toString('base64')}`;
    const stub = async (page, meStatus) => {
      await page.route('**/api/config', (route) => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ publishableKey: key, proxyUrl: `${BASE}/__clerk` }),
      }));
      await page.route('https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js', (route) => route.fulfill({
        status: 200, contentType: 'application/javascript',
        body: `window.Clerk = { user: { id: 'mission-user', fullName: 'Mission User', email: 'mission@example.test' },
          session: { async getToken() { return 'mission-token'; } }, async load() {}, addListener() {}, mountSignIn() {} };`,
      }));
      await page.route('**/api/me', (route) => route.fulfill({
        status: meStatus, contentType: 'application/json',
        body: meStatus === 200
          ? JSON.stringify({ user: { id: 'mission-user', fullName: 'Mission User', email: 'mission@example.test' },
              memberships: [{ organization_id: '00000000-0000-4000-8000-000000000001', role: 'owner',
                organizations: { id: '00000000-0000-4000-8000-000000000001', type: 'brand', display_name: 'Mission Test Brand' } }] })
          : JSON.stringify({ error: 'unauthorized' }),
      }));
      await page.route('**/api/products', (route) => route.fulfill({
        status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'mission_api_failure' }),
      }));
      // sync() charge quatre sources en parallele : les autres doivent
      // repondre pour que la panne /api/products soit celle qui remonte.
      for (const path of ['/api/suppliers', '/api/materials', '/api/data-requests']) {
        await page.route(`**${path}`, (route) => route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ suppliers: [], materials: [], requests: [] }),
        }));
      }
    };
    const scenarios = [
      { meStatus: 200, expected: 'mission_api_failure' },
      { meStatus: 401, expected: 'unauthorized' },
    ];
    for (const sc of scenarios) {
      const page = await browser.newPage();
      await stub(page, sc.meStatus);
      try {
        await page.goto(`${BASE}/brand-console/?lang=en`, { waitUntil: 'domcontentloaded' });
        await page.locator('.config-error').waitFor({ state: 'attached' });
        await page.waitForFunction((code) => document.querySelector('.config-error')?.textContent.includes(code), sc.expected, { timeout: 10000 });
        assert.equal(await page.locator('.demo-banner').count(), 0, 'aucun repli vers la demonstration');
        assert.equal(await page.evaluate(() => window.tracefabBrandConsole.state.demo), false);
        assert.equal(await page.locator('[data-action="retry"]').count(), 1, 'un bouton de reessai doit etre propose');
      } finally { await page.close(); }
    }
  });

  // --------------------------------------------------------- 10. titre SPA
  await check('Product Intelligence : titre propre conserve apres changement de langue', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${BASE}/product-intelligence/?demo=1&lang=fr`, { waitUntil: 'networkidle' });
      await page.evaluate(() => window.TF_I18N.setLanguage('en'));
      await page.waitForTimeout(150);
      assert.match(await page.title(), /Product Intelligence/);
    } finally { await page.close(); }
  });
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}

const failed = results.filter((r) => !r.pass);
console.log('\n' + '-'.repeat(78));
console.log(`${results.length - failed.length}/${results.length} controles de non-regression valides`);
if (failed.length) process.exit(1);
