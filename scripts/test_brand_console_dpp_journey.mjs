#!/usr/bin/env node
/* ==========================================================================
   Parcours DPP marque — execution REELLE du JavaScript de la console.
   --------------------------------------------------------------------------
   Les autres suites de cette famille lisent le source et cherchent des
   chaines : elles prouvent qu'une ligne existe, pas qu'un bouton fait ce
   qu'il annonce. Ici, `brand-console.1.js` est execute dans un DOM (jsdom),
   les appels reseau sont interceptes, et l'on verifie le CORPS EXACT envoye
   aux routes du dossier DPP :

     1. activation d'un produit (draft -> active) ;
     2. depot d'un document (intent -> PUT -> scan) ;
     3. noeud de chaine portant UNE seule reference + un document ;
     4. data point marque portant `sourceDocumentId` ;
     5. identite resolvable puis publication du passeport.

   Ce que ce test ne prouve pas : que les routes acceptent ces corps (c'est
   le role de `test_product_edit_api.ts` et des contrats SQL), ni que la
   base est migree. Il prouve que l'interface n'invente ni ne perd de champ.
   ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// jsdom est une devDependency epinglee : son absence signifie une installation
// incomplete, pas un environnement sans navigateur. On echoue donc : un test
// qui se declare vert sans avoir rien execute est exactement le faux positif
// que cette suite existe pour eviter.
let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch (error) {
  console.error('ECHEC  jsdom introuvable — executer `npm ci` (devDependencies).');
  console.error(String(error && error.message ? error.message : error));
  process.exit(1);
}

const BRAND = '11111111-1111-4111-8111-111111111111';
const PRODUCT = '22222222-2222-4222-8222-222222222222';
const DOCUMENT = '33333333-3333-4333-8333-333333333333';
const MATERIAL = '44444444-4444-4444-8444-444444444444';
const SUPPLIER = '55555555-5555-4555-8555-555555555555';
const IDENTITY = '66666666-6666-4666-8666-666666666666';

const product = {
  id: PRODUCT,
  brandOrganizationId: BRAND,
  reference: 'TS-001',
  sku: null,
  name: 'T-shirt a dossier',
  category: 'T-shirt',
  status: 'draft',
  version: 1,
  publicSlug: null,
  description: null,
  colorName: null,
  sizeRange: null,
  countryOfDesign: null,
  countryOfManufacture: null,
  weightGrams: null,
  careInstructions: null,
  dataReadiness: 'draft',
  dataCompletion: '0',
};

const dppBase = {
  id: '77777777-7777-4777-8777-777777777777',
  productId: PRODUCT,
  productVersion: 1,
  profileKey: 'textile-apparel',
  profileVersion: '1',
  readinessStatus: 'data_ready',
  statusLabel: 'Structure technique complete',
  completionScore: 100,
  totalRequirements: 13,
  metRequirements: 13,
  blockingCount: 0,
  missingFields: [],
  blockingIssues: [],
  pillars: {},
  canMarkReadyToPublish: true,
  isReadyToPublish: false,
  computedAt: '2026-10-27T10:00:00.000Z',
  reviewedAt: null,
  reviewedBy: null,
  inputFingerprint: 'abc',
};

/* ------------------------------------------------------------------ réseau */
const calls = [];
// Etat mutable : les routes renvoient ce que la base contiendrait apres
// l'ecriture. Un stub figé masquerait precisement les bugs de rafraichissement.
const db = { identities: [], dpp: { ...null }, readiness: 'data_ready', slug: null };
const jsonResponse = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

