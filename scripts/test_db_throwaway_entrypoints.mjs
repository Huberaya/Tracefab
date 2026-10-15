#!/usr/bin/env node
/**
 * Preuve de l'entrypoint `npm run db:deploy:throwaway` — sans Prisma Engine,
 * sans PostgreSQL, sans reseau, sans binaire Prisma reel.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyTarget } from './lib/require-throwaway-db.mjs';
import {
  THROWAWAY_NPM_BODY,
  THROWAWAY_NPM_SCRIPT,
  throwawayNpmBodyIsWrapper,
} from './lib/throwaway-deploy-binding.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const WRAPPER_SRC = join(HERE, 'db-deploy-throwaway.mjs');
const LIB_SRC = join(HERE, 'lib', 'require-throwaway-db.mjs');
const REAL_PRISMA = join(REPO, 'node_modules', '.bin', 'prisma');

let echecs = 0;
let passes = 0;
const ok = (m) => { passes += 1; console.log(`  ok    ${m}`); };
const ko = (m) => { echecs += 1; console.log(`  ECHEC ${m}`); };

const SECRET_PASSWORD = 'motdepasse_qui_ne_doit_jamais_sortir';
const SECRET_HOST = 'ep-secret-123456.eu-central-1.aws.neon.tech';
const LOCAL_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/tracefab_test';
const NEON_URL = `postgresql://neondb_owner:${SECRET_PASSWORD}@${SECRET_HOST}/neondb`;
const REMOTE_URL = 'postgresql://u:p@test-db.internal.example:5432/tracefab_test';

const CORPS_DANGEREUX = [
  ['prisma migrate deploy', 'prisma migrate deploy'],
  ['npx prisma migrate deploy', 'npx prisma migrate deploy'],
  ['script non audite', 'node scripts/unguarded-migrate.mjs'],
  ['wrapper avec --url', 'node scripts/db-deploy-throwaway.mjs --url postgresql://x'],
  ['chemin ./scripts', 'node ./scripts/db-deploy-throwaway.mjs'],
];

const savedNodeEnv = process.env.NODE_ENV;
const savedVercelEnv = process.env.VERCEL_ENV;
delete process.env.NODE_ENV;
delete process.env.VERCEL_ENV;

function leaks(text) {
  return text.includes(SECRET_PASSWORD)
    || text.includes(SECRET_HOST)
    || /postgresql:\/\/[^\s]+/i.test(text)
    || /postgres:\/\/[^\s]+/i.test(text);
}

console.log('\n  0. contrat de liaison npm');

{
  let depotPkg;
  try {
    depotPkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  } catch (error) {
    depotPkg = null;
    ko(`package.json du depot illisible (${error.message})`);
  }
  const corpsDepot = depotPkg?.scripts?.[THROWAWAY_NPM_SCRIPT];
  throwawayNpmBodyIsWrapper(corpsDepot)
    ? ok('package.json du depot : db:deploy:throwaway est le wrapper')
    : ko(`package.json du depot : corps inattendu (${JSON.stringify(corpsDepot)})`);
  depotPkg?.scripts?.['db:deploy'] === 'prisma migrate deploy'
    ? ok('package.json du depot : db:deploy ops inchange')
    : ko('package.json du depot : db:deploy ops a change');
  existsSync(WRAPPER_SRC)
    ? ok('wrapper present dans le depot')
    : ko('wrapper absent du depot');
}

{
  throwawayNpmBodyIsWrapper(THROWAWAY_NPM_BODY)
    ? ok('contrat : le corps attendu est accepte')
    : ko('contrat : le corps attendu est refuse');
  for (const [nom, corps] of CORPS_DANGEREUX) {
    throwawayNpmBodyIsWrapper(corps)
      ? ko(`contrat : corps dangereux accepte (${nom})`)
      : ok(`contrat : refuse « ${nom} »`);
  }
}

let harnessRoot;
try {
  harnessRoot = mkdtempSync(join(tmpdir(), 'tf-t15-harness-'));
  const wrapper = join(harnessRoot, 'scripts', 'db-deploy-throwaway.mjs');
  const sentinelBin = join(harnessRoot, 'node_modules', '.bin', 'prisma');
  const sentinelLog = join(harnessRoot, 'sentinel.log');
  const packageJson = join(harnessRoot, 'package.json');

  mkdirSync(join(harnessRoot, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(harnessRoot, 'node_modules', '.bin'), { recursive: true });
  copyFileSync(WRAPPER_SRC, wrapper);
  copyFileSync(LIB_SRC, join(harnessRoot, 'scripts', 'lib', 'require-throwaway-db.mjs'));

  writeFileSync(sentinelBin, `#!/usr/bin/env node
const { appendFileSync } = require('fs');
const mark = process.env.TF_PRISMA_SENTINEL;
if (!mark) process.exit(1);
appendFileSync(mark, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
if (process.env.TF_PRISMA_LEAK_URL) {
  console.log('LEAK_OUT ' + process.env.TF_PRISMA_LEAK_URL);
  console.error('LEAK_ERR ' + process.env.TF_PRISMA_LEAK_URL);
}
console.log('SENTINEL_PRISMA_FAKE');
process.exit(42);
`);
  chmodSync(sentinelBin, 0o755);

  writeFileSync(join(harnessRoot, 'scripts', 'unguarded-migrate.mjs'), `#!/usr/bin/env node
console.log('UNGUARDED_SCRIPT');
process.exit(7);
`);

  function writeHarnessPackage(scriptBody) {
    writeFileSync(packageJson, `${JSON.stringify({
      name: 'tf-t15-harness',
      private: true,
      scripts: {
        'db:deploy': 'prisma migrate deploy',
        [THROWAWAY_NPM_SCRIPT]: scriptBody,
      },
    }, null, 2)}\n`);
  }

  function resetSentinel() {
    writeFileSync(sentinelLog, '');
  }

  function sentinelInvocations() {
    const raw = readFileSync(sentinelLog, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').map((line) => JSON.parse(line));
  }

  function envPour(env) {
    const merged = {
      ...process.env,
      ...env,
      TF_PRISMA_SENTINEL: sentinelLog,
    };
    if (!('NODE_ENV' in env)) delete merged.NODE_ENV;
    if (!('VERCEL_ENV' in env)) delete merged.VERCEL_ENV;
    return merged;
  }

  function runNpm(env, { args = [], scriptBody = THROWAWAY_NPM_BODY } = {}) {
    writeHarnessPackage(scriptBody);
    resetSentinel();
    const npmArgs = args.length > 0
      ? ['run', THROWAWAY_NPM_SCRIPT, '--', ...args]
      : ['run', THROWAWAY_NPM_SCRIPT];
    const result = spawnSync('npm', npmArgs, {
      cwd: harnessRoot,
      env: envPour(env),
      encoding: 'utf8',
      shell: false,
    });
    return {
      status: result.status,
      error: result.error,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      combined: `${result.stdout || ''}\n${result.stderr || ''}`,
      invocations: sentinelInvocations(),
    };
  }

  console.log('\n  A0. wrapper : contrats d execution (pas le moteur Prisma)');

  {
    const src = readFileSync(WRAPPER_SRC, 'utf8');
    !/shell\s*:\s*true/.test(src)
      ? ok('wrapper : pas de shell: true')
      : ko('wrapper : shell: true present');
    /spawn\(/.test(src) && /\['migrate',\s*'deploy'\]/.test(src)
      ? ok('wrapper : spawn prisma local, argv fixes migrate deploy')
      : ko('wrapper : spawn/argv inattendus');
    !/spawn\(\s*['"]npx['"]/.test(src) && !/\bnpx\s+prisma\b/.test(src)
      ? ok('wrapper : npx absent du chemin d execution')
      : ko('wrapper : npx dans le chemin d execution');
    const gardeAvantSpawn = src.lastIndexOf('requireThrowawayDb(') !== -1
      && src.indexOf('spawn(') !== -1
      && src.lastIndexOf('requireThrowawayDb(') < src.indexOf('spawn(');
    gardeAvantSpawn
      ? ok('wrapper : requireThrowawayDb avant spawn')
      : ko('wrapper : spawn avant la garde, ou garde absente');
    !/stdio\s*:\s*['"]inherit['"]/.test(src) && /caviarderFlux/.test(src)
      ? ok('wrapper : flux caviardes, pas de stdio inherit')
      : ko('wrapper : stdio inherit ou caviardage absent');
  }

  console.log('\n  A. classificateur');

  {
    const v = classifyTarget(LOCAL_URL);
    v.allowed && v.code === 'throwaway_local' ? ok('cible jetable locale acceptee') : ko(`locale refusee (${v.code})`);
  }
  {
    const v = classifyTarget(NEON_URL);
    !v.allowed && v.code === 'managed_host' ? ok('hote manage refuse') : ko(`production acceptee (${v.code})`);
  }
  {
    const v = classifyTarget('postgresql://postgres:postgres@127.0.0.1:5432/tracefab_prod');
    !v.allowed && v.code === 'production_name' ? ok('tracefab_prod local refuse') : ko(`tracefab_prod local accepte (${v.code})`);
  }
  {
    const v = classifyTarget(`${LOCAL_URL}?hostaddr=8.8.8.8`);
    !v.allowed && v.code === 'hostaddr_param' ? ok('hostaddr refuse') : ko(`hostaddr accepte (${v.code})`);
  }

  console.log('\n  B. npm run db:deploy:throwaway — refus : sentinelle jamais invoquee');

  {
    const r = runNpm({ DATABASE_URL: NEON_URL });
    r.error
      ? ko(`npm absent ou inexecutable (${r.error.message})`)
      : r.status === 3 && /REFUS/.test(r.combined) && r.invocations.length === 0
        && !/SENTINEL_PRISMA_FAKE/.test(r.combined)
        ? ok('production : sortie 3, sentinelle intacte')
        : ko(`production status=${r.status} invocations=${r.invocations.length}`);
    leaks(r.combined) ? ko('production : secret ou URL dans les logs') : ok('production : logs sans secret ni URL');
  }
  {
    const r = runNpm({ DATABASE_URL: LOCAL_URL }, { args: ['--url', NEON_URL] });
    r.status === 2 && /aucun argument/.test(r.combined) && r.invocations.length === 0
      ? ok('argument inattendu : sortie 2, sentinelle intacte')
      : ko(`argv status=${r.status} invocations=${r.invocations.length}`);
  }
  {
    const r = runNpm({
      DATABASE_URL: REMOTE_URL,
      TRACEFAB_ALLOW_NONLOCAL_TEST_DB: 'true',
      TRACEFAB_TEST_DB_HOST_ALLOWLIST: 'test-db.internal.example',
      TRACEFAB_TEST_DB_NAME_ALLOWLIST: 'tracefab_test',
    });
    r.status === 3 && /REFUS/.test(r.combined) && r.invocations.length === 0
      ? ok('opt-in distant refuse, sentinelle intacte')
      : ko(`opt-in status=${r.status} invocations=${r.invocations.length}`);
  }
  {
    const r = runNpm({ DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/tracefab_prod' });
    r.status === 3 && r.invocations.length === 0
      ? ok('tracefab_prod local : sortie 3, sentinelle intacte')
      : ko(`prod local status=${r.status} invocations=${r.invocations.length}`);
  }
  {
    const r = runNpm({ DATABASE_URL: LOCAL_URL, NODE_ENV: 'production' });
    r.status === 3 && r.invocations.length === 0
      ? ok('NODE_ENV=production : sortie 3, sentinelle intacte')
      : ko(`NODE_ENV status=${r.status} invocations=${r.invocations.length}`);
  }
  {
    const r = runNpm({ DATABASE_URL: LOCAL_URL, VERCEL_ENV: 'production' });
    r.status === 3 && r.invocations.length === 0 && !/SENTINEL_PRISMA_FAKE/.test(r.combined)
      ? ok('VERCEL_ENV=production : sortie 3, sentinelle intacte')
      : ko(`VERCEL_ENV status=${r.status} invocations=${r.invocations.length}`);
  }
  {
    const r = runNpm({ DATABASE_URL: `${LOCAL_URL}?hostaddr=8.8.8.8` });
    r.status === 3 && r.invocations.length === 0
      ? ok('hostaddr : sortie 3, sentinelle intacte')
      : ko(`hostaddr wrapper status=${r.status} invocations=${r.invocations.length}`);
  }
  {
    const r = runNpm({ DATABASE_URL: `${LOCAL_URL}?HOSTADDR=1.2.3.4` });
    r.status === 3 && r.invocations.length === 0
      ? ok('HOSTADDR : sortie 3, sentinelle intacte')
      : ko(`HOSTADDR status=${r.status} invocations=${r.invocations.length}`);
  }

  console.log('\n  C. npm run — cible locale, sentinelle, exit 42, migrate deploy');

  {
    const r = runNpm({ DATABASE_URL: LOCAL_URL });
    const args = r.invocations[0]?.argv;
    const usedRealPrisma = r.combined.includes(REAL_PRISMA);
    r.status === 42
      && r.invocations.length === 1
      && Array.isArray(args) && args.length === 2 && args[0] === 'migrate' && args[1] === 'deploy'
      && /SENTINEL_PRISMA_FAKE/.test(r.combined)
      && /throwaway_local/.test(r.combined)
      && !usedRealPrisma
      ? ok('npm run throwaway : sentinelle migrate deploy, exit 42')
      : ko(`locale status=${r.status} invocations=${JSON.stringify(r.invocations)} body=${r.combined.slice(0, 280)}`);
    leaks(r.combined) ? ko('locale : URL dans les logs') : ok('locale : logs sans URL');
  }

  console.log('\n  C2. binaire prisma local absent : sortie 2, sentinelle jamais invoquee');

  {
    const hidden = `${sentinelBin}.hidden`;
    renameSync(sentinelBin, hidden);
    try {
      const r = runNpm({ DATABASE_URL: LOCAL_URL });
      r.status === 2 && /binaire prisma local absent/.test(r.combined) && r.invocations.length === 0
        ? ok('prisma absent : sortie 2, sentinelle intacte')
        : ko(`prisma absent status=${r.status} inv=${r.invocations.length} body=${r.combined.slice(0, 180)}`);
    } finally {
      renameSync(hidden, sentinelBin);
    }
  }

  console.log('\n  C3. stdout/stderr prisma : URL caviardée, code de sortie conserve');

  {
    const r = runNpm({ DATABASE_URL: LOCAL_URL, TF_PRISMA_LEAK_URL: NEON_URL });
    const args = r.invocations[0]?.argv;
    r.status === 42
      && r.invocations.length === 1
      && Array.isArray(args) && args[0] === 'migrate' && args[1] === 'deploy'
      && /SENTINEL_PRISMA_FAKE/.test(r.combined)
      && /\[redacted-url\]/.test(r.combined)
      && !leaks(r.combined)
      ? ok('flux prisma : URL caviardée, sentinelle exit 42')
      : ko(`caviardage status=${r.status} leaks=${leaks(r.combined)} body=${r.combined.slice(0, 280)}`);
  }

  console.log('\n  D. substitution dangereuse du corps npm');

  {
    const r = runNpm({ DATABASE_URL: LOCAL_URL }, { scriptBody: 'prisma migrate deploy' });
    const contourne = r.invocations.length >= 1 && !/throwaway_local/.test(r.combined) && !/garde cible/.test(r.combined);
    contourne
      ? ok('corps prisma : npm contourne le wrapper (sentinelle joignable)')
      : ko(`corps prisma n a pas contourne le wrapper status=${r.status} inv=${r.invocations.length}`);
    throwawayNpmBodyIsWrapper('prisma migrate deploy')
      ? ko('contrat a accepte prisma migrate deploy')
      : ok('contrat refuse prisma migrate deploy — le test echoue si le depot substitue ce corps');
  }
  {
    const r = runNpm({ DATABASE_URL: LOCAL_URL }, { scriptBody: 'node scripts/unguarded-migrate.mjs' });
    r.status === 7 && /UNGUARDED_SCRIPT/.test(r.combined) && r.invocations.length === 0
      && !/throwaway_local/.test(r.combined)
      ? ok('corps autre script : npm n appelle pas le wrapper')
      : ko(`autre script status=${r.status} inv=${r.invocations.length} body=${r.combined.slice(0, 180)}`);
    throwawayNpmBodyIsWrapper('node scripts/unguarded-migrate.mjs')
      ? ko('contrat a accepte un script non audite')
      : ok('contrat refuse le script non audite');
  }
} finally {
  if (harnessRoot) rmSync(harnessRoot, { recursive: true, force: true });
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  if (savedVercelEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = savedVercelEnv;
}

console.log(`\n  ${passes} ok, ${echecs} echec(s)\n`);
process.exit(echecs === 0 ? 0 : 1);
