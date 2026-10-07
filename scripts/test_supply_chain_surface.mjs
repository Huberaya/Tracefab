#!/usr/bin/env node
/**
 * Brand Console supply-chain surface test.
 *
 * Pins the outcome of the Chantier-3 repair: the five-tier pipeline is rendered
 * from real `state.supplyChain.stages` data, the score cards come from the real
 * `computeTraceabilitySummary`, and the two hardcoded mockups that used to sit
 * there (a 7-step "chain of custody" and a mass-balance table with invented
 * transaction certificates) stay gone.
 *
 *   npm run test:supplychain:surface
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
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const settle = () => new Promise((r) => setTimeout(r, 120));
/** Texte du conteneur rendu uniquement : document.body inclut le source du <script>. */
const appText = () => (document.getElementById('app') || {}).textContent || '';

const TIERS = ['Tier 4 · Matières', 'Tier 3 · Filature', 'Tier 2 · Tissage', 'Tier 1 · Confection', 'Tier 0 · Produit Fini'];

console.log('\nA. Démarrage');
assert(pageErrors.length === 0, 'aucune erreur de page', pageErrors.join(' | '));
assert(!!window.tracefabBrandConsole, 'la console expose son état');

console.log('\nB. Les cinq niveaux sont rendus, dans l’ordre matière → produit');
/* La chaîne se charge depuis la fiche produit : on suit ce parcours réel plutôt
   que d'appeler une fonction interne. */
click($('[data-view="products"]'));
await settle();
const productLink = $('[data-product-id]');
assert(!!productLink, 'un produit est ouvrable depuis le catalogue');
click(productLink);
await settle();
const chainLink = $('[data-action="product-supply-chain-from-detail"]');
assert(!!chainLink, 'la fiche produit propose d’ouvrir la chaîne');
click(chainLink);
await settle();
assert(!!$('.pipeline'), 'le pipeline est rendu');
const cards = $$('.pipeline .pillar-card');
eq(cards.length, 5, 'cinq niveaux affichés');
const labels = cards.map((c) => (c.querySelector('.pillar-name') || {}).textContent);
TIERS.forEach((tier, i) => eq(labels[i], tier, `niveau ${i + 1} = « ${tier} »`));
eq(labels[0], 'Tier 4 · Matières', 'la chaîne commence par la matière');
eq(labels[4], 'Tier 0 · Produit Fini', 'la chaîne finit par le produit');

console.log('\nC. Les clés de niveaux correspondent au contrat API');
const sc = window.tracefabBrandConsole.state.supplyChain || {};
const stageKeys = Object.keys(sc.stages || {});
for (const key of ['tier4_raw_materials', 'tier3_spinning', 'tier2_fabric', 'tier1_assembly', 'tier0_product']) {
  assert(stageKeys.includes(key), `clé réelle « ${key} » présente dans les données`, stageKeys.join(','));
}
// Chaque niveau affiche le nombre réel de nœuds, pas un chiffre décoratif.
cards.forEach((card, i) => {
  const key = ['tier4_raw_materials', 'tier3_spinning', 'tier2_fabric', 'tier1_assembly', 'tier0_product'][i];
  const shown = Number((card.querySelector('.pillar-score') || {}).textContent);
  eq(shown, (sc.stages[key] || []).length, `compte du niveau « ${key} » = nombre réel de nœuds`);
});
assert(
  cards.every((c) => c.textContent.includes('Aucun nœud rattaché') || c.querySelector('.pillar-item')),
  'un niveau vide le dit explicitement plutôt que de disparaître',
);

console.log('\nD. Les scores viennent du calcul réel');
const summary = sc.summary || {};
for (const field of ['nodeCount', 'linkCount', 'documentedNodeCount', 'documentedLinkCount', 'documentationRate']) {
  assert(field in summary, `le résumé réel expose « ${field} »`, Object.keys(summary).join(','));
}
const text = appText();
assert(text.includes(`${summary.documentedNodeCount ?? '—'} / ${summary.nodeCount}`), 'les nœuds documentés affichent le ratio réel');
assert(text.includes(`${summary.documentationRate}%`), 'la couverture documentaire est celle du calcul');
assert(!text.includes('7 / 7'), 'le score fabriqué « 7 / 7 » a disparu');
assert(!text.includes('98.4%'), 'la couverture fabriquée « 98.4% » a disparu');

console.log('\nE. Les actions existent réellement, pas seulement leur gestionnaire');
for (const action of ['generate-baseline-chain', 'new-chain-link', 'new-chain-node']) {
  assert(!!$(`[data-action="${action}"]`), `un bouton déclenche « ${action} »`);
}
assert(html.includes("action === 'generate-baseline-chain'"), 'le gestionnaire de génération existe');
assert(html.includes("action === 'new-chain-link'"), 'le gestionnaire de liaison existe');