function router(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const target = String(url);
  let body = null;
  if (typeof options.body === 'string') {
    try { body = JSON.parse(options.body); } catch { body = options.body; }
  }
  calls.push({ method, url: target, headers: options.headers || {}, body });

  const pathname = target.replace(/^https?:\/\/[^/]+/, '').split('?')[0];

  if (pathname === '/api/config') return jsonResponse(200, { publishableKey: 'pk_test_console' });
  if (pathname === '/api/me') return jsonResponse(200, {
    user: { id: 'user_1', email: 'brand@example.test', firstName: 'Brand' },
    memberships: [{
      organization_id: BRAND,
      role: 'owner',
      organizations: { id: BRAND, type: 'brand', legal_name: 'Atelier Test', display_name: 'Atelier Test' },
    }],
  });
  if (pathname === '/api/products') return jsonResponse(200, { products: [product] });
  if (pathname === '/api/suppliers') return jsonResponse(200, {
    suppliers: [{ organization_id: SUPPLIER, role: 'tier1', organizations: { display_name: 'Tissage Test', legal_name: 'Tissage Test' } }],
  });
  if (pathname === '/api/materials') return jsonResponse(200, {
    materials: [{ id: MATERIAL, name: 'Coton teste', originCountryCode: 'FR' }],
  });
  if (pathname === '/api/data-requests') return jsonResponse(200, { requests: [] });
  if (pathname === '/api/questionnaires') return jsonResponse(200, { questionnaires: [] });
  if (pathname === '/api/documents') return jsonResponse(200, {
    documents: [
      { id: DOCUMENT, kind: 'certificate', status: 'available', originalFilename: 'certificat-fournisseur.pdf', contentType: 'application/pdf', byteSize: 1024, createdAt: '2026-10-27T09:00:00.000Z' },
      { id: '88888888-8888-4888-8888-888888888888', kind: 'invoice', status: 'scanning', originalFilename: 'facture.pdf', contentType: 'application/pdf', byteSize: 512, createdAt: '2026-10-27T09:00:00.000Z' },
    ],
  });

  if (pathname === `/api/products/${PRODUCT}`) {
    return jsonResponse(200, {
      product: method === 'PATCH' ? { ...product, status: body?.status || product.status } : product,
      identifiers: [], materials: [], compositions: [],
    });
  }
  if (pathname === `/api/products/${PRODUCT}/data-points`) return jsonResponse(200, { dataPoints: [], definitions: {} });
  if (pathname === `/api/schema-bindings`) return jsonResponse(200, { bindings: [] });
  if (pathname === `/api/products/${PRODUCT}/data-points`) return jsonResponse(200, { dataPoints: [], definitions: {} });
  if (pathname === `/api/products/${PRODUCT}/supply-chain`) return jsonResponse(200, { graph: { nodes: [], links: [] }, summary: null });
  if (pathname === `/api/products/${PRODUCT}/mass-balance`) return jsonResponse(404, { error: 'not_found' });
  if (pathname === `/api/products/${PRODUCT}/dpp`) return jsonResponse(200, { dpp: { ...dppBase, readinessStatus: db.readiness } });
  if (pathname === `/api/products/${PRODUCT}/dpp/publish-review`) {
    db.readiness = 'ready_to_publish';
    return jsonResponse(200, { dpp: { ...dppBase, readinessStatus: db.readiness } });
  }
  if (pathname === `/api/products/${PRODUCT}/dpp/identities`) {
    if (method === 'POST') {
      const identity = { id: IDENTITY, public_id: body?.publicId, granularity: body?.granularity, qualifier: body?.qualifier || null, status: 'active', created_at: '2026-10-27T10:05:00.000Z' };
      db.identities.push(identity);
      return jsonResponse(201, { identity });
    }
    return jsonResponse(200, { identities: db.identities });
  }
  if (pathname === `/api/products/${PRODUCT}/dpp/publication`) {
    return jsonResponse(200, {
      dpp: { ...dppBase, readinessStatus: body?.action === 'publish' ? 'published' : 'ready_to_publish', statusLabel: 'Publie' },
      publication: { action: body?.action, publicSlug: body?.action === 'publish' ? body?.publicSlug : null },
    });
  }

  if (pathname === '/api/documents/upload-intent') {
    return jsonResponse(201, {
      document: { id: DOCUMENT, kind: body?.kind, originalFilename: body?.originalFilename, status: 'uploaded' },
      upload: { method: 'PUT', url: 'https://storage.test/put', headers: { 'x-test': '1' } },
      next: { scan: `/api/documents/${DOCUMENT}/scan` },
    });
  }
  if (target === 'https://storage.test/put') return jsonResponse(200, {});
  if (pathname === `/api/documents/${DOCUMENT}/scan`) return jsonResponse(200, { document: { id: DOCUMENT, status: 'available' } });

  if (pathname === `/api/products/${PRODUCT}/supply-chain/nodes`) return jsonResponse(201, { node: { id: '99999999-9999-4999-8999-999999999999', node_type: body?.nodeType, label: body?.label, status: 'documented' } });
  if (pathname === `/api/products/${PRODUCT}/data-points` && method === 'POST') return jsonResponse(201, { point: { dataKey: body?.dataKey, status: 'documented' } });

  return jsonResponse(404, { error: `unmapped_${pathname}` });
}

