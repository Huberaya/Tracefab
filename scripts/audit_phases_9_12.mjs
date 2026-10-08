#!/usr/bin/env node
/**
 * Batterie d'audit des phases 9 a 12 du cahier des charges TRACEFAB.
 *
 *   PHASE 9  — Tracabilite        : vue supplyChain + lignage produit
 *   PHASE 10 — DPP Readiness      : vue dpp de la console de marque
 *   PHASE 11 — DPP public         : page /dpp/ destinee au consommateur
 *   PHASE 12 — i18n               : architecture et couverture des 7 langues
 *
 * Mesure ce que le cahier des charges exige explicitement, puis la liste de
 * controles imposee apres chaque phase : responsive, accessibilite,
 * performance, routes. Aucun chiffre n'est ecrit en dur : tout est mesure.
 *
 *   node scripts/audit_phases_9_12.mjs --base http://127.0.0.1:3000
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '').split('=')[1]
  || process.argv[process.argv.indexOf('--base') + 1]
  || 'http://127.0.0.1:3000';

const results = [];
let failed = 0;

function check(phase, label, ok, got, want) {
  results.push({ phase, label, ok: !!ok, got: String(got), want: String(want) });
  if (!ok) failed++;
}

/** Navigue vers une vue de la console de marque et rend la main une fois peinte. */
async function gotoView(page, view) {
  return page.evaluate(async (v) => {
    const b = document.querySelector(`.nav button[data-view="${v}"]`);
    if (!b) return false;
    b.click();
    await new Promise((r) => setTimeout(r, 750));
    return true;
  }, view);
}

/** Mesure commune a toute page : debordement, cibles tactiles, fuites de gabarit. */
async function hygiene(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const small = [...document.querySelectorAll('button, a[href], select, input, [role="button"]')]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (r.height < 40 || r.width < 40);
      }).length;
    const imgs = [...document.querySelectorAll('img')];
    return {
      overflow: doc.scrollWidth - doc.clientWidth,
      touchSmall: small,
      imgNoAlt: imgs.filter((i) => !i.hasAttribute('alt')).length,
      leak: /\$\{|\bundefined\b|\bNaN\b|\[object Object\]/.test(document.body.innerText),
      h1: document.querySelectorAll('h1').length,
      lang: doc.lang,
    };
  });
}

const browser = await chromium.launch();

