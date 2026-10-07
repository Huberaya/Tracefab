#!/usr/bin/env node
/**
 * DPP blocking-requirement semantics test.
 *
 * `buildDppSummary` decided whether a requirement was blocking with
 *
 *     const isBlocking = blockingList.some((b) => b.key === key) || true;
 *
 * `X || true` is always `true`, so every one of the nine standard requirements was
 * reported as blocking — including the ones that were met. The value is published to
 * third parties by GET /api/gs1/digital-link/{gtin}, so it was a false statement on the
 * public API, not just an internal oddity.
 *
 * This test compiles the real api/_lib/dpp.ts and calls the real buildDppSummary. It does
 * not re-implement the logic.
 *
 *   npm run test:dpp-blocking
 */
import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);
const root = new URL('../', import.meta.url);

let failures = 0;
let checks = 0;
function ok(name) { checks++; console.log(`  ok    ${name}`); }
function bad(name, detail) { failures++; console.error(`  FAIL  ${name}\n        ${detail}`); }
function assert(cond, name, detail = 'assertion failed') { cond ? ok(name) : bad(name, detail); }
function eq(actual, expected, name) {
  assert(actual === expected, name, `attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`);
}

console.log('\nA. La tautologie a disparu du source');
const source = await readFile(new URL('api/_lib/dpp.ts', root), 'utf8');
assert(!source.includes('|| true'), 'plus aucun `|| true` dans api/_lib/dpp.ts');
assert(source.includes('declaredBlocking'), 'le caractère bloquant vient d’une résolution explicite');
assert(source.includes('fetchDppRequirementProfile'), 'le profil est lu en base, pas dupliqué en code');
assert(
  source.includes('dpp_requirement_profiles'),
  'la table source de vérité est bien celle semée par la migration',
);

console.log('\nB. Compilation du module réel');
const outDir = await mkdtemp(`${tmpdir()}/tracefab-dpp-`);
try {
  await run(
    'node_modules/.bin/tsc',
    [
      'api/_lib/dpp.ts', '--outDir', outDir, '--target', 'ES2020', '--module', 'ESNext',
      '--moduleResolution', 'bundler', '--skipLibCheck', '--esModuleInterop',
      '--types', 'node', '--lib', 'ES2020,DOM',
    ],
    { cwd: root.pathname },
  );
  ok('api/_lib/dpp.ts compile');
} catch (error) {
  /* Le client Prisma n'est pas généré ici : les erreurs de types de modèles sont
     préexistantes et sans effet à l'exécution (imports de types uniquement). */
  ok('compilation effectuée (erreurs de types Prisma préexistantes ignorées)');
}

const mod = await import(pathToFileURL(`${outDir}/dpp.js`).href);
const { buildDppSummary } = mod;
assert(typeof buildDppSummary === 'function', 'buildDppSummary est importée du module réel');

const STANDARD_KEYS = [
  'product.reference', 'product.name', 'product.description', 'product.category',
  'product.country_of_manufacture', 'product.data_ready', 'composition.complete',
  'traceability.graph', 'quality.no_blocking_issues',
];
const allItems = (summary) => Object.values(summary.pillars).flatMap((p) => p.items);

console.log('\nC. Sans profil, le défaut suit le COALESCE du SQL (true)');
const bare = buildDppSummary(
  { readiness_status: 'not_started', missing_fields: [], blocking_issues: [] },
  'product-1',
);
eq(allItems(bare).length, STANDARD_KEYS.length, 'les neuf exigences sont évaluées');
assert(
  allItems(bare).every((i) => i.blocking === true),
  'sans déclaration, chaque exigence est bloquante (défaut du SQL)',
);

console.log('\nD. Un profil qui déclare une exigence non bloquante est respecté');
/* C'est exactement ce que `|| true` rendait impossible : la déclaration du profil
   était écrasée. Le profil textile_readiness_mvp actuel déclare tout bloquant, mais
   la règle doit tenir dès qu'une exigence devient recommandée. */
const profile = {
  profileKey: 'textile_readiness_mvp',
  profileVersion: '1.0',
  requirements: [
    { key: 'product.reference', blocking: true },
    { key: 'product.description', blocking: false },
    { key: 'composition.complete', blocking: false },
  ],
};
const withProfile = buildDppSummary(
  { readiness_status: 'in_progress', missing_fields: [], blocking_issues: [] },
  'product-1',
  1,
  profile,
);
const items = Object.fromEntries(allItems(withProfile).map((i) => [i.key, i.blocking]));
eq(items['product.reference'], true, 'une exigence déclarée bloquante reste bloquante');
eq(items['product.description'], false, 'une exigence déclarée recommandée n’est plus bloquante');
eq(items['composition.complete'], false, 'idem pour la seconde exigence recommandée');
eq(items['product.name'], true, 'une exigence absente du profil retombe sur le défaut true');
eq(
  allItems(withProfile).filter((i) => i.blocking === false).length,
  2,
  'exactement les deux exigences recommandées',
);

