#!/usr/bin/env node
/**
 * P10.7 — LA SONDE D'IDENTITE RUNTIME EST-ELLE OUVERTE LA OU ELLE DOIT L'ETRE ?
 *
 * POURQUOI CE TEST EXISTE
 *
 * `runtimeProbeAuthorized` decide si `GET /api/internal/p2/readiness?identity=1`
 * accepte un appelant sans secret worker. C'est la porte d'entree de TOUTES les
 * preuves runtime de P10.7 : identite signee, cle HMAC chargee, anti-usurpation,
 * identite PostgreSQL effective. Si elle est fermee sur le deploiement a
 * prouver, les quatre preuves sont inobtenables — et rien ne le signale, parce
 * qu'un 401 ressemble a « pas autorise » et non a « mal configure ».
 *
 * C'est exactement ce qui s'est produit. La fonction comparait la branche a une
 * CONSTANTE, `fix/tracefab-p11-identity-runtime-20261109`, morte depuis la
 * fusion de la PR #118. Mesure du 2026-11-13 : sur la branche de la PR #121, la
 * sonde rendait `401`, et aucune preuve runtime du candidat n'etait possible.
 *
 * Le defaut a survecu parce qu'AUCUN test ne couvrait cette fonction. Ce fichier
 * ferme cette porte : il mesure la decision, branche par branche, et il echoue
 * si la liste ne contient plus la branche de la PR.
 *
 * CE QU'IL NE FAIT PAS : il n'appelle aucun reseau, ne lit aucun secret, ne
 * modifie aucune variable d'environnement globale. Il construit une requete
 * factice et appelle la fonction.
 *
 * UTILISATION
 *   node scripts/test_p107_sonde_runtime_porte.mjs
 */
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

let echecs = 0;
let assertions = 0;
const ok = (cond, libelle, detail = '') => {
  assertions += 1;
  if (!cond) echecs += 1;
  console.log(`  ${cond ? 'ok   ' : 'ECHEC'} ${libelle}${detail ? ` — ${detail}` : ''}`);
};

// Le module est en TypeScript ; le depot est compile en .js a cote dans
// `node_modules/.tmp` ou via `tsx`. On tente le .js compile, puis le .ts via tsx.
const CHEMINS = [
  '../api/_lib/worker-auth.js',
  '../api/_lib/worker-auth.ts',
];
let module = null;
let charge = null;
for (const rel of CHEMINS) {
  const url = new URL(rel, import.meta.url);
  if (!existsSync(url)) continue;
  try {
    module = await import(url.href);
    charge = rel;
    break;
  } catch (e) {
    if (rel.endsWith('.ts')) {
      // tsx n'est pas forcement le chargeur courant : on le signale sans mentir.
      console.log(`  info  ${rel} non importable par Node seul : ${String(e.message).split('\n')[0]}`);
    }
  }
}
if (!module) {
  console.log('  NON EXECUTE — worker-auth introuvable en .js comme en .ts.');
  console.log('  (ce test exige une compilation prealable : npm run build)');
  process.exit(2);
}
console.log(`  module charge : ${charge}\n`);

const { runtimeProbeAuthorized, BRANCHES_SONDE_RUNTIME } = module;

// --- La liste doit nommer la branche de la PR #121 -------------------------
ok(Array.isArray(BRANCHES_SONDE_RUNTIME) && BRANCHES_SONDE_RUNTIME.length > 0,
  'la liste des branches autorisees est publiee et non vide',
  Array.isArray(BRANCHES_SONDE_RUNTIME) ? BRANCHES_SONDE_RUNTIME.join(', ') : typeof BRANCHES_SONDE_RUNTIME);
ok(Object.isFrozen(BRANCHES_SONDE_RUNTIME),
  'la liste est GELEE — un import ne peut pas y ajouter une branche a l execution');
ok(BRANCHES_SONDE_RUNTIME.includes('release/p107-runtime-production-20261110'),
  'la branche de la PR #121 est autorisee — sans elle, aucune preuve runtime du candidat');

