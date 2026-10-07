#!/usr/bin/env node
/**
 * TRACEFAB landing-page verification gate (Phase 4).
 *
 * Runs the checks that a browser would otherwise be needed for, statically:
 *   1. WCAG 2.1 contrast for the real token pairs the page uses
 *   2. anchor integrity — every href="#x" resolves to an id
 *   3. duplicate HTML attributes
 *   4. CSS custom properties referenced but never defined
 *   5. cascade order for the mobile supply-chain stack
 *   6. mobile navigation present and wired
 *   7. demonstration data is labelled as such
 *   8. no emoji in body copy
 *   9. reduced-motion guard
 *  10. vercel.json route targets exist on disk
 *
 * Exit 1 on any failure. `npm run check:landing`.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');
const vercel = JSON.parse(await readFile(new URL('vercel.json', root), 'utf8'));

let failures = 0;
let checks = 0;
const fail = (name, detail) => { failures++; console.error(`  FAIL  ${name}\n        ${detail}`); };
const pass = (name) => { checks++; console.log(`  ok    ${name}`); };

/* ---------------------------------------------------------------- tokens --
   A custom property resolves differently per surface context, so build one
   map per context. Collapsing them into a single map (as the first version of
   this script did) silently measures light-section text against dark values
   and reports passes that are not real.                                        */
function declsFrom(blockRe) {
  const out = {};
  for (const block of html.matchAll(blockRe)) {
    for (const d of block[1].matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;}\n]+)[;}\n]/g)) {
      out[d[1]] = d[2].trim();
    }
  }
  return out;
}

const rootDecls = declsFrom(/:root\s*\{([^}]*)\}/g);
const lightSurface = declsFrom(/\.tf-surface,\s*\n?:root\s*\{([^}]*)\}/g);
const darkSurface = declsFrom(/\.tf-surface--dark\s*\{([^}]*)\}/g);

const CTX = {
  light: { ...rootDecls, ...lightSurface },
  dark: { ...rootDecls, ...lightSurface, ...darkSurface },
};

