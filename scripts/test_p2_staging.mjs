import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const baseUrl = process.env.TRACEFAB_STAGING_URL?.trim();
const storageStatePath = process.env.TRACEFAB_E2E_STORAGE_STATE?.trim();
const workerSecret = process.env.TRACEFAB_STAGING_WORKER_SECRET?.trim();
if (!baseUrl || !storageStatePath || !workerSecret) {
  throw new Error('P2 staging E2E requires TRACEFAB_STAGING_URL, TRACEFAB_E2E_STORAGE_STATE and TRACEFAB_STAGING_WORKER_SECRET; no mock/demo fallback is allowed');
}
if (!existsSync(storageStatePath)) throw new Error(`P2 staging E2E storage state not found: ${storageStatePath}`);
const origin = new URL(baseUrl);
assert.equal(origin.protocol, 'https:', 'P2 staging URL must use HTTPS');

const readinessResponse = await fetch(new URL('/api/internal/p2/readiness', origin), { headers: { 'x-tracefab-worker-secret': workerSecret } });
const readiness = await readinessResponse.json();
assert.equal(readinessResponse.status, 200, `P2 staging services are not ready: ${JSON.stringify(readiness)}`);
assert.equal(readiness.ready, true, 'P2 staging readiness must be true');

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ storageState: storageStatePath });
  const page = await context.newPage();
  for (const path of ['/supplier-portal/', '/brand-console/', '/quality-center/']) {
    const response = await page.goto(new URL(path, origin).toString(), { waitUntil: 'networkidle' });
    assert(response && response.ok(), `staging page failed: ${path}`);
    assert(!page.url().includes('?demo'), `demo mode must not be used: ${path}`);
    assert.equal(await page.locator('body').getAttribute('data-tracefab-demo'), null, `demo marker found: ${path}`);
  }
  await context.close();
} finally {
  await browser.close();
}
console.log('P2 staging E2E passed: real HTTPS staging, authenticated storage state, private-storage/email/alert readiness and three portal surfaces without mocks');
