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

/**
 * Ouvre une page authentifiee et attend qu'elle soit REELLEMENT prete.
 *
 * Attendre la seule session Clerk serait une course : `state.clerk.session`
 * est pose avant la synchronisation des organisations, et
 * `state.activeOrganizationId` / `state.selectedOrganizationId` n'arrive
 * qu'apres l'appel serveur qui resout le locataire. Lire l'identifiant
 * d'organisation avant qu'il soit pose echouerait de facon aleatoire.
 */
async function openAuthenticated(storageState, path, readySelector, globalName, organizationKey) {
  const context = await browser.newContext({
    storageState,
    // La locale est forcee : le runner GitHub est en `en-US`, et le
    // disclaimer du Quality Center est un texte traduit
    // (`quality.heroLede`, assets/i18n/fr.json). Sans locale imposee, la
    // page rendrait la variante anglaise et le controle echouerait pour une
    // raison etrangere au produit. Le controle accepte les deux langues.
    locale: 'fr-FR',
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
  await page.waitForFunction(
    ({ name, organizationKey: key }) => {
      const app = window[name];
      if (!app?.state || app.state.demo !== false || !app.state.user || !app.state.clerk?.session) return false;
      if (key && !app.state[key]) return false;
      return true;
    },
    { name: globalName, organizationKey: organizationKey },
    { timeout: 60000 },
  );
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

/**
 * Export du catalogue, tel que l'export le voit reellement.
 *
 * `headerOrganizationId` et `queryOrganizationId` sont distincts a dessein :
 * la precedence du locataire (en-tete, puis query) change la SIGNIFICATION de
 * la requete. Les tester separement, c'est tester deux contrats differents.
 */
async function exportCsv(page, { token, headerOrganizationId, queryOrganizationId }) {
  return page.evaluate(async ({ token, headerOrganizationId, queryOrganizationId }) => {
    const chemin = queryOrganizationId
      ? `/api/catalog/products/export?organizationId=${encodeURIComponent(queryOrganizationId)}`
      : '/api/catalog/products/export';
    const headers = { Authorization: `Bearer ${token}` };
    if (headerOrganizationId) headers['X-Tracefab-Organization-Id'] = headerOrganizationId;
    const response = await fetch(chemin, { headers });
    return {
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      body: await response.text(),
    };
  }, { token, headerOrganizationId, queryOrganizationId });
}

/**
 * Appel applicatif, avec en-tete de locataire optionnel.
 *
 * L'en-tete `X-Tracefab-Organization-Id` est ce que les routes resolvent
 * (api/_lib/tenant.ts) : c'est donc la seule maniere de demander
 * explicitement un locataire etranger.
 */
async function apiRequest(page, { method, path, token, headerOrganizationId, body }) {
  return page.evaluate(async ({ method, path, token, headerOrganizationId, body }) => {
    const headers = { Authorization: `Bearer ${token}` };
    if (headerOrganizationId) headers['X-Tracefab-Organization-Id'] = headerOrganizationId;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, contentType: response.headers.get('content-type') || '', body: text, json };
  }, { method, path, token, headerOrganizationId, body });
}

/**
 * References exportees. La premiere colonne du CSV de catalogue est
 * `reference` (api/_lib/catalog-importer.ts, CATALOG_EXPORT_HEADERS).
 */
function lignesCsv(body) {
  const lignes = String(body ?? '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((ligne) => ligne.trim() !== '');
  if (lignes.length === 0) return [];
  const indexReference = lignes[0].split(',').indexOf('reference');
  return lignes.slice(1).map((ligne) => {
    const cellule = indexReference >= 0 ? ligne.split(',')[indexReference] : ligne.split(',')[0];
    return String(cellule ?? '').replace(/^"|"$/g, '').trim();
  });
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
  // Reference unique par execution : la simulation ne persiste rien, mais un
  // doublon preexistant dans l'organisation ferait re-echo la valeur CSV
  // dans le message d'erreur du serveur, et le controle « la reponse ne
  // re-echo pas les valeurs CSV » echouerait alors pour une raison
  // etrangere au controle lui-meme.
  const referenceSimulation = `P1-STAGING-DRY-RUN-${Date.now()}`;

  const brandPage = await openAuthenticated(brandStatePath, '/brand-console/', 'h1.mc-headline', 'tracefabBrandConsole', 'activeOrganizationId');
  const brandAuth = await authContext(brandPage, 'tracefabBrandConsole', 'activeOrganizationId');
  const catalogPreview = await jsonRequest(brandPage, '/api/catalog/products/import', brandAuth, {
    brandOrganizationId: brandAuth.organizationId,
    filename: 'p1-staging-dry-run.csv',
    dryRun: true,
    csvContent: `reference,name,category\n${referenceSimulation},Staging dry run,T-shirt\n`,
  });
  assert.equal(catalogPreview.status, 200, `catalog dry run failed: ${JSON.stringify(catalogPreview.body)}`);
  assert.equal(catalogPreview.body.valid, true);
  assert.equal(JSON.stringify(catalogPreview.body).includes(referenceSimulation), false, 'preview must not echo raw CSV values');

  const qualityPage = await openAuthenticated(brandStatePath, '/quality-center/', 'h1', 'tracefabQualityCenter');
  // Le disclaimer existe dans les neuf langues de l'application ; la phrase
  // de reference est la francaise, celle du depot. La variante anglaise est
  // acceptee pour que le controle ne depende pas d'un choix de locale.
  const texteQuality = await qualityPage.locator('body').innerText();
  assert.match(
    texteQuality,
    /(statuts\s+déclaratifs[^]*certification|declarative\s+statuses[^]*certification)/i,
    'Quality Center disclaimer missing on staging',
  );

  const supplierPage = await openAuthenticated(supplierStatePath, '/supplier-portal/', 'h1.sp-hero-h1', 'tracefabSupplierPortal', 'selectedOrganizationId');
  const supplierAuth = await authContext(supplierPage, 'tracefabSupplierPortal', 'selectedOrganizationId');
  const bomResult = await jsonRequest(supplierPage, '/api/supplier/materials/import-bom', supplierAuth, {
    autoSaveMaterials: false,
    csvContent: 'Matiere;Pourcentage;Type;Pays;Standard;NumeroLicence;LotFournisseur\nCoton Bio;85%;fiber;PT;GOTS;CU-881294;LOT-P1-001\nCoton Recycle;15%;fiber;ES;GRS;IDFL-4412;LOT-P1-002\n',
  });
  assert.equal(bomResult.status, 200, `BOM validation failed: ${JSON.stringify(bomResult.body)}`);
  assert.equal(bomResult.body.isValid, true);
  assert.equal(bomResult.body.savedMaterialsCount, 0, 'staging BOM proof must not persist materials');

  const secondBrandPage = await openAuthenticated(secondBrandStatePath, '/brand-console/', 'h1.mc-headline', 'tracefabBrandConsole', 'activeOrganizationId');
  const secondBrandAuth = await authContext(secondBrandPage, 'tracefabBrandConsole', 'activeOrganizationId');
  assert.notEqual(secondBrandAuth.organizationId, brandAuth.organizationId, 'tenant-isolation test requires two distinct brand organizations');

  /* --- ISOLEMENT INTER-ORGANISATIONS ------------------------------------
   *
   * CONTRAT RETENU PAR LE PROPRIETAIRE (2026-10-23)
   *   « Un export visant une organisation etrangere est refuse selon le
   *     contrat anti-divulgation `404 organization_not_found`, sans
   *     elargissement du perimetre des donnees ; l'export du locataire
   *     autorise continue de fonctionner. »
   *
   * La suite mesure l'isolation sur TROIS plans, parce qu'une application
   * borne ses donnees a trois endroits distincts, et qu'un seul plan ne
   * prouve rien des deux autres :
   *
   *   1. LE RESOLVEUR DE LOCATAIRE (api/_lib/tenant.ts) — route
   *      `GET /api/catalog/products/export` : `requireActiveTenant` refuse un
   *      locataire non adherent par 404 `organization_not_found`, puis
   *      l'export porte sur UN locataire (`[tenant.organizationId]`).
   *   2. LES POLITIQUES RLS (base) — route `GET /api/catalog/export/products`
   *      : elle ne resout AUCUN locataire et interroge pourtant une table
   *      bornée par `tracefab_is_org_member(brand_organization_id)`. La seule
   *      barriere est donc la base. Une session d'une organisation qui
   *      demande les produits d'une autre doit obtenir ZERO ligne.
   *   3. LE CONTROLE APPLICATIF DES ECRITURES — `POST /api/products` et
   *      `POST /api/catalog/products/import` : une ecriture dirigee vers une
   *      organisation etrangere doit etre refusee AVANT toute persistance.
   *
   * PRECEDENCE DU LOCATAIRE (api/_lib/tenant.ts) : en-tete
   * `X-Tracefab-Organization-Id`, puis query `organizationId`, puis corps.
   * Les trois formes de demande n'ont donc pas le meme sens, et la suite les
   * mesure toutes.
   *
   * LE STATUT NE SUFFIT PAS : un 404 est un indice, pas une preuve. La preuve
   * est dans les DONNEES — zero ligne, et aucune reference de l'organisation
   * etrangere dans une reponse obtenue par l'appelant.
   *
   * IDENTITES DISTINCTES : deux personnes reellement differentes, chacune
   * authentifiee dans SA organisation. L'ancienne suite interrogeait le
   * locataire courant avec un parametre etranger : elle ne prouvait rien.
   */
  assert.ok(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(brandAuth.organizationId),
    'the first brand organization id must be a UUID',
  );
  assert.ok(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(secondBrandAuth.organizationId),
    'the second brand organization id must be a UUID',
  );
  assert.notEqual(secondBrandAuth.organizationId, brandAuth.organizationId, 'tenant-isolation test requires two distinct brand organizations');

  /* --- plan 1 : le resolveur de locataire --------------------------------- */

  // CONTROLE POSITIF : l'export du locataire autorise doit fonctionner.
  const exportPropre = await exportCsv(secondBrandPage, { token: secondBrandAuth.token, headerOrganizationId: secondBrandAuth.organizationId });
  assert.equal(exportPropre.status, 200, `own-tenant export failed: ${exportPropre.status}`);
  const refsPropres = lignesCsv(exportPropre.body);

  // Ce que l'organisation etrangere detient reellement : le contenu qui ne
  // doit JAMAIS apparaitre dans une reponse obtenue par l'appelant.
  const exportEtranger = await exportCsv(brandPage, { token: brandAuth.token, headerOrganizationId: brandAuth.organizationId });
  assert.equal(exportEtranger.status, 200, `own-tenant export of the second brand failed: ${exportEtranger.status}`);
  const refsEtrangers = lignesCsv(exportEtranger.body);

  // (1) en-tete etranger et (2) query etrangere sans en-tete : dans les deux
  // cas le serveur resout l'organisation ETRANGERE, et doit refuser.
  const crossEntete = await exportCsv(secondBrandPage, { token: secondBrandAuth.token, headerOrganizationId: brandAuth.organizationId });
  const crossQuery = await exportCsv(secondBrandPage, { token: secondBrandAuth.token, queryOrganizationId: brandAuth.organizationId });

  for (const [nom, reponse] of [['en-tete etranger', crossEntete], ['query etrangere', crossQuery]]) {
    assert.equal(
      reponse.status,
      404,
      `cross-tenant export (${nom}): 404 organization_not_found expected, got ${reponse.status}`,
    );
    let corps = null;
    try { corps = JSON.parse(reponse.body); } catch { corps = null; }
    assert.ok(corps && typeof corps.error === 'string', `cross-tenant refusal must be an error, not a document: ${reponse.body.slice(0, 120)}`);
    assert.equal(corps.error, 'organization_not_found', `cross-tenant refusal must use the anti-disclosure error, got: ${corps.error}`);
    assert.ok(!String(reponse.contentType).includes('text/csv'), `cross-tenant refusal (${nom}) must not be a CSV document`);
    assert.equal(lignesCsv(reponse.body).length, 0, `cross-tenant refusal (${nom}) must carry zero data row`);
  }

  // (3) En-tete propre + query etrangere : l'en-tete prime. La reponse doit
  // etre IDENTIQUE a l'export propre — un parametre etranger n'elargit pas le
  // perimetre, il est ecrase.
  const crossParametre = await exportCsv(secondBrandPage, { token: secondBrandAuth.token, headerOrganizationId: secondBrandAuth.organizationId, queryOrganizationId: brandAuth.organizationId });
  assert.equal(crossParametre.status, 200, `own-tenant export with a foreign parameter failed: ${crossParametre.status}`);
  assert.equal(crossParametre.body, exportPropre.body, 'a foreign organizationId must not widen the exported scope');

  // PREUVE AU NIVEAU DES DONNEES, dans les reponses de refus : aucune
  // reference — ni de l'organisation etrangere, ni du locataire appelant —
  // ne doit y figurer. Une reponse de refus est un document d'erreur : elle
  // ne peut rien contenir d'autre.
  for (const [nom, reponse] of [['en-tete etranger', crossEntete], ['query etrangere', crossQuery]]) {
    for (const ref of [...refsEtrangers, ...refsPropres]) {
      if (!ref) continue;
      assert.ok(!reponse.body.includes(ref), `cross-tenant refusal (${nom}) leaked a data reference`);
    }
  }
  const refsUniquementEtranger = refsEtrangers.filter((ref) => ref && !refsPropres.includes(ref));
  for (const ref of refsUniquementEtranger) {
    assert.ok(!crossParametre.body.includes(ref), 'a foreign organizationId widened the exported scope');
  }

  /* --- plan 2 : les politiques RLS, route sans resolveur de locataire ----- */

  // `GET /api/catalog/export/products` ne resout AUCUN locataire : elle
  // demande une organisation et interroge directement la table, bornee par
  // `tracefab_is_org_member(brand_organization_id)`. La seule barriere est
  // donc la base. La session de la marque B qui demande les produits de la
  // marque A doit obtenir ZERO ligne — pas un refus, pas un 403 : l'absence
  // de donnees.
  const rlsEtranger = await apiRequest(secondBrandPage, {
    method: 'GET',
    path: `/api/catalog/export/products?organizationId=${encodeURIComponent(brandAuth.organizationId)}`,
    token: secondBrandAuth.token,
  });
  assert.equal(rlsEtranger.status, 200, `RLS-scoped export failed: ${rlsEtranger.status}`);
  // Le statut 200 ne suffit pas : un corps d'erreur JSON compterait aussi
  // zero ligne. La reponse doit etre un DOCUMENT CSV, et vide de donnees.
  assert.ok(String(rlsEtranger.contentType).includes('text/csv'), `RLS-scoped export must be a CSV document, got ${rlsEtranger.contentType}`);
  const lignesRls = lignesCsv(rlsEtranger.body);
  assert.equal(lignesRls.length, 0, `RLS must return zero row for a foreign organization, got ${lignesRls.length}`);
  for (const ref of refsEtrangers) {
    if (!ref) continue;
    assert.ok(!rlsEtranger.body.includes(ref), 'RLS-scoped export leaked a reference of the foreign organization');
  }

  // Controle positif de la meme route : sa propre organisation lui rend ses
  // lignes. Sans ce controle, « zero ligne » ne prouverait rien.
  const rlsPropre = await apiRequest(secondBrandPage, {
    method: 'GET',
    path: `/api/catalog/export/products?organizationId=${encodeURIComponent(secondBrandAuth.organizationId)}`,
    token: secondBrandAuth.token,
  });
  assert.equal(rlsPropre.status, 200, `RLS-scoped own export failed: ${rlsPropre.status}`);
  // Controle positif par CONTENU, pas par comptage de lignes : une reference
  // peut contenir un separateur CSV, et le decoupage ligne a ligne compterait
  // alors des morceaux. Seules les references simples sont comparees.
  const refsSimples = refsPropres.filter((ref) => ref && !/[",;\r\n]/.test(ref));
  for (const ref of refsSimples) {
    assert.ok(rlsPropre.body.includes(ref), 'the own organization must get its own rows back through the RLS route');
  }

  /* --- plan 3 : lectures JSON bornees par organization -------------------- */

  // `GET /api/products` resout le locataire puis borne les lignes. Chaque
  // ligne renvoyee doit porter l'identifiant du locataire appelant : c'est
  // la preuve, ligne a ligne, que l'appelant ne voit que les siennes.
  const produitsPropres = await apiRequest(secondBrandPage, {
    method: 'GET',
    path: '/api/products',
    token: secondBrandAuth.token,
    headerOrganizationId: secondBrandAuth.organizationId,
  });
  assert.equal(produitsPropres.status, 200, `own product list failed: ${produitsPropres.status}`);
  const lignesPropres = Array.isArray(produitsPropres.json?.products) ? produitsPropres.json.products : [];
  for (const produit of lignesPropres) {
    assert.equal(
      produit.brandOrganizationId,
      secondBrandAuth.organizationId,
      'a product was returned from another organization',
    );
  }

  const produitsEtrangers = await apiRequest(secondBrandPage, {
    method: 'GET',
    path: '/api/products',
    token: secondBrandAuth.token,
    headerOrganizationId: brandAuth.organizationId,
  });
  assert.equal(produitsEtrangers.status, 404, `cross-tenant product list must be refused with 404, got ${produitsEtrangers.status}`);
  assert.equal(produitsEtrangers.json?.error, 'organization_not_found', 'cross-tenant product list must use the anti-disclosure error');
  assert.equal((produitsEtrangers.json?.products ?? []).length, 0, 'cross-tenant product list must carry zero row');

  // Les deux organisations expose-elles des produits DIFFERENTS ? Si oui,
  // l'isolation est demonstrable. Sinon, la suite le consigne (mesure, pas
  // echec) : l'absence de donnee n'est pas une fuite.
  const produitsMarqueA = await apiRequest(brandPage, {
    method: 'GET',
    path: '/api/products',
    token: brandAuth.token,
    headerOrganizationId: brandAuth.organizationId,
  });
  assert.equal(produitsMarqueA.status, 200, `first brand product list failed: ${produitsMarqueA.status}`);
  const lignesMarqueA = Array.isArray(produitsMarqueA.json?.products) ? produitsMarqueA.json.products : [];
  for (const produit of lignesMarqueA) {
    assert.equal(produit.brandOrganizationId, brandAuth.organizationId, 'a product was returned from another organization');
  }
  const refsMarqueA = lignesMarqueA.map((p) => p.reference).filter(Boolean);
  const refsMarqueB = lignesPropres.map((p) => p.reference).filter(Boolean);
  const refsCommunes = refsMarqueA.filter((ref) => refsMarqueB.includes(ref));

  /* --- plan 4 : ecritures et mutations sensibles ------------------------- */

  // W1 : creation d'un produit dans l'organisation etrangere, en gardant le
  // locator legitime. La garde applicative compare le corps a la
  // organisation active et refuse (`brand_organization_mismatch`).
  const referenceEcriture = `P1-ISOLATION-${Date.now()}`;
  const creationDirigee = await apiRequest(secondBrandPage, {
    method: 'POST',
    path: '/api/products',
    token: secondBrandAuth.token,
    headerOrganizationId: secondBrandAuth.organizationId,
    body: { brandOrganizationId: brandAuth.organizationId, reference: referenceEcriture, name: 'P1 isolation probe' },
  });
  assert.equal(creationDirigee.status, 400, `cross-tenant creation must be refused, got ${creationDirigee.status}`);
  assert.equal(creationDirigee.json?.error, 'brand_organization_mismatch', 'cross-tenant creation must be refused by the tenant guard');

  // W2 : meme ecriture, mais en demandant l'ORGANISATION ETRANGERE comme
  // locataire actif. Le resolveur refuse avant toute ecriture.
  const creationEnteteEtranger = await apiRequest(secondBrandPage, {
    method: 'POST',
    path: '/api/products',
    token: secondBrandAuth.token,
    headerOrganizationId: brandAuth.organizationId,
    body: { brandOrganizationId: brandAuth.organizationId, reference: referenceEcriture, name: 'P1 isolation probe' },
  });
  assert.equal(creationEnteteEtranger.status, 404, `cross-tenant creation with a foreign tenant header must be refused with 404, got ${creationEnteteEtranger.status}`);
  assert.equal(creationEnteteEtranger.json?.error, 'organization_not_found', 'cross-tenant creation must use the anti-disclosure error');

  // W3 : import catalogue vers l'organisation etrangere. La route verifie
  // l'appartenance de l'appelant a l'organisation cible et refuse ; la
  // simulation n'ecrit de toute facon rien.
  const importEtranger = await apiRequest(secondBrandPage, {
    method: 'POST',
    path: '/api/catalog/products/import',
    token: secondBrandAuth.token,
    headerOrganizationId: brandAuth.organizationId,
    body: {
      brandOrganizationId: brandAuth.organizationId,
      filename: 'p1-isolation-dry-run.csv',
      dryRun: true,
      csvContent: `reference,name,category\n${referenceEcriture},P1 isolation probe,T-shirt\n`,
    },
  });
  assert.equal(importEtranger.status, 403, `cross-tenant catalog import must be refused, got ${importEtranger.status}`);
  assert.equal(importEtranger.json?.error, 'brand_organization_access_denied', 'cross-tenant catalog import must be refused by the membership guard');

  // PREUVE DE NON-PERSISTANCE : la reference d'ecriture ne doit exister
  // dans AUCUNE des deux organisations. On relit les listes apres les
  // tentatives.
  const produitsApresEcritures = await apiRequest(brandPage, {
    method: 'GET',
    path: '/api/products',
    token: brandAuth.token,
    headerOrganizationId: brandAuth.organizationId,
  });
  const lignesApresEcritures = Array.isArray(produitsApresEcritures.json?.products) ? produitsApresEcritures.json.products : [];
  assert.ok(
    !lignesApresEcritures.some((produit) => produit.reference === referenceEcriture),
    'a refused cross-tenant write must not have persisted anything',
  );
  const produitsBapresEcritures = await apiRequest(secondBrandPage, {
    method: 'GET',
    path: '/api/products',
    token: secondBrandAuth.token,
    headerOrganizationId: secondBrandAuth.organizationId,
  });
  const lignesBapresEcritures = Array.isArray(produitsBapresEcritures.json?.products) ? produitsBapresEcritures.json.products : [];
  assert.ok(
    !lignesBapresEcritures.some((produit) => produit.reference === referenceEcriture),
    'a refused cross-tenant write must not have persisted anything',
  );

  // MESURES PUBLIEES : le journal de run n'est pas relisible depuis
  // l'exterieur, les annotations, si. Aucun contenu de donnee n'y figure :
  // uniquement des compteurs et des statuts.
  const mesures = [
    ['inter_tenant_export_refusal_status', String(crossEntete.status)],
    ['inter_tenant_export_refusal_error', 'organization_not_found'],
    ['inter_tenant_export_query_refusal_status', String(crossQuery.status)],
    ['inter_tenant_export_data_rows', '0'],
    ['rls_foreign_rows', String(lignesRls.length)],
    ['rls_own_refs', String(refsSimples.length)],
    ['products_own_rows', String(lignesPropres.length)],
    ['products_foreign_rows', '0'],
    ['products_brand_a_rows', String(lignesMarqueA.length)],
    ['shared_references_between_brands', String(refsCommunes.length)],
    ['write_cross_tenant_status', String(creationDirigee.status)],
    ['write_cross_tenant_error', 'brand_organization_mismatch'],
    ['write_foreign_tenant_status', String(creationEnteteEtranger.status)],
    ['write_import_foreign_status', String(importEtranger.status)],
    ['refused_write_persisted', 'none'],
    ['own_export_with_foreign_parameter', 'identical'],
  ];
  for (const [cle, valeur] of mesures) console.log(`::notice title=P1 staging::${cle}=${valeur}`);

  const verdict = `P1 staging E2E passed: non-demo Clerk auth, catalog dry-run, BOM non-persisting validation, Quality Center disclaimer, cross-tenant export denied (404 organization_not_found, zero data rows, own export unchanged), RLS returns zero row for a foreign organization, cross-tenant reads and writes refused and nothing persisted`;
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
