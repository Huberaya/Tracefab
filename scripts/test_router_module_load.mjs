#!/usr/bin/env node
/**
 * Chargement des modules de route — le test de non-regression de l incident.
 *
 * CE QUI S EST PASSE EN PRODUCTION LE 2026-10-12
 *
 * `https://tracefab.vercel.app/` a repondu :
 *
 *     {"error":"internal_error","correlationId":"c3696f22-..."}
 *
 * La forme de cette reponse ne peut venir que d un seul endroit du depot :
 * la barriere d erreur centrale de `api/index.ts`. Elle se declenche dans
 * deux cas seulement — une exception hors du try/catch d un gestionnaire, ou
 * l echec du CHARGEMENT DYNAMIQUE du module de route. Un client Prisma non
 * initialise produit le second, et il a ete reproduit : le module de route
 * importe `api/_lib/prisma.ts`, qui construit le client au chargement, et ce
 * chargement echoue AVANT que le try/catch de la route ne prenne la main.
 *
 * C est pourquoi `/api/health` ne repondait pas `database_unavailable` : son
 * `catch` autour de `SELECT 1` n etait jamais atteint.
 *
 * CE QUE CE TEST VERIFIE
 *
 *   1. les 125 modules de route s importent tous — c est le mode de
 *      defaillance exact de l incident ;
 *   2. le routeur lui-meme repond correctement pour une route sans base
 *      (200) et pour une route inconnue (404), sans identifiant de
 *      correlation : ces deux reponses prouvent que le routeur fonctionne et
 *      qu une reponse corrélée signale bien un echec de chargement.
 *
 * Il ne se connecte a aucune base : construire un client Prisma n ouvre pas
 * de connexion, et aucune requete n est emise.
 *
 * S execute sous tsx (les modules de route sont en TypeScript) :
 *     npm run test:router-load
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let echecs = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const ko = (m) => { echecs += 1; console.log(`  ECHEC ${m}`); };

function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// 1. Tous les modules de route s importent-ils ?
// ---------------------------------------------------------------------------
const routeFiles = collect(join(ROOT, 'api', '_routes'));
const failures = [];

for (const file of routeFiles) {
  const label = relative(ROOT, file);
  try {
    const module = await import(file);
    if (typeof module.default !== 'function') failures.push([label, 'export par defaut absent ou non appelable']);
  } catch (error) {
    const message = String(error?.message || error).split('\n')[0];
    failures.push([label, `${error?.constructor?.name || 'Error'}: ${message}`]);
  }
}

if (failures.length === 0) {
  ok(`${routeFiles.length} modules de route charges, export par defaut appelable pour chacun`);
} else {
  const prismaRelated = failures.filter(([, why]) => /prisma|initialize/i.test(why)).length;
  ko(`${failures.length} module(s) de route sur ${routeFiles.length} ne se chargent pas`);
  for (const [label, why] of failures.slice(0, 8)) console.log(`          ${label} -> ${why}`);
  if (failures.length > 8) console.log(`          … et ${failures.length - 8} autre(s)`);
  if (prismaRelated > 0) {
    console.error('\n  Diagnostic : le client Prisma n est pas genere.');
    console.error('  En production, chacune de ces routes repond internal_error avec un');
    console.error('  identifiant de correlation — exactement l incident du 2026-10-12.');
    console.error('  Correctif : npm run db:generate (ou npm ci, qui le fait desormais).\n');
  }
}

// ---------------------------------------------------------------------------
// 2. Le routeur repond-il correctement, sans identifiant de correlation ?
// ---------------------------------------------------------------------------
function fakeRequest(query, url = '/api/') {
  return { method: 'GET', url, headers: {}, query };
}

function fakeResponse() {
  const headers = {};
  const res = {
    statusCode: 200, headersSent: false, writableEnded: false, body: undefined,
    setHeader(k, v) { headers[k.toLowerCase()] = v; return res; },
    getHeader(k) { return headers[k.toLowerCase()]; },
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; res.writableEnded = true; return res; },
    send(payload) { res.body = payload; res.writableEnded = true; return res; },
    end(payload) { if (payload !== undefined) res.body = payload; res.writableEnded = true; return res; },
  };
  return res;
}

let routerHandler = null;
try {
  ({ default: routerHandler } = await import(join(ROOT, 'api', 'index.ts')));
} catch (error) {
  ko(`api/index.ts ne se charge pas : ${String(error?.message || error).split('\n')[0]}`);
}

if (routerHandler) {
  const probes = [
    ['catalog/schemas', 200, 'route sans base de donnees'],
    ['does-not-exist-at-all', 404, 'route inconnue'],
  ];
  for (const [path, expected, label] of probes) {
    const res = fakeResponse();
    try {
      await routerHandler(fakeRequest({ path }, `/api/${path}`), res);
    } catch (error) {
      ko(`${path} a jete hors du routeur : ${String(error?.message || error).split('\n')[0]}`);
      continue;
    }
    const correlated = res.body && typeof res.body === 'object' && 'correlationId' in res.body;
    if (correlated) {
      ko(`${path} (${label}) a repondu AVEC identifiant de correlation : echec de chargement de module`);
    } else if (res.statusCode === expected) {
      ok(`${path} -> ${res.statusCode} (${label}), sans identifiant de correlation`);
    } else {
      ko(`${path} -> ${res.statusCode}, attendu ${expected} (${label})`);
    }
  }
}

console.log('\n  --------------------------------------------');
console.log(`  ${echecs === 0 ? 'Chargement des routes : OK.' : `Chargement des routes : ${echecs} probleme(s).`}`);
console.log('  --------------------------------------------\n');
if (echecs > 0) process.exit(1);
