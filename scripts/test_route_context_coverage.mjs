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

// Toutes les routes sans authentification Clerk doivent aussi être classées.
// Les routes publiques ne sont pas toutes tenant-scoped : certains catalogues
// ont une politique SELECT publique active-only, les sondes ne lisent que le
// catalogue, et les mutations publiques doivent passer par une fonction
// SECURITY DEFINER dédiée. Une route inconnue n'est jamais une exception implicite.
const nonClerkRouteExceptions = new Map([
  ['api/_routes/catalog/questionnaires.ts', 'static'],
  ['api/_routes/catalog/schemas.ts', 'static'],
  ['api/_routes/catalog/certification-standards.ts', 'static'],
  ['api/_routes/clerk-proxy.ts', 'static'],
  ['api/_routes/config.ts', 'static'],
  ['api/_routes/health.ts', 'health'],
  ['api/_routes/internal/notification-outbox/health.ts', 'worker-direct'],
  ['api/_routes/internal/notification-outbox/process.ts', 'worker-helper'],
  ['api/_routes/internal/notification-outbox/reminders.ts', 'worker-helper'],
  ['api/_routes/internal/notification-outbox/schedule.ts', 'cron-helper'],
  ['api/_routes/internal/p2-readiness.ts', 'readiness'],
  ['api/_routes/webhooks/clerk.ts', 'worker-direct'],
  ['api/_routes/pef/factors.ts', 'public-reference'],
  ['api/_routes/green-claims/rules.ts', 'public-reference'],
  ['api/_routes/passport/[tokenOrSlug]/request-access.ts', 'security-definer-entrypoint'],
  ['api/_routes/preview-storage/object.ts', 'preview-signed-capability'],
]);

const helperSources = {
  outbox: readFileSync(join(ROOT, 'api/_lib/notification-outbox.ts'), 'utf8'),
  reminders: readFileSync(join(ROOT, 'api/_lib/notification-reminders.ts'), 'utf8'),
  passport: readFileSync(join(ROOT, 'api/_lib/supplier-passport/passport-manager.ts'), 'utf8'),
  readiness: readFileSync(join(ROOT, 'api/_lib/readiness-probes.ts'), 'utf8'),
  previewStore: readFileSync(join(ROOT, 'api/_lib/preview-postgres-store.ts'), 'utf8'),
};

let unauthenticatedRoutes = 0;
let classifiedUnauthenticatedRoutes = 0;
for (const route of routePaths) {
  if (!existsSync(route.file)) continue;
  const source = readFileSync(route.file, 'utf8');
  if (/requireClerkUser\s*\(/.test(source)) continue;
  unauthenticatedRoutes += 1;

  if (publicReadRoutes.includes(route.relative)) {
    classifiedUnauthenticatedRoutes += 1;
    continue; // le contexte public est contrôlé dans le bloc ci-dessus
  }

  const kind = nonClerkRouteExceptions.get(route.relative);
  if (!kind) {
    fail(`${route.relative} est sans Clerk mais n'a ni contexte tenant ni exception documentée`);
    continue;
  }

  const dbAccess = /\bprisma\s*\.|\$queryRaw\b|\$executeRaw\b|new\s+PrismaClient\s*\(|\bpool\.query\s*\(/.test(source);
  let valid = false;
  switch (kind) {
    case 'static':
      valid = !dbAccess;
      break;
    case 'health':
      valid = /prisma\.\$queryRaw\s*`\s*SELECT\s+1\s*`/i.test(source)
        && !/\bFROM\s+(?:public\.)?[a-z_][a-z0-9_]*/i.test(source);
      break;
    case 'worker-direct':
      valid = /withTracefabWorkerContext\s*\(/.test(source)
        && /workerAuthorized\s*\(|verifyWebhook\s*\(/.test(source);
      break;
    case 'worker-helper':
      valid = /workerAuthorized\s*\(/.test(source)
        && /processNotificationOutbox\s*\(|enqueueDueDataRequestReminders\s*\(/.test(source)
        && /withTracefabWorkerContext\s*\(/.test(helperSources.outbox)
        && /withTracefabWorkerContext\s*\(/.test(helperSources.reminders);
      break;
    case 'cron-helper':
      valid = /cronAuthorized\s*\(/.test(source)
        && /processNotificationOutbox\s*\(/.test(source)
        && /enqueueDueDataRequestReminders\s*\(/.test(source)
        && /withTracefabWorkerContext\s*\(/.test(helperSources.outbox)
        && /withTracefabWorkerContext\s*\(/.test(helperSources.reminders);
      break;
    case 'readiness':
      valid = /workerAuthorized\s*\(/.test(source)
        && /probeDatabaseIdentity\s*\(/.test(source)
        && /current_user/.test(helperSources.readiness)
        && /current_database\(\)/.test(helperSources.readiness)
        && /SELECT\s+1/.test(helperSources.readiness);
      break;
    case 'public-reference':
      valid = /prisma\.(?:pef_emission_factors|green_claims_rules)\.findMany/.test(source)
        && /where:\s*\{\s*is_active:\s*true\s*\}/.test(source)
        && /static_catalog/.test(source);
      break;
    case 'security-definer-entrypoint':
      valid = /requestPassportAccess\s*\(/.test(source)
        && /tracefab_request_passport_access\s*\(/.test(helperSources.passport);
      break;
    case 'preview-signed-capability': {
      // Ni route publique, ni exemption Clerk generale : une capacite signee
      // PUT/GET est obligatoire avant tout transfert, et le stockage arme sa
      // propre transaction RLS apres verification du role SQL. Les refus sont
      // egalement exerces contre le vrai routeur et PostgreSQL par la suite CI.
      const validation = source.indexOf('verifyPreviewCapability(req.headers');
      const ecriture = source.indexOf('putPreviewObject(capability.key');
      const lecture = source.indexOf('readPreviewObject(capability.key');
      valid = !dbAccess && /assertPreviewStorageConfig\s*\(/.test(source)
        && validation >= 0 && ecriture > validation && lecture > validation
        && /if\s*\(!capability\)/.test(source)
        && /assertPreviewTransactionRole\(tx\)/.test(helperSources.previewStore)
        && /\$transaction\s*\(/.test(helperSources.previewStore)
        && /set_config\('tracefab\.preview_storage_key'/.test(helperSources.previewStore);
      break;
    }
  }

  if (!valid) {
    fail(`${route.relative} — exception « ${kind} » non conforme au contrat vérifié`);
  } else {
    classifiedUnauthenticatedRoutes += 1;
    ok(`${route.relative} — exception contrôlée : ${kind}`);
  }
}

if (classifiedUnauthenticatedRoutes !== unauthenticatedRoutes) {
  fail(`routes sans Clerk classées : ${classifiedUnauthenticatedRoutes}/${unauthenticatedRoutes}`);
} else {
  ok(`${classifiedUnauthenticatedRoutes}/${unauthenticatedRoutes} routes sans Clerk classées explicitement`);
}

for (const relative of authContextExceptions.keys()) {
  if (!routePaths.some((route) => route.relative === relative)) {
    fail(`exception de contexte devenue orpheline : ${relative}`);
  }
}

console.log(`\n  Couverture du contexte RLS : ${failures === 0 ? 'OK' : failures + ' échec(s)'}.`);
process.exit(failures === 0 ? 0 : 1);