/* --------------------------------------------------------------- démarrage */
const html = fs
  .readFileSync(path.join(root, 'brand-console/index.html'), 'utf8')
  .replace(/<script src="[^"]*"><\/script>/g, '');

const url = `https://console.test/brand-console/?view=productDetail&productId=${PRODUCT}`;
const dom = new JSDOM(html, { url, runScripts: 'dangerously', pretendToBeVisual: true });
const { window } = dom;

const confirmations = [];
window.confirm = (message) => { confirmations.push(message); return true; };
window.alert = () => {};
window.fetch = (input, options) => Promise.resolve(router(input, options));

// jsdom n'implemente ni les File de formulaire ni les navigations completement :
// on fournit ce que la console utilise reellement.
if (!window.structuredClone) window.structuredClone = (value) => JSON.parse(JSON.stringify(value));

window.Clerk = {
  loaded: true,
  user: { id: 'user_1', primaryEmailAddress: { emailAddress: 'brand@example.test' } },
  session: { getToken: async () => 'test-token' },
  load: async () => {},
  addListener: () => {},
  mountSignIn: () => {},
  signOut: async () => {},
};

const scripts = [
  'assets/js/tf-actions.js',
  'assets/js/tf-skip-meta.js',
  'assets/i18n/en.js',
  'assets/js/tf-i18n.js',
  'assets/js/tf-demo-figures.js',
  'assets/js/brand-console.1.js',
];
for (const script of scripts) {
  const code = fs.readFileSync(path.join(root, script), 'utf8');
  window.eval(code);
}

const errors = [];
window.addEventListener('error', (event) => errors.push(event.message));
process.on('unhandledRejection', (reason) => errors.push(`unhandled: ${reason}`));

const flush = async (times = 12) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setTimeout(resolve, 12));
};

await flush();

const app = window.document.getElementById('app');
const state = window.tracefabBrandConsole?.state;

