#!/usr/bin/env node
/**
 * Garde de regression pour `assets/design-system/tracefab-console.css`.
 *
 * Cette feuille a ete elaguee de 379 a 185 regles en testant chaque selecteur
 * contre le DOM vivant. L'elagage est sur tant que le DOM mesure couvre tout
 * ce que la page sait produire. Deux angles morts l'ont failli compromettre,
 * et ce test les ferme :
 *
 *   1. La page rend ONZE onglets. N'en mesurer qu'un ferait passer pour
 *      mortes les regles des dix autres. On les parcourt tous.
 *   2. Les valeurs de `data-level` viennent des fixtures. Le DOM ne prouve
 *      pas qu'un niveau est mort, seulement qu'il n'est pas joue aujourd'hui.
 *      On verifie donc chaque niveau que le JS sait emettre, en le forcant.
 *
 * Usage : node scripts/test_console_css.mjs [--base http://127.0.0.1:3000]
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const baseIdx = process.argv.indexOf('--base');
const BASE = baseIdx > -1 ? process.argv[baseIdx + 1] : 'http://127.0.0.1:3000';
const PAGE = `${BASE}/product-intelligence/`;
const UNSTYLED = 'rgb(255, 255, 255)'; // pastille laissee blanche = niveau sans regle

const fails = [];
const ok = (label) => console.log(`  ok   ${label}`);
const ko = (label) => { fails.push(label); console.log(`  ECHEC ${label}`); };

// Niveaux de confiance que le rendu sait reellement produire, lus a la source.
const js = readFileSync(new URL('../assets/js/tf-product.js', import.meta.url), 'utf8');
const levels = [...new Set([...js.matchAll(/level:\s*'([a-z]+)'/g)].map((m) => m[1]))].sort();
if (!levels.length) throw new Error('aucun niveau de confiance trouve dans tf-product.js');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const jsErrors = [];
const notFound = [];
page.on('pageerror', (e) => jsErrors.push(String(e).slice(0, 120)));
page.on('response', (r) => {
  if (r.status() >= 400 && !r.url().includes('/api/')) notFound.push(`${r.status()} ${r.url()}`);
});

await page.goto(PAGE, { waitUntil: 'load' });
await page.waitForTimeout(1600);

// --- 1. Les onze onglets rendent -------------------------------------------
const tabs = await page.evaluate(() =>
  [...document.querySelectorAll('.pi-tab')].map((b) => b.dataset.tab).filter(Boolean));
if (tabs.length >= 11) ok(`${tabs.length} onglets exposes`);
else ko(`${tabs.length} onglets exposes, 11 attendus`);

for (const width of [390, 1280]) {
  await page.setViewportSize({ width, height: 900 });
  for (const tab of tabs) {
    await page.evaluate((t) => {
      const b = document.querySelector(`.pi-tab[data-tab="${t}"]`);
      if (b) b.click();
    }, tab);
    await page.waitForTimeout(260);
    const r = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      nodes: document.querySelector('#pi-panel, [role="tabpanel"]')?.querySelectorAll('*').length || 0,
    }));
    if (r.overflow > 1) ko(`onglet ${tab} @${width}px : debordement ${r.overflow}px`);
    if (r.nodes === 0) ko(`onglet ${tab} @${width}px : panneau vide`);
  }
}
if (!fails.length) ok(`${tabs.length} onglets x 2 largeurs : 0 debordement, 0 panneau vide`);

// --- 2. L'echelle de confiance est complete ---------------------------------
await page.setViewportSize({ width: 1280, height: 900 });
await page.evaluate(() => {
  const b = document.querySelector('.pi-tab[data-tab="history"]');
  if (b) b.click();
});
await page.waitForTimeout(400);

const dots = await page.evaluate((lvls) => {
  const ev = document.querySelector('.pi-event');
  if (!ev) return null;
  const keep = ev.getAttribute('data-level');
  const out = {};
  for (const l of lvls) {
    ev.setAttribute('data-level', l);
    out[l] = getComputedStyle(ev, '::before').backgroundColor;
  }
  if (keep) ev.setAttribute('data-level', keep);
  return out;
}, levels);

if (!dots) {
  ko('aucun .pi-event dans la frise — structure changee');
} else {
  for (const [lvl, color] of Object.entries(dots)) {
    if (color === UNSTYLED) ko(`niveau "${lvl}" emis par le JS mais sans pastille (reste blanc)`);
  }
  if (Object.values(dots).every((c) => c !== UNSTYLED)) {
    ok(`echelle de confiance complete : ${levels.join(', ')}`);
  }
}

// Aucune pastille blanche dans la frise reellement rendue.
const live = await page.evaluate(() => {
  let blank = 0;
  const all = document.querySelectorAll('.pi-event');
  all.forEach((e) => {
    if (getComputedStyle(e, '::before').backgroundColor === 'rgb(255, 255, 255)') blank += 1;
  });
  return { total: all.length, blank };
});
if (live.blank) ko(`${live.blank} pastille(s) non stylee(s) sur ${live.total} dans la frise`);
else ok(`frise rendue : ${live.total} evenements, 0 pastille non stylee`);

// --- 3. Hygiene de page ------------------------------------------------------
if (jsErrors.length) ko(`${jsErrors.length} erreur(s) JS : ${jsErrors[0]}`);
else ok('0 erreur JS');
if (notFound.length) ko(`${notFound.length} ressource(s) manquante(s) : ${notFound[0]}`);
else ok('0 ressource manquante');

await browser.close();

console.log(fails.length
  ? `\n${fails.length} echec(s)`
  : '\ntracefab-console.css : garde verte');
process.exit(fails.length ? 1 : 0);
