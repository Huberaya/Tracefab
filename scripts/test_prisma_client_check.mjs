#!/usr/bin/env node
/**
 * Preuve du controle de client Prisma.
 *
 * Un controle qui refuse tout ne prouve rien ; un controle qui accepte tout
 * non plus. Cette suite installe le verificateur dans trois projets jetables
 * sous /tmp et verifie les trois issues :
 *
 *   1. client factice          -> le controle DOIT echouer ;
 *   2. client conforme         -> le controle DOIT passer ;
 *   3. client incomplet        -> le controle DOIT echouer.
 *
 * Le projet jetable reprend le vrai `prisma/schema.prisma` : le nombre de
 * modeles attendus est donc celui du depot, pas une valeur inventee.
 *
 * Aucun fichier du depot n'est modifie : tout se passe sous /tmp.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let echecs = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const ko = (m) => { echecs += 1; console.log(`  ECHEC ${m}`); };

const STUB = `"use strict";
class PrismaClient {
  constructor() {
    throw new Error('@prisma/client did not initialize yet. Please run "prisma generate" and try to import it again.');
  }
}
module.exports = { PrismaClient, Prisma: { defineExtension: (e) => e }, default: {} };
`;

/** Client conforme : tout modele du schema expose un delegue, sans connexion. */
const CONFORMING = `"use strict";
const delegate = () => ({ findMany: async () => [], findFirst: async () => null });
class PrismaClient {
  constructor() {
    return new Proxy(this, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === 'symbol') return undefined;
        return delegate();
      },
    });
  }
  async $transaction(fn) { return typeof fn === 'function' ? fn(this) : []; }
  async $queryRaw() { return []; }
  async $executeRaw() { return 0; }
  async $connect() {}
  async $disconnect() {}
}
module.exports = { PrismaClient, Prisma: { defineExtension: (e) => e }, default: {} };
`;

/** Client fabrique a la main : se construit, tous les modeles sont la, mais la
 *  surface du client genere manque ($disconnect). C'est ce qu'un paquet qui
 *  embarque un client bricole produirait, et ce controle doit le refuser. */
const MANUEL = CONFORMING.replace('  async $disconnect() {}\n', '');

/** Client incomplet : construit, mais un modele du schema manque. */
const INCOMPLETE = `"use strict";
const delegate = () => ({ findMany: async () => [] });
class PrismaClient {
  constructor() {
    return new Proxy(this, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === 'symbol') return undefined;
        // Le premier modele du schema est volontairement absent.
        if (prop === 'user') return undefined;
        return delegate();
      },
    });
  }
  async $transaction(fn) { return typeof fn === 'function' ? fn(this) : []; }
  async $connect() {}
  async $disconnect() {}
}
module.exports = { PrismaClient, Prisma: { defineExtension: (e) => e }, default: {} };
`;

function project(label, clientSource, { engine = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `tracefab-prisma-${label}-`));
  mkdirSync(join(dir, 'prisma'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', '@prisma', 'client'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', '.prisma', 'client'), { recursive: true });
  cpSync(join(ROOT, 'prisma', 'schema.prisma'), join(dir, 'prisma', 'schema.prisma'));
  cpSync(join(ROOT, 'scripts', 'verify_prisma_client.mjs'), join(dir, 'scripts', 'verify_prisma_client.mjs'));
  writeFileSync(join(dir, 'node_modules', '@prisma', 'client', 'package.json'),
    JSON.stringify({ name: '@prisma/client', version: '0.0.0-shim', main: 'index.js' }));
  writeFileSync(join(dir, 'node_modules', '@prisma', 'client', 'index.js'), clientSource);

  // Le client genere vit dans node_modules/.prisma/client, et la resolution
  // passe par le specifieur `.prisma/client/default` — celui que @prisma/client
  // utilise reellement. Le moteur, lui, est copie a cote : quand il manque, le
  // client se construit et echoue a la premiere requete.
  writeFileSync(join(dir, 'node_modules', '.prisma', 'client', 'default.js'),
    `module.exports = require('../../../@prisma/client/index.js');\n`);
  if (engine) {
    writeFileSync(join(dir, 'node_modules', '.prisma', 'client', 'libquery_engine-debian-openssl-3.0.x.so.node'), 'moteur factice pour la sonde\n');
  }
  return dir;
}

