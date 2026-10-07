#!/usr/bin/env node
/**
 * TRACEFAB Public DPP behaviour test.
 *
 * Executes the real consumer passport page in a DOM (demo mode) and pins the
 * honesty contract of the phase: a section with no data source is displayed as
 * absent, and a value substituted by an API fallback is displayed as "not
 * measured" rather than as a figure.
 *
 *   npm run test:public-dpp
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

async function boot(query) {
  const html = await readFile(new URL('dpp/index.html', root), 'utf8');
  const pageErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => pageErrors.push(e.message));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: `https://tracefab.vercel.app/dpp/${query}`,
    virtualConsole,
  });
  const { window } = dom;
  if (window.document.readyState !== 'complete') {
    await new Promise((r) => window.addEventListener('load', r, { once: true }));
  }
  await new Promise((r) => setTimeout(r, 80));
  return { window, document: window.document, pageErrors, html };
}

const { window, document, pageErrors, html } = await boot('?demo=1');
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const settle = () => new Promise((r) => setTimeout(r, 25));
/** Texte du conteneur rendu uniquement : document.body inclut le source du <script>. */
const appText = () => (document.getElementById('dpp') || {}).textContent || '';
const app = window.tracefabPublicDpp;
const tab = async (id) => { click($(`[data-tab="${id}"]`)); await settle(); };

console.log('\nA. Démarrage');
assert(pageErrors.length === 0, 'aucune erreur de page', pageErrors.join(' | '));
assert(!!app, 'la page expose son état');
eq(app.state.demo, true, 'mode démonstration détecté');
assert(!!app.state.dpp, 'un passeport est chargé');
assert(appText().includes('Mode démonstration'), 'les données de démo sont étiquetées');

console.log('\nB. Les onze rubriques du brief');
eq(app.SECTIONS.length, 11, 'onze rubriques');
eq($$('.dpp-tab-btn').length, 11, 'onze onglets rendus');
for (const s of app.SECTIONS) {
  assert(!!$(`[data-tab="${s.id}"]`), `onglet « ${s.label} » présent`);
}

console.log('\nC. Produit — identité réelle');
await tab('produit');
const d = app.state.dpp;
for (const value of [d.productName, d.productReference, d.brandName, d.brandLegalName, d.gtin]) {
  assert(appText().includes(String(value)), `valeur réelle affichée : ${value}`);
}
assert(!appText().includes('undefined') && !appText().includes('NaN'), 'aucune valeur undefined/NaN');

console.log('\nD. Composition — barres proportionnelles');
await tab('composition');
const mats = d.materials;
const fills = $$('.comp-bar > div');
eq(fills.length, mats.length, 'un segment par matière');
mats.forEach((m, i) => {
  eq(fills[i].style.width, `${m.percentage}%`, `largeur du segment « ${m.name} » = pourcentage réel`);
});
assert(appText().includes('Total déclaré'), 'le total déclaré est affiché');
assert(appText().includes('100 %'), 'le total est exact pour ce jeu');

console.log('\nE. Fabrication — étapes issues de la chaîne réelle');
await tab('fabrication');
const steps = String(d.supplyChainSummary).split('➔').map((s) => s.trim()).filter(Boolean);
eq($$('.timeline-node').length, steps.length, `une étape par nœud (${steps.length})`);
assert(appText().includes('Confection'), 'l’étape de confection est nommée');
assert(appText().includes('Pays déclaré : PT'), 'le pays est extrait du nœud');

console.log('\nF. Réparation — aucune source, donc rien d’inventé');
await tab('reparation');
assert(appText().includes('Réparabilité non publiée'), 'la rubrique est annoncée comme non publiée');
assert(appText().includes('ne stocke aucun indice de réparabilité'), 'la raison réelle est donnée');
assert(!/\d+\s*\/\s*10/.test(appText()), 'aucun indice de réparabilité inventé');

console.log('\nG. Preuves — publication non câblée, dit explicitement');
await tab('preuves');
assert(appText().includes('Aucune preuve publiée'), 'la rubrique est annoncée comme non publiée');
assert(appText().includes('pas encore câblée'), 'la raison réelle est donnée');

