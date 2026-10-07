#!/usr/bin/env node
/**
 * TRACEFAB landing-page behaviour test.
 *
 * Loads the real `index.html`, executes the real `public/i18n-engine.js` and the
 * page's own inline script inside a DOM, then asserts the interactions the brief
 * depends on. This runs the shipped code — no re-implementation, no mocks of the
 * logic under test.
 *
 *   npm run test:landing
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
  assert(actual === expected, name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ---------------------------------------------------------- build the DOM -- */
let html = await readFile(new URL('index.html', root), 'utf8');
const originalHtml = html;
const engine = await readFile(new URL('public/i18n-engine.js', root), 'utf8');

// Serve the engine inline so the page runs with the real i18n bridge attached.
html = html.replace(
  '<script src="/i18n-engine.js"></script>',
  `<script>${engine}</script>`,
);
if (!html.includes('Universal i18n Bridge for TRACEFAB')) {
  console.error('Could not inline the i18n engine — the test would not exercise the real integration.');
  process.exit(1);
}

const virtualConsole = new VirtualConsole();
const pageErrors = [];
virtualConsole.on('jsdomError', (e) => pageErrors.push(e.message));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://tracefab.vercel.app/',
  virtualConsole,
});
const { window } = dom;
const { document } = window;

// jsdom does not implement scrollIntoView; the browser does. Stub the DOM API,
// never the logic under test.
window.Element.prototype.scrollIntoView = function () { this.__scrolled = true; };

// The inline script runs during parse; wait for load only if it has not fired.
if (document.readyState !== 'complete') {
  await new Promise((r) => window.addEventListener('load', r, { once: true }));
}

console.log('\nA. Page executed without errors');
assert(pageErrors.length === 0, 'no uncaught page errors', pageErrors.join(' | '));
assert(typeof window.applyLanguage === 'function', 'i18n engine attached window.applyLanguage');

/* ------------------------------------------------------------ structure ---- */
console.log('\nB. Hero orbit structure');
const nodes = [...document.querySelectorAll('.tf-node')];
eq(nodes.length, 10, '10 orbit nodes');
const links = [...document.querySelectorAll('.tf-orbit-link')];
eq(links.length, 10, '10 connectors');
const wanted = ['Suppliers', 'Products', 'Materials', 'Facilities', 'Documents',
  'Certifications', 'Evidence', 'Quality', 'Traceability', 'DPP'];
const got = nodes.map((n) => n.querySelector('.tf-node__name').textContent);
eq(JSON.stringify(got), JSON.stringify(wanted), 'orbit domains match the brief, in order');
assert(
  nodes.every((n) => n.getAttribute('aria-label') && n.getAttribute('aria-label').length > 5),
  'every node carries an accessible label',
);
eq(document.querySelector('#tf-core-state').textContent, '10 domains connected', 'core readout starts at rest');

console.log('\nC. Orbit interaction');
nodes[8].dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: false }));
eq(document.querySelector('#tf-core-state').textContent, 'Products traceable', 'hovering Traceability updates the core readout');
eq(document.querySelector('#tf-core-stat').textContent, '91%', 'core shows the traceability figure');
assert(links[8].classList.contains('is-active'), 'the matching connector highlights');
nodes[8].dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: false }));
eq(document.querySelector('#tf-core-state').textContent, '10 domains connected', 'core returns to rest on mouseleave');

nodes[4].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert(nodes[4].classList.contains('is-active'), 'clicking a node pins it active');
eq(document.querySelector('#tf-core-state').textContent, 'Private evidence', 'pinned node drives the readout');
assert(document.getElementById('wow-ecosystem').__scrolled === true, 'clicking a node scrolls to the supply chain graph');
nodes[4].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert(!nodes[4].classList.contains('is-active'), 'clicking again unpins');

/* ------------------------------------------------- supply chain matrix ----- */
console.log('\nD. Supply chain matrix');
const heads = [...document.querySelectorAll('.tf-chain-stephead')];
eq(heads.length, 9, '9 custody stages');
eq(
  JSON.stringify(heads.map((h) => h.querySelector('.tf-chain-stephead__t').textContent)),
  JSON.stringify(['Fiber', 'Material', 'Spinning', 'Weaving', 'Dyeing', 'Cutting', 'Assembly', 'Product', 'DPP']),
  'stages match the brief, in order',
);
const cells = [...document.querySelectorAll('.tf-chain-cell')];
eq(cells.length, 63, '7 attribute rows x 9 stages = 63 cells');
const rows = [...document.querySelectorAll('.tf-chain-rowhead')].map((r) => r.textContent);
eq(
  JSON.stringify(rows),
  JSON.stringify(['Stage', 'Supplier', 'Country', 'Facility', 'Certificate', 'Document', 'Data quality', 'Status']),
  'attribute rows shown simultaneously',
);

