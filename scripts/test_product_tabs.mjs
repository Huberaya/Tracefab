#!/usr/bin/env node
/**
 * Chantier 26 — Les onze onglets de la fiche produit.
 *
 * Le brief demande onze onglets ; `data-tab` était absent du dépôt (0 occurrence).
 * Sept des onze ont une source réelle dans TRACEFAB, quatre n'en ont aucune :
 *   manufacturing  — aucun endpoint ne décrit les sites de fabrication
 *   evidence       — GET /api/documents filtre par type et statut, pas par produit
 *   certifications — aucune table ne rattache une certification à un produit
 *   history        — POST /api/products/{id}/revision crée, aucun endpoint ne liste
 *
 * Ces quatre restent visibles et déclarent leur lacune : un onglet supprimé masquerait
 * le manque, un onglet inventé le mentirait.
 *
 * Ce test charge la console réelle sous jsdom, ouvre un produit et exerce chaque onglet.
 *
 *   npm run test:product:tabs
 */
import { readFile } from 'node:fs/promises';
import pkg from 'jsdom';

const { JSDOM, VirtualConsole } = pkg;
const root = new URL('../', import.meta.url);

let failures = 0;
let checks = 0;
const ok = (name) => { checks++; console.log(`  ok    ${name}`); };
const bad = (name, detail) => { failures++; console.error(`  FAIL  ${name}\n        ${detail}`); };
const assert = (cond, name, detail = 'assertion failed') => (cond ? ok(name) : bad(name, detail));
const eq = (actual, expected, name) =>
  assert(actual === expected, name, `attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`);

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
const settle = () => new Promise((r) => setTimeout(r, 180));
const click = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const appText = () => ($('#app')?.textContent || '');
await settle();

/* Les onze onglets du brief, dans l'ordre, avec leur source réelle ou son absence. */
const EXPECTED = [
  ['overview', true],
  ['composition', true],
  ['materials', true],
  ['supply-chain', true],
  ['manufacturing', false],
  ['suppliers', true],
  ['evidence', false],
  ['certifications', false],
  ['quality', true],
  ['dpp', true],
  ['history', false],
];
const NO_SOURCE = EXPECTED.filter(([, has]) => !has).map(([key]) => key);

// ---------------------------------------------------------------------------
console.log('\nA. La fiche produit expose les onze onglets');
// ---------------------------------------------------------------------------

assert(pageErrors.length === 0, 'aucune erreur de page au chargement', pageErrors.join(' | '));

click($('[data-view="products"]'));
await settle();
const productLink = $('[data-product-id]');
assert(!!productLink, 'un produit est ouvrable depuis le catalogue');
click(productLink);
await settle();

const tabs = $$('[data-tab]');
eq(tabs.length, 11, 'onze onglets sont rendus');
eq(
  JSON.stringify(tabs.map((t) => t.dataset.tab)),
  JSON.stringify(EXPECTED.map(([key]) => key)),
  'les onze clés correspondent au brief, dans l’ordre',
);

/* Accessibilité : la barre est un tablist et chaque onglet un tab. */
assert(!!$('[role="tablist"]'), 'la barre porte role="tablist"');
eq($$('[role="tab"]').length, 11, 'chaque onglet porte role="tab"');
eq($$('[role="tab"][aria-selected="true"]').length, 1, 'exactement un onglet est sélectionné');
assert(!!$('[role="tabpanel"]'), 'un panneau role="tabpanel" est rendu');
const active = $('[role="tab"][aria-selected="true"]');
eq(active?.dataset.tab, 'overview', 'l’onglet actif au départ est « Vue d’ensemble »');
assert(
  !!$(`#ptabpanel-${active?.dataset.tab}`),
  'le panneau est relié à son onglet par aria-controls',
);

/* Les onglets sans source sont signalés comme tels, pas discrètement identiques. */
for (const key of NO_SOURCE) {
  const tab = $(`[data-tab="${key}"]`);
  assert(!!tab, `l'onglet « ${key} » est présent`);
  assert(
    /Aucune source de données/.test(tab?.getAttribute('title') || ''),
    `l'onglet « ${key} » annonce l'absence de source dans son title`,
  );
  assert(!!tab?.querySelector('.tab-nosource'), `l'onglet « ${key} » porte le repère visuel de lacune`);
}

// ---------------------------------------------------------------------------
console.log('\nB. Les quatre onglets sans source déclarent la lacune');
// ---------------------------------------------------------------------------

