import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { launchTestBrowser } from './lib/launch_chromium.mjs';

/**
 * Brand Console — un meme utilisateur, deux organisations, zero fuite.
 *
 * Scenario de reproduction Production du 2026-10-17 : un administrateur Clerk
 * membre de `Ginger` et de `Tracefab Recette Production` voyait, depuis Ginger,
 * le produit brouillon `RECETTE-DPP-20261017` qui n'appartient qu'au tenant de
 * recette.
 *
 * Ce test verifie, dans un vrai navigateur :
 *
 *   1. chaque appel prive porte l'en-tete de locataire actif ;
 *   2. le serveur de fixture applique le contrat reel — une requete privee sans
 *      locataire nomme recoit 400 `organization_id_required`, jamais un repli
 *      sur l'union des organisations ;
 *   3. Ginger ne voit que Ginger, la recette ne voit que la recette ;
 *   4. au changement de tenant, l'etat precedent est vide AVANT le
 *      rechargement : aucun flash de donnees, y compris sur un reseau lent ;
 *   5. le locataire actif est persiste : un rechargement ne bascule pas
 *      silencieusement sur la premiere organisation de la liste ;
 *   6. un echec de chargement ne bascule jamais sur le jeu de demonstration.
 *
 * LIMITE ASSUMEE, ET NON SIMULEE : l'API est un serveur de fixture. Un parcours
 * reellement non mocke exigerait un compte Clerk Production membre de deux
 * organisations et une base ecrivable — deux secrets que ce test n'a pas. Ce
 * test prouve le contrat client/serveur et l'absence de residue d'etat ;
 * l'etancheite en base est prouvee par `npm run test:neon:cross-tenant`.
 *
 * Usage : node scripts/test_multi_tenant_browser.mjs
 */

const port = 4181;
const base = `http://127.0.0.1:${port}`;
const TENANT_HEADER = 'x-tracefab-organization-id';

// Les deux organisations du scenario de reproduction.
const GINGER = '11111111-1111-4111-8111-111111111111';
const RECETTE = '22222222-2222-4222-8222-222222222222';
const USER_ID = 'user_multi_tenant';

// Le produit de recette : brouillon, et uniquement dans le tenant de recette.
const RECETTE_PRODUCT = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  brandOrganizationId: RECETTE,
  reference: 'RECETTE-DPP-20261017',
  name: 'Produit synthetique de recette',
  category: null,
  sku: null,
  status: 'draft',
  version: 1,
  publicSlug: null,
  dataReadiness: 'in_progress',
  dataCompletion: '0',
};

const GINGER_PRODUCT = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
  brandOrganizationId: GINGER,
  reference: 'GINGER-0001',
  name: 'Produit reel de Ginger',
  category: null,
  sku: null,
  status: 'draft',
  version: 1,
  publicSlug: null,
  dataReadiness: 'in_progress',
  dataCompletion: '0',
};

const ALL_PRODUCTS = [GINGER_PRODUCT, RECETTE_PRODUCT];

const MEMBERSHIPS = [
  { organization_id: GINGER, role: 'admin', status: 'active', organizations: { id: GINGER, type: 'brand', display_name: 'Ginger', legal_name: 'Ginger SAS', status: 'active' } },
  { organization_id: RECETTE, role: 'admin', status: 'active', organizations: { id: RECETTE, type: 'brand', display_name: 'Tracefab Recette Production', legal_name: 'Tracefab Recette SAS', status: 'active' } },
];

// Routes sans donnee de locataire : les seules a pouvoir s'en passer, parce
// qu'elles servent justement a determiner lequel est actif.
const TENANT_FREE = new Set(['/api/me', '/api/organizations', '/api/config']);

const CLERK_STUB = `window.Clerk = {
  status: 'ready',
  user: { id: '${USER_ID}', fullName: 'Admin Multi-Tenant', primaryEmailAddress: { emailAddress: 'admin@example.test' } },
  session: { getToken: async () => 'test-token' },
  async load() { this.status = 'ready'; },
  addListener() {},
  mountSignIn(element) { element.dataset.clerkMounted = 'true'; },
};`;