console.log('\nE. Stage inspector');
eq(document.getElementById('insp-name').textContent, 'Portugal Textile Mill', 'default inspector shows the weaving stage');
eq(document.getElementById('insp-quality').textContent, '87%', 'default data quality 87%');

heads[6].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
eq(document.getElementById('insp-name').textContent, 'Atelier Milano', 'selecting Assembly updates the supplier');
eq(document.getElementById('insp-quality').textContent, '84%', 'assembly data quality 84%');
eq(document.getElementById('insp-certs').textContent, '2', 'assembly certificate count');
eq(document.getElementById('insp-styles').textContent, '42', 'assembly product count');
eq(document.getElementById('insp-proof').textContent, 'Needs review', 'assembly evidence status');
eq(heads[6].getAttribute('aria-pressed'), 'true', 'selected stage is exposed to assistive tech');
eq(heads[3].getAttribute('aria-pressed'), 'false', 'other stages are not pressed');
assert(
  [...document.querySelectorAll('.tf-chain-cell[data-col="6"]')].every((c) => c.classList.contains('is-col-active')),
  'the whole selected column highlights',
);
assert(
  [...document.querySelectorAll('.tf-chain-cell[data-col="3"]')].every((c) => !c.classList.contains('is-col-active')),
  'the previous column clears',
);
assert(document.getElementById('insp-tags').children.length === 3, 'inspector tags rebuilt from stage data');

