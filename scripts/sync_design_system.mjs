#!/usr/bin/env node
/**
 * TRACEFAB design-system sync.
 *
 * The static surfaces (index.html, brand-console, supplier-portal, ...) are
 * self-contained documents: they carry their CSS inline so they never depend on
 * an extra render-blocking request, and so `vercel.json` (which only builds
 * `**\/*.html` plus the API) cannot break them.
 *
 * To keep ONE source of truth, the canonical stylesheet lives at
 * `assets/design-system/tracefab-ds.css` and is inlined verbatim between
 * `TF:DS:BEGIN` / `TF:DS:END` markers in each registered surface.
 *
 *   npm run ds:sync    rewrite every surface from the canonical file
 *   npm run ds:check   fail (exit 1) if any surface drifted
 */
import { readFile, writeFile } from 'node:fs/promises';

const CANON = new URL('../assets/design-system/tracefab-ds.css', import.meta.url);

/** Surfaces that carry the inlined design system. Paths are relative to the repo root. */
const SURFACES = ['index.html', 'quality-center/index.html', 'supplier-portal/index.html'];

const BEGIN = '/* TF:DS:BEGIN */';
const END = '/* TF:DS:END */';

const check = process.argv.includes('--check');
const canon = (await readFile(CANON, 'utf8')).trim();

if (!canon.includes('TRACEFAB DESIGN SYSTEM')) {
  console.error('ds: canonical stylesheet looks empty or wrong.');
  process.exit(1);
}

let drift = 0;
let synced = 0;

for (const rel of SURFACES) {
  const url = new URL(rel, new URL('../', import.meta.url));
  let html;
  try {
    html = await readFile(url, 'utf8');
  } catch {
    console.error(`ds: surface not found — ${rel}`);
    drift++;
    continue;
  }

  const start = html.indexOf(BEGIN);
  const stop = html.indexOf(END);

  if (start === -1 || stop === -1 || stop < start) {
    console.error(
      `ds: ${rel} is missing the ${BEGIN} / ${END} markers. ` +
      `Add them inside a <style data-tf-ds> block.`,
    );
    drift++;
    continue;
  }

  const current = html.slice(start + BEGIN.length, stop).trim();
  if (current === canon) {
    console.log(`ds: ${rel} in sync`);
    continue;
  }

  if (check) {
    console.error(
      `ds: ${rel} drifted from assets/design-system/tracefab-ds.css — run \`npm run ds:sync\`.`,
    );
    drift++;
    continue;
  }

  const next = html.slice(0, start + BEGIN.length) + '\n' + canon + '\n' + html.slice(stop);
  await writeFile(url, next);
  console.log(`ds: ${rel} updated`);
  synced++;
}

if (check) {
  if (drift > 0) {
    console.error(`\nds:check FAILED — ${drift} surface(s) out of sync.`);
    process.exit(1);
  }
  console.log(`\nds:check passed — ${SURFACES.length} surface(s) in sync with the canonical design system.`);
} else {
  console.log(`\nds:sync done — ${synced} surface(s) updated, ${SURFACES.length - synced} already in sync.`);
}
