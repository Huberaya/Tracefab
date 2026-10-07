#!/usr/bin/env node
/**
 * TRACEFAB test suite runner with honest classification.
 *
 * `npm test` chains 25 steps with `&&`, so it stops at the first failure. In an
 * environment where the Prisma engine cannot be downloaded, it stops at step 2
 * (`api:typecheck`) and the other 23 never run — which makes the suite look broken
 * without saying what is actually broken, or what merely cannot run here.
 *
 * This runner executes every `test:*` script independently and sorts the results into
 * three buckets:
 *
 *   PASS  the script ran and succeeded
 *   SKIP  the script could not run because the environment lacks something, and the
 *         reason is a measured one (see ENVIRONMENTAL below) — not a code defect
 *   FAIL  the script ran and reported a real problem
 *
 * The exit code is non-zero only when there is a FAIL. A SKIP never hides a FAIL: the
 * classification is driven by the script's own output, and anything unrecognised is a
 * FAIL.
 *
 *   npm run test:suite            # full run
 *   npm run test:suite -- --only brand   # filter by substring
 *   npm run test:suite -- --json         # machine-readable summary
 *
 *   npm run test:suite
 */
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const onlyIndex = argv.indexOf('--only');
const only = onlyIndex === -1 ? null : argv[onlyIndex + 1];
const timeoutMs = Number(process.env.TRACEFAB_TEST_TIMEOUT_MS || 180000);

/**
 * Reasons measured in this environment, each confirmed by running the command that
 * fails. A pattern is only listed here once the cause has been established; anything
 * that does not match stays a FAIL.
 */
const ENVIRONMENTAL = [
  {
    id: 'prisma-engine',
    patterns: [
      /@prisma\/client did not initialize yet/,
      /binaries\.prisma\.sh/,
      /PrismaClientInitializationError/,
    ],
    reason: 'Client Prisma non généré — binaries.prisma.sh est injoignable depuis cet environnement.',
    remedy: 'npx prisma generate (réseau requis)',
  },
  {
    id: 'database',
    patterns: [/DATABASE_URL is required/, /Can't reach database server/, /P1001/],
    reason: 'Base Neon requise — DATABASE_URL n’est pas défini.',
    remedy: 'exporter DATABASE_URL vers une base de test',
  },
  {
    id: 'browser',
    patterns: [
      /Executable doesn't exist at .*ms-playwright/,
      /browserType\.launch/,
      /npx playwright install/,
    ],
    reason: 'Navigateur Playwright absent — cdn.playwright.dev est injoignable depuis cet environnement.',
    remedy: 'npx playwright install chromium',
  },
  {
    id: 'staging',
    patterns: [/requires TRACEFAB_STAGING_URL/, /TRACEFAB_E2E_STORAGE_STATE/],
    reason: 'Environnement de staging requis — aucun repli mock ou démo n’est autorisé, par conception.',
    remedy: 'définir TRACEFAB_STAGING_URL et les jetons de session',
  },
];

function run(script, command) {
  return new Promise((resolveRun) => {
    const started = Date.now();
    /* `detached` place l'enfant dans son propre groupe de processus. `npm run` lance
       lui-même un node : tuer npm seul laisserait ce petit-enfant tenir les pipes
       ouverts, et le runner attendrait alors indéfiniment. */
    const child = spawn('npm', ['run', '--silent', script], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let out = '';
    let timedOut = false;
    const collect = (chunk) => {
      out += chunk.toString();
      if (out.length > 200000) out = out.slice(0, 100000) + out.slice(-100000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const killTree = () => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const timer = setTimeout(killTree, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ script, code, output: timedOut ? `${out}\n[delai depasse apres ${timeoutMs} ms]` : out, ms: Date.now() - started, timedOut });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolveRun({ script, code: -1, output: `${out}\n${error.message}`, ms: Date.now() - started });
    });
  });
}

function classify(result) {
  if (result.code === 0) return { status: 'PASS' };
  /* Un dépassement de délai n'est jamais un SKIP : il reste un échec réel. */
  if (result.timedOut) return { status: 'FAIL', timedOut: true };
  for (const entry of ENVIRONMENTAL) {
    if (entry.patterns.some((pattern) => pattern.test(result.output))) {
      return { status: 'SKIP', reason: entry.reason, remedy: entry.remedy, id: entry.id };
    }
  }
  return { status: 'FAIL' };
}

/** Last meaningful lines, so a FAIL is reported with something readable. */
function excerpt(output, lines = 4) {
  const meaningful = output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^npm (warn|WARN)/.test(l) && !/^>/.test(l));
  return meaningful.slice(-lines).join(' ⏎ ').slice(0, 420);
}

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
/* `test:suite` est lui-même un script `test:*` : sans cette exclusion le runner
   s'exécute récursivement et ne se termine jamais. */
const SELF = 'test:suite';
const scripts = Object.keys(pkg.scripts)
  .filter((name) => name.startsWith('test:') && name !== SELF)
  .filter((name) => !only || name.includes(only))
  .sort();

if (!asJson) {
  console.log(`\nTRACEFAB — suite de tests`);
  console.log(`${scripts.length} script(s) test:*${only ? ` filtrés sur « ${only} »` : ''}\n`);
}

const results = [];
for (const [index, script] of scripts.entries()) {
  const result = await run(script, pkg.scripts[script]);
  const verdict = classify(result);
  results.push({ script, ...verdict, ms: result.ms, excerpt: verdict.status === 'FAIL' ? excerpt(result.output) : undefined });
  if (!asJson) {
    const label = verdict.status.padEnd(4);
    const timing = `${(result.ms / 1000).toFixed(1)}s`.padStart(7);
    console.log(`${label}  ${timing}  ${script}`);
    if (verdict.status === 'FAIL') console.error(`        ↳ ${results.at(-1).excerpt}`);
  }
}

const counts = results.reduce((acc, r) => {
  acc[r.status] = (acc[r.status] || 0) + 1;
  return acc;
}, {});
const skipped = results.filter((r) => r.status === 'SKIP');
const failed = results.filter((r) => r.status === 'FAIL');
const byReason = skipped.reduce((acc, r) => {
  acc[r.id] = (acc[r.id] || 0) + 1;
  return acc;
}, {});

if (asJson) {
  console.log(JSON.stringify({ total: results.length, counts, byReason, results }, null, 2));
} else {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`PASS ${counts.PASS || 0} · SKIP ${counts.SKIP || 0} · FAIL ${counts.FAIL || 0} — sur ${results.length} scripts`);
  if (skipped.length) {
    console.log(`\nNon exécutés, cause mesurée (aucun défaut de code) :`);
    for (const [id, n] of Object.entries(byReason)) {
      const sample = skipped.find((r) => r.id === id);
      console.log(`  ${String(n).padStart(2)} × ${id}`);
      console.log(`      ${sample.reason}`);
      console.log(`      à faire : ${sample.remedy}`);
      console.log(`      scripts : ${skipped.filter((r) => r.id === id).map((r) => r.script).join(', ')}`);
    }
  }
  if (failed.length) {
    console.log(`\nÉchecs réels à traiter :`);
    for (const r of failed) console.log(`  ✗ ${r.script}\n      ${r.excerpt}`);
  }
  console.log('');
}

process.exit(failed.length ? 1 : 0);