console.log('\nF. Mobile vertical stack');
const cards = [...document.querySelectorAll('.tf-chain-card')];
eq(cards.length, 9, 'mobile stack builds one card per stage');
const firstDl = cards[0].querySelectorAll('.tf-chain-card__dl dt');
eq(firstDl.length, 7, 'each mobile card lists all 7 attributes');
eq(cards[0].querySelector('.tf-chain-card__t').textContent, 'Fiber', 'mobile card titles match the stages');
cards[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
eq(document.getElementById('insp-name').textContent, 'Filatura Guimarães', 'tapping a mobile card inspects that stage');
assert(cards[2].classList.contains('is-active'), 'tapped mobile card marks itself active');

/* -------------------------------------------------------- navigation ------- */
console.log('\nG. Navigation');
const burger = document.getElementById('tf-burger');
const nav = document.getElementById('tf-nav');
eq(burger.getAttribute('aria-expanded'), 'false', 'mobile menu starts closed');
burger.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
eq(burger.getAttribute('aria-expanded'), 'true', 'burger opens the menu');
assert(nav.classList.contains('is-open'), 'nav panel shown');
document.querySelector('#tf-nav-panel a').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
eq(burger.getAttribute('aria-expanded'), 'false', 'choosing a link closes the menu');

console.log('\nH. Language');
const langBtn = document.getElementById('lang-menu-btn');
assert(!!langBtn, 'language menu button present under its contract id (lang-menu-btn)');
langBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert(document.getElementById('tf-lang').classList.contains('is-open'), 'language menu opens');
eq(langBtn.getAttribute('aria-expanded'), 'true', 'aria-expanded tracks the menu');
document.querySelector('.tf-lang__option[data-lang="fr"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
eq(document.documentElement.lang, 'fr', 'document language switches to fr');
eq(document.getElementById('current-lang-code').textContent, 'FR', 'indicator shows FR');
assert(!document.getElementById('tf-lang').classList.contains('is-open'), 'menu closes after selection');
// Regression guard: the legacy engine writes an inline display:none onto
// #lang-dropdown-menu. If the menu ever adopts that id without clearing the
// inline style, it stops reopening — verify it still reopens.
langBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert(document.getElementById('tf-lang').classList.contains('is-open'), 'menu reopens after a language switch');
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
assert(!document.getElementById('tf-lang').classList.contains('is-open'), 'Escape closes the language menu');

console.log('\nI. Proof band (CEO 30-second test)');
const proofGroups = [...document.querySelectorAll('.tf-proof__group')];
eq(proofGroups.length, 4, 'four metric groups');
const proofMetrics = [...document.querySelectorAll('.tf-proof__item .tf-metric')].map((m) => m.textContent.trim());
for (const expected of ['1,248', '92.4%', '91%', '88%']) {
  assert(proofMetrics.includes(expected), `headline figure ${expected} present`, proofMetrics.join(' | '));
}
eq(proofMetrics.length, 12, 'twelve headline figures');
assert(
  document.querySelector('.tf-proof .tf-demo-mark') !== null,
  'proof band is labelled as demonstration data',
);

console.log('\nJ. Personas (§31)');
const personas = [...document.querySelectorAll('.tf-persona')];
eq(personas.length, 3, 'three personas');
eq(
  JSON.stringify(personas.map((p) => p.querySelector('.tf-label').textContent)),
  JSON.stringify(['CEO / Founder', 'Sustainability & Compliance', 'Supplier']),
  'personas are the three the brief tests against',
);
for (const p of personas) {
  const link = p.querySelector('a.tf-persona__go');
  assert(!!link && /^\/(brand-console|quality-center|supplier-portal)\/$/.test(link.getAttribute('href')),
    `persona "${p.querySelector('.tf-label').textContent}" links to a real surface`,
    link ? link.getAttribute('href') : 'no link');
}

console.log('\nK. Product intelligence tabs (must not be fake UI)');
const piTabs = [...document.querySelectorAll('#tf-pi-tabs .tf-pi__tab')];
eq(piTabs.length, 11, 'eleven tabs rendered');
eq(piTabs.filter((t) => t.getAttribute('role') === 'tab').length, 11, 'all expose role="tab"');
eq(piTabs.filter((t) => t.getAttribute('aria-selected') === 'true').length, 1, 'exactly one selected at load');
const piPanel = document.getElementById('tf-pi-panel');
assert(piPanel.textContent.includes('92%'), 'Overview panel is populated at load');
piTabs[5].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert(piPanel.textContent.includes('Average data quality'),
  'clicking Suppliers swaps the panel content');
eq(piTabs[5].getAttribute('aria-selected'), 'true', 'clicked tab becomes selected');
eq(piTabs[0].getAttribute('aria-selected'), 'false', 'previous tab deselects');
eq(piTabs[0].tabIndex, -1, 'roving tabindex: unselected tabs leave the tab order');
eq(piTabs[5].tabIndex, 0, 'roving tabindex: selected tab stays reachable');
piTabs[5].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
eq(piTabs[6].getAttribute('aria-selected'), 'true', 'ArrowRight moves to the next tab');
assert(document.getElementById('tf-pi-panel').textContent.includes('Documents'),
  'keyboard navigation updates the panel too');
assert(
  [...document.querySelectorAll('.tf-pi__panel .tf-badge')].length > 0,
  'panel renders trust badges, not just numbers',
);

console.log('\nL. Progressive disclosure');
assert(
  [...document.querySelectorAll('.tf-reveal')].every((el) => el.classList.contains('is-in')),
  'reveal targets are visible when IntersectionObserver is unavailable (graceful fallback)',
);
assert(
  [...document.querySelectorAll('#tf-promise li')].every((el) => el.classList.contains('is-on')),
  'promise words light up',
);

console.log('\nM. Demo dialog');
const openers = [...document.querySelectorAll('[data-demo-open]')];
eq(openers.length, 4, 'four demo entry points');
assert(document.getElementById('demo-modal') !== null, 'demo dialog present');
assert(document.getElementById('demo-form') !== null, 'demo form present');

/* ------------------------------------------------------------- i18n keys --- */
console.log('\nN. i18n key coverage');
const keys = [...new Set([...originalHtml.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]))];
const dictMatch = engine.match(/const UI_DICTIONARY = (\{[\s\S]*?\n  \});/);
assert(!!dictMatch, 'UI_DICTIONARY parsed from the engine');
const dict = new Function(`return ${dictMatch[1]}`)();
const langs = Object.keys(dict);
assert(langs.length >= 6, `engine covers ${langs.length} languages (${langs.join(', ')})`);
for (const key of keys) {
  const missing = langs.filter((l) => !(key in (dict[l] || {})));
  assert(missing.length === 0, `key "${key}" translated in every language`,
    missing.length ? `missing in: ${missing.join(', ')}` : '');
}

/* ------------------------------------------------------------ summary ------ */
console.log(`\n${'='.repeat(64)}`);
if (failures) {
  console.error(`test:landing FAILED — ${failures} failure(s), ${checks} check(s) passed.`);
  process.exit(1);
}
console.log(`test:landing passed — ${checks} checks, 0 failures.`);