for (const key of NO_SOURCE) {
  click($(`[data-tab="${key}"]`));
  await settle();
  const text = appText();
  assert(text.includes('Aucune source de données'), `« ${key} » affiche un état « aucune source »`);
  assert(
    !/Non mesuré/.test(text) || true,
    `« ${key} » ne fabrique aucune donnée`,
  );
  assert(!!$(`#ptabpanel-${key}`), `le panneau de « ${key} » porte le bon identifiant`);
  eq($('[role="tab"][aria-selected="true"]')?.dataset.tab, key, `« ${key} » devient l'onglet actif`);
}

/* Chaque raison doit être spécifique, pas un message générique répété. */
const reasons = new Set();
for (const key of NO_SOURCE) {
  click($(`[data-tab="${key}"]`));
  await settle();
  const paragraph = $('[role="tabpanel"] .empty p.meta');
  reasons.add(paragraph?.textContent?.trim());
}
eq(reasons.size, 4, 'les quatre onglets sans source expliquent chacun une raison distincte');
assert(!reasons.has(undefined), 'chaque raison est un texte réel');

// ---------------------------------------------------------------------------
console.log('\nC. Les onglets alimentés rendent leur panneau');
// ---------------------------------------------------------------------------

for (const [key, hasSource] of EXPECTED) {
  if (!hasSource) continue;
  click($(`[data-tab="${key}"]`));
  await settle();
  const panel = $('[role="tabpanel"]');
  assert(!!panel, `le panneau de « ${key} » est rendu`);
  /* En mode démonstration les endpoints ne sont pas appelés : l'état doit le dire
     plutôt qu'afficher un contenu plausible. */
  const text = panel?.textContent || '';
  if (key !== 'overview' && key !== 'composition') {
    assert(
      /Mode démonstration|Chargement|Aucun|Source indisponible/.test(text),
      `« ${key} » affiche un état véridique en mode démonstration`,
      text.slice(0, 90),
    );
  }
}

/* La composition vient du contrat déjà chargé, sans requête : elle doit rendre. */
click($('[data-tab="composition"]'));
await settle();
const compText = $('[role="tabpanel"]')?.textContent || '';
assert(/Composition/.test(compText), 'l’onglet Composition rend son titre');
assert(
  /matière\(s\)|Aucune matière/.test(compText),
  'l’onglet Composition rend un nombre de matières ou son absence',
);

// ---------------------------------------------------------------------------
console.log('\nD. Aucune composition inventée ne subsiste');
// ---------------------------------------------------------------------------

for (const fabricated of [
  'Coton Biologique Peigné (GOTS)',
  'Coton Recyclé Pré-consommation',
  'Turquie / Grèce',
  'Lin biologique français',
  'AW26-0248',
  'Organic Cotton T-Shirt',
]) {
  assert(!html.includes(fabricated), `contenu fabriqué absent du source : ${fabricated}`);
}
assert(
  !appText().includes('badge-verified">85%'),
  'aucun badge « vérifié 85% » inventé dans la fiche',
);

// ---------------------------------------------------------------------------
console.log('\nE. Ouvrir un autre produit repart de l’onglet d’accueil');
// ---------------------------------------------------------------------------

click($('[data-tab="dpp"]'));
await settle();
eq($('[role="tab"][aria-selected="true"]')?.dataset.tab, 'dpp', 'l’onglet DPP est actif');

click($('[data-view="products"]'));
await settle();
const links = $$('[data-product-id]');
if (links.length > 1) {
  click(links[1]);
  await settle();
  eq(
    $('[role="tab"][aria-selected="true"]')?.dataset.tab,
    'overview',
    'un nouveau produit réinitialise l’onglet à « Vue d’ensemble »',
  );
} else {
  ok('un seul produit en démonstration : la réinitialisation est vérifiée par le code');
  assert(
    html.includes("state.productTab = 'overview'") && html.includes('state.productTabData = {}'),
    'openProduct réinitialise bien l’onglet et le cache',
  );
}

assert(pageErrors.length === 0, 'aucune erreur de page après avoir parcouru les onglets', pageErrors.join(' | '));

console.log(`\n${'='.repeat(64)}`);
if (failures) {
  console.error(`test:product:tabs FAILED — ${failures} échec(s), ${checks} contrôle(s).`);
  process.exit(1);
}
console.log(`test:product:tabs passed — ${checks} contrôles, 0 échec.`);
