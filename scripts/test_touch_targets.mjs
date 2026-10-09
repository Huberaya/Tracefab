#!/usr/bin/env node
/**
 * Plancher de cible tactile — garde de non-regression.
 *
 * Un audit des neuf pages avait releve 33 types de controles sous 40 px de
 * haut : navigation a 39 px, selecteurs de langue a 30 px, pastilles de filtre
 * a 23 px, boutons-liens a 14 px. La feuille
 * assets/design-system/tracefab-touch.css pose le plancher ; ce test verifie
 * qu'il tient, sur toutes les pages et a toutes les largeurs.
 *
 * Les liens en ligne au fil d'un texte sont exclus : WCAG 2.5.8 les exempte
 * explicitement et les grossir casserait l'interlignage editorial.
 *
 *   node scripts/test_touch_targets.mjs [--base http://127.0.0.1:3000]
 */
import { chromium } from 'playwright';

const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '').split('=')[1]
  || process.argv[process.argv.indexOf('--base') + 1]
  || 'http://127.0.0.1:3000';

const MIN = 40;
const PAGES = ['/', '/brand-console/', '/supplier-portal/', '/dpp/', '/quality-center/',
  '/operations/', '/passport/', '/product-intelligence/', '/invitations/accept/'];
const WIDTHS = [390, 760, 1280];

const browser = await chromium.launch();
let failures = 0;

for (const path of PAGES) {
  const offenders = new Map();
  for (const width of WIDTHS) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(BASE + path, { waitUntil: 'load' });
    await page.waitForTimeout(1300);
    const bad = await page.evaluate((min) => {
      const out = [];
      const sel = 'button, a[href], select, input:not([type=hidden]), [role="button"], summary';
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        if (r.height >= min && r.width >= min) continue;
        // WCAG 2.5.8 : un lien au fil d'une phrase n'est pas une cible a
        // dimensionner. On le reconnait a son display inline dans un parent
        // qui porte nettement plus de texte que lui.
        const par = el.parentElement;
        const inlineInText = el.tagName === 'A' && par
          && cs.display.startsWith('inline')
          && par.textContent.trim().length > el.textContent.trim().length + 12;
        if (inlineInText) continue;
        const cls = typeof el.className === 'string' && el.className.trim()
          ? '.' + el.className.trim().split(/\s+/)[0] : '';
        out.push(`${el.tagName.toLowerCase()}${cls} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      return out;
    }, MIN);
    for (const b of bad) offenders.set(b, (offenders.get(b) || 0) + 1);
    await page.close();
  }
  if (offenders.size) {
    failures++;
    console.log(`  ECHEC ${path} : ${offenders.size} type(s) sous ${MIN}px`);
    for (const [k] of [...offenders].slice(0, 6)) console.log(`          ${k}`);
  } else {
    console.log(`  ok    ${path}`);
  }
}

await browser.close();
console.log('');
if (failures) {
  console.error(`Cibles tactiles : ${failures} page(s) sous le plancher de ${MIN}px.`);
  process.exit(1);
}
console.log(`Cibles tactiles : OK — ${PAGES.length} pages x ${WIDTHS.length} largeurs, plancher ${MIN}px tenu.`);
