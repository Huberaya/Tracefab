import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const baseUrl = process.env.TRACEFAB_STAGING_URL?.trim();
const brandStatePath = process.env.TRACEFAB_P1_BRAND_STORAGE_STATE?.trim();
const supplierStatePath = process.env.TRACEFAB_P1_SUPPLIER_STORAGE_STATE?.trim();
const secondBrandStatePath = process.env.TRACEFAB_P1_SECOND_BRAND_STORAGE_STATE?.trim();

/**
 * Contournement de la protection de deploiement Vercel — OPTIONNEL.
 *
 * Les Previews Vercel de ce projet sont derriere la protection de deploiement
 * (SSO). Une requete non authentifiee y reçoit un 302 vers `/sso-api` : le
 * runner atteint la protection, pas l'application. Quand le projet expose un
 * secret « Protection Bypass for Automation », l'envoyer dans l'en-tete
 * `x-vercel-protection-bypass` ouvre la Preview.
 *
 * Ce comportement est STRICTEMENT OPTIONNEL : sans cette variable, la suite
 * s'execute exactement comme avant. La valeur ne doit jamais etre affichee,
 * ni loguee, ni placee dans une URL.
 */
const vercelBypass = process.env.TRACEFAB_VERCEL_BYPASS?.trim() || '';
const bypassHeaders = vercelBypass
  ? { 'x-vercel-protection-bypass': vercelBypass, 'x-vercel-set-bypass-cookie': 'true' }
  : {};

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
  const context = await browser.newContext({
    storageState,
    ...(Object.keys(bypassHeaders).length ? { extraHTTPHeaders: bypassHeaders } : {}),
  });
  contexts.push(context);
  const page = await context.newPage();
  // Les appels faits par la page elle-meme (les exports, les simulations) sont
  // same-origin : ils doivent porter le meme contournement que la navigation,
  // sinon la protection les intercepterait aussi.
  if (Object.keys(bypassHeaders).length) {
    await page.addInitScript((headers) => {
      const original = window.fetch.bind(window);
      window.fetch = (input, init = {}) => {
        const merged = { ...(init.headers || {}) };
        for (const [name, value] of Object.entries(headers)) merged[name] = value;
        return original(input, { ...init, headers: merged });
      };
    }, bypassHeaders);
  }
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

  /* --- ISOLEMENT INTER-ORGANISATIONS ------------------------------------
   *
   * Le contrat de refus du depot est explicite et non negociable : un
   * locataire auquel l'appelant n'adhere pas est refuse par 404
   * `organization_not_found`, et NON par 403 — « un 403 revelerait que
   * l'organisation existe » (api/_lib/tenant.ts). Ce contrat est protege par
   * une non-regression locale (scripts/test_active_tenant_context.mjs), et il
   * est present dans le SHA de la Preview.
   *
   * L'attente « 403 » qu'ecritait la premiere version de cette suite datait
   * du 2026-10-07, avant le changement de contrat du 2026-10-17, et n'avait
   * jamais ete executee contre une Preview : la procedure etait alors notee
   * « NON VERIFIABLE » dans docs/experience/. Une attente non executee n'est
   * pas une preuve ; elle est une hypothese. La suite mesure donc la
   * propriete reelle, en deux temps.
   *
   *   (a) la demande qui REVENDIQUE le locataire de l'autre marque doit etre
   *       REFUSEE : ni donnees, ni document, seulement une erreur. Le statut
   *       observe est publie (404 aujourd'hui, par decision de securite ;
   *       403 resterait un refus correct) ;
   *   (b) la demande qui garde son propre locataire mais nomme l'autre dans
   *       la query string doit rendre EXACTEMENT les memes lignes que la
   *       demande sans ce parametre : un parametre etranger n'elargit pas le
   *       perimetre. C'est la preuve qu'aucune fuite inter-organisation n'est
   *       possible, y compris quand l'appelant est de bonne foi.
   */
  const crossTenant = await secondBrandPage.evaluate(async ({ token, foreignOrganizationId }) => {
    const response = await fetch(`/api/catalog/products/export?organizationId=${encodeURIComponent(foreignOrganizationId)}`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Tracefab-Organization-Id': foreignOrganizationId },
    });
    return { status: response.status, body: await response.text() };
  }, { token: secondBrandAuth.token, foreignOrganizationId: brandAuth.organizationId });
  assert.ok(
    crossTenant.status === 403 || crossTenant.status === 404,
    `cross-tenant export was not rejected: ${crossTenant.status}`,
  );
  let corpsRefus = null;
  try { corpsRefus = JSON.parse(crossTenant.body); } catch { corpsRefus = null; }
  assert.ok(
    corpsRefus && typeof corpsRefus.error === 'string',
    `cross-tenant refusal must be an error, not a document: ${crossTenant.body.slice(0, 120)}`,
  );
  console.log(`inter_tenant_export_refusal_status=${crossTenant.status}`);
  console.log(`inter_tenant_export_refusal_error=${corpsRefus.error}`);

  const exportPropre = await secondBrandPage.evaluate(async ({ token, organizationId }) => {
    const response = await fetch('/api/catalog/products/export', {
      headers: { Authorization: `Bearer ${token}`, 'X-Tracefab-Organization-Id': organizationId },
    });
    return { status: response.status, body: await response.text() };
  }, { token: secondBrandAuth.token, organizationId: secondBrandAuth.organizationId });
  assert.equal(exportPropre.status, 200, `own-tenant export failed: ${exportPropre.status}`);

  const exportUsurpe = await secondBrandPage.evaluate(async ({ token, organizationId, foreignOrganizationId }) => {
    const response = await fetch(`/api/catalog/products/export?organizationId=${encodeURIComponent(foreignOrganizationId)}`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Tracefab-Organization-Id': organizationId },
    });
    return { status: response.status, body: await response.text() };
  }, { token: secondBrandAuth.token, organizationId: secondBrandAuth.organizationId, foreignOrganizationId: brandAuth.organizationId });
  assert.equal(exportUsurpe.status, 200, `own-tenant export with a foreign parameter failed: ${exportUsurpe.status}`);
  assert.equal(
    exportUsurpe.body,
    exportPropre.body,
    'a foreign organizationId must not widen the exported scope',
  );

  const verdict = `P1 staging E2E passed: non-demo Clerk auth, catalog dry-run, BOM non-persisting validation, Quality Center disclaimer, cross-tenant export denial (HTTP ${crossTenant.status})`;
  console.log(verdict);
  // Le verdict sort aussi en annotation : l'hote qui sert les journaux de run
  // n'est pas joignable depuis un bac a sable d'analyse, alors que
  // api.github.com l'est. Sans cela, une reussite resterait illisible.
  console.log(`::notice title=P1 staging::${verdict}`);
} catch (error) {
  const message = String(error?.message || error).split('\n')[0].slice(0, 200);
  console.error(`::error title=P1 staging::${message}`);
  throw error;
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
}