function makeResolver(map) {
  const resolve = (value, depth = 0) => {
    if (depth > 8) return value;
    return value.replace(/var\((--[a-zA-Z0-9-]+)\)/g, (_, n) => resolve(map[n] || '', depth + 1));
  };
  return {
    resolve,
    hex: (name) => {
      const m = resolve(map[name] || '').match(/#[0-9a-fA-F]{6}\b/);
      return m ? m[0].toLowerCase() : null;
    },
  };
}
const resolvers = { light: makeResolver(CTX.light), dark: makeResolver(CTX.dark) };
const allDefined = new Set([...Object.keys(CTX.light), ...Object.keys(CTX.dark)]);

/* --------------------------------------------------------------- contrast -- */
function luminance(h) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

console.log('\n1. WCAG 2.1 contrast (AA: 4.5 body / 3.0 large text)');
// [label, context, foreground token, background token, large-text?]
const pairs = [
  ['hero title', 'dark', '--tf-sf-text', '--tf-sf-bg', true],
  ['hero lead', 'dark', '--tf-sf-text-mute', '--tf-sf-bg', false],
  ['hero accent line', 'dark', '--tf-sf-accent-hi', '--tf-sf-bg', true],
  ['core readout state', 'dark', '--tf-sf-text-dim', '--tf-forest-800', false],
  ['core readout stat', 'dark', '--tf-sf-accent-hi', '--tf-forest-800', true],
  ['orbit node label at rest', 'dark', '--tf-sf-text-dim', '--tf-sf-bg', false],

  ['proof metric', 'light', '--tf-sf-text', '--tf-paper', true],
  ['proof label', 'light', '--tf-sf-text-mute', '--tf-paper', false],
  ['proof accent label', 'light', '--tf-sf-accent', '--tf-paper', false],

  // The matrix sits on a LIGHT ground. It was dark until the rhythm rework;
  // measuring it against the dark context is how a false pass happens.
  ['matrix row head', 'light', '--tf-sf-text-dim', '--tf-paper-2', false],
  ['matrix cell text', 'light', '--tf-sf-text-mute', '--tf-white', false],
  ['matrix supplier cell', 'light', '--tf-sf-text', '--tf-white', false],
  ['matrix stage number', 'light', '--tf-sf-text-dim', '--tf-paper-2', false],
  ['matrix numeric cell', 'light', '--tf-sf-text', '--tf-white', true],
  ['inspector body', 'light', '--tf-sf-text-mute', '--tf-white', false],
  ['mobile card label', 'light', '--tf-sf-text-dim', '--tf-white', false],
  ['demo mark on light', 'light', '--tf-sf-text-mute', '--tf-white', false],

  ['persona question', 'light', '--tf-sf-text', '--tf-white', true],
  ['persona body', 'light', '--tf-sf-text-mute', '--tf-white', false],
  ['persona link', 'light', '--tf-sf-accent', '--tf-white', false],

  ['product tab label', 'light', '--tf-sf-text-mute', '--tf-white', false],
  ['product panel value', 'light', '--tf-sf-text', '--tf-paper-2', false],

  ['demo-data mark', 'dark', '--tf-sf-text-mute', '--tf-sf-bg', false],
  ['footer link', 'dark', '--tf-sf-text-mute', '--tf-sf-bg', false],
  ['promise word at rest', 'dark', '--tf-sf-text', '--tf-sf-bg', true],

  ['section title on paper', 'light', '--tf-sf-text', '--tf-paper', true],
  ['section title on paper-2', 'light', '--tf-sf-text', '--tf-paper-2', true],
  ['body / muted on paper', 'light', '--tf-sf-text-mute', '--tf-paper', false],
  ['body / muted on paper-2', 'light', '--tf-sf-text-mute', '--tf-paper-2', false],
  ['technical label on paper', 'light', '--tf-sf-text-mute', '--tf-paper', false],
  ['chip text on chip ground', 'light', '--tf-sf-text-mute', '--tf-paper-3', false],
  ['layer number accent', 'light', '--tf-sf-accent', '--tf-paper', false],
  ['lineage index', 'light', '--tf-sf-text-mute', '--tf-white', false],
  ['demo mark on light', 'light', '--tf-sf-text-mute', '--tf-white', false],
  ['dialog body text', 'light', '--tf-ink-400', '--tf-white', false],

  ['badge certified', 'light', '--tf-certified', '--tf-certified-bg', false],
  ['badge verified', 'light', '--tf-verified', '--tf-verified-bg', false],
  ['badge documented', 'light', '--tf-documented', '--tf-documented-bg', false],
  ['badge declared', 'light', '--tf-declared', '--tf-declared-bg', false],
  ['badge needs review', 'light', '--tf-review', '--tf-review-bg', false],
  ['badge missing', 'light', '--tf-missing', '--tf-missing-bg', false],
];

for (const [label, ctx, fg, bg, large] of pairs) {
  const r = resolvers[ctx];
  const a = r.hex(fg);
  const b = r.hex(bg);
  if (!a || !b) { fail(`contrast: ${label}`, `unresolved token (${fg}=${a}, ${bg}=${b})`); continue; }
  const v = ratio(a, b);
  const min = large ? 3.0 : 4.5;
  checks++;
  if (v < min) fail(`contrast: ${label}`, `[${ctx}] ${a} on ${b} = ${v.toFixed(2)}:1, needs ${min}:1`);
  else console.log(`  ok    ${label.padEnd(26)} [${ctx}] ${a} on ${b} = ${v.toFixed(2)}:1`);
}

/* ---------------------------------------------------------------- anchors -- */
console.log('\n2. Anchor integrity');
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const anchors = [...new Set([...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]))];
let deadAnchors = 0;
for (const a of anchors) if (!ids.has(a)) { fail(`dead anchor #${a}`, 'no matching id in the document'); deadAnchors++; }
if (!deadAnchors) pass(`${anchors.length} in-page anchors all resolve (${anchors.join(', ')})`);

/* ------------------------------------------------------ duplicate attrs ---- */
console.log('\n3. Duplicate HTML attributes');
// Strip quoted attribute VALUES first: otherwise repeated words inside a
// content="..." string look like repeated attribute names.
const tagRe = /<[a-zA-Z][^>]*>/g;
let dupes = 0;
for (const raw of html.match(tagRe) || []) {
  const tag = raw.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
  const names = [...tag.matchAll(/\s([a-zA-Z-]+)(?==|[\s/>])/g)].map((m) => m[1].toLowerCase());
  const seen = new Set();
  for (const n of names) {
    if (seen.has(n)) { fail('duplicate attribute', `${n} in ${raw.slice(0, 100)}`); dupes++; }
    seen.add(n);
  }
}
if (!dupes) pass('no tag declares the same attribute twice');