function run(dir) {
  const result = spawnSync(process.execPath, [join(dir, 'scripts', 'verify_prisma_client.mjs')],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, DATABASE_URL: '' } });
  return { code: result.status, out: `${result.stdout || ''}${result.stderr || ''}` };
}

const cases = [
  ['client factice', STUB, 1, 'repli factice', {}],
  ['client conforme', CONFORMING, 0, 'conforme', {}],
  ['client incomplet', INCOMPLETE, 1, 'delegue', {}],
  // Un client complet mais prive de son moteur : c'est le vert qui precede la
  // panne. Le controle doit le refuser, sans quoi il ne couvre pas la forme de
  // defaillance observee en production le 2026-10-12.
  ['client sans moteur', CONFORMING, 1, 'moteur', { engine: false }],
  ['client fabrique a la main', MANUEL, 1, 'disconnect', {}],
];

console.log('\n  Le controle doit distinguer les cinq etats d un client Prisma\n');
const dirs = [];
for (const [label, source, expected, needle, options] of cases) {
  const dir = project(label.replace(/\s+/g, '-'), source, options);
  dirs.push(dir);
  const { code, out } = run(dir);
  const verdictOk = code === expected;
  const messageOk = out.toLowerCase().includes(needle.toLowerCase());
  if (verdictOk && messageOk) ok(`${label} -> sortie ${code} (attendue ${expected}), diagnostic explicite`);
  else if (!verdictOk) ko(`${label} -> sortie ${code}, attendue ${expected}`);
  else ko(`${label} -> sortie ${code} correcte mais diagnostic sans « ${needle} »`);
}

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Le contournement de generation ne doit pas s appliquer dans un deploiement
// ---------------------------------------------------------------------------
// `PRISMA_SKIP_POSTINSTALL_GENERATE` existe pour les environnements contraints.
// S il s appliquait dans un build distant, le paquet partirait sans client : le
// deploiement serait vert et l application repondrait internal_error, soit
// exactement l incident du 2026-10-09.
//
// Le trou ferme ici avait ete mesure : `VERCEL=1` seul (VERCEL_ENV absent ou
// « development ») laissait passer le contournement.
console.log('\n  Le contournement doit etre refuse des qu un contexte de deploiement est present\n');
{
  const GENERATEUR = join(ROOT, 'scripts', 'prisma-generate.mjs');
  const CAS = [
    ['VERCEL_ENV=production', { VERCEL_ENV: 'production' }, 1],
    ['VERCEL_ENV=preview', { VERCEL_ENV: 'preview' }, 1],
    ['VERCEL_ENV=development + VERCEL=1', { VERCEL_ENV: 'development', VERCEL: '1' }, 1],
    ['VERCEL=1 seul (VERCEL_ENV absent)', { VERCEL: '1' }, 1],
    ['hors Vercel (developpement local)', {}, 0],
  ];
  for (const [nom, variables, attendu] of CAS) {
    const env = { ...process.env };
    delete env.VERCEL_ENV;
    delete env.VERCEL;
    Object.assign(env, variables, { PRISMA_SKIP_POSTINSTALL_GENERATE: 'true' });
    const resultat = spawnSync(process.execPath, [GENERATEUR], { cwd: ROOT, encoding: 'utf8', env });
    const sortie = `${resultat.stdout || ''}${resultat.stderr || ''}`;
    if (resultat.status === attendu) {
      const motif = attendu === 1 ? 'refuse' : 'honore hors deploiement';
      ok(`contournement ${motif} — ${nom}`);
    } else {
      ko(`contournement ${nom} : sortie ${resultat.status}, attendue ${attendu}`);
    }
    if (attendu === 1 && !/REFUS/.test(sortie)) ko(`  le refus de ${nom} ne dit pas pourquoi`);
  }
}

console.log('\n  --------------------------------------------');
console.log(`  ${echecs === 0 ? 'Controle de client Prisma : OK.' : `Controle de client Prisma : ${echecs} echec(s).`}`);
console.log('  --------------------------------------------\n');
if (echecs > 0) process.exit(1);