// --- La decision, branche par branche -------------------------------------
const JETON = 'jeton_de_sonde_factice_pour_le_test';
const req = (entetes = { 'x-tracefab-runtime-probe-token': JETON }) => ({ headers: entetes, query: {} });

function avecEnv(vars, fn) {
  const avant = {};
  for (const [k, v] of Object.entries(vars)) {
    avant[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(avant)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const ouvert = (env, r = req()) => avecEnv(
  { TRACEFAB_RUNTIME_PROBE_TOKEN: JETON, ...env }, () => runtimeProbeAuthorized(r),
);

// 1. Preview + branche de la PR + bon jeton  -> OUVERT
ok(ouvert({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'release/p107-runtime-production-20261110' }) === true,
  'Preview sur la branche de la PR, jeton correct — la porte s ouvre');

// 2. Production + meme branche + bon jeton   -> FERME (la garde ne peut qu'ajouter)
ok(ouvert({ VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'release/p107-runtime-production-20261110' }) === false,
  'PRODUCTION, meme branche et jeton correct — la porte reste FERMEE');

// 3. Developpement                           -> FERME
ok(ouvert({ VERCEL_ENV: 'development', VERCEL_GIT_COMMIT_REF: 'release/p107-runtime-production-20261110' }) === false,
  'developpement local — la porte reste FERMEE');

// 4. Preview sur une branche NON citee        -> FERME
ok(ouvert({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'une/autre-branche' }) === false,
  'Preview sur une branche non citee — refus');

// 5. Branche absente                          -> FERME
ok(ouvert({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: undefined }) === false,
  'VERCEL_GIT_COMMIT_REF absente — refus, aucun joker');

// 6. Jeton absent                             -> FERME
ok(ouvert({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'release/p107-runtime-production-20261110' },
  req({})) === false,
  'aucun jeton presente — refus');

// 7. Mauvais jeton                            -> FERME
ok(ouvert({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'release/p107-runtime-production-20261110' },
  req({ 'x-tracefab-runtime-probe-token': 'mauvais_jeton' })) === false,
  'jeton incorrect — refus');

// 8. Jeton de longueur differente             -> FERME (comparaison a temps constant)
ok(ouvert({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'release/p107-runtime-production-20261110' },
  req({ 'x-tracefab-runtime-probe-token': `${JETON}x` })) === false,
  'jeton plus long — refus sans exception de longueur');

// 9. Jeton via la query string
ok(ouvert({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'release/p107-runtime-production-20261110' },
  { headers: {}, query: { runtimeProbeToken: JETON } }) === true,
  'jeton en query string — accepte (chemin alternatif documente)');

// 10. Secret de sonde non configure           -> FERME
ok(avecEnv({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'release/p107-runtime-production-20261110', TRACEFAB_RUNTIME_PROBE_TOKEN: undefined },
  () => runtimeProbeAuthorized(req())) === false,
  'TRACEFAB_RUNTIME_PROBE_TOKEN absente — refus, aucun jeton ne peut correspondre');

// 11. La branche historique reste ouverte (compatibilite d'un deploiement en ligne)
ok(ouvert({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'fix/tracefab-p11-identity-runtime-20261109' }) === true,
  'branche historique toujours autorisee — aucun deploiement en ligne casse');

// 12. Le prefixe ne suffit pas (pas de joker par prefixe)
ok(ouvert({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'release/p107-runtime-production-20261110-evil' }) === false,
  'prefixe de la branche autorisee mais nom different — refus (pas de joker)');

console.log('');
if (echecs === 0) {
  console.log(`  P10.7 sonde runtime, porte d acces : ${assertions} assertions — la porte s ouvre ou il faut, et la Production reste fermee.`);
  process.exit(0);
}
console.log(`  ${echecs} ECHEC sur ${assertions} assertions.`);
process.exit(1);
