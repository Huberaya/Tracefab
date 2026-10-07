#!/usr/bin/env node
/**
 * TRACEFAB DPP Readiness behaviour test.
 *
 * Boots the real Brand Console in demo mode and drives the DPP view through the
 * DOM. Pins three things the phase is about:
 *   1. the readiness score is never presented as a legal certification;
 *   2. every missing requirement carries an action that resolves it;
 *   3. the CIRPASS structure check reports what TRACEFAB genuinely cannot supply
 *      (no AGEC Art. 13 block, no repairability index in the schema) instead of
 *      inventing it.
 *
 *   npm run test:dpp-readiness
 */
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = new URL('../', import.meta.url);

let failures = 0;
let checks = 0;
function ok(name) { checks++; console.log(`  ok    ${name}`); }
function bad(name, detail) { failures++; console.error(`  FAIL  ${name}\n        ${detail}`); }
function assert(cond, name, detail = 'assertion failed') { cond ? ok(name) : bad(name, detail); }
function eq(actual, expected, name) {
  assert(actual === expected, name, `attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`);
}

const html = await readFile(new URL('brand-console/index.html', root), 'utf8');

const pageErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => pageErrors.push(e.message));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://tracefab.vercel.app/brand-console/?demo=1',
  virtualConsole,
});
const { window } = dom;
const { document } = window;

if (document.readyState !== 'complete') {
  await new Promise((r) => window.addEventListener('load', r, { once: true }));
}
await new Promise((r) => setTimeout(r, 80));

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const settle = () => new Promise((r) => setTimeout(r, 40));
/** Texte du conteneur rendu uniquement : document.body inclut le source du <script>. */
const appText = () => (document.getElementById('app') || {}).textContent || '';

const app = window.tracefabBrandConsole;

console.log('\nA. Démarrage');
assert(pageErrors.length === 0, 'aucune erreur de page', pageErrors.join(' | '));
assert(!!app, 'la console expose son état');
eq(app.state.demo, true, 'mode démonstration détecté');
assert($('.demo-banner') !== null, 'les données de démo sont étiquetées');
assert(app.state.products.length > 0, `catalogue de démo chargé (${app.state.products.length} produits)`);

console.log('\nB. La maquette fabriquée a disparu');
assert(!/dppConsoleView/.test(html), 'dppConsoleView supprimée du fichier');
for (const fake of ['42 / 48', "alert('Tous les scores DPP ont été recalculés.')"]) {
  assert(!html.includes(fake), `valeur fabriquée absente : ${fake}`);
}

console.log('\nC. Accès à la vue DPP');
const navBtn = $('[data-view="dpp"]');
assert(!!navBtn, 'entrée de navigation DPP présente');
click(navBtn);
await settle();
const select = $('#dpp-product-select');
assert(!!select, 'sélecteur de produit affiché avant tout choix');
assert(select.options.length > 1, `produits proposés (${select.options.length - 1})`);

const productId = app.state.products[0].id;
select.value = productId;
select.dispatchEvent(new window.Event('change', { bubbles: true }));
await settle();
assert(!!app.state.dpp, 'un bilan de préparation est chargé');

console.log('\nD. Le score n’est jamais présenté comme une certification');
const disclaimer = appText();
assert(disclaimer.includes('Indicateur interne de préparation'), 'la nature d’indicateur interne est énoncée');
assert(disclaimer.includes('ne constitue ni une certification'), 'la non-certification est explicite');
assert(disclaimer.includes('organisme notifié'), 'le renvoi à un organisme notifié est présent');
assert(
  !/avant de pouvoir certifier le passeport/.test(disclaimer),
  'l’ancienne formulation « certifier le passeport » a disparu',
);

console.log('\nE. Piliers réels');
eq($$('.pillar-card').length, 4, 'quatre piliers rendus');
const dpp = app.state.dpp;
eq(dpp.totalRequirements, 9, 'neuf exigences au total');
eq(dpp.metRequirements, 7, 'sept exigences satisfaites');
eq(dpp.completionScore, Math.round((7 / 9) * 100), 'le score global découle du ratio réel');
const pillarTotals = Object.values(dpp.pillars).reduce((sum, p) => sum + p.total, 0);
eq(pillarTotals, dpp.totalRequirements, 'la somme des piliers égale le total des exigences');
for (const pillar of Object.values(dpp.pillars)) {
  eq(
    pillar.metPercent,
    pillar.total > 0 ? Math.round((pillar.met / pillar.total) * 100) : 0,
    `pourcentage du pilier « ${pillar.name} » cohérent`,
  );
}

console.log('\nF. Ce qui manque, et l’action qui le résout');
eq(dpp.missingFields.length, 2, 'deux exigences manquantes');
for (const field of dpp.missingFields) {
  const text = appText();
  assert(text.includes(field.label), `l’exigence « ${field.label} » est affichée`);
}
const actionButtons = $$('[data-action="product-new-request"], [data-product-id], [data-action="select-supply-chain-product"], [data-action="select-quality-product"]');
assert(
  actionButtons.length >= dpp.missingFields.length,
  `au moins une action de résolution par manque (${actionButtons.length} pour ${dpp.missingFields.length})`,
);
// Aucune cible inventée : chaque action pointe un produit réel ou une vue existante.
// Les cibles autorisées sont dérivées du switch de rendu, jamais codées en dur.
const declaredViews = new Set([...html.matchAll(/state\.view === '([a-zA-Z]+)'/g)].map((m) => m[1]));
assert(declaredViews.size >= 15, `le switch de rendu gère ${declaredViews.size} vues`);
for (const btn of $$('[data-view]')) {
  assert(declaredViews.has(btn.dataset.view), `cible de navigation gérée par le switch : ${btn.dataset.view}`);
}
const compositionAction = actionButtons.find((b) => b.dataset.productId);
assert(!!compositionAction, 'l’action de résolution cible un produit identifié');
eq(compositionAction.dataset.productId, dpp.productId, 'l’action vise bien le produit évalué');