console.log('\nF. Les maquettes fabriquées ne reviennent pas');
for (const fabricated of ['Ege Birlik', 'TC-CU-881294', 'tc-echelon-card', 'tc-reconcil-card', 'ÉCHELON 01', '98.4%']) {
  assert(!html.includes(fabricated), `contenu fabriqué absent du source : ${fabricated}`);
}
/* Chantier 22 : supplyChainConsoleView() n'était appelée par aucun dispatcher — le
   rendu passe par supplyChainView(), qui consomme state.supplyChain. La fonction
   morte et l'objet codé en dur qui l'alimentait sont supprimés : un diagramme de
   six fournisseurs inventés ne doit pas pouvoir être rebranché par accident. */
for (const fabricated of [
  'supplyChainConsoleView', 'state.chainNodes', 'selectedChainNode',
  'Jersey 185g', 'ZDHC Level 3', 'Malhas do Ave', 'Tinturaria Braga',
  'Circuit fermé STeP', 'BCI & GOTS Mill', 'LOT-PT-2026-CTN-089', '38.0151',
]) {
  assert(!html.includes(fabricated), `maquette de chaîne morte supprimée : ${fabricated}`);
}
click($('[data-view="supplyChain"]'));
await settle();
assert(!appText().includes('Izmir'), 'aucune ferme inventée dans la vue chaîne');
assert(appText().includes('Ouvrir la traçabilité'), 'le bilan de masse renvoie vers la surface qui le calcule');

console.log('\nG. La couche Intelligence ne sert aucune donnée inventée');
click($('[data-view="intelligence"]'));
await settle();
assert(appText().includes('Couche non disponible'), 'un état véridique est affiché');
assert(!appText().includes('Demande introuvable'), 'la chute sur un écran d’erreur a disparu');
for (const fabricated of ['ZERO HALLUCINATION', 'SGS-LAB-098', 'SMETA-BRAGA-26', 'AW26-0812']) {
  assert(!html.includes(fabricated), `maquette supprimée : ${fabricated}`);
}

console.log('\nH. La lignée de la fiche produit est réelle');
click($('[data-view="products"]'));
await settle();
click($('[data-product-id]'));
await settle();
const detailText = appText();
assert(detailText.includes('Lignée de transformation'), 'la lignée est rendue');
const lineageCards = $$('.lineage-step-card');
assert(lineageCards.length >= 3, `au moins trois échelons (obtenu ${lineageCards.length})`);
const detail = window.tracefabBrandConsole.state.selectedProductDetail || {};
const realMaterials = Array.isArray(detail.materials) ? detail.materials : [];
/* Une carte par matière réelle (ou une carte « aucune matière » si la liste est vide),
   puis transformation + produit + DPP. */
eq(lineageCards.length, Math.max(realMaterials.length, 1) + 3, 'une carte par matière réelle, plus trois échelons fixes');
assert(
  realMaterials.length > 0 || detailText.includes('Aucune matière rattachée'),
  'une fiche sans matière le dit explicitement',
);
assert(detailText.includes('ouvrir le graphe'), 'les échelons absents du contrat renvoient vers le graphe');
assert(/Complétude \d+%/.test(detailText), 'la complétude affichée vient du produit réel');
for (const fabricated of ['Ferme Izmir', 'Haute-Vienne', 'EcoDye Aquitaine', 'Barcelos', '3.42 kg', '100% Vérifié & Scellé', 'Ne 30/1']) {
  assert(!detailText.includes(fabricated), `aucun contenu inventé dans la lignée : ${fabricated}`);
}
assert(!html.includes("alert('Échelon"), 'les alert() codées en dur ont disparu');

console.log('\nI. Le centre de qualité n\'affiche que ce qu\'il mesure');
click($('[data-view="quality"]'));
await settle();
const qualityText = appText();
assert(qualityText.includes('Non mesuré'), 'les indicateurs hors contrat sont dits non mesurés');
for (const fake of ['96.8%', '92.0%', '88.5%', '94.2%']) {
  assert(!qualityText.includes(fake), `pourcentage codé en dur retiré : ${fake}`);
}
assert(/ÉTAT : /.test(qualityText), 'l\'état vient du produit réel');

console.log('\nJ. Intégrité de la feuille de style');
const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
eq(css.split('{').length, css.split('}').length, 'les accolades CSS sont équilibrées');
for (const dead of ['.intel-', '.tc-echelon', '.tc-reconcil']) {
  assert(!css.includes(dead), `aucune règle CSS morte : ${dead}`);
}

console.log(`\n${'='.repeat(64)}`);
if (failures) {
  console.error(`test:supplychain:surface FAILED — ${failures} échec(s), ${checks} contrôle(s) réussi(s).`);
  process.exit(1);
}
console.log(`test:supplychain:surface passed — ${checks} contrôles, 0 échec.`);
