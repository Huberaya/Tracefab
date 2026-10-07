#!/usr/bin/env node
/**
 * TRACEFAB — visual capture harness.
 *
 *   node scripts/visual_capture.mjs --out .visual/before --base http://127.0.0.1:3000
 *
 * Captures desktop + mobile screenshots of every shell route, collects
 * console errors, failed requests, and basic a11y/perf signals.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : fallback;
};

const BASE = arg('base', 'http://127.0.0.1:3000');
const OUT = path.resolve(arg('out', '.visual/capture'));
const ONLY = arg('only', null);

const ROUTES = [
  { id: 'landing', url: '/', full: true },
  { id: 'brand-console', url: '/brand-console/', full: false },
  { id: 'product-intelligence', url: '/product-intelligence/', full: true },
  { id: 'supplier-portal', url: '/supplier-portal/', full: false },
  { id: 'dpp', url: '/dpp/', full: false },
  { id: 'quality-center', url: '/quality-center/', full: false },
  { id: 'operations', url: '/operations/', full: false },
];

const VIEWPORTS = [
  { id: 'desktop', width: 1440, height: 900, scale: 1 },
  { id: 'mobile', width: 390, height: 844, scale: 2, mobile: true },
];

fs.mkdirSync(OUT, { recursive: true });

const report = { base: BASE, generatedAt: new Date().toISOString(), routes: [] };

const browser = await chromium.launch();

for (const route of ROUTES) {
  if (ONLY && !ONLY.split(',').includes(route.id)) continue;
  const entry = { id: route.id, url: route.url, viewports: [], consoleErrors: [], failedRequests: [] };

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.scale,
      isMobile: Boolean(vp.mobile),
      hasTouch: Boolean(vp.mobile),
    });
    const page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') entry.consoleErrors.push(`[${vp.id}] ${msg.text().slice(0, 240)}`);
    });
    page.on('requestfailed', (req) => {
      entry.failedRequests.push(`[${vp.id}] ${req.url().slice(0, 160)} — ${req.failure()?.errorText}`);
    });

    const started = Date.now();
    try {
      await page.goto(`${BASE}${route.url}`, { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(900);
      // walk the whole page so IntersectionObserver-driven reveals fire
      await page.evaluate(async () => {
        const step = Math.round(window.innerHeight * 0.7);
        const total = document.documentElement.scrollHeight;
        for (let y = 0; y < total; y += step) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 110));
        }
        window.scrollTo(0, total);
        await new Promise((r) => setTimeout(r, 400));
        window.scrollTo(0, 0);
        await new Promise((r) => setTimeout(r, 300));
      });
      await page.waitForTimeout(1800);
    } catch (error) {
      entry.consoleErrors.push(`[${vp.id}] navigation: ${String(error).slice(0, 200)}`);
    }
    const loadMs = Date.now() - started;

    const file = path.join(OUT, `${route.id}--${vp.id}.png`);
    await page.screenshot({ path: file, fullPage: route.full });

    const metrics = await page.evaluate(() => {
      const docEl = document.documentElement;
      const imgs = Array.from(document.images);
      return {
        title: document.title,
        lang: docEl.getAttribute('lang'),
        scrollHeight: docEl.scrollHeight,
        hDocWiderThanViewport: docEl.scrollWidth > window.innerWidth + 1,
        h1Count: document.querySelectorAll('h1').length,
        imgsWithoutAlt: imgs.filter((i) => !i.getAttribute('alt')).length,
        imgCount: imgs.length,
        buttonsWithoutLabel: Array.from(document.querySelectorAll('button')).filter(
          (b) => !b.textContent.trim() && !b.getAttribute('aria-label')
        ).length,
        linksWithoutLabel: Array.from(document.querySelectorAll('a')).filter(
          (a) => !a.textContent.trim() && !a.getAttribute('aria-label')
        ).length,
        domNodes: document.querySelectorAll('*').length,
        inlineStyleBytes: Array.from(document.querySelectorAll('style')).reduce((n, s) => n + s.textContent.length, 0),
      };
    });

    entry.viewports.push({ id: vp.id, file: path.relative(OUT, file), loadMs, ...metrics });
    await context.close();
  }
  report.routes.push(entry);
  console.log(`captured ${route.id}`);
}

await browser.close();
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\nreport → ${path.join(OUT, 'report.json')}`);