console.log('\nG. Anomalies bloquantes motivées');
eq(dpp.blockingIssues.length, 1, 'une anomalie bloquante');
const issue = dpp.blockingIssues[0];
assert(!!issue.reason, 'le blocage est motivé');
assert(appText().includes(issue.reason), `le motif réel est affiché : ${issue.reason}`);
assert(appText().includes('Anomalies bloquantes'), 'le panneau des blocages est rendu');
assert(appText().includes(issue.key), 'le code d’exigence est affiché');

console.log('\nG2. L’entrée Intelligence ne tombe plus sur un écran d’erreur');
click($('[data-view="intelligence"]'));
await settle();
assert(appText().includes('Couche non disponible'), 'un état véridique est affiché');
assert(
  !appText().includes('Demande introuvable'),
  'la chute par défaut sur « Demande introuvable » a disparu',
);
assert(
  !appText().includes('ZERO HALLUCINATION'),
  'la maquette rédigée à la main n’est pas branchée',
);
assert(
  !/TC-CU-881294|SGS-LAB-098|SMETA-BRAGA-26/.test(appText()),
  'aucun certificat inventé n’est affiché',
);
click($('[data-view="dpp"]'));
await settle();
assert(!!app.state.dpp, 'retour à la vue DPP');

console.log('\nH. Validation structurelle CIRPASS');
const validateBtn = $('[data-action="validate-cirpass"]');
assert(!!validateBtn, 'le bouton d’évaluation CIRPASS existe');
assert(
  appText().includes('ne vaut pas conformité légale'),
  'la portée du contrôle structurel est bornée',
);
click(validateBtn);
await settle();
const report = app.state.cirpass;
assert(!!report, 'un rapport CIRPASS est produit');

// Le payload doit venir des données réelles du produit de démo.
const payload = app.state.cirpassPayload;
const source = app.state.products[0];
eq(payload.gtin, '3760000000017', 'le GTIN vient des identifiants du produit');
eq(payload.sku, source.sku || source.reference, 'le SKU provient du produit réel (ou de sa référence à défaut)');
eq(payload.name, source.name, 'la désignation provient du produit réel');
eq(payload.materialComposition.length, 2, 'deux matières réelles');
eq(
  payload.materialComposition.reduce((s, m) => s + m.percentage, 0),
  98,
  'la composition réelle totalise 98 %',
);
assert(
  payload.frenchAgecArticle13 === undefined,
  'aucun bloc AGEC inventé — le schéma n’en contient pas',
);

// Le validateur doit signaler exactement ces deux manques.
eq(report.blockingErrors.length, 2, 'deux erreurs bloquantes');
assert(
  report.blockingErrors.some((e) => e.includes('98%')),
  'l’écart de composition réel est signalé',
  report.blockingErrors.join(' | '),
);
assert(
  report.blockingErrors.some((e) => e.includes('AGEC Article 13')),
  'l’absence de bloc AGEC est signalée',
  report.blockingErrors.join(' | '),
);
eq(report.readinessScore, Math.round(((8 - report.blockingErrors.length) / 8) * 100), 'le score structurel suit la règle (8 - erreurs) / 8');
eq(report.isPublishable, false, 'non publiable tant qu’il manque des données obligatoires');
eq(report.isValid, false, 'structure invalide en l’état');
eq(report.standardsPassed.frenchAgecArt13, false, 'AGEC Art. 13 non satisfait');
eq(report.standardsPassed.germanLkSg, false, 'LkSG non satisfait — aucune provenance amont dans le payload');
eq(report.standardsPassed.cirpassJsonLd, true, 'JSON-LD satisfait : GTIN et identifiant présents');
assert(report.warnings.length >= 1, 'au moins un avertissement (réparabilité non déclarée)');
assert(appText().includes('Score structurel'), 'le score structurel est affiché');
assert(appText().includes('AGEC Art. 13 (FR)'), 'les référentiels contrôlés sont listés');
assert(appText().includes('Structure incomplète'), 'le verdict est affiché');

console.log('\nI. Routage');
const router = await readFile(new URL('api/index.ts', root), 'utf8');
assert(/pattern: \/\^dpp\\\/validate\$/.test(router), 'dpp/validate est déclarée dans le routeur');
const validateLine = router.split('\n').findIndex((l) => l.includes('dpp\\/validate'));
const gtinLine = router.split('\n').findIndex((l) => /dpp\\\/\(\[\^\\\/\]\+\)\$/.test(l));
assert(validateLine > -1 && gtinLine > -1 && validateLine < gtinLine, 'dpp/validate est déclarée avant dpp/[gtin]', `${validateLine} vs ${gtinLine}`);
assert(html.includes('/api/dpp/validate'), 'la console appelle la route enregistrée');

console.log(`\n${'='.repeat(64)}`);
if (failures) {
  console.error(`test:dpp-readiness FAILED — ${failures} échec(s), ${checks} contrôle(s) réussi(s).`);
  process.exit(1);
}
console.log(`test:dpp-readiness passed — ${checks} contrôles, 0 échec.`);
