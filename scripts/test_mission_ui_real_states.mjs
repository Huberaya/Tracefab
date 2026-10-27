#!/usr/bin/env node
/**
 * Etats REELS de l'interface — preuves navigateur.
 *
 * Ce test ne remplace AUCUNE integration par un mock presente comme
 * operationnelle : les reponses API ci-dessous sont des FIXTURES servant a
 * verifier les etats de l'interface (chargement, erreur explicite avec code et
 * reessai, absence de document, depot, apercu prive). La realite du backend
 * est eprouvee separement par `npm run test:mission-functional` sur PostgreSQL
 * jetable et par les suites CI.
 *
 *Usage : npm run test:mission-ui:states
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { launchTestBrowser } from './lib/launch_chromium.mjs';

const PORT = 4191;
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['scripts/dev_static_server.mjs', '--port', String(PORT)], {
  cwd: new URL('..', import.meta.url), stdio: 'ignore',
});

let browser;
const resultats = [];
async function check(nom, fn) {
  try { await fn(); resultats.push([nom, true]); console.log(`OK   ${nom}`); }
  catch (error) { resultats.push([nom, false, error.message]); console.log(`ECHEC ${nom}\n        -> ${error.message}`); }
}

const DOC = {
  id: '11111111-1111-4111-8111-111111111111',
  ownerOrganizationId: '22222222-2222-4222-8222-222222222222',
  originalFilename: 'mission-certificate.pdf',
  contentType: 'application/pdf',
  byteSize: 1024,
  kind: 'certificate',
  status: 'available',
  visibility: 'private',
  createdAt: '2026-10-26T10:00:00.000Z',
  updatedAt: '2026-10-26T10:00:00.000Z',
  metadata: { productId: '33333333-3333-4333-8333-333333333333', issuer: 'Mission Lab' },
  validation: { status: 'passed', reason: 'Certificat coherent', method: 'manual_review_v1' },
};
const PREVIEW = {
  preview: true, private: true, published: false, state: 'incomplete',
  product: { id: '33333333-3333-4333-8333-333333333333', reference: 'MISSION-001', name: 'Mission T-shirt', version: 1, status: 'draft', category: 'T-shirt', description: 'Donnee persistee' },
  identifiers: [{ type: 'GTIN', value: '3760123456789', is_primary: true }],
  composition: [{ material: 'Organic cotton', percentage: '85', origin: 'FR', role: 'primary' }],
  dataPoints: [{ key: 'main_material_percentage', value: 85, status: 'declared', version: 1 }],
  documents: [{ id: DOC.id, filename: DOC.originalFilename, status: 'available', kind: 'certificate' }],
  dossier: { readinessStatus: 'in_progress', blockingCount: 1, missingFields: [{ key: 'product.description', label: 'Description', blocking: true }] },
  trust: { note: 'Valeurs relues en base — aucune verification inventees.' },
};

try {
  await delay(350);
  browser = await launchTestBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const erreurs = [];
  page.on('console', (m) => { if (m.type() === 'error') erreurs.push(m.text()); });
  page.on('pageerror', (e) => erreurs.push(e.message));

  let mode = 'ok';
  await page.route('**/api/documents', (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    if (mode === 'error') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'documents_backend_down' }) });
    if (mode === 'empty') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ documents: [] }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ documents: [DOC] }) });
  });
  await page.route('**/api/documents/upload-intent*', (route) => route.fulfill({
    status: 201, contentType: 'application/json',
    body: JSON.stringify({ document: DOC, upload: { method: 'PUT', url: `${BASE}/__put/mission.pdf`, headers: { 'Content-Type': 'application/pdf' } } }),
  }));
  await page.route('**/__put/**', (route) => route.fulfill({ status: 200, body: '' }));
  await page.route('**/api/documents/*/scan', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'available' }) }));
  await page.route('**/api/products/*/dpp/preview*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PREVIEW) }));
  await page.route('**/api/products/*/dpp', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ dpp: PREVIEW.dossier }) }));

  await page.goto(`${BASE}/brand-console/?demo=1&lang=en&view=documents`, { waitUntil: 'networkidle' });
  await page.locator('.app').waitFor();

  await check('documents : etats branches sur la vraie route (pas de demo)', async () => {
    await page.evaluate(() => {
      const s = window.tracefabBrandConsole.state;
      s.demo = false;
      s.activeOrganizationId = '22222222-2222-4222-8222-222222222222';
      s.documents = null;
    });
    await page.locator('.nav button[data-view="documents"]').click();
    await page.getByText('mission-certificate.pdf').first().waitFor({ timeout: 10000 });
    const texte = await page.locator('.content').innerText();
    assert.match(texte, /available/i);
    assert.match(texte, /passed|Certificat coherent/i);
    assert.ok(await page.locator('[data-action="download-document"]').count() >= 1, 'action de telechargement');
    assert.ok(await page.locator('[data-action="review-document"]').count() >= 1, 'action de decision');
  });

  await check('documents : erreur explicite avec code et reessai', async () => {
    mode = 'error';
    await page.locator('[data-action="retry-documents"]').first().click();
    await page.getByText(/documents_backend_down/).first().waitFor({ timeout: 10000 });
    assert.ok(await page.locator('[data-action="retry-documents"]').count() >= 1, 'bouton de reessai conserve');
  });

  await check('documents : etat vide distinct de "non calcule"', async () => {
    mode = 'empty';
    await page.locator('[data-action="retry-documents"]').first().click();
    await page.waitForTimeout(120);
    const texte = await page.locator('.content').innerText();
    assert.match(texte, /no document|aucune source|no evidence/i);
    assert.doesNotMatch(texte, /documents_backend_down/);
  });

  await check('depot : formulaire reel, aucun faux succes', async () => {
    mode = 'ok';
    await page.locator('[data-action="open-upload-document"]').click();
    await page.locator('#upload-document-form').waitFor();
    await page.locator('#upload-document-form input[type="file"]').setInputFiles({
      name: 'mission-certificate.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 mission'),
    });
    await page.locator('#upload-document-form button[type="submit"]').click();
    await page.waitForTimeout(250);
    // Le depot reussi ferme la modale ; une panne de stockage doit rester visible.
    const modaleOuverte = await page.locator('#upload-document-form').count();
    const erreurVisible = await page.locator('.modal .notice-error').count();
    assert.ok(modaleOuverte === 0 || erreurVisible > 0,
      'succes = modale fermee, echec = erreur explicite : jamais de succes silencieux');
  });

  await check('apercu DPP : brouillon PRIVE, donnees persistees, champs manquants', async () => {
    await page.goto(`${BASE}/brand-console/?demo=1&lang=en&view=productDetail&productId=demo-product-1`, { waitUntil: 'networkidle' });
    await page.locator('.app').waitFor();
    await page.evaluate(() => {
      const s = window.tracefabBrandConsole.state;
      s.demo = false;
      s.activeOrganizationId = '22222222-2222-4222-8222-222222222222';
    });
    await page.locator('[data-action="open-dpp-preview"]').first().click();
    await page.getByText('Mission T-shirt').first().waitFor({ timeout: 10000 });
    const texte = await page.locator('.modal').innerText();
    assert.match(texte, /Private draft|prive/i, 'bandeau brouillon prive');
    assert.match(texte, /MISSION-001/);
    assert.match(texte, /product\.description|Description/i, 'champ manquant signale');
    assert.match(texte, /Organic cotton|main_material_percentage/i, 'donnees persistees affichees');
    assert.doesNotMatch(texte, /Published passport/i);
    // L'URL publique /dpp/?gtin=... ne doit plus etre le bouton d'apercu.
    assert.equal(await page.locator('[data-action="open-dpp-preview"][data-tf-arg*="/dpp/"]').count(), 0);
  });

  await check('aucune erreur JavaScript sur les parcours', async () => {
    assert.deepEqual(erreurs.filter((e) => !/Failed to load resource/.test(e)), []);
  });
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}

const echecs = resultats.filter(([, ok]) => !ok);
console.log('\n' + '-'.repeat(70));
console.log(`${resultats.length - echecs.length}/${resultats.length} controles navigateur valides`);
if (echecs.length) process.exit(1);
