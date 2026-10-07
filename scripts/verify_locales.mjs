/* TRACEFAB — locale verification harness.
   Loads the landing page in each supported language, asserts the i18n runtime
   resolved every key, records layout overflow, and writes one screenshot per
   language so typographic blow-ups (de/fr compounds) are visible.

   node scripts/verify_locales.mjs [--base http://127.0.0.1:3000] [--out .visual/i18n]
*/
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BASE = arg('--base', 'http://127.0.0.1:3000');
const OUT = arg('--out', '.visual/i18n');
const LANGS = (arg('--langs', 'en,fr,de,it,es,nl')).split(',');
const MOBILE = args.includes('--mobile');
const VP = MOBILE ? { width: 390, height: 844 } : { width: 1440, height: 900 };
const DSF = MOBILE ? 2 : 1;
const TAG = MOBILE ? 'mobile' : 'desktop';

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const report = [];

for (const lang of LANGS) {
  const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: DSF, isMobile: MOBILE, hasTouch: MOBILE });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => errors.push('failed: ' + r.url()));

  await page.goto(`${BASE}/?lang=${lang}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  // scroll the whole document slowly so IntersectionObserver reveals fire
  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.6);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 260));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 600));
  });
  await page.waitForTimeout(500);

  const audit = await page.evaluate((expected) => {
    const htmlLang = document.documentElement.getAttribute('lang');
    const keys = [...document.querySelectorAll('[data-i18n],[data-i18n-html]')];
    const empty = keys
      .filter((el) => !(el.textContent || '').trim())
      .map((el) => el.getAttribute('data-i18n') || el.getAttribute('data-i18n-html'));

    // overflow detection — only text-bearing leaves, and only where the box
    // actually clips or the word genuinely sticks out of its own content box.
    // (`.tf-layer::before` bleeds into the gutter by design and must not flag.)
    const de = document.documentElement;
    const hOverflow = de.scrollWidth - de.clientWidth;
    const isLeaf = (el) => ![...el.children].some((c) => getComputedStyle(c).display !== 'inline');
    const clipped = [...document.querySelectorAll(
      '.tf-chain__cell, .tf-chain__cell *, .tf-layer__name, .tf-layer__q, .tf-layer__chip, .tf-layer__aside *,' +
      '.tf-promise__cell *, .tf-btn, .tf-nav a, .tf-dossier *, .tf-core__row *, .tf-hero__title span, .tf-eyebrow'
    )]
      .filter((el) => el.offsetParent !== null && isLeaf(el) && (el.textContent || '').trim())
      .filter((el) => el.scrollWidth > el.clientWidth + 2)
      .slice(0, 12)
      .map((el) => ({ sel: el.className.toString().slice(0, 48) || el.tagName, text: (el.textContent || '').trim().slice(0, 40), over: el.scrollWidth - el.clientWidth }));

    const reveals = [...document.querySelectorAll('[data-tf-reveal]')];
    return {
      htmlLang,
      langMatches: htmlLang === expected,
      i18nNodes: keys.length,
      emptyKeys: empty,
      revealTotal: reveals.length,
      revealDone: reveals.filter((el) => el.classList.contains('is-revealed')).length,
      coreLive: !!document.querySelector('.tf-core.is-live'),
      hOverflow,
      clipped,
      title: document.title,
      heroLine1: (document.querySelector('[data-i18n="hero.line1"]') || {}).textContent || null,
      chainStage: (document.querySelector('[data-i18n="chain.stageLabel"]') || {}).textContent || null,
      scrollHeight: document.body.scrollHeight,
      chainMode: (() => {
        const grid = document.querySelector('.tf-chain__scroll');
        const vert = document.querySelector('.tf-chain__vertical');
        const vis = (e) => e && getComputedStyle(e).display !== 'none' && e.offsetParent !== null;
        return vis(grid) ? 'matrix' : (vis(vert) ? 'vertical' : 'none');
      })(),
      coreMode: (() => {
        const svg = document.querySelector('.tf-core__svg');
        const list = document.querySelector('.tf-core__list');
        const vis = (e) => e && getComputedStyle(e).display !== 'none';
        return vis(svg) ? 'svg' : (vis(list) ? 'list' : 'none');
      })(),
      // WCAG 2.5.8 AA target size: 24x24 CSS px. SVG <g> hit areas are excluded
      // (they report 0x0 when their <svg> is display:none behind the mobile list).
      tapTargets: [...document.querySelectorAll('a, button, [role="button"], summary, input, select')]
        .filter((e) => !(e instanceof SVGElement) && e.offsetParent !== null)
        .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.height < 24 || r.width < 24); })
        .slice(0, 10)
        .map((e) => { const r = e.getBoundingClientRect(); return { t: (e.textContent || '').trim().slice(0, 24), cls: e.className.toString().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) }; })
    };
  }, lang);

  const shot = async (name) => page.screenshot({ path: `${OUT}/${lang}--${TAG}--${name}.png` });
  await shot('hero');
  for (const [sel, name] of [['#supply-chain', 'chain'], ['#platform', 'spine'], ['#why', 'promise']]) {
    const el = await page.$(sel);
    if (!el) continue;
    await el.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -88));
    await page.waitForTimeout(700);
    await shot(name);
  }

  const ok = audit.langMatches && audit.emptyKeys.length === 0 && errors.length === 0 &&
    audit.hOverflow <= 0 && audit.clipped.length === 0 && audit.tapTargets.length === 0 &&
    audit.chainMode === (MOBILE ? 'vertical' : 'matrix') && audit.coreMode === (MOBILE ? 'list' : 'svg');
  report.push({ lang, viewport: TAG, ok, errors, ...audit });
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${TAG}  ${lang}  lang=${audit.htmlLang}  keys=${audit.i18nNodes}` +
    `  empty=${audit.emptyKeys.length}  reveal=${audit.revealDone}/${audit.revealTotal}` +
    `  chain=${audit.chainMode}  core=${audit.coreMode}` +
    `  overflow=${audit.hOverflow}  clipped=${audit.clipped.length}  tap<32=${audit.tapTargets.length}  err=${errors.length}`
  );
  if (audit.clipped.length) audit.clipped.forEach((c) => console.log(`        ↳ +${c.over}px  ${c.sel}  "${c.text}"`));
  if (audit.tapTargets.length) audit.tapTargets.forEach((c) => console.log(`        ↳ target ${c.w}x${c.h}  ${c.cls}  "${c.t}"`));
  if (errors.length) errors.slice(0, 5).forEach((e) => console.log('        ! ' + e));

  await ctx.close();
}

await browser.close();
await writeFile(`${OUT}/report-${TAG}.json`, JSON.stringify(report, null, 2));
const failed = report.filter((r) => !r.ok);
console.log(`\n${report.length - failed.length}/${report.length} locales pass (${TAG}) → ${OUT}/report-${TAG}.json`);
process.exit(failed.length ? 1 : 0);
