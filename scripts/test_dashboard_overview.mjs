#!/usr/bin/env node
/**
 * Dashboard overview test.
 *
 * The mission-control dashboard used to render the numbers from the product brief as
 * literals — 92.4% data quality, 84.0% evidence coverage, 214 audited sites, 18 countries,
 * 91.0% traceability, 88.0% DPP readiness, "Conformité AGEC Art. 13 100%" — while reading
 * `state` twice. Every figure is now computed from the lists actually loaded at boot, and
 * what cannot be aggregated there is displayed as "Non mesuré".
 *
 *   npm run test:dashboard:overview
 */
import { readFile } from 'node:fs/promises';
import pkg from 'jsdom';

const { JSDOM, VirtualConsole } = pkg;
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
await new Promise((r) => setTimeout(r, 250));

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const text = () => ((document.getElementById('app') || {}).textContent || '').replace(/\s+/g, ' ');
const state = () => window.tracefabBrandConsole?.state || {};

console.log('\nA. Démarrage');
assert(pageErrors.length === 0, 'aucune erreur de page', pageErrors.join(' | '));
eq(state().view, 'overview', 'le tableau de bord est la vue par défaut');

console.log('\nB. Les quatre domaines du brief sont présents');
const domains = $$('.mc-domain-card');
eq(domains.length, 4, 'quatre cartes de domaine');
const tags = domains.map((d) => (d.querySelector('.mc-domain-tag') || {}).textContent || '');
assert(tags.some((t) => /SUPPLY CHAIN/.test(t)), 'domaine Supply Chain');
assert(tags.some((t) => /DATA QUALITY/.test(t)), 'domaine Data Quality');
assert(tags.some((t) => /TRACEABILITY/.test(t)), 'domaine Traceability');
assert(tags.some((t) => /DPP/.test(t)), 'domaine DPP Readiness');

console.log('\nC. Chaque comptage correspond aux listes réellement chargées');
const st = state();
const supplyChainCard = domains.find((d) => /SUPPLY CHAIN/.test(d.textContent));
const supplyValues = [...supplyChainCard.querySelectorAll('.mc-stat-subitem strong')].map((e) => Number(e.textContent));
eq(supplyValues[0], st.products.length, 'produits référencés = state.products.length');
eq(supplyValues[1], st.suppliers.length, 'fournisseurs = state.suppliers.length');
eq(supplyValues[2], st.materials.length, 'matières = state.materials.length');
const expectedCountries = new Set([
  ...st.suppliers.map((s) => s?.organizations?.country_code).filter(Boolean).map(String),
  ...st.products.map((p) => p.countryOfManufacture).filter(Boolean).map(String),
]).size;
eq(supplyValues[3], expectedCountries, 'pays = pays réellement déclarés');

console.log('\nD. La complétude est une moyenne réelle, pas une constante');
const completions = st.products.map((p) => Number(p.dataCompletion)).filter((n) => Number.isFinite(n));
const expectedAvg = completions.length
  ? Math.round(completions.reduce((a, b) => a + b, 0) / completions.length)
  : null;
const dataCard = domains.find((d) => /DATA QUALITY/.test(d.textContent));
const headline = (dataCard.querySelector('.mc-stat-huge') || {}).textContent.trim();
eq(headline, expectedAvg === null ? 'Non mesuré' : `${expectedAvg}%`, 'complétude moyenne calculée');
const readinessCounts = [...dataCard.querySelectorAll('.mc-stat-subitem strong')].map((e) => Number(e.textContent));
eq(readinessCounts[0], st.products.filter((p) => p.dataReadiness === 'data_ready').length, 'produits « données prêtes »');
eq(readinessCounts[1], st.products.filter((p) => p.dataReadiness === 'in_progress').length, 'produits en cours');
eq(readinessCounts[2], st.products.filter((p) => p.dataReadiness === 'needs_review').length, 'produits à revoir');
eq(readinessCounts[3], st.products.filter((p) => p.dataReadiness === 'not_started').length, 'produits non démarrés');

console.log('\nE. Ce qui n’est pas agrégable au démarrage est dit non mesuré');
const t = text();
assert(t.includes('Non mesuré'), 'les domaines non mesurables l’affichent');
for (const view of ['supplyChain', 'dpp']) {
  assert(
    domains.some((d) => d.textContent.includes(view === 'dpp' ? 'préparation DPP' : 'chaîne d’approvisionnement')
      || d.textContent.includes(view === 'dpp' ? 'préparation DPP' : "chaîne d'approvisionnement")),
    `le domaine non mesuré renvoie vers la vue ${view}`,
  );
}

console.log('\nF. Les points d’attention sont des comptes réels');
const pills = $$('.mc-attention-pill');
eq(pills.length, 4, 'quatre points d’attention');
const pillNumbers = pills.map((p) => Number((p.querySelector('.mc-attention-num') || {}).textContent));
const openRequests = st.requests.filter((r) => !['approved', 'cancelled'].includes(r.status)).length;
eq(pillNumbers[0], openRequests, 'demandes ouvertes = comptage réel');
eq(pillNumbers[2], st.products.filter((p) => Number(p.dataCompletion) < 100).length, 'produits incomplets = comptage réel');
eq(pillNumbers[3], st.products.filter((p) => p.dataReadiness === 'needs_review').length, 'produits à revoir = comptage réel');
assert(pills.every((p) => /onclick=/.test(p.outerHTML)), 'chaque point d’attention mène à une action');

console.log('\nG. Les chiffres du brief ne sont plus codés en dur');
for (const fabricated of ['92.4%', '84.0%', '78.0%', '91.0%', '97.6%', '88.0%', '1 248', '214 sites', '1 098 styles', '142']) {
  assert(!t.includes(fabricated), `chiffre du brief absent du rendu : ${fabricated}`);
}
assert(!t.includes('Conformité AGEC Art. 13'), 'aucune conformité AGEC affirmée sur le tableau de bord');
assert(!t.includes('GRADE A'), 'aucun grade décrété sans calcul');
assert(!html.includes('|| 1248'), 'plus de repli sur le nombre du brief');

console.log(`\n${'='.repeat(64)}`);
if (failures) {
  console.error(`test:dashboard:overview FAILED — ${failures} échec(s), ${checks} contrôle(s) réussi(s).`);
  process.exit(1);
}
console.log(`test:dashboard:overview passed — ${checks} contrôles, 0 échec.`);
