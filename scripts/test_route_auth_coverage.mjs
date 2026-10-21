#!/usr/bin/env node
/**
 * TRACEFAB — preuve HTTP d'absence d'accès anonyme sur les routes TENANT.
 *
 * Le test statique test_cross_tenant.mjs vérifie les déclarations de garde.
 * Ce test appelle les vrais gestionnaires exportés, sans jeton Clerk, pour
 * chaque route enregistrée qui invoque requireClerkUser().
 *
 * Isolation stricte du test :
 * - aucune URL de base de données n'est conservée dans le processus ;
 * - une clé Clerk factice est posée, mais aucun bearer token n'est envoyé ;
 * - aucun appel au réseau Clerk ne doit être possible sans bearer token ;
 * - les modules sont appelés directement, sans passer par le rate limiter
 *   central, afin de mesurer la garde d'authentification de chaque handler.
 *
 * Pour chaque route, GET/POST/PUT/PATCH/DELETE doivent soit répondre 401/403,
 * soit répondre 405 (méthode interdite). Toute réponse 2xx, 4xx autre que
 * 401/403/405, toute réponse 5xx ou toute exception inattendue fait échouer
 * le test. Une route doit avoir au moins une méthode refusée explicitement
 * comme non authentifiée (401/403).
 *
 * Usage : npx tsx scripts/test_route_auth_coverage.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_INDEX = readFileSync(join(ROOT, 'api/index.ts'), 'utf8');

// Ne jamais hériter d'une URL distante ou d'un secret de l'environnement CI.
delete process.env.DATABASE_URL;
delete process.env.TF_RLS_APP_URL;
process.env.NODE_ENV = 'test';
process.env.CLERK_SECRET_KEY = 'sk_test_tracefab_route_auth_probe_without_token';
delete process.env.TRACEFAB_AUTHORIZED_PARTIES;

const routeRe =
  /\{ pattern: (\/\^.*?\$\/), params: \[([^\]]*)\], load: \(\) => import\('\.\/_routes\/([^']+)\.js'\) \}/g;
const registered = [...API_INDEX.matchAll(routeRe)].map((m) => ({
  pattern: eval(m[1]), // littéral RegExp provenant du routeur du dépôt
  params: m[2].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean),
  file: join(ROOT, 'api', '_routes', m[3] + '.ts'),
  routeName: m[3],
}));

const declaredLoads = (API_INDEX.match(/load:\s*\(\)\s*=>\s*import\(/g) || []).length;
if (registered.length === 0 || registered.length !== declaredLoads) {
  console.error(`ECHEC : analyse du routeur incohérente (parsed=${registered.length}, declared=${declaredLoads}).`);
  process.exit(1);
}

const sampleFor = (name) => {
  if (/gtin/i.test(name)) return '3760123456789';
  if (/token|slug|publicid|questionnairekey/i.test(name)) return 'probe-token-not-real';
  if (/clerkpath/i.test(name)) return 'v1/probe';
  if (/email/i.test(name)) return 'probe@example.test';
  return '00000000-0000-4000-8000-000000000001';
};

function samplePath(route) {
  let paramIndex = 0;
  const raw = route.pattern.source
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\((?:\[\^\\\/\]\+|\.\+|\.\*|[^()]*)\)/g, () => {
      const name = route.params[paramIndex] || 'param';
      paramIndex += 1;
      return sampleFor(name);
    })
    .replace(/\\([-/])/g, '$1')
    .replace(/\\\./g, '.');
  return raw;
}

function makeRequest(method, path, params, serial) {
  return {
    method,
    url: `/api/${path}`,
    query: { ...params },
    body: {},
    headers: {
      host: 'tracefab.test',
      'user-agent': 'tracefab-p0-route-auth-coverage',
      'x-forwarded-for': `198.18.${Math.floor(serial / 250)}.${(serial % 250) + 1}`,
    },
    socket: { remoteAddress: `198.18.${Math.floor(serial / 250)}.${(serial % 250) + 1}` },
    on() {}, once() {}, removeListener() {},
  };
}

function makeResponse() {
  const headers = {};
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    body: undefined,
    setHeader(name, value) { headers[String(name).toLowerCase()] = value; return res; },
    getHeader(name) { return headers[String(name).toLowerCase()]; },
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; res.headersSent = true; res.writableEnded = true; return res; },
    send(body) { res.body = body; res.headersSent = true; res.writableEnded = true; return res; },
    end(body) { if (body !== undefined) res.body = body; res.headersSent = true; res.writableEnded = true; return res; },
  };
  return res;
}

const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
let failures = 0;
let checked = 0;
let denied = 0;
const fail = (message) => { failures += 1; console.error(`  ECHEC ${message}`); };
const ok = (message) => { checked += 1; console.log(`  ok    ${message}`); };

console.log('\n=== TRACEFAB — couverture HTTP des routes authentifiées ===');
console.log(`Routeur : ${registered.length} routes enregistrées`);

for (const route of registered) {
  let source;
  try {
    source = readFileSync(route.file, 'utf8');
  } catch (error) {
    fail(`${route.routeName}: fichier de route illisible (${String(error).split('\n')[0]})`);
    continue;
  }

  // Seules les routes réellement classées TENANT par le garde statique sont
  // incluses : elles doivent invoquer requireClerkUser. Les surfaces PUBLIC,
  // REFERENCE, WEBHOOK et WORKER ont leur propre contrat d'accès.
  if (!/requireClerkUser\s*\(/.test(source)) continue;

  const path = samplePath(route);
  const params = Object.fromEntries(route.params.map((name) => [name, sampleFor(name)]));
  let routeDenied = false;
  let routeHadAllowedMethod = false;

  let mod;
  try {
    mod = await import(route.file);
    if (typeof mod.default !== 'function') throw new Error('export default absent ou non appelable');
  } catch (error) {
    fail(`${route.routeName}: import du gestionnaire impossible: ${String(error?.message || error).split('\n')[0]}`);
    continue;
  }

  for (const method of methods) {
    const req = makeRequest(method, path, params, ++checked);
    const res = makeResponse();
    let thrown = null;
    try {
      await mod.default(req, res);
    } catch (error) {
      thrown = error;
    }

    if (thrown) {
      if (thrown instanceof Error && (thrown.name === 'UnauthorizedError' || thrown.message === 'unauthorized')) {
        routeDenied = true;
        denied += 1;
        continue;
      }
      fail(`${route.routeName} ${method}: exception inattendue avant refus d'authentification: ${String(thrown?.message || thrown).split('\n')[0]}`);
      continue;
    }

    const status = Number(res.statusCode);
    if (status === 401 || status === 403) {
      routeDenied = true;
      denied += 1;
      continue;
    }
    if (status === 405) continue;
    routeHadAllowedMethod = true;
    if (status >= 200 && status < 300) {
      fail(`${route.routeName} ${method}: réponse ${status} sans jeton Clerk`);
    } else if (status >= 500) {
      fail(`${route.routeName} ${method}: réponse ${status}; l'authentification n'a pas échoué proprement`);
    } else {
      fail(`${route.routeName} ${method}: statut ${status} au lieu de 401/403 (auth) ou 405 (méthode)`);
    }
  }

  if (!routeDenied) {
    fail(`${route.routeName}: aucune méthode n'a explicitement refusé la requête sans authentification`);
  } else if (!routeHadAllowedMethod) {
    ok(`${route.routeName}: refus d'accès anonyme explicite (méthodes testées)`);
  } else {
    ok(`${route.routeName}: les méthodes acceptées refusent l'accès anonyme`);
  }
}

console.log('------------------------------------------------------------');
console.log(`Refus d'authentification observés : ${denied}`);
console.log(`Échecs : ${failures}`);
console.log(failures === 0
  ? 'Couverture HTTP des routes authentifiées : OK.'
  : 'Couverture HTTP des routes authentifiées : ECHEC.');
if (failures > 0) process.exit(1);
