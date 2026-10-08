#!/usr/bin/env node
/**
 * Detection de copie metier non traduite.
 *
 * Remplace un controle qui s'intitulait « Aucune copie metier en dur hors
 * catalogue » mais n'assertait que `totalKeys > 1400`. Un catalogue volumineux
 * ne dit rien de ce qui reste en dur dans les pages : le controle promettait
 * beaucoup plus qu'il ne verifiait. Il a laisse passer quatre chaines
 * francaises affichees sur une page `lang="en"`.
 *
 * Principe : une chaine traduite CHANGE quand on bascule la langue. On releve
 * donc le texte visible en anglais, on passe en francais, on releve a nouveau,
 * et tout ce qui n'a pas bouge est suspect — sauf ce qui est invariant par
 * nature. Ces exceptions sont listees ci-dessous une par une, avec leur
 * raison : c'est la liste qu'un relecteur doit contester, pas le resultat.
 *
 * Usage : node scripts/test_hardcoded_copy.mjs [--base http://127.0.0.1:3000] [--list]
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const argv = process.argv;
const BASE = argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : 'http://127.0.0.1:3000';
const LIST = argv.includes('--list');

const PAGES = ['/', '/brand-console/', '/supplier-portal/', '/quality-center/', '/operations/',
  '/passport/', '/dpp/', '/product-intelligence/', '/invitations/accept'];

/** Invariants legitimes. Chaque motif porte sa justification. */
const ALLOW = [
  // Marque et noms de surfaces : un nom de produit ne se traduit pas.
  [/tracefab/i, 'marque'],
  [/\b(brand console|supplier portal|supplier workspace|universal supplier passport)\b/i, 'nom de surface'],
  // Normes, reglements et formats : des identifiants, pas de la copie.
  [/\b(ESPR|AGEC|CSRD|GS1|OEKO-TEX|GOTS|GRS|SMETA|ISO|EPCIS|PEF|SHA-256|NDA|CSV|Excel|PDF|API)\b/, 'norme ou format'],
  [/\b(Apple|Google) Wallet\b/, 'nom de service tiers'],
  [/Control Union|Global Organic Textile Standard|Digital Link/i, 'organisme ou norme'],
  // Donnees de demonstration : noms propres, lieux, references produit.
  // Decision produit assumee — la donnee de demo reste en anglais, sans cle.
  [/Atelier (Demo|Milano)|Camille Martin|Rui Costa|Nhãn Textile|Fibrha|Guimarães|Adriatic|Portugal Textile Mill/, 'entite de demonstration'],
  [/\b(Paris|Porto|Braga|Milano|Lisboa)\b|United States/, 'toponyme'],
  [/Organic Cotton|Recycled Cotton|natural linen|Autumn collection|product-data-core|Product data core/i, 'reference produit de demo'],
  [/Knitting & Cutting|Garment Making|Integrated textile manufacture/i, 'libelle de site de demo'],
  [/\bBatch:|Tier \d|\d+ site\(s\)|Trade secret redacted/, 'valeur de demonstration'],
  [/Origin and composition|Design system/i, 'libelle de demo'],
];

// Certaines traductions sont legitimement identiques d'une langue a l'autre
// (« sites » se dit « sites »). La bascule de langue ne peut pas distinguer
// « non traduit » de « traduit a l'identique » : on tranche sur le catalogue.
// Tout mot qui est la valeur d'une cle dont EN et FR coincident est explique.
const ctx = { window: {} };
vm.runInContext(readFileSync(new URL('../assets/i18n/en.js', import.meta.url), 'utf8'),
  vm.createContext(ctx));
const EN = ctx.window.TF_I18N_BUNDLES.en;
const FR = JSON.parse(readFileSync(new URL('../assets/i18n/fr.json', import.meta.url), 'utf8'));
const sameInBoth = new Set();
for (const [root, table] of Object.entries(EN)) {
  if (!table || typeof table !== 'object' || !FR[root]) continue;
  for (const [k, v] of Object.entries(table)) {
    if (typeof v === 'string' && FR[root][k] === v) {
      v.toLowerCase().split(/[^a-zà-ÿ0-9]+/).filter(Boolean).forEach((w) => sameInBoth.add(w));
    }
  }
}

const explain = (s) => {
  const hit = ALLOW.find(([re]) => re.test(s));
  if (hit) return hit;
  // mots restants une fois retires chiffres et ponctuation
  const words = s.toLowerCase().split(/[^a-zà-ÿ0-9]+/).filter((w) => w && !/^\d+$/.test(w));
  if (words.length && words.every((w) => sameInBoth.has(w))) {
    return [null, 'traduction identique en FR (cle presente au catalogue)'];
  }
  return undefined;
};

const snapshot = (page) => page.evaluate(() => {
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    const t = (n.textContent || '').trim().replace(/\s+/g, ' ');
    if (t.length < 4 || !/[A-Za-z]{3}/.test(t)) continue;
    const el = n.parentElement;
    if (!el || el.closest('script,style')) continue;
    if (!el.offsetParent && el.tagName !== 'BODY') continue;
    out.push(t.slice(0, 80));
  }
  return out;
});

const browser = await chromium.launch();
let suspects = 0;
let scanned = 0;
const allowedHits = new Map();

for (const url of PAGES) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  let frozen = [];
  try {
    await page.goto(BASE + url, { waitUntil: 'load' });
    await page.waitForTimeout(1700);
    const en = await snapshot(page);
    const switched = await page.evaluate(() =>
      (window.TF_I18N ? window.TF_I18N.setLanguage('fr').then(() => true, () => false) : false));
    if (!switched) { console.log(`  ECHEC ${url} : bascule de langue impossible`); suspects += 1; await page.close(); continue; }
    await page.waitForTimeout(1400);
    const fr = await snapshot(page);
    scanned += en.length;
    // Une chaine presente a l'identique dans les deux releves n'a pas ete traduite.
    frozen = [...new Set(en.filter((t) => fr.includes(t)))]
      .filter((t) => /\s/.test(t) && /[a-z]{3}/.test(t)); // mots isoles et sigles : hors perimetre
  } catch (e) {
    console.log(`  ECHEC ${url} : ${String(e).slice(0, 70)}`);
    suspects += 1; await page.close(); continue;
  }

  const unexplained = [];
  for (const s of frozen) {
    const hit = explain(s);
    if (hit) allowedHits.set(hit[1], (allowedHits.get(hit[1]) || 0) + 1);
    else unexplained.push(s);
  }
  if (unexplained.length) {
    console.log(`  ECHEC ${url} : ${unexplained.length} chaine(s) non traduite(s) et non justifiee(s)`);
    unexplained.forEach((s) => console.log(`         « ${s} »`));
    suspects += unexplained.length;
  } else {
    console.log(`  ok    ${url.padEnd(24)} ${String(frozen.length).padStart(3)} invariant(s), tous justifies`);
  }
  if (LIST) frozen.forEach((s) => console.log(`         [${explain(s)?.[1] || 'NON JUSTIFIE'}] ${s}`));
  await page.close();
}

await browser.close();

console.log(`\n  ${scanned} chaines visibles analysees sur ${PAGES.length} pages`);
console.log(`  exceptions appliquees : ${[...allowedHits].map(([k, v]) => `${k} (${v})`).join(', ')}`);
console.log(suspects
  ? `\n${suspects} chaine(s) de copie metier non traduite(s)`
  : '\nCopie metier : aucune chaine non traduite hors exceptions justifiees');
process.exit(suspects ? 1 : 0);