const results = [];
function check(label, condition, detail = '') {
  results.push({ label, ok: Boolean(condition), detail });
  if (!condition) console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

function click(selector) {
  const element = window.document.querySelector(selector);
  if (!element) throw new Error(`element introuvable: ${selector}`);
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  return element;
}

function submit(formSelector) {
  const form = window.document.querySelector(formSelector);
  if (!form) throw new Error(`formulaire introuvable: ${formSelector}`);
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  return form;
}

function setValue(selector, value) {
  const element = window.document.querySelector(selector);
  if (!element) throw new Error(`champ introuvable: ${selector}`);
  element.value = value;
  element.dispatchEvent(new window.Event('input', { bubbles: true }));
  element.dispatchEvent(new window.Event('change', { bubbles: true }));
}

const last = (predicate) => [...calls].reverse().find(predicate);

/* ------------------------------------------------------ 0. démarrage réel */
check('console demarree en mode reel (pas demonstration)', state && state.demo === false, state ? `demo=${state.demo}` : 'state absent');
check('produit charge dans le catalogue', (state?.products || []).some((p) => p.id === PRODUCT));
check('aucune erreur JavaScript au demarrage', errors.length === 0, errors.join(' | '));

/* ------------------------------------------- 1. activation draft -> active */
await flush(4);
const activationButton = window.document.querySelector('[data-action="activate-product"]');
check('la fiche produit expose le bouton d activation', Boolean(activationButton));
if (activationButton) {
  click('[data-action="activate-product"]');
  await flush();
  const patch = last((call) => call.method === 'PATCH' && call.url === `/api/products/${PRODUCT}`);
  check('activation : PATCH /api/products/:id emis', Boolean(patch));
  check('activation : corps exact { status: "active" }', Boolean(patch) && JSON.stringify(patch.body) === '{"status":"active"}', patch ? JSON.stringify(patch.body) : 'aucun appel');
  check('activation : confirmation demandee avant l acte', confirmations.length > 0);
      check('activation : le statut affiche suit la reponse', state?.selectedProductDetail?.product?.status === 'active', String(state?.selectedProductDetail?.product?.status));
}

/* ------------------------------------------------- 2. depot d'un document */
state.view = 'documents';
window.tracefabBrandConsole.state.selectedProduct = product;
click('[data-view="products"]');
await flush(4);
const documentsNav = window.document.querySelector('[data-view="documents"]');
if (documentsNav) { documentsNav.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await flush(6); }
check('registre documentaire charge depuis /api/documents', Array.isArray(state?.documents) && state.documents.length === 2, JSON.stringify(state?.documents));

const uploadButton = window.document.querySelector('[data-action="upload-document"]');
check('le bouton Importer est actif (non desactive)', Boolean(uploadButton) && uploadButton.disabled !== true);
if (uploadButton) {
  click('[data-action="upload-document"]');
  await flush(4);
  const form = window.document.getElementById('upload-document-form');
  check('la modale de depot s ouvre', Boolean(form));
  if (form) {
    setValue('#upload-document-form select[name="kind"]', 'certificate');
    const input = form.querySelector('input[name="file"]');
    const file = new window.File(['%PDF-1.4 test'], 'certificat-fournisseur.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    submit('#upload-document-form');
    await flush(14);
    const intent = last((call) => call.url === '/api/documents/upload-intent');
    check('depot : intention creee', Boolean(intent) && intent.method === 'POST');
    check('depot : metadonnees completes', Boolean(intent) && intent.body?.originalFilename === 'certificat-fournisseur.pdf' && intent.body?.contentType === 'application/pdf' && intent.body?.kind === 'certificate' && intent.body?.byteSize > 0, intent ? JSON.stringify(intent.body) : 'aucun');
    check('depot : octets envoyes au stockage presigne', Boolean(last((call) => call.url === 'https://storage.test/put' && call.method === 'PUT')));
    check('depot : scan declenche apres le transfert', Boolean(last((call) => call.method === 'POST' && call.url === `/api/documents/${DOCUMENT}/scan`)));
    check('depot : aucun jeton Clerk envoye au stockage tiers', !JSON.stringify(last((call) => call.url === 'https://storage.test/put')?.headers || {}).toLowerCase().includes('authorization'));
  }
}

/* ------------------------------------- 3. noeud de chaine + document source */
await window.tracefabBrandConsole.state && flush(2);
state.view = 'supplyChain';
window.tracefabBrandConsole.state.selectedSupplyChainProduct = product;
const chainNav = window.document.querySelector('[data-view="supplyChain"]');
if (chainNav) { chainNav.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await flush(8); }
await flush(6);

const addNode = window.document.querySelector('[data-action="new-chain-node"]');
check('la vue tracabilite expose l ajout de noeud', Boolean(addNode));
if (addNode) {
  click('[data-action="new-chain-node"]');
  await flush(4);
  const form = window.document.getElementById('chain-node-form');
  check('la modale de noeud s ouvre', Boolean(form));
  if (form) {
    setValue('#chain-node-form input[name="label"]', 'Teinture test');
    setValue('#chain-node-form select[name="nodeType"]', 'material');
    setValue('#chain-node-form select[name="materialId"]', MATERIAL);
    setValue('#chain-node-form select[name="organizationId"]', SUPPLIER);
    setValue('#chain-node-form select[name="sourceDocumentId"]', DOCUMENT);
    submit('#chain-node-form');
    await flush(12);
    const post = last((call) => call.method === 'POST' && call.url === `/api/products/${PRODUCT}/supply-chain/nodes`);
    check('noeud : POST emis', Boolean(post));
    const body = post?.body || {};
    const references = [body.materialId, body.organizationId, body.processCode].filter(Boolean);
    check('noeud : une seule reference envoyee', references.length === 1, JSON.stringify(body));
    check('noeud : la reference est celle du type choisi', body.materialId === MATERIAL && body.organizationId === null && body.processCode === null, JSON.stringify(body));
    check('noeud : document source transmis', body.sourceDocumentId === DOCUMENT, JSON.stringify(body));
  }
}

/* --------------------------------------- 4. data point + document source */
// Retour a la liste puis ouverture de la fiche par son bouton : c'est le
// chemin reel de l'utilisateur (la vue liste porte [data-product-id]).
const productNav = window.document.querySelector('[data-view="products"]');
if (productNav) { productNav.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await flush(6); }
click(`[data-product-id="${PRODUCT}"]`);
await flush(14);
const dataPointForm = window.document.getElementById('product-data-point-form');
check('la fiche produit expose le formulaire de data point', Boolean(dataPointForm));
if (dataPointForm) {
  check('le formulaire propose un document source', Boolean(dataPointForm.querySelector('select[name="sourceDocumentId"]')));
  const options = [...dataPointForm.querySelectorAll('select[name="sourceDocumentId"] option')].map((option) => option.value).filter(Boolean);
  check('seuls les documents disponibles sont rattachables', options.length === 1 && options[0] === DOCUMENT, options.join(','));
  setValue('#product-data-point-form select[name="dataKey"]', dataPointForm.querySelector('select[name="dataKey"]')?.value || 'product.fiber_composition');
  setValue('#product-data-point-form select[name="sourceDocumentId"]', DOCUMENT);
  const valueField = dataPointForm.querySelector('[name="value"]');
  if (valueField) valueField.value = '100 % coton (test)';
  submit('#product-data-point-form');
  await flush(12);
  const post = last((call) => call.method === 'POST' && call.url === `/api/products/${PRODUCT}/data-points`);
  check('data point : POST emis', Boolean(post));
  check('data point : sourceDocumentId transmis', Boolean(post) && post.body?.sourceDocumentId === DOCUMENT, post ? JSON.stringify(post.body) : 'aucun');
}

/* ------------------------------- 5. identite resolvable puis publication */
// Le bouton « Preparer le DPP » de la fiche est l'entree nominale : il charge
// le dossier ET ses identites (lecture auxiliaire).
click('[data-action="product-dpp-from-detail"]');
await flush(16);
const identityForm = window.document.getElementById('dpp-identity-form');
check('la vue DPP expose la creation d identite', Boolean(identityForm));
if (identityForm) {
  setValue('#dpp-identity-form input[name="publicId"]', 'ts001-modele-2026');
  setValue('#dpp-identity-form select[name="granularity"]', 'model');
  submit('#dpp-identity-form');
  await flush(12);
  const post = last((call) => call.method === 'POST' && call.url === `/api/products/${PRODUCT}/dpp/identities`);
  check('identite : POST emis', Boolean(post));
  check('identite : corps conforme au contrat', Boolean(post) && post.body?.publicId === 'ts001-modele-2026' && post.body?.granularity === 'model', post ? JSON.stringify(post.body) : 'aucun');
  check('identite : QR expose pour un identifiant cree', Boolean(window.document.querySelector('a[href^="/api/resolve/"]')));
}

// La publication n'apparait QU'APRES la revue interne : c'est la regle du
// dossier, et le test la verifie au lieu de la contourner.
check('publication indisponible avant la revue', !window.document.getElementById('dpp-publication-form'));
click('[data-action="publish-dpp"]');
await flush(14);
const publicationForm = window.document.getElementById('dpp-publication-form');
check('la vue DPP expose la publication quand le dossier est pret', Boolean(publicationForm) || Boolean(window.document.querySelector('[data-action="suspend-dpp"]')));
if (publicationForm) {
  setValue('#dpp-publication-form input[name="publicSlug"]', 'ts001-atelier-test');
  submit('#dpp-publication-form');
  await flush(12);
  const post = last((call) => call.method === 'POST' && call.url === `/api/products/${PRODUCT}/dpp/publication`);
  check('publication : POST emis', Boolean(post));
  check('publication : action et slug transmis', Boolean(post) && post.body?.action === 'publish' && post.body?.publicSlug === 'ts001-atelier-test', post ? JSON.stringify(post.body) : 'aucun');
  check('publication : confirmation demandee', confirmations.some((message) => /publi/i.test(message)));
  check('publication : le slug public est conserve pour le lien', window.tracefabBrandConsole.state.selectedDppProduct?.publicSlug === 'ts001-atelier-test', String(window.tracefabBrandConsole.state.selectedDppProduct?.publicSlug));
}

/* ------------------------------------------------------------- conclusion */
check('aucune erreur JavaScript pendant le parcours', errors.length === 0, errors.join(' | '));

const failed = results.filter((result) => !result.ok);
console.log(`\nParcours DPP console : ${results.length - failed.length}/${results.length} verifications reussies.`);
if (failed.length) {
  console.error(`${failed.length} verification(s) en echec :`);
  for (const failure of failed) console.error(` - ${failure.label}${failure.detail ? ` (${failure.detail})` : ''}`);
  process.exit(1);
}
console.log('Parcours DPP console : OK — activation, document, noeud, data point, identite et publication emettent les corps attendus.');
