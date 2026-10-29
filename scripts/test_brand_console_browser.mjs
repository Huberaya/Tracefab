import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { launchTestBrowser } from './lib/launch_chromium.mjs';

const port = 4173;
// On sert via dev_static_server.mjs, seul serveur local qui applique les
// reecritures de vercel.json. Un test qui valide contre un serveur ignorant le
// routage de production ne prouve rien sur la production.
const server = spawn(process.execPath, ['scripts/dev_static_server.mjs', '--port', String(port)], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});

try {
  await delay(350);
  const browser = await launchTestBrowser();
  const testProxyUrl = `http://127.0.0.1:${port}/__clerk`;
  const testPublishableKey = `pk_live_${Buffer.from('clerk.tracefab.example$').toString('base64')}`;

  // Une panne Clerk en mode normal doit rester une erreur d'authentification,
  // jamais se transformer silencieusement en espace rempli de données démo.
  const unavailablePage = await browser.newPage();
  await unavailablePage.route('**/api/config', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'clerk_not_configured' }),
  }));
  await unavailablePage.route('**/assets/config/clerk.json', (route) => route.abort('failed'));
  await unavailablePage.goto(`http://127.0.0.1:${port}/brand-console/?lang=fr`, { waitUntil: 'domcontentloaded' });
  await unavailablePage.locator('.config-error').waitFor();
  assert.equal(await unavailablePage.evaluate(() => window.tracefabBrandConsole?.state.demo), false);
  assert.equal(await unavailablePage.locator('.demo-banner').count(), 0);
  assert.doesNotMatch(await unavailablePage.locator('#app').innerText(), /Cotton Essential|Atelier Demo/);
  await unavailablePage.close();

  // A configured publishable key is not enough: if the ClerkJS network load
  // fails, the real app must still report the error instead of showing demo data.
  const sdkFailurePage = await browser.newPage();
  await sdkFailurePage.route('**/api/config', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ publishableKey: testPublishableKey, proxyUrl: testProxyUrl }),
  }));
  await sdkFailurePage.route('https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js', (route) => route.abort('failed'));
  await sdkFailurePage.goto(`http://127.0.0.1:${port}/brand-console/?lang=fr`, { waitUntil: 'domcontentloaded' });
  await sdkFailurePage.locator('.config-error').waitFor();
  assert.equal(await sdkFailurePage.evaluate(() => window.tracefabBrandConsole?.state.demo), false);
  assert.equal(await sdkFailurePage.locator('.demo-banner').count(), 0);
  await sdkFailurePage.close();

  // Exercise the real app bootstrap: it fetches /api/config, loads the
  // ClerkJS bundle from the CSP-approved CDN, passes the configured proxy URL
  // on Clerk's supported script attribute, and uses /__clerk for FAPI calls.
  const clerkPage = await browser.newPage();
  let clerkBundleLoaded = false;
  let clerkProxyRequest = '';
  await clerkPage.route('**/api/config', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ publishableKey: testPublishableKey, proxyUrl: testProxyUrl }),
  }));
  await clerkPage.route('https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js', (route) => {
    clerkBundleLoaded = true;
    return route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `window.Clerk = {
        status: 'loading', user: null, session: null,
        async load() {
          const script = document.querySelector('script[data-clerk-publishable-key]');
          const proxyUrl = script && script.getAttribute('data-clerk-proxy-url');
          if (proxyUrl !== ${JSON.stringify(testProxyUrl)}) throw new Error('clerk_proxy_url_not_configured');
          const response = await fetch(proxyUrl + '/v1/client?__clerk_api_version=2026-08-01');
          if (!response.ok) throw new Error('clerk_proxy_request_failed');
          this.status = 'ready';
        },
        addListener() {},
        mountSignIn(element) { element.dataset.clerkMounted = 'true'; element.textContent = 'Clerk sign-in ready'; },
      };`,
    });
  });
  await clerkPage.route(`${testProxyUrl}/**`, (route) => {
    clerkProxyRequest = route.request().url();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ client: {} }) });
  });
  await clerkPage.goto(`http://127.0.0.1:${port}/brand-console/?lang=fr`, { waitUntil: 'domcontentloaded' });
  await clerkPage.waitForFunction(() => window.Clerk?.status === 'ready' && window.tracefabBrandConsole?.state.demo === false);
  await clerkPage.locator('#clerk-sign-in[data-clerk-mounted="true"]').waitFor();
  assert.equal(clerkBundleLoaded, true, 'Brand Console must load the ClerkJS bundle');
  assert.equal(new URL(clerkProxyRequest).pathname, '/__clerk/v1/client', 'Clerk FAPI traffic must use the configured proxy path');
  assert.equal(await clerkPage.locator('.demo-banner').count(), 0);
  await clerkPage.close();

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  // Ce scenario verifie des libelles francais : la locale par defaut du site
  // est l'anglais depuis la couche i18n, donc on force la langue.
  await page.goto(`http://127.0.0.1:${port}/brand-console/?demo=1&lang=fr`, { waitUntil: 'domcontentloaded' });

  // Exercise the French native UI explicitly; the console defaults to English when no preference exists.
  await page.locator('#brand-lang-select').selectOption('fr');
  await page.locator('h1.mc-headline').waitFor();
  await page.locator('button[data-view="products"]').click();
  await page.locator('[data-product-id="demo-product-1"]').click();
  // Fixture de demonstration : anglicisee par la regle « donnees de demo », donc
  // insensible a la locale.
  await page.getByRole('heading', { name: 'Cotton Essential' }).waitFor();

  await page.locator('#material-form select[name="materialId"]').selectOption('demo-material-1');
  await page.locator('#material-form input[name="percentage"]').fill('80');
  await page.locator('#material-form button[type="submit"]').click();
  await page.getByText('Organic cotton').first().waitFor();

  await page.locator('#identifier-form select[name="identifierType"]').selectOption('ean');
  await page.locator('#identifier-form input[name="identifierValue"]').fill('3760123456789');
  await page.locator('#identifier-form button[type="submit"]').click();
  await page.getByText('EAN').first().waitFor();

  await page.locator('button[data-view="suppliers"]').click();
  await page.locator('[data-supplier-id-view="demo-supplier-record"]').click();
  await page.getByRole('heading', { name: 'Nhãn Textile' }).waitFor();

  await browser.close();
  console.log('Brand Console browser flow passed: Clerk bootstrap/proxy, no automatic demo fallback, explicit demo navigation and product/supplier journeys');
} finally {
  server.kill('SIGTERM');
}
