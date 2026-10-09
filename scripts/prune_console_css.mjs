#!/usr/bin/env node
/**
 * Elagage de assets/design-system/tracefab-console.css.
 *
 * Ce fichier porte le nom de la Brand Console, mais la console ne le charge
 * pas : elle a sa propre feuille en ligne. Le seul consommateur est
 * product-intelligence/, une page de 7,7 ko qui en utilise 33 classes sur
 * 193. Le reste — environ 78 % du poids — est expedie a chaque visiteur sans
 * jamais rien peindre.
 *
 * L'elagage ne se fait pas par recherche textuelle, trop fragile pour les
 * selecteurs composes et les DOM construits en JS : chaque selecteur est
 * teste contre le DOM reellement rendu, aux deux largeurs de reference.
 *
 *   node scripts/prune_console_css.mjs [--write]
 *
 * Sans --write, le script se contente de rapporter.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const SRC = 'assets/design-system/tracefab-console.css';
const PAGE = 'http://127.0.0.1:3000/product-intelligence/';
const WRITE = process.argv.includes('--write');

const css = readFileSync(SRC, 'utf8');

/* -- 1. Decoupage en blocs de premier niveau ------------------------------ */
function split(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    // commentaires et blancs de tete
    const ws = /^\s*/.exec(src.slice(i))[0];
    if (ws) { out.push({ type: 'raw', text: ws }); i += ws.length; continue; }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i) + 2;
      out.push({ type: 'comment', text: src.slice(i, end) });
      i = end; continue;
    }
    const open = src.indexOf('{', i);
    if (open === -1) { out.push({ type: 'raw', text: src.slice(i) }); break; }
    // equilibrage des accolades
    let depth = 0, j = open;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) break; }
    }
    const prelude = src.slice(i, open).trim();
    const body = src.slice(open + 1, j);
    out.push({ type: prelude.startsWith('@') ? 'at' : 'rule', prelude, body, text: src.slice(i, j + 1) });
    i = j + 1;
  }
  return out;
}

/* -- 2. Selecteurs a tester ----------------------------------------------- */
// On retire les pseudo-classes et pseudo-elements : ils ne changent pas
// l'existence de l'element porteur, seulement son etat.
const strip = (s) => s
  .replace(/::?[a-z-]+(\([^)]*\))?/gi, '')
  .replace(/\s+/g, ' ')
  .trim();

const blocks = split(css);
const selectorSet = new Set();
const collect = (bs) => {
  for (const b of bs) {
    if (b.type === 'rule') {
      for (const s of b.prelude.split(',')) {
        const c = strip(s);
        if (c && !c.startsWith('@')) selectorSet.add(c);
      }
    } else if (b.type === 'at' && /^@media/i.test(b.prelude)) {
      collect(split(b.body));
    }
  }
};
collect(blocks);

/* -- 3. Test contre le DOM rendu ------------------------------------------ */
const browser = await chromium.launch();
const alive = new Set();
// La page rend 11 onglets, chacun avec son propre DOM : n'en mesurer qu'un
// ferait passer pour mortes les regles des dix autres. On les parcourt tous,
// aux deux largeurs de reference.
let tabsSeen = 0;
for (const width of [390, 1280]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(PAGE, { waitUntil: 'load' });
  await page.waitForTimeout(1800);
  const tabs = await page.evaluate(() =>
    [...document.querySelectorAll('.pi-tab')].map((b) => b.dataset.tab).filter(Boolean));
  if (!tabs.length) throw new Error('aucun onglet .pi-tab trouve — la page a change de structure');
  tabsSeen = tabs.length;
  for (const tab of tabs) {
    await page.evaluate((t) => {
      const b = document.querySelector(`.pi-tab[data-tab="${t}"]`);
      if (b) b.click();
    }, tab);
    await page.waitForTimeout(450);
    const hits = await page.evaluate((sels) => sels.filter((s) => {
      try { return !!document.querySelector(s); } catch { return true; }
    }), [...selectorSet]);
    hits.forEach((h) => alive.add(h));
  }
  await page.close();
}
await browser.close();
console.log(`onglets parcourus   : ${tabsSeen}`);

// --- Regle de famille sur les attributs de donnees -------------------------
// Les valeurs de [data-level] / [data-sev] viennent des fixtures. Les donnees
// de demo n'exposent qu'une partie de l'echelle de confiance (missing, review,
// declared, documented, verified, certified) : le DOM ne prouve donc PAS
// qu'une variante est morte, seulement qu'elle n'est pas jouee aujourd'hui.
// Des qu'une variante d'un attribut est vivante, on conserve toute la famille.
const liveAttrs = new Set();
for (const sel of alive) {
  for (const m of sel.matchAll(/\[(data-[a-z-]+)=/g)) liveAttrs.add(m[1]);
}
let rescued = 0;
for (const sel of selectorSet) {
  if (alive.has(sel)) continue;
  for (const m of sel.matchAll(/\[(data-[a-z-]+)=/g)) {
    if (liveAttrs.has(m[1])) { alive.add(sel); rescued++; break; }
  }
}
if (rescued) console.log(`variantes rattrapees : ${rescued} (familles ${[...liveAttrs].join(', ')})`);

/* -- 4. Reconstruction ----------------------------------------------------- */
const keepRule = (b) => b.prelude.split(',').some((s) => {
  const c = strip(s);
  // :root et les declarations de variables sont toujours conservees
  return !c || c === ':root' || c === 'html' || c === 'body' || c === '*' || alive.has(c);
});

function rebuild(bs, indent = '') {
  let out = '';
  for (const b of bs) {
    if (b.type === 'comment' || b.type === 'raw') { out += b.text; continue; }
    if (b.type === 'at') {
      if (/^@media/i.test(b.prelude)) {
        const inner = rebuild(split(b.body), indent + '  ');
        if (/[a-zA-Z]/.test(inner.replace(/\/\*[\s\S]*?\*\//g, ''))) {
          out += `${b.prelude} {${inner}}\n`;
        }
      } else {
        out += b.text; // @keyframes, @font-face, @import : conserves
      }
      continue;
    }
    if (keepRule(b)) out += `${b.prelude} {${b.body}}\n`;
  }
  return out;
}

const pruned = rebuild(blocks)
  .replace(/\n{3,}/g, '\n\n');

const before = css.length, after = pruned.length;
console.log(`selecteurs declares : ${selectorSet.size}`);
console.log(`selecteurs vivants  : ${alive.size}`);
console.log(`poids : ${before} o -> ${after} o  (-${Math.round((1 - after / before) * 100)} %)`);
console.log(`regles : ${(css.match(/\{/g) || []).length} -> ${(pruned.match(/\{/g) || []).length}`);

if (WRITE) {
  writeFileSync(SRC, pruned);
  console.log(`\necrit ${SRC}`);
} else {
  console.log('\n(lecture seule — relancer avec --write pour appliquer)');
}
