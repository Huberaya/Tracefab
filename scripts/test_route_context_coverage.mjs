#!/usr/bin/env node
/**
 * Couverture du contexte RLS au niveau des routes réellement enregistrées.
 *
 * L'authentification seule ne suffit pas : après le refus anonyme, une route
 * métier doit poser le contexte transactionnel de l'utilisateur/tenant avant
 * d'interroger les tables protégées. Ce contrôle complète
 * test_route_auth_coverage.mjs et test_context_integrity.mjs.
 *
 * Les seules exceptions sans contexte applicatif explicite sont les deux
 * routes de questionnaires, qui ne font que lire des modèles statiques et
 * n'accèdent à aucune base de données.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_INDEX = readFileSync(join(ROOT, 'api/index.ts'), 'utf8');
const routeRe =
  /load:\s*\(\)\s*=>\s*import\('\.\/_routes\/([^']+)\.js'\)/g;
const routePaths = [...API_INDEX.matchAll(routeRe)].map((match) => ({
  name: match[1],
  file: join(ROOT, 'api', '_routes', match[1] + '.ts'),
  relative: 'api/_routes/' + match[1] + '.ts',
}));
const declaredLoads = (API_INDEX.match(/load:\s*\(\)\s*=>\s*import\(/g) || []).length;

let failures = 0;
const ok = (message) => console.log('  ok    ' + message);
const fail = (message) => {
  failures += 1;
  console.error('  ECHEC ' + message);
};

if (routePaths.length === 0 || routePaths.length !== declaredLoads) {
  fail(`registre incohérent : ${routePaths.length} routes analysées pour ${declaredLoads} imports`);
  process.exit(1);
}
ok(`${routePaths.length} routes du routeur principal analysées`);

const authContextExceptions = new Map([
  ['api/_routes/questionnaires.ts', 'lecture de modèles statiques uniquement'],
  ['api/_routes/questionnaires/[questionnaireKey].ts', 'lecture de modèles statiques uniquement'],
]);

const publicReadRoutes = [
  'api/_routes/dpp/[gtin].ts',
  'api/_routes/resolve/[publicId].ts',
  'api/_routes/resolve/[publicId]/qr.ts',
  'api/_routes/passport/[tokenOrSlug].ts',
  'api/_routes/dpp/[gtin]/apple-wallet.ts',
  'api/_routes/dpp/[gtin]/google-wallet.ts',
  'api/_routes/gs1/digital-link/[gtin].ts',
  'api/_routes/products/[productId]/wallet/apple.ts',
  'api/_routes/products/[productId]/wallet/google.ts',
];

let authenticatedRoutes = 0;
let authenticatedWithContext = 0;
for (const route of routePaths) {
  if (!existsSync(route.file)) {
    fail(`route enregistrée sans fichier source : ${route.relative}`);
    continue;
  }
  const source = readFileSync(route.file, 'utf8');
  if (!/requireClerkUser\s*\(/.test(source)) continue;
  authenticatedRoutes += 1;
  const hasContext = /withTracefab(?:Request|User|Worker|Public)Context\s*\(/.test(source);
  if (hasContext) {
    authenticatedWithContext += 1;
    continue;
  }
  const exception = authContextExceptions.get(route.relative);
  if (!exception) {
    fail(`${route.relative} exige Clerk mais n'arme aucun contexte TraceFab`);
    continue;
  }
  const databaseAccess = /\bprisma\s*\.|\$queryRaw\b|\$executeRaw\b|new\s+PrismaClient\s*\(|\bpool\.query\s*\(/.test(source);
  if (databaseAccess) {
    fail(`${route.relative} est une exception mais accède directement à la base`);
    continue;
  }
  ok(`${route.relative} — exception justifiée : ${exception}`);
}
ok(`${authenticatedWithContext}/${authenticatedRoutes} routes authentifiées arment explicitement un contexte`);

for (const relative of publicReadRoutes) {
  const file = join(ROOT, relative);
  if (!existsSync(file)) {
    fail(`route publique attendue absente : ${relative}`);
    continue;
  }
  const source = readFileSync(file, 'utf8');
  if (!/withTracefabPublicContext\s*\(/.test(source)) {
    fail(`${relative} — lecture publique sans contexte public transactionnel explicite`);
  } else {
    ok(`${relative} — contexte public transactionnel explicite`);
  }
}

for (const relative of authContextExceptions.keys()) {
  if (!routePaths.some((route) => route.relative === relative)) {
    fail(`exception de contexte devenue orpheline : ${relative}`);
  }
}

console.log(`\n  Couverture du contexte RLS : ${failures === 0 ? 'OK' : failures + ' échec(s)'}.`);
process.exit(failures === 0 ? 0 : 1);
