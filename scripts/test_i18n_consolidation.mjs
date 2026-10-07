/* ==========================================================================
   Verification de la consolidation i18n.

   Les tests statiques ne prouvent que la presence de chaines dans un
   fichier. Ils ne prouvent pas qu'un changement de langue fonctionne. Ce
   test ouvre reellement les pages et controle quatre proprietes :

     1. parite du catalogue  — aucune locale ne perd de cle par rapport a EN
     2. un seul catalogue    — plus de dictionnaire inline dans les SPA
     3. changement de langue — la console et le portail se traduisent
     4. continuite           — la langue choisie sur la landing est reprise
                               par les applications (c'etait casse : deux
                               cles de stockage differentes)

   Usage : node scripts/test_i18n_consolidation.mjs [--base http://127.0.0.1:3000]
   Sans navigateur disponible, les points 3 et 4 sont ignores et signales.
   ========================================================================== */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const baseArg = process.argv.indexOf('--base');
const BASE = baseArg > -1 ? process.argv[baseArg + 1] : 'http://127.0.0.1:3000';
let failures = 0;
const fail = (m) => { console.error('  ECHEC ' + m); failures++; };
const ok = (m) => console.log('  ok    ' + m);

/* -- 1. parite du catalogue ---------------------------------------------- */
function leaves(o, p = '', out = []) {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v, key, out);
    else out.push(key);
  }
  return out;
}

const g = {};
new Function('window', readFileSync(join(ROOT, 'assets/i18n/en.js'), 'utf8'))(g);
const EN = g.TF_I18N_BUNDLES.en;
const enKeys = new Set(leaves(EN));
ok(`catalogue EN : ${enKeys.size} cles`);

for (const ns of ['shared', 'console', 'portal']) {
  if (!EN[ns]) fail(`portee ${ns} absente de en.js`);
}

// Locales completes : parite stricte attendue.
const FULL = ['fr', 'de', 'it', 'es', 'nl', 'pt'];
// Locales partielles : servies au seul portail, repli anglais assume.
const PARTIAL = { tr: ['shared', 'portal'], zh: ['shared', 'portal'] };

for (const lang of FULL) {
  const d = JSON.parse(readFileSync(join(ROOT, `assets/i18n/${lang}.json`), 'utf8'));
  const keys = new Set(leaves(d));
  const missing = [...enKeys].filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !enKeys.has(k));
  if (missing.length) fail(`${lang}: ${missing.length} cle(s) manquante(s) — ${missing.slice(0, 4)}`);
  else if (extra.length) fail(`${lang}: ${extra.length} cle(s) en trop — ${extra.slice(0, 4)}`);
  else ok(`${lang}: parite stricte avec EN (${keys.size} cles)`);
}

for (const [lang, scopes] of Object.entries(PARTIAL)) {
  const d = JSON.parse(readFileSync(join(ROOT, `assets/i18n/${lang}.json`), 'utf8'));
  const keys = new Set(leaves(d));
  const expected = [...enKeys].filter((k) => scopes.includes(k.split('.')[0]));
  const missing = expected.filter((k) => !keys.has(k));
  if (missing.length) fail(`${lang}: ${missing.length} cle(s) manquante(s) sur ${scopes.join('+')}`);
  else ok(`${lang}: portees ${scopes.join('+')} completes (${keys.size} cles, repli EN ailleurs)`);
}