/* ------------------------------------------------------------------ */
/* PHASE 9 — Tracabilite                                               */
/* ------------------------------------------------------------------ */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 90)));
  await page.goto(BASE + '/brand-console/', { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  const ok = await gotoView(page, 'supplyChain');
  check('9', 'Vue Supply Chain atteignable', ok, ok ? 'oui' : 'non', 'oui');

  const sc = await page.evaluate(() => {
    const main = document.querySelector('.content, main') || document.body;
    const txt = main.innerText;
    // Les sept etapes imposees par le brief pour la chaine de valeur.
    const steps = ['FIBER', 'MATERIAL', 'SPINNING', 'WEAVING', 'DYEING', 'CUTTING', 'ASSEMBLY'];
    const found = steps.filter((s) => new RegExp(s, 'i').test(txt));
    return {
      chars: txt.replace(/\s+/g, ' ').trim().length,
      blocks: main.querySelectorAll('tr, .card, .mc-tile, li, .pillar-card, .item, .node').length,
      steps: found,
      tiers: /tier\s*0?[1-9]/i.test(txt),
      // Le produit ecrit « Türkiye », pas « Turkey », et abrege en code ISO.
      countries: (txt.match(/\b(France|Portugal|Italy|Italia|Germany|Deutschland|T[üu]rkiye|Turkey|India|Bangladesh|Vietnam|China|Morocco|Tunisia|FR|PT|IT|DE|TR)\b/g) || []).length,
    };
  });
  check('9', 'Vue Supply Chain non squelettique', sc.chars > 1500, sc.chars + ' car.', '> 1500');
  check('9', 'Blocs de contenu rendus', sc.blocks >= 10, sc.blocks + ' blocs', '>= 10');
  check('9', 'Niveaux de rang (Tier) exposes', sc.tiers, sc.tiers ? 'oui' : 'non', 'oui');
  check('9', 'Pays de production nommes', sc.countries >= 3, sc.countries + ' mentions', '>= 3');

  // Lignage : Champ -> Egrenage -> Filature -> Tricotage -> Ennoblissement ->
  // Confection -> Distribution. Il est rendu par la vue Supply Chain elle-meme.
  const lineage = await page.evaluate(() => {
    const txt = (document.querySelector('.content, main') || document.body).innerText;
    const stages = [/farm|field|champ/i, /gin|egren/i, /spin|filature/i,
      /knit|weav|tricot|tiss/i, /finish|dye|ennobl|teint/i, /assembl|confection/i,
      /distrib/i];
    return { found: stages.filter((re) => re.test(txt)).length };
  });
  check('9', 'Lignage multi-etapes de la chaine', lineage.found >= 5,
    lineage.found + '/7 etapes', '>= 5');

  const h9 = await hygiene(page);
  check('9', 'Aucun debordement horizontal', h9.overflow === 0, h9.overflow + 'px', '0px');
  check('9', 'Aucune fuite de gabarit', !h9.leak, h9.leak ? 'fuite' : 'propre', 'propre');
  check('9', 'Aucune erreur JS', errs.length === 0, errs.length + ' erreur(s)', '0');
  await page.close();
}

/* ------------------------------------------------------------------ */
/* PHASE 10 — DPP Readiness                                            */
/* ------------------------------------------------------------------ */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 90)));
  await page.goto(BASE + '/brand-console/', { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  const ok = await gotoView(page, 'dpp');
  check('10', 'Vue DPP Readiness atteignable', ok, ok ? 'oui' : 'non', 'oui');

  const dp = await page.evaluate(() => {
    const main = document.querySelector('.content, main') || document.body;
    const txt = main.innerText;
    return {
      chars: txt.replace(/\s+/g, ' ').trim().length,
      score: /\b(8[0-9]|9[0-9]|7[0-9])\s*%/.test(txt),
      hasChecks: (txt.match(/✓/g) || []).length,
      hasGaps: (txt.match(/[⚠✗]/g) || []).length,
      // Le score ne doit JAMAIS etre presente comme une certification legale.
      claimsCert: /(certifi(e|ed|cation)\s+(ESPR|DPP|legal)|DPP\s+(Conforme|Compliant|Konform))/i.test(txt),
      // Il doit au contraire etre qualifie d'indicateur.
      saysIndicator: /(indicateur|indicator|readiness|preparation|pr[ée]paration)/i.test(txt),
      actionList: main.querySelectorAll('button, a[href]').length,
      resolveBtns: main.querySelectorAll('[data-action="dp-resolve"]').length,
      gapRows: main.querySelectorAll('.item').length,
    };
  });
  check('10', 'Vue DPP non squelettique', dp.chars > 1200, dp.chars + ' car.', '> 1200');
  check('10', 'Score de preparation affiche', dp.score, dp.score ? 'oui' : 'non', 'oui');
  check('10', 'Items conformes (✓) presents', dp.hasChecks >= 3, dp.hasChecks + ' marques', '>= 3');
  check('10', 'Ecarts (✗) presents', dp.hasGaps >= 1, dp.hasGaps + ' marques', '>= 1');
  check('10', 'JAMAIS presente comme certification', !dp.claimsCert,
    dp.claimsCert ? 'REVENDICATION TROUVEE' : 'aucune', 'aucune');
  check('10', 'Qualifie d indicateur de preparation', dp.saysIndicator,
    dp.saysIndicator ? 'oui' : 'non', 'oui');
  check('10', 'Liste d actions cliquables', dp.actionList >= 5, dp.actionList + ' controles', '>= 5');
  check('10', 'Chaque ecart mene a sa correction', dp.resolveBtns >= 1 && dp.resolveBtns === dp.gapRows,
    dp.resolveBtns + ' boutons / ' + dp.gapRows + ' ecarts', 'un par ecart');

  const h10 = await hygiene(page);
  check('10', 'Aucun debordement horizontal', h10.overflow === 0, h10.overflow + 'px', '0px');
  check('10', 'Aucune erreur JS', errs.length === 0, errs.length + ' erreur(s)', '0');
  await page.close();
}

/* ------------------------------------------------------------------ */
/* PHASE 11 — DPP public                                               */
/* ------------------------------------------------------------------ */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errs = [];
  const bad = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 90)));
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().includes('/api/')) bad.push(r.status() + ' ' + r.url());
  });
  const t0 = Date.now();
  await page.goto(BASE + '/dpp/', { waitUntil: 'load' });
  const loadMs = Date.now() - t0;
  await page.waitForTimeout(1200);

  const pub = await page.evaluate(() => {
    // textContent et non innerText : les volets inactifs sont masques en CSS.
    const txt = document.body.textContent;
    // Les dix volets imposes par le brief pour l'experience consommateur.
    const panels = {
      Origin: /origin|origine|provenance/i, Materials: /material|mati[eè]re/i,
      Composition: /composition/i, Manufacturing: /manufactur|fabrication/i,
      Certifications: /certificat/i, Circularity: /circular|circularit/i,
      Care: /\bcare\b|entretien/i, Repair: /repair|r[ée]paration/i,
      Traceability: /traceab|tra[cç]abilit/i, Evidence: /evidence|preuve/i,
    };
    const found = Object.entries(panels).filter(([, re]) => re.test(txt)).map(([k]) => k);
    return {
      chars: txt.replace(/\s+/g, ' ').trim().length,
      panels: found,
      visible: document.body.innerText.replace(/\s+/g, ' ').trim().length,
      claimsCert: /(DPP\s+(Conforme|Compliant|Konform)|certifi[ée]\s+ESPR|Conforme R[eè]glementation)/i.test(txt),
      langSelect: !!document.querySelector('#dpp-lang-select'),
    };
  });
  check('11', 'DPP public non squelettique', pub.chars > 1500, pub.chars + ' car.', '> 1500');
  check('11', 'Volets du brief couverts', pub.panels.length >= 8,
    pub.panels.length + '/10 (' + pub.panels.join(',') + ')', '>= 8');
  check('11', 'Aucune revendication de conformite', !pub.claimsCert,
    pub.claimsCert ? 'REVENDICATION TROUVEE' : 'aucune', 'aucune');
  check('11', 'Selecteur de langue present', pub.langSelect, pub.langSelect ? 'oui' : 'non', 'oui');
  check('11', 'Chargement sous 3 s', loadMs < 3000, loadMs + ' ms', '< 3000 ms');
  check('11', 'Aucune ressource en echec', bad.length === 0, bad.length + ' echec(s)', '0');

  // Un DPP se scanne au telephone : le mobile n'est pas optionnel ici.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(700);
  const hm = await hygiene(page);
  check('11', 'Mobile 390px sans debordement', hm.overflow === 0, hm.overflow + 'px', '0px');
  check('11', 'Mobile : images avec alt', hm.imgNoAlt === 0, hm.imgNoAlt + ' sans alt', '0');
  check('11', 'Exactement un h1', hm.h1 === 1, hm.h1 + ' h1', '1');
  check('11', 'Aucune erreur JS', errs.length === 0, errs.length + ' erreur(s)', '0');
  await page.close();
}