/* --------------------------------------------------------- token leaks ---- */
console.log('\n4. CSS custom properties');
const defined = new Set([...html.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
const used = new Set([...html.matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map((m) => m[1]));
const missing = [...used].filter((u) => !defined.has(u));
if (missing.length) missing.forEach((m) => fail('undefined custom property', m));
else pass(`${used.size} referenced, all defined (${defined.size} declared)`);
if (!allDefined.has('--tf-sf-text-mute')) fail('surface context', '--tf-sf-text-mute is not defined in any surface context');
else pass('surface contexts expose --tf-sf-text-mute');

/* --------------------------------------------------------- cascade order -- */
console.log('\n5. Mobile cascade order');
// The supply-chain graph must collapse to a vertical stack under 720px. Both
// rules have specificity (0,1,0), so the LATER one wins: the display:none base
// must come before the display:flex override.
const stackRules = [...html.matchAll(/\.tf-chain-stack\s*\{([^}]*)\}/g)];
const noneRule = stackRules.find((m) => /display:\s*none/.test(m[1]));
const flexRule = stackRules.find((m) => /display:\s*flex/.test(m[1]));
if (!noneRule) fail('.tf-chain-stack', 'no base rule with display:none');
else if (!flexRule) fail('.tf-chain-stack', 'no override with display:flex');
else if (noneRule.index > flexRule.index) {
  fail('cascade order', 'display:none base rule appears after the display:flex override — the mobile stack would stay hidden');
} else {
  checks++;
  console.log('  ok    display:none base precedes the display:flex override — mobile stack shows under 720px');
}
if (/\.tf-chain-grid\s*\{\s*display:\s*none/.test(html)) pass('matrix hides under 720px');
else fail('mobile matrix', '.tf-chain-grid is not hidden under 720px');

/* ------------------------------------------------------- mobile nav ------- */
console.log('\n6. Mobile navigation');
for (const need of ['id="tf-burger"', 'aria-expanded', 'aria-controls="tf-nav-panel"', 'id="tf-nav-panel"']) {
  if (html.includes(need)) pass(`present: ${need}`);
  else fail('mobile navigation', `missing ${need}`);
}

/* ------------------------------------------------------- demo labelling --- */
console.log('\n7. Demonstration data labelling');
const demoMarks = (html.match(/tf-demo-mark/g) || []).length;
if (demoMarks >= 3) pass(`${demoMarks} demo-data markers present`);
else fail('demo data', `only ${demoMarks} tf-demo-mark occurrences; hero, supply chain and product surfaces must be labelled`);

/* ------------------------------------------------------------- emoji ------ */
console.log('\n8. No emoji in body copy');
const bodyOnly = html.slice(html.indexOf('<body'));
const emoji = bodyOnly.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu) || [];
if (emoji.length) fail('emoji in markup', [...new Set(emoji)].join(' '));
else pass('no emoji in body markup');

/* ----------------------------------------------------- reduced motion ----- */
console.log('\n9. Reduced-motion support');
if (html.includes('prefers-reduced-motion: reduce')) pass('CSS guard present');
else fail('reduced motion', 'no prefers-reduced-motion guard');
if (html.includes('prefersReducedMotion()')) pass('JS honours reduced motion');
else fail('reduced motion', 'JS does not check prefers-reduced-motion');

/* ------------------------------------------------------ vercel routes ----- */
console.log('\n10. vercel.json route targets');
let routeFail = 0;
for (const r of vercel.routes || []) {
  if (!r.dest) continue;
  const target = r.dest.split('?')[0].replace(/^\//, '');
  if (!target || target.startsWith('api/')) continue;
  const p = fileURLToPath(new URL(target, root));
  if (existsSync(p)) console.log(`  ok    ${r.src} -> ${r.dest}`);
  else { fail(`route ${r.src}`, `dest ${r.dest} does not exist on disk`); routeFail++; }
  checks++;
}
if (!routeFail) pass('all static route destinations exist');

/* ------------------------------------------------------------ summary ----- */
console.log(`\n${'='.repeat(64)}`);
if (failures) {
  console.error(`check:landing FAILED — ${failures} failure(s), ${checks} check(s) passed.`);
  process.exit(1);
}
console.log(`check:landing passed — ${checks} checks, 0 failures.`);
