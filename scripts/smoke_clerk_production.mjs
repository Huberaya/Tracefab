#!/usr/bin/env node
/**
 * Post-deploy, secret-free browser smoke test for the real Clerk Production
 * instance. Run with TRACEFAB_CLERK_SMOKE_URL=https://tracefab.vercel.app.
 */
import assert from 'node:assert/strict';
import { launchTestBrowser } from './lib/launch_chromium.mjs';

const configuredBase = process.env.TRACEFAB_CLERK_SMOKE_URL;
assert(configuredBase, 'Set TRACEFAB_CLERK_SMOKE_URL to the deployed production origin.');
const base = new URL(configuredBase);
assert.equal(base.protocol, 'https:', 'The Clerk Production smoke test requires HTTPS.');
const origin = base.origin;
const expectedProxyUrl = `${origin}/__clerk`;

const configResponse = await fetch(new URL('/api/config', origin), { cache: 'no-store' });
assert.equal(configResponse.status, 200, `/api/config returned ${configResponse.status}`);
const config = await configResponse.json();
assert.match(config.publishableKey || '', /^pk_live_/, '/api/config must expose the Production publishable key.');
assert.equal(config.proxyUrl, expectedProxyUrl, '/api/config must return the canonical Clerk proxy URL.');
assert.doesNotMatch(JSON.stringify(config), /sk_(?:live|test)_/i, '/api/config must never expose a Clerk secret key.');

const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  const clerkScriptRequests = [];
  const proxyResponses = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes('/npm/@clerk/clerk-js@5/dist/clerk.browser.js')) {
      clerkScriptRequests.push(url.href);
    }
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin === origin && url.pathname.startsWith('/__clerk/')) proxyResponses.push(response);
  });

  await page.goto(new URL('/brand-console/', origin).href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const state = window.tracefabBrandConsole?.state;
    return window.Clerk?.status === 'ready' && state && state.demo === false;
  }, undefined, { timeout: 45_000 });
  await page.waitForFunction(() => performance.getEntriesByType('resource').some((entry) => {
    try { return new URL(entry.name).pathname.startsWith('/__clerk/'); } catch { return false; }
  }), undefined, { timeout: 45_000 });

  assert.ok(clerkScriptRequests.length > 0, 'The actual ClerkJS production bundle did not load.');
  assert.ok(proxyResponses.length > 0, 'ClerkJS did not make a request through /__clerk/.');
  assert.ok(proxyResponses.some((response) => response.status() < 500), 'The Clerk proxy returned only server errors.');
  assert.equal(await page.locator('.demo-banner').count(), 0, 'The production Brand Console must not enter demo mode.');
  assert.equal(await page.locator('#clerk-sign-in').count(), 1, 'The unauthenticated Brand Console must mount Clerk sign-in.');

  console.log(`Clerk Production smoke passed: SDK loaded, ${proxyResponses.length} request(s) used ${expectedProxyUrl}, Brand Console stayed outside demo mode.`);
} finally {
  await browser.close();
}