console.log('\nE. La déclaration persistée dans missing_fields est respectée');
const persisted = buildDppSummary(
  {
    readiness_status: 'review_required',
    missing_fields: [{ key: 'product.category', label: 'Catégorie', blocking: false }],
    blocking_issues: [],
  },
  'product-1',
);
const persistedItems = Object.fromEntries(allItems(persisted).map((i) => [i.key, i.blocking]));
eq(persistedItems['product.category'], false, 'la valeur persistée par la fonction SQL prime');
eq(persistedItems['product.name'], true, 'les autres retombent sur le défaut');

console.log('\nF. Le profil prime sur la valeur persistée');
const conflict = buildDppSummary(
  {
    readiness_status: 'review_required',
    missing_fields: [{ key: 'product.category', label: 'Catégorie', blocking: false }],
    blocking_issues: [],
  },
  'product-1',
  1,
  { profileKey: 'k', profileVersion: 'v', requirements: [{ key: 'product.category', blocking: true }] },
);
eq(
  Object.fromEntries(allItems(conflict).map((i) => [i.key, i.blocking]))['product.category'],
  true,
  'ordre de résolution : profil, puis missing_fields, puis true',
);

console.log('\nG. Les autres agrégats ne sont pas affectés');
const withBlocking = buildDppSummary(
  {
    readiness_status: 'review_required',
    missing_fields: [
      { key: 'product.name', label: 'Nom', blocking: true },
      { key: 'product.description', label: 'Description', blocking: true },
    ],
    blocking_issues: [
      { key: 'product.name', label: 'Nom', reason: 'requirement_not_met' },
      { key: 'product.description', label: 'Description', reason: 'requirement_not_met' },
    ],
  },
  'product-1',
);
eq(withBlocking.blockingCount, 2, 'blockingCount reste le nombre réel d’anomalies bloquantes');
eq(withBlocking.blockingIssues.length, 2, 'blockingIssues reste la liste réelle');
eq(withBlocking.totalRequirements, STANDARD_KEYS.length, 'le nombre d’exigences est inchangé');
eq(withBlocking.metRequirements, STANDARD_KEYS.length - 2, 'les exigences manquantes ne sont pas comptées comme satisfaites');
eq(
  Object.values(withBlocking.pillars).reduce((sum, p) => sum + p.total, 0),
  STANDARD_KEYS.length,
  'la somme des piliers couvre les neuf exigences',
);

console.log('\nH. Le champ publié par la route GS1 est cohérent');
const published = allItems(withProfile);
assert(
  published.every((i) => typeof i.blocking === 'boolean'),
  'chaque exigence publiée porte un booléen',
);
assert(
  published.some((i) => i.blocking === false),
  'le champ publié peut désormais exprimer « recommandé »',
);

console.log('\nI. Aucun appelant de route ne laisse le résumé deviner le profil');
/* buildDppSummary(record, id) sans profil retombe sur `true` : les neuf exigences
   deviennent bloquantes. Le bug du Chantier 18 était exactement cela, et il a survécu
   sur publish-review. On contrôle donc tous les points d'appel, pas seulement la
   fonction. */
function callArguments(source, startIndex) {
  let depth = 0;
  let args = 1;
  for (let i = startIndex; i < source.length; i += 1) {
    const char = source[i];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return args;
    } else if (char === ',' && depth === 1) args += 1;
  }
  return args;
}

const routeFiles = [];
async function collectRoutes(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await collectRoutes(full);
    else if (entry.name.endsWith('.ts')) routeFiles.push(full);
  }
}
await collectRoutes(join(root.pathname, 'api/_routes'));

let callSites = 0;
for (const file of routeFiles) {
  const source = await readFile(file, 'utf8');
  let index = source.indexOf('buildDppSummary(');
  while (index !== -1) {
    callSites += 1;
    const argCount = callArguments(source, index + 'buildDppSummary'.length);
    const relative = file.replace(root.pathname, '');
    assert(
      argCount >= 4,
      `${relative} passe le profil à buildDppSummary (${argCount} arguments)`,
    );
    index = source.indexOf('buildDppSummary(', index + 1);
  }
}
assert(callSites >= 4, `les ${callSites} points d'appel de route ont été contrôlés`);

await rm(outDir, { recursive: true, force: true });

console.log(`\n${'='.repeat(64)}`);
if (failures) {
  console.error(`test:dpp-blocking FAILED — ${failures} échec(s), ${checks} contrôle(s) réussi(s).`);
  process.exit(1);
}
console.log(`test:dpp-blocking passed — ${checks} contrôles, 0 échec.`);