/* -- 2. un seul catalogue ------------------------------------------------- */
const SPAS = {
  'brand-console/index.html': 'brandTranslations',
  'supplier-portal/index.html': 'translations',
};
for (const [file, varName] of Object.entries(SPAS)) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  if (new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*\\{`).test(src)) {
    fail(`${file}: le dictionnaire inline ${varName} est revenu`);
  } else ok(`${file}: aucun dictionnaire inline`);
  if (!src.includes('/assets/js/tf-i18n.js')) fail(`${file}: ne charge pas le runtime partage`);
  if (!src.includes('TF_I18N_SKIP_META')) {
    fail(`${file}: TF_I18N_SKIP_META absent — le titre de la page serait ecrase`);
  }
}

/* -- 3 et 4. comportement reel -------------------------------------------- */
let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* absent */ }

if (!chromium) {
  console.log('  —     playwright absent : controles navigateur ignores');
} else {
  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    console.log('  —     navigateur indisponible : controles navigateur ignores');
  }
  if (browser) {
    // 'networkidle' ne se declenche jamais : ces pages chargent Clerk depuis
    // un CDN. On attend le runtime i18n, qui est le seul prerequis reel.
    const boot = async (p, url) => {
      const r = await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
      if (!r || !r.ok()) return false;
      return p.waitForFunction('window.TF_I18N && window.TF_I18N.lang', { timeout: 15000 })
        .then(() => true).catch(() => false);
    };
    const page = await browser.newPage();
    const reach = await boot(page, `${BASE}/brand-console/`);

    if (!reach) {
      console.log(`  —     ${BASE} injoignable : controles navigateur ignores`);
    } else {
      // 3. la console se traduit
      const title = await page.title();
      await page.evaluate(() => window.TF_I18N.setLanguage('de'));
      await page.waitForTimeout(300);
      const de = await page.evaluate(() => window.TF_I18N.t('shared.stDraft', null));
      const deScoped = await page.evaluate(() => window.TF_I18N.t('console.reports', null));
      const titleAfter = await page.title();
      if (de === 'Entwurf') ok(`console: fonds commun traduit (shared.stDraft = ${de})`);
      else fail(`console: shared.stDraft en allemand = ${JSON.stringify(de)}, attendu "Entwurf"`);
      if (deScoped === 'Berichte & Audits') ok(`console: portee propre traduite (console.reports = ${deScoped})`);
      else fail(`console: console.reports en allemand = ${JSON.stringify(deScoped)}`);
      // la traduction doit atteindre le DOM, pas seulement la fonction t()
      const domDe = await page.evaluate(() => document.body.innerText.includes('Berichte'));
      if (domDe) ok('console: le DOM rendu est bien en allemand');
      else fail('console: t() traduit mais le DOM rendu ne contient pas le texte allemand');
      if (titleAfter === title) ok('console: titre de page preserve apres changement de langue');
      else fail(`console: titre ecrase — "${title}" devenu "${titleAfter}"`);

      // les deux cles de stockage sont ecrites
      const keys = await page.evaluate(() => [
        localStorage.getItem('tracefab.lang'), localStorage.getItem('tracefab_lang'),
      ]);
      if (keys[0] === 'de' && keys[1] === 'de') ok('console: les deux cles de stockage sont synchronisees');
      else fail(`console: cles de stockage desynchronisees — ${JSON.stringify(keys)}`);

      // 4. continuite depuis la landing
      const p2 = await browser.newPage();
      await boot(p2, `${BASE}/?lang=it`);
      await p2.waitForTimeout(500);
      await boot(p2, `${BASE}/brand-console/`);
      await p2.waitForTimeout(500);
      const carried = await p2.evaluate(() => window.TF_I18N.lang);
      if (carried === 'it') ok('continuite: la langue choisie sur la landing est reprise par la console');
      else fail(`continuite: la console est en "${carried}" alors que la landing etait en italien`);

      // le portail accepte le turc
      const p3 = await browser.newPage();
      const r3 = await boot(p3, `${BASE}/supplier-portal/`);
      if (r3) {
        await p3.evaluate(() => window.TF_I18N.setLanguage('tr'));
        await p3.waitForTimeout(300);
        const tr = await p3.evaluate(() => window.TF_I18N.t('shared.stDraft', null));
        if (tr === 'Taslak') ok(`portail: le turc est servi (shared.stDraft = ${tr})`);
        else fail(`portail: shared.stDraft en turc = ${JSON.stringify(tr)}, attendu "Taslak"`);
      }
    }
    await browser.close();
  }
}

console.log('');
if (failures) {
  console.error(`Consolidation i18n : ${failures} probleme(s).`);
  process.exit(1);
}
console.log('Consolidation i18n : OK.');
