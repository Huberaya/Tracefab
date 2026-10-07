import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const baseUrl = process.env.TRACEFAB_STAGING_URL?.trim();
const brandStatePath = process.env.TRACEFAB_P1_BRAND_STORAGE_STATE?.trim();
const supplierStatePath = process.env.TRACEFAB_P1_SUPPLIER_STORAGE_STATE?.trim();
const secondBrandStatePath = process.env.TRACEFAB_P1_SECOND_BRAND_STORAGE_STATE?.trim();

if (!baseUrl || !brandStatePath || !supplierStatePath || !secondBrandStatePath) {
  throw new Error('P1 staging E2E requires TRACEFAB_STAGING_URL, TRACEFAB_P1_BRAND_STORAGE_STATE, TRACEFAB_P1_SUPPLIER_STORAGE_STATE and TRACEFAB_P1_SECOND_BRAND_STORAGE_STATE; no mock/demo fallback is allowed');
}
for (const path of [brandStatePath, supplierStatePath, secondBrandStatePath]) {
  if (!existsSync(path)) throw new Error(`P1 staging storage state not found: ${path}`);
}
const origin = new URL(baseUrl);
assert.equal(origin.protocol, 'https:', 'P1 staging URL must use HTTPS');

const browser = await chromium.launch({ headless: true });
const contexts = [];

async function openAuthenticated(storageState, path, readySelector, globalName) {
  const context = await browser.newContext({ storageState });
  contexts.push(context);
  const page = await context.newPage();
  const response = await page.goto(new URL(path, origin).toString(), { waitUntil: 'networkidle' });
  assert(response && response.ok(), `staging page failed: ${path}`);
  assert(!page.url().includes('?demo'), `demo mode must not be used: ${path}`);
  assert.equal(await page.locator('body').getAttribute('data-tracefab-demo'), null, `demo marker found: ${path}`);
  await page.locator(readySelector).waitFor();
  await page.waitForFunction((name) => {
    const app = window[name];
    return Boolean(app?.state && app.state.demo === false && app.state.user && app.state.clerk?.session);
  }, globalName);
  return page;
}

async function authContext(page, globalName, organizationKey) {
  return page.evaluate(async ({ name, organizationKey: key }) => {
    const state = window[name].state;
    const token = await state.clerk.session.getToken();
    const organizationId = state[key];
    if (!token || !organizationId || String(organizationId).startsWith('demo-')) throw new Error('authenticated non-demo organization context missing');
    return { token, organizationId };
  }, { name: globalName, organizationKey });
}

async function jsonRequest(page, path, auth, body) {
  return page.evaluate(async ({ path, auth, body }) => {
    const response = await fetch(path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
        'X-Tracefab-Organization-Id': auth.organizationId,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }, { path, auth, body });
}

try {
  const brandPage = await openAuthenticated(brandStatePath, '/brand-console/', 'h1.mc-headline', 'tracefabBrandConsole');
  const brandAuth = await authContext(brandPage, 'tracefabBrandConsole', 'activeOrganizationId');
  const catalogPreview = await jsonRequest(brandPage, '/api/catalog/products/import', brandAuth, {
    brandOrganizationId: brandAuth.organizationId,
    filename: 'p1-staging-dry-run.csv',
    dryRun: true,
    csvContent: 'reference,name,category\nP1-STAGING-DRY-RUN,Staging dry run,T-shirt\n',
  });
  assert.equal(catalogPreview.status, 200, `catalog dry run failed: ${JSON.stringify(catalogPreview.body)}`);
  assert.equal(catalogPreview.body.valid, true);
  assert.equal(JSON.stringify(catalogPreview.body).includes('P1-STAGING-DRY-RUN'), false, 'preview must not echo raw CSV values');

  const qualityPage = await openAuthenticated(brandStatePath, '/quality-center/', 'h1', 'tracefabQualityCenter');
  assert.match(await qualityPage.locator('body').innerText(), /statuts déclaratifs.*certification/s, 'Quality Center disclaimer missing on staging');

  const supplierPage = await openAuthenticated(supplierStatePath, '/supplier-portal/', 'h1.sp-hero-h1', 'tracefabSupplierPortal');
  const supplierAuth = await authContext(supplierPage, 'tracefabSupplierPortal', 'selectedOrganizationId');
  const bomResult = await jsonRequest(supplierPage, '/api/supplier/materials/import-bom', supplierAuth, {
    autoSaveMaterials: false,
    csvContent: 'Matiere;Pourcentage;Type;Pays;Standard;NumeroLicence;LotFournisseur\nCoton Bio;85%;fiber;PT;GOTS;CU-881294;LOT-P1-001\nCoton Recycle;15%;fiber;ES;GRS;IDFL-4412;LOT-P1-002\n',
  });
  assert.equal(bomResult.status, 200, `BOM validation failed: ${JSON.stringify(bomResult.body)}`);
  assert.equal(bomResult.body.isValid, true);
  assert.equal(bomResult.body.savedMaterialsCount, 0, 'staging BOM proof must not persist materials');

  const secondBrandPage = await openAuthenticated(secondBrandStatePath, '/brand-console/', 'h1.mc-headline', 'tracefabBrandConsole');
  const secondBrandAuth = await authContext(secondBrandPage, 'tracefabBrandConsole', 'activeOrganizationId');
  assert.notEqual(secondBrandAuth.organizationId, brandAuth.organizationId, 'tenant-isolation test requires two distinct brand organizations');
  const forbidden = await secondBrandPage.evaluate(async ({ token, organizationId, foreignOrganizationId }) => {
    const response = await fetch(`/api/catalog/products/export?organizationId=${encodeURIComponent(foreignOrganizationId)}`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Tracefab-Organization-Id': organizationId },
    });
    return { status: response.status, body: await response.text() };
  }, { token: secondBrandAuth.token, organizationId: secondBrandAuth.organizationId, foreignOrganizationId: brandAuth.organizationId });
  assert.equal(forbidden.status, 403, `cross-tenant export was not rejected: ${forbidden.status}`);

  console.log('P1 staging E2E passed: non-demo Clerk auth, catalog dry-run, BOM non-persisting validation, Quality Center disclaimer and cross-tenant export denial');
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
}
