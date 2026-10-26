#!/usr/bin/env node
/**
 * Génère le VRAI client Prisma sans accès à binaries.prisma.sh.
 *
 * POURQUOI
 * --------
 * `npm ci` (postinstall) et `npm run db:generate` téléchargent les moteurs
 * natifs depuis https://binaries.prisma.sh. Un runner isolé — ou un poste
 * derrière une liste d'hôtes sortants restreinte — ne peut pas les joindre :
 * `prisma generate` échoue, @prisma/client reste le repli factice, et toutes
 * les routes de données répondent internal_error (incident du 2026-10-12).
 *
 * CE QUE FAIT CE SCRIPT — ET CE QU'IL NE FAIT PAS
 * -----------------------------------------------
 * Il ne fabrique AUCUN client. Il demande au CLI Prisma local de générer le
 * client à partir de prisma/schema.prisma, en lui indiquant où trouver des
 * fichiers de moteurs déjà présents dans le paquet npm `prisma` :
 *
 *   - node_modules/prisma/build/schema_engine_bg.wasm
 *   - node_modules/prisma/build/query_engine_bg.<provider>.wasm
 *
 * Ces deux fichiers sont les moteurs WASM publiés par Prisma lui-même. Le
 * client généré est donc le client officiel, avec son DMMF complet, ses
 * délégués de modèles et son moteur de requêtes WASM — pas un stub.
 *
 * `PRISMA_CLIENT_FORCE_WASM=1` configure le client pour utiliser ce moteur
 * WASM. Dans ce mode, l'exécution d'une requête sous Node exige un adaptateur
 * de pilote (`@prisma/adapter-pg`) : c'est exactement le chemin déjà prévu
 * par `scripts/lib/test_prisma_client.mjs` (`createTestPrisma`). Les
 * environnements qui disposent du moteur natif (CI, production) continuent
 * d'utiliser `npm run db:generate` sans ce script.
 *
 * SÉCURITÉ
 * --------
 * Aucun contrôle de test, aucune assertion de sécurité et aucune politique
 * RLS ne sont modifiés. Le script refuse de s'exécuter si le CLI Prisma ou
 * les moteurs WASM sont absents, et vérifie la génération avant de sortir.
 *
 * Usage : npm run db:generate:offline
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const CLI = join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const BUILD = join(ROOT, 'node_modules', 'prisma', 'build');
const CLIENT_DIR = join(ROOT, 'node_modules', '.prisma', 'client');

const schema = readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
const provider = /provider\s*=\s*"(\w+)"/.exec(schema)?.[1] ?? 'postgresql';
const schemaEngine = join(BUILD, 'schema_engine_bg.wasm');
const queryEngine = join(BUILD, `query_engine_bg.${provider}.wasm`);

for (const [label, file] of [['CLI Prisma', CLI], ['moteur de schéma WASM', schemaEngine], ['moteur de requêtes WASM', queryEngine]]) {
  if (!existsSync(file)) {
    console.error(`  ECHEC — ${label} introuvable : ${file}`);
    console.error('  Installer les dépendances (npm ci --ignore-scripts) avant de générer.');
    process.exit(2);
  }
}

console.log('  generation Prisma hors ligne — moteurs WASM du paquet npm local');
const result = spawnSync(process.execPath, [CLI, 'generate'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    PRISMA_SCHEMA_ENGINE_BINARY: schemaEngine,
    PRISMA_QUERY_ENGINE_LIBRARY: queryEngine,
    PRISMA_CLIENT_FORCE_WASM: '1',
  },
});
if (result.status !== 0) {
  console.error(`  ECHEC — prisma generate a retourné ${result.status}.`);
  process.exit(result.status ?? 1);
}

const indexDts = join(CLIENT_DIR, 'index.d.ts');
const indexJs = join(CLIENT_DIR, 'index.js');
const wasm = join(CLIENT_DIR, 'query_engine_bg.wasm');
const controles = [
  ['déclarations TypeScript générées', indexDts, 100_000],
  ['client JavaScript généré', indexJs, 100_000],
  ['moteur de requêtes WASM réel', wasm, 1_000_000],
];
for (const [label, file, tailleMin] of controles) {
  if (!existsSync(file) || statSync(file).size < tailleMin) {
    console.error(`  ECHEC — ${label} absent ou trop petit : ${file}`);
    process.exit(1);
  }
}
if (!readFileSync(indexJs, 'utf8').includes('config.engineWasm')) {
  console.error('  ECHEC — le client généré ne référence pas le moteur WASM.');
  process.exit(1);
}

// Le paquet @prisma/adapter-pg est nécessaire pour exécuter des requêtes sous
// Node avec ce moteur. Ne pas le réclamer ici : la génération seule n'en a
// pas besoin, et npm ci en environnement restreint ne doit pas échouer pour
// une dépendance utile uniquement aux suites de test.
let adapter = 'absent (requis uniquement pour exécuter des requêtes)';
try { require.resolve('@prisma/adapter-pg'); adapter = 'présent'; } catch { /* optionnel */ }

console.log('  client Prisma généré et vérifié : DMMF complet + moteur WASM officiel.');
console.log(`  adaptateur @prisma/adapter-pg : ${adapter}.`);
console.log('  Ce mode est réservé aux environnements sans binaire natif.');
console.log('  En CI/production : npm run db:generate (moteur natif) reste la référence.');