/* ------------------------------------------------------------------ */
/* PHASE 12 — i18n                                                     */
/* ------------------------------------------------------------------ */
{
  // Volet statique : catalogues et parite.
  const vm = await import('node:vm');
  const ctx = { window: {} };
  vm.runInContext(fs.readFileSync('assets/i18n/en.js', 'utf8'), vm.createContext(ctx));
  const EN = ctx.window.TF_I18N_BUNDLES.en;
  const roots = Object.keys(EN);
  const full = ['fr', 'de', 'it', 'es', 'nl', 'pt'];

  let parityOk = true;
  const gaps = [];
  for (const l of full) {
    const J = JSON.parse(fs.readFileSync(`assets/i18n/${l}.json`, 'utf8'));
    for (const r of roots) {
      const missing = Object.keys(EN[r]).filter((k) => !(J[r] && k in J[r]));
      if (missing.length) { parityOk = false; gaps.push(`${l}.${r}:${missing.length}`); }
    }
  }
  const totalKeys = roots.reduce((n, r) => n + Object.keys(EN[r]).length, 0);
  check('12', 'Parite stricte sur les 6 locales', parityOk,
    parityOk ? 'complete' : gaps.slice(0, 4).join(' '), 'complete');
  check('12', 'Phase 1 du brief : EN/FR/DE/IT/ES/NL', full.slice(0, 5).every((l) => fs.existsSync(`assets/i18n/${l}.json`)),
    'presentes', 'presentes');

  // Volet dynamique : toutes les pages portent la pile et un selecteur.
  const pages = ['/', '/brand-console/', '/supplier-portal/', '/dpp/', '/quality-center/',
    '/operations/', '/passport/', '/product-intelligence/', '/invitations/accept/'];
  let withStack = 0, withSelector = 0, langEn = 0;
  const noSel = [];
  for (const path of pages) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(BASE + path, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    const o = await page.evaluate(() => ({
      stack: typeof window.TF_I18N === 'object' && !!window.TF_I18N,
      // La landing a un menu maison, les autres pages un <select>.
      sel: !!document.querySelector('select[id*="lang"], .lang-menu, [class*="lang-select"], .tf-lang, #lang-menu-btn'),
      lang: document.documentElement.lang,
    }));
    if (o.stack) withStack++;
    if (o.sel) withSelector++; else noSel.push(path);
    if (o.lang === 'en') langEn++;
    await page.close();
  }
  check('12', 'Pile i18n sur toutes les pages', withStack === pages.length,
    withStack + '/' + pages.length, pages.length + '/' + pages.length);
  check('12', 'Selecteur de langue sur toutes les pages', withSelector === pages.length,
    withSelector + '/' + pages.length + (noSel.length ? ' (manque ' + noSel.join(',') + ')' : ''),
    pages.length + '/' + pages.length);
  check('12', 'Toutes les pages en lang="en" par defaut', langEn === pages.length,
    langEn + '/' + pages.length, pages.length + '/' + pages.length);
  // Ce controle s'intitulait « Aucune copie metier en dur hors catalogue »
  // alors qu'il ne mesurait que la taille du catalogue. Un catalogue
  // volumineux ne dit rien de ce qui reste en dur dans les pages : le nom
  // promettait un resultat que l'assertion ne produisait pas, et quatre
  // chaines francaises affichees sur une page lang="en" sont passees dessous.
  // Il porte desormais le nom de ce qu'il fait. La copie non traduite est
  // verifiee par `npm run test:copy` (scripts/test_hardcoded_copy.mjs), qui
  // bascule la langue et compare le texte reellement rendu.
  check('12', 'Catalogue i18n au-dessus du seuil', totalKeys > 1400,
    totalKeys + ' cles catalogue', '> 1400');
}

await browser.close();

/* ------------------------------------------------------------------ */
const byPhase = {};
for (const r of results) (byPhase[r.phase] ||= []).push(r);
const titles = { 9: 'Tracabilite', 10: 'DPP Readiness', 11: 'DPP public', 12: 'i18n' };
for (const p of ['9', '10', '11', '12']) {
  const rs = byPhase[p] || [];
  const okN = rs.filter((r) => r.ok).length;
  console.log(`\nPHASE ${p} — ${titles[p]}   ${okN}/${rs.length}`);
  for (const r of rs) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(42)} ${r.got}${r.ok ? '' : '   (attendu ' + r.want + ')'}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} controles valides`);
fs.mkdirSync('.visual/phases', { recursive: true });
fs.writeFileSync('.visual/phases/audit-9-12.json', JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