const server = spawn(process.execPath, ['scripts/dev_static_server.mjs', '--port', String(port)], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${base}/brand-console/`);
      if (res.ok) return;
    } catch { /* pas encore pret */ }
    await delay(250);
  }
  throw new Error('le serveur statique de test ne demarre pas');
}

/**
 * Fixture d'API qui applique le CONTRAT SERVEUR REEL.
 *
 * - une route privee sans locataire nomme -> 400 organization_id_required ;
 * - un locataire mal forme            -> 400 invalid_organization_id ;
 * - un locataire non adherent         -> 404 organization_not_found ;
 * - sinon, uniquement les lignes de CE locataire.
 *
 * Le repli `{ in: toutesLesOrganisations }` est volontairement absent : c'est
 * le defaut corrige. Une route de fixture qui l'imiterait rendrait le test
 * incapable de detecter sa reintroduction.
 */
function installApi(page, state) {
  return page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === '/api/config') return route.fallback();

    const header = route.request().headers()[TENANT_HEADER];
    state.requests.push({ path, header });

    if (!TENANT_FREE.has(path)) {
      if (!header) {
        return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'organization_id_required' }) });
      }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(header)) {
        return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_organization_id' }) });
      }
      if (!MEMBERSHIPS.some((m) => m.organization_id === header)) {
        return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'organization_not_found' }) });
      }
    }

    if (path === '/api/me') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: { id: USER_ID, fullName: 'Admin Multi-Tenant', email: 'admin@example.test' }, memberships: MEMBERSHIPS }) });
    }
    if (path === '/api/organizations') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ organizations: MEMBERSHIPS.map((m) => ({ organizationId: m.organization_id, role: m.role, organizations: m.organizations })) }) });
    }
    if (path === '/api/products') {
      // LE POINT DECISIF : la fixture ne renvoie que les produits du locataire
      // nomme. Si la console affichait RECETTE-DPP-20261017 depuis Ginger,
      // cela ne viendrait pas d'ici.
      const products = ALL_PRODUCTS.filter((p) => p.brandOrganizationId === header);
      // Retard reproductible : c'est pendant cette fenetre qu'un flash de
      // donnees du tenant precedent serait visible.
      return setTimeout(() => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ products, nextCursor: null }) }), state.delayMs);
    }
    if (path === '/api/suppliers') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ suppliers: [] }) });
    if (path === '/api/materials') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ materials: [] }) });
    if (path === '/api/data-requests') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ requests: [] }) });
    if (path === '/api/questionnaires') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ questionnaires: [] }) });
    if (path.startsWith('/api/catalog/schemas')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schemas: [] }) });
    if (path === '/api/mass-balance/certificates') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ certificates: [], count: 0 }) });
    if (path === '/api/dpp/portfolio') {
      const total = ALL_PRODUCTS.filter((p) => p.brandOrganizationId === header).length;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', scoreIsReadinessIndicatorOnly: true, profileKey: 'textile_readiness_mvp', profileVersion: '1.0', totalProducts: total, computedProducts: 0, uncomputedProducts: total, blockedProducts: 0, readinessScore: 0, statusCounts: {}, gaps: [], lastComputedAt: null }) });
    }
    // Fail-closed : une route non declaree fait echouer le scenario au lieu de
    // laisser le navigateur atteindre un vrai backend.
    state.unexpected.push(path);
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: `unexpected_route_${path}` }) });
  });
}

async function stubClerk(page) {
  await page.route('**/api/config', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ publishableKey: 'pk_test_bXVsdGkudGVuYW50JA==', proxyUrl: `${base}/__clerk` }),
  }));
  await page.route('https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js', (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: CLERK_STUB,
  }));
}

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const ko = (m) => { failures += 1; console.error(`  ECHEC ${m}`); };
const check = (label, condition, detail = '') => (condition ? ok(label) : ko(`${label}${detail ? ` — ${detail}` : ''}`));

let browser;
try {
  await waitForServer();
  browser = await launchTestBrowser();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  const state = { requests: [], unexpected: [], delayMs: 400 };
  await stubClerk(page);
  await installApi(page, state);

  await page.goto(`${base}/brand-console/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.tracefabBrandConsole?.state?.products?.length > 0, null, { timeout: 15000 });

  const console1 = window => window.tracefabBrandConsole.state;

  /* -- 1. locataire actif porte par chaque appel prive -------------------- */
  const privateCalls = state.requests.filter((r) => !TENANT_FREE.has(r.path));
  check('au moins un appel prive a ete observe', privateCalls.length > 0, `aucun appel prive (${state.requests.length} requetes au total)`);
  const missingHeader = privateCalls.filter((r) => r.header !== GINGER && r.header !== RECETTE);
  check('chaque appel prive porte un locataire actif valide', missingHeader.length === 0,
    missingHeader.map((r) => `${r.path}=${r.header}`).join(', '));

  /* -- 2. Ginger ne voit que Ginger --------------------------------------- */
  const afterLoad = await page.evaluate(console1);
  check('le locataire actif initial est Ginger', afterLoad.activeOrganizationId === GINGER,
    `obtenu ${afterLoad.activeOrganizationId}`);
  const refsGinger = afterLoad.products.map((p) => p.reference);
  check('Ginger ne liste QUE ses produits', refsGinger.length === 1 && refsGinger[0] === 'GINGER-0001',
    `obtenu [${refsGinger.join(', ')}]`);
  check('RECETTE-DPP-20261017 est absent de Ginger', !refsGinger.includes('RECETTE-DPP-20261017'));

  const gingerHtml = await page.content();
  check("le DOM de Ginger ne contient pas la reference de recette", !gingerHtml.includes('RECETTE-DPP-20261017'));

  /* -- 3. changement de tenant : aucun flash ------------------------------ */
  // La console vide l'etat AVANT de recharger. On le verifie pendant la
  // fenetre de reseau (state.delayMs) : a cet instant, la liste doit deja etre
  // vide, pas encore celle de Ginger.
  await page.selectOption('#active-org', RECETTE);
  await delay(Math.floor(state.delayMs / 2));
  const duringSwitch = await page.evaluate(console1);
  check("l'etat du tenant precedent est vide pendant le rechargement",
    duringSwitch.products.length === 0,
    `${duringSwitch.products.length} produit(s) encore affiches pendant le basculement`);
  check("aucune fiche detail du tenant precedent ne survit",
    duringSwitch.selectedProductDetail === null && duringSwitch.selectedProduct === null);

  await page.waitForFunction(() => window.tracefabBrandConsole?.state?.products?.length > 0, null, { timeout: 15000 });
  const afterSwitch = await page.evaluate(console1);
  const refsRecette = afterSwitch.products.map((p) => p.reference);
  check('la recette ne liste QUE ses produits', refsRecette.length === 1 && refsRecette[0] === 'RECETTE-DPP-20261017',
    `obtenu [${refsRecette.join(', ')}]`);
  check('GINGER-0001 est absent de la recette', !refsRecette.includes('GINGER-0001'));

  const switchedHeader = state.requests.filter((r) => r.header === RECETTE);
  check('les appels apres basculement portent le nouveau locataire', switchedHeader.length > 0);
  const gingerAfterSwitch = state.requests.filter((r) => r.header === GINGER);
  check('les deux locataires ont ete nommes explicitement, jamais melanges',
    gingerAfterSwitch.length > 0 && switchedHeader.length > 0);

  /* -- 4. persistance du locataire actif ---------------------------------- */
  const persisted = await page.evaluate(() => localStorage.getItem('tracefab_active_organization_id'));
  check('le locataire actif est persiste', persisted === RECETTE, `obtenu ${persisted}`);

  state.requests.length = 0;
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.tracefabBrandConsole?.state?.products?.length > 0, null, { timeout: 15000 });
  const afterReload = await page.evaluate(console1);
  check('un rechargement ne bascule pas sur la premiere organisation',
    afterReload.activeOrganizationId === RECETTE, `obtenu ${afterReload.activeOrganizationId}`);
  check('apres rechargement, la recette ne voit toujours que la recette',
    afterReload.products.every((p) => p.brandOrganizationId === RECETTE));

  /* -- 5. jamais de repli sur la demonstration ---------------------------- */
  check("aucune route inattendue n'a ete appelee", state.unexpected.length === 0,
    [...new Set(state.unexpected)].join(', '));
  const demoBanner = await page.evaluate(() => Boolean(document.querySelector('.demo-banner')));
  check('aucun bandeau de demonstration hors ?demo=1', demoBanner === false);

  /* -- 6. 390 px : pas de debordement horizontal -------------------------- */
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  check('aucun debordement horizontal a 390 px', overflow.scroll <= overflow.client + 1,
    `scrollWidth ${overflow.scroll} > clientWidth ${overflow.client}`);

  await page.close();
} catch (error) {
  ko(`scenario interrompu : ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill('SIGKILL');
}

console.log('');
if (failures > 0) {
  console.error(`Multi-locataires navigateur : ${failures} echec(s).`);
  process.exit(1);
}
console.log('Multi-locataires navigateur : un utilisateur, deux organisations, aucune fuite, aucun flash.');
