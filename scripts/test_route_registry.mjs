#!/usr/bin/env node
/**
 * TRACEFAB route registry integrity.
 *
 * Two failure modes have already shipped in this repo:
 *
 *  1. A handler file exists under api/_routes/ but was never added to the
 *     dispatcher in api/index.ts -> the feature answers 404. `supplier/shares`
 *     did exactly this: the Supplier Portal called it on every load and the
 *     404 was swallowed by Promise.allSettled, so the sharing view rendered
 *     permanently empty with nothing in the console.
 *
 *  2. A route is registered and fully implemented but no surface calls it ->
 *     the feature is unreachable (the five CAP endpoints, Phase 8).
 *
 * Failure mode 1 is a hard failure: a UI calling a route that cannot answer is
 * a defect today, whatever the intent. Failure mode 2 is reported as a warning,
 * because an endpoint may legitimately be built ahead of its interface.
 *
 *   npm run test:route-registry
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = new URL('../', import.meta.url);
const fsPath = (u) => u.pathname;

let failures = 0;
let checks = 0;
const ok = (n) => { checks++; console.log(`  ok    ${n}`); };
const bad = (n, d) => { failures++; console.error(`  FAIL  ${n}\n        ${d}`); };

/* ---------------------------------------------------------------- routes -- */

const router = await readFile(new URL('api/index.ts', root), 'utf8');
const registered = [...router.matchAll(/pattern:\s*\/\^([^\$]+)\$\//g)].map((m) =>
  m[1].replace(/\\\//g, '/').replace(/\\-/g, '-'),
);
const routeMatchers = registered.map((r) => ({
  route: r,
  re: new RegExp(`^/api/${r}$`),
}));
console.log(`\nRegistre : ${registered.length} motifs déclarés dans api/index.ts`);

/* --------------------------------------------------------------- surfaces -- */

const SURFACES = [
  'index.html',
  'brand-console/index.html',
  'supplier-portal/index.html',
  'quality-center/index.html',
  'operations/index.html',
  'dpp/index.html',
  'passport/index.html',
];

const surfaceCalls = new Map();
for (const surface of SURFACES) {
  let html;
  try {
    html = await readFile(new URL(surface, root), 'utf8');
  } catch {
    continue; // surface absente : rien à vérifier
  }
  const literals = new Set();
  for (const m of html.matchAll(/['"`]\/api\/[^'"`\s]*/g)) {
    const path = m[0].slice(1).split(/['"`]/)[0];
    if (path) literals.add(path);
  }
  surfaceCalls.set(surface, [...literals].sort());
}
const totalCalls = [...surfaceCalls.values()].reduce((a, c) => a + c.length, 0);
console.log(`Surfaces : ${surfaceCalls.size} fichier(s), ${totalCalls} appel(s) /api/* distinct(s)`);

/**
 * A literal may embed `${...}` (one path segment) and a query string, and nested
 * backticks can leave an interpolation unterminated. Reduce it to a concrete
 * path the route patterns can be tested against.
 */
function analyze(literal) {
  let path = literal.split(/[?#]/)[0];
  const unterminated = /\$\{[^}]*$/.test(path);
  if (unterminated) path = path.replace(/\$\{[^}]*$/, '');
  return { sample: path.replace(/\$\{[^}]*\}/g, 'SEGMENT'), unterminated };
}

console.log('\n1. Chaque appel d’interface aboutit à une route déclarée');
const dangling = [];
for (const [surface, calls] of surfaceCalls) {
  for (const call of calls) {
    const { sample, unterminated } = analyze(call);
    const match = routeMatchers.find(({ re }) => re.test(sample) || (unterminated && re.test(`${sample}SEGMENT`)));
    if (!match) dangling.push({ surface, call });
  }
}
if (dangling.length === 0) {
  ok(`${totalCalls} appel(s) d’interface résolvent tous vers une route déclarée`);
} else {
  bad(
    `${dangling.length} appel(s) d’interface vers une route non déclarée (404 en production)`,
    dangling.map((d) => `${d.call}  <- ${d.surface}`).join('\n        '),
  );
}

/* ------------------------------------------------- handlers non déclarés -- */

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const routesDir = fsPath(new URL('api/_routes', root));
const handlerFiles = (await walk(routesDir)).map((f) =>
  relative(routesDir, f).replace(/\\/g, '/').replace(/\.ts$/, ''),
);
const registeredFiles = new Set(
  [...router.matchAll(/import\('\.\/_routes\/([^']+)\.js'\)/g)].map((m) => m[1]),
);
const orphans = handlerFiles.filter((f) => !registeredFiles.has(f)).sort();

console.log(`\n2. Handlers présents sous api/_routes (${handlerFiles.length}) déclarés dans le registre`);
if (orphans.length === 0) {
  ok('aucun handler orphelin');
} else {
  console.warn(
    `\n  ATTENTION — ${orphans.length} handler(s) écrit(s) mais non déclarés, donc inatteignables :\n` +
      orphans.map((o) => `        ${o}`).join('\n'),
  );
  // Un orphelin appelé par une interface est déjà couvert par le contrôle 1.
  // Ici on vérifie seulement que le registre ne déclare pas un fichier absent.
}

const phantom = [...registeredFiles].filter((f) => !handlerFiles.includes(f));
if (phantom.length === 0) {
  ok('le registre ne pointe vers aucun fichier inexistant');
} else {
  bad('le registre pointe vers des fichiers absents', phantom.join('\n        '));
}

/* ------------------------------------------ routes déclarées, jamais appelées -- */

/**
 * L'inverse du contrôle 1 : une route peut exister sans interface. Ce n'est pas
 * un échec — `/api/data-requests/:id/items` est un primitive de bas niveau, les
 * items étant instanciés depuis un questionnaire via `/items/from-template`, et
 * son GET est couvert par `/api/data-requests/:id`. Mais une route que personne
 * n'appelle doit rester visible, pas disparaître du radar : c'est ainsi que les
 * cinq endpoints CAP ont attendu la phase 8.
 */
console.log('\n3. Routes déclarées mais appelées par aucune surface');
const neverCalled = routeMatchers
  .filter(({ re }) => {
    for (const calls of surfaceCalls.values()) {
      for (const call of calls) {
        const { sample, unterminated } = analyze(call);
        if (re.test(sample) || (unterminated && re.test(`${sample}SEGMENT`))) return false;
      }
    }
    return true;
  })
  .map(({ route }) => `/api/${route.replace(/\(\[\^\/\]\+\)/g, '{id}')}`);
if (neverCalled.length) {
  console.warn(
    `\n  À SUIVRE — ${neverCalled.length} route(s) déclarée(s) qu'aucune surface n'appelle :\n` +
      neverCalled.sort().map((r) => `        ${r}`).join('\n'),
  );
} else {
  ok('toutes les routes déclarées sont appelées');
}

/* ------------------------------------------------------------- résultat -- */

console.log(`\n${'='.repeat(64)}`);
if (failures) {
  console.error(`test:route-registry FAILED — ${failures} échec(s), ${checks} contrôle(s) réussi(s).`);
  process.exit(1);
}
console.log(`test:route-registry passed — ${checks} contrôles, 0 échec.`);
if (orphans.length) {
  console.log(`(${orphans.length} handler(s) orphelin(s) signalés ci-dessus — à exposer ou à retirer.)`);
}