console.log('\nH. Circularité — un chiffre de repli n’est jamais affiché comme une mesure');
await tab('circularite');
for (const fake of ['3,42', '3.42', '0,85', '0.85']) {
  assert(!appText().includes(fake), `l’empreinte de repli ${fake} n’est pas affichée comme mesurée`);
}
assert(appText().includes('Non mesuré'), 'les indicateurs absents sont annoncés');
assert(appText().includes('Aucune évaluation PEF'), 'l’absence de PEF est expliquée');
assert(appText().includes('Texte générique'), 'la consigne de fin de vie constante est signalée');

console.log('\nI. Entretien — texte constant signalé comme tel');
await tab('entretien');
assert(appText().includes('identique pour tous les produits'), 'le caractère générique est énoncé');

console.log('\nJ. Certifications — portée bornée');
await tab('certifications');
assert(appText().includes(d.transactionCertificateNumber), 'le certificat rattaché est affiché');
assert(appText().includes('allocation de matière certifiée'), 'la portée réelle du certificat est énoncée');

console.log('\nK. Traçabilité');
await tab('tracabilite');
assert(appText().includes(d.digitalLinkUri), 'le GS1 Digital Link réel est affiché');
assert(appText().includes(d.serialNumber), 'le numéro de série du passeport est affiché');
assert(appText().includes('ne stocke pas de lot'), 'la limite de traçabilité est énoncée');

console.log('\nL. JSON-LD généré, sans signature inventée');
const jsonld = JSON.parse($('#dpp-jsonld').textContent);
eq(jsonld['@type'], 'Product', 'JSON-LD de type Product');
eq(jsonld.name, d.productName, 'le nom vient des données réelles');
eq(jsonld.sku, d.sku, 'le SKU vient des données réelles');
assert(jsonld.material.includes('95%'), 'la composition vient des matières réelles', jsonld.material);
assert(!('verificationSignature' in jsonld), 'aucune signature cryptographique inventée');
assert(!/sha256-/.test($('#dpp-jsonld').textContent), 'aucune empreinte inventée');
assert(!jsonld.repairServicesUrl, 'aucune URL de réparation inventée');

console.log('\nM. Piédestal et liens');
assert(html.includes('btn-action'), 'les boutons Wallet sont rendus');
const walletLinks = $$('a.btn-action').map((a) => a.getAttribute('href'));
assert(walletLinks.some((h) => h && h.includes('/apple-wallet')), 'lien Apple Wallet issu de la réponse');
assert(walletLinks.some((h) => h && h.includes('/google-wallet')), 'lien Google Wallet issu de la réponse');
assert(
  !/atelier-demo\.fr/.test(html),
  'aucune URL de démonstration héritée de l’ancienne maquette',
);

console.log('\nN. Aucune donnée de l’ancienne maquette ne subsiste');
for (const legacy of ['Essentiel Coton Biologique', 'TRACEFAB Cryptographic Ledger', 'Filature ➔ Tissage ➔ Ennoblissement ➔ Confection auditée', 'recyclabilityRate']) {
  assert(!html.includes(legacy), `chaîne fabriquée absente : ${legacy}`);
}

console.log('\nO. Identifiant manquant');
const second = await boot('?demo=0');
const text2 = (second.document.getElementById('dpp') || {}).textContent || '';
assert(text2.includes('Passeport introuvable'), 'sans identifiant, la page le dit', text2.slice(0, 120));
assert(text2.includes('?gtin='), 'la page explique quel paramètre fournir');

console.log('\nP. Routage');
const router = await readFile(new URL('api/index.ts', root), 'utf8');
assert(/pattern: \/\^dpp\\\/\(\[\^\\\/\]\+\)\$/.test(router), 'dpp/{identifiant} est déclarée');
assert(html.includes('/api/dpp/${encodeURIComponent(state.identifier)}'), 'la page appelle la route enregistrée');

console.log(`\n${'='.repeat(64)}`);
if (failures) {
  console.error(`test:public-dpp FAILED — ${failures} échec(s), ${checks} contrôle(s) réussi(s).`);
  process.exit(1);
}
console.log(`test:public-dpp passed — ${checks} contrôles, 0 échec.`);
