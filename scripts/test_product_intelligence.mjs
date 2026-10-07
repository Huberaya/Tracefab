#!/usr/bin/env node
/**
 * Product intelligence test.
 *
 * The product record used to pre-fill its technical form with invented defaults —
 * 'Navy Deep', 'PT', '185' g, sizes XS–XL — inside real <input> elements. Submitting the
 * form therefore wrote fabricated values into the actual record, since the PATCH handler
 * accepts colorName, sizeRange, countryOfManufacture and weightGrams. It also carried a
 * `countryOfSpinning` field that exists in no contract, and a "100% Reconcilié" badge that
 * never summed anything.
 *
 *   npm run test:product:intelligence
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
const settle = () => new Promise((r) => setTimeout(r, 160));
const click = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await settle();

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const text = () => ((document.getElementById('app') || {}).textContent || '').replace(/\s+/g, ' ');
const state = () => window.tracefabBrandConsole?.state || {};

console.log('\nA. Ouverture d’un produit réel');
click($('[data-view="products"]'));
await settle();
const productLink = $('[data-product-id]');
assert(!!productLink, 'un produit est ouvrable depuis le catalogue');
click(productLink);
await settle();
assert(pageErrors.length === 0, 'aucune erreur de page', pageErrors.join(' | '));
const detail = state().selectedProductDetail || {};
assert(!!detail.product, 'la fiche expose le produit réel');

console.log('\nB. Le formulaire ne pré-remplit aucune valeur inventée');
const form = $('#product-detail-form');
assert(!!form, 'le formulaire technique est présent');
const values = Object.fromEntries([...form.elements].filter((e) => e.name).map((e) => [e.name, e.value]));
for (const fabricated of ['Navy Deep', 'PT', '185', 'XS, S, M, L, XL', 'Prêt-à-porter']) {
  assert(!Object.values(values).includes(fabricated), `aucune valeur fabriquée : ${fabricated}`);
}
/* Un champ vide dans la donnée doit rester vide dans le formulaire : sinon la soumission
   écrase l'enregistrement réel avec une valeur inventée. */
for (const field of ['colorName', 'countryOfManufacture', 'weightGrams', 'sizeRange']) {
  eq(values[field], String(detail.product[field] ?? ''), `« ${field} » reflète la donnée réelle`);
}
assert(!('countryOfSpinning' in values), 'le champ fantôme countryOfSpinning a disparu');
assert('countryOfDesign' in values, 'remplacé par un champ du contrat (countryOfDesign)');
assert(!html.includes('countryOfSpinning'), 'plus aucune référence au champ fantôme');

console.log('\nC. La nomenclature totalise réellement les parts');
const bomMaterials = Array.isArray(detail.materials) ? detail.materials : [];
const parts = bomMaterials.map((m) => Number(m.percentage)).filter((n) => Number.isFinite(n));
const expectedTotal = parts.length ? Math.round(parts.reduce((a, b) => a + b, 0)) : null;
const bomBadge = text().match(/Somme des parts : (\d+)%|Aucune matière rattachée/);
assert(!!bomBadge, 'un état de nomenclature est affiché');
if (expectedTotal === null) {
  assert(text().includes('Aucune matière rattachée'), 'sans matière, la fiche le dit');
} else {
  assert(text().includes(`Somme des parts : ${expectedTotal}%`), `total réel ${expectedTotal}%`);
}
assert(!text().includes('100% Reconcilié'), 'le total n’est plus décrété à 100%');
assert(!html.includes("|| 'Fibre certifiée'"), 'plus de type de matière inventé en repli');

console.log('\nD. Chaque exploration mène à une surface qui répond sur données réelles');
for (const action of ['product-supply-chain-from-detail', 'product-quality-from-detail', 'product-dpp-from-detail', 'product-new-request']) {
  assert(!!$(`[data-action="${action}"]`), `un bouton déclenche « ${action} »`);
  assert(html.includes(`action === '${action}'`), `le gestionnaire de « ${action} » existe`);
}
/* product-quality-from-detail avait un gestionnaire mais aucun déclencheur. */
click($('[data-action="product-quality-from-detail"]'));
await settle();
eq(state().view, 'quality', 'le bouton qualité bascule vers le centre de qualité');

console.log('\nE. Ce que la fiche ne porte pas est annoncé, pas simulé');
click($('[data-view="products"]'));
await settle();
click($('[data-product-id]'));
await settle();
const detailText = text();
assert(detailText.includes('Explorer ce produit'), 'le périmètre de la fiche est explicite');
assert(/ne figurent pas dans la fiche produit/.test(detailText), 'les absences sont dites');
for (const surface of ['les documents', 'les certifications', 'les demandes']) {
  assert(detailText.includes(surface), `renvoi vers ${surface}`);
}
assert(detail.identifiers !== undefined, 'les identifiants viennent du contrat réel');
assert(new RegExp(`${detail.identifiers?.length ?? 0} identifiant`).test(detailText), 'le nombre d’identifiants est celui du contrat');

console.log(`\n${'='.repeat(64)}`);
if (failures) {
  console.error(`test:product:intelligence FAILED — ${failures} échec(s), ${checks} contrôle(s) réussi(s).`);
  process.exit(1);
}
console.log(`test:product:intelligence passed — ${checks} contrôles, 0 échec.`);
