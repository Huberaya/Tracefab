#!/usr/bin/env npx tsx
/**
 * Classement et budgets du limiteur de debit.
 *
 * POURQUOI CE TEST EXISTE
 *
 * `classify()` interrogeait les justificatifs AVANT le chemin :
 *
 *     if (carriesCredentials(req)) return 'credentialed';
 *     if (/wallet/.test(path))     return 'wallet';
 *
 * et `carriesCredentials` se contentait d'un en-tete Authorization non vide.
 * Deux consequences, toutes deux exploitables sans rien connaitre du systeme :
 *
 *   - `Authorization: Bearer x` sur une ecriture anonyme faisait passer le
 *     budget de 10 par 5 minutes a 600 par minute, soit un facteur 300 ;
 *   - le meme en-tete sur un laissez-passer Wallet le faisait passer de 20 a
 *     600 par minute, alors que la route signe cryptographiquement.
 *
 * Le code assumait ce choix : « la route rejettera de toute facon ». Mais le
 * budget est consomme AVANT la route, et pour une route authentifiee le rejet
 * coute un appel reseau a Clerk. Le limiteur protegeait donc tout sauf ce qui
 * coute cher.
 *
 *   npm run test:rate-limit
 */

import {
  classify, budgetFor, evaluate, resetMemory, resetDatabaseBackoff,
  type RateLimitClass,
} from '../api/_lib/rate-limit.js';
import type { VercelRequest } from '../api/_lib/vercel-types.js';

let echecs = 0;
const ok = (cond: boolean, message: string) => {
  console.log(`  ${cond ? 'ok   ' : 'ECHEC'} ${message}`);
  if (!cond) echecs += 1;
};

/** Requete minimale. `headers` tel qu'un client peut le composer. */
function req(method: string, headers: Record<string, string> = {}): VercelRequest {
  return { method, headers, query: {}, body: undefined } as unknown as VercelRequest;
}

/** Un JWT non signe mais structurellement valide. */
function jwt(charge: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(charge)}.c2lnbmF0dXJl`;
}
const JETON_VALIDE = jwt({ sub: 'user_123', exp: Math.floor(Date.now() / 1000) + 3600 });
const JETON_EXPIRE = jwt({ sub: 'user_123', exp: Math.floor(Date.now() / 1000) - 3600 });

const PUBLIC_DPP = 'dpp/03760123456789';
const WALLET_PUBLIC = 'dpp/03760123456789/apple-wallet';
const WALLET_INTERNE = 'products/abc-123/wallet/google';
const DEMANDE_ACCES = 'passport/jeton-abc/request-access';
const ROUTE_APP = 'products';

console.log('\n  budgets de reference');
const budgets: Record<string, number> = {};
for (const k of ['public-read', 'public-write', 'wallet', 'credentialed'] as RateLimitClass[]) {
  budgets[k] = budgetFor(k).limit;
  const b = budgetFor(k);
  console.log(`    ${k.padEnd(14)} ${String(b.limit).padStart(4)} / ${b.windowSeconds}s`);
}
ok(budgets.credentialed > budgets['public-read'] && budgets['public-read'] > budgets.wallet
  && budgets.wallet > budgets['public-write'],
  'les budgets sont bien ordonnes du plus permissif au plus restrictif');

// --- A. anonyme : la reference ---
console.log('\n  A. requetes anonymes');
ok(classify(PUBLIC_DPP, req('GET')) === 'public-read', 'DPP public en GET -> public-read');
ok(classify(DEMANDE_ACCES, req('POST')) === 'public-write', 'demande d\'acces en POST -> public-write');
ok(classify(WALLET_PUBLIC, req('GET')) === 'wallet', 'laissez-passer public -> wallet');
ok(classify(WALLET_INTERNE, req('GET')) === 'wallet', 'laissez-passer interne -> wallet');
ok(classify('health', req('GET')) === 'exempt', 'health -> exempt');

// --- B. le faux jeton ne doit rien ouvrir ---
console.log('\n  B. faux justificatif (le defaut d\'origine)');
const FAUX = { authorization: 'Bearer x' };
ok(classify(DEMANDE_ACCES, req('POST', FAUX)) === 'public-write',
  `« Bearer x » sur une ecriture anonyme reste public-write (${budgets['public-write']}/5min, pas ${budgets.credentialed}/min)`);
ok(classify(WALLET_PUBLIC, req('GET', FAUX)) === 'wallet',
  '« Bearer x » sur un laissez-passer reste wallet');
ok(classify(WALLET_INTERNE, req('GET', FAUX)) === 'wallet',
  '« Bearer x » sur le laissez-passer interne reste wallet');
ok(classify(ROUTE_APP, req('GET', FAUX)) === 'public-read',
  '« Bearer x » sur une route applicative n\'ouvre pas credentialed');
ok(classify(ROUTE_APP, req('GET', { authorization: 'Bearer ' + 'A'.repeat(400) })) === 'public-read',
  'un jeton long mais informe reste refuse');
ok(classify(ROUTE_APP, req('GET', { cookie: '__session=nimportequoi' })) === 'public-read',
  'un cookie __session informe n\'ouvre pas credentialed');
ok(classify(ROUTE_APP, req('GET', { authorization: `Bearer ${JETON_EXPIRE}` })) === 'public-read',
  'un jeton structurellement valide mais expire n\'ouvre pas credentialed');

// --- C. la route prime, meme avec un jeton plausible ---
console.log('\n  C. la nature de la route prime');
const PLAUSIBLE = { authorization: `Bearer ${JETON_VALIDE}` };
ok(classify(WALLET_PUBLIC, req('GET', PLAUSIBLE)) === 'wallet',
  'un jeton plausible ne reclasse pas un laissez-passer');
ok(classify(DEMANDE_ACCES, req('POST', PLAUSIBLE)) === 'public-write',
  'un jeton plausible ne reclasse pas la demande d\'acces anonyme');
ok(classify(PUBLIC_DPP, req('GET', PLAUSIBLE)) === 'public-read',
  'un jeton plausible ne reclasse pas le DPP public');

// --- D. l'usage legitime reste servi ---
console.log('\n  D. usage authentifie legitime');
ok(classify(ROUTE_APP, req('GET', PLAUSIBLE)) === 'credentialed',
  'une route applicative avec un jeton plausible -> credentialed');
ok(classify(ROUTE_APP, req('GET', { cookie: `__session=${JETON_VALIDE}` })) === 'credentialed',
  'le cookie de session plausible ouvre aussi credentialed');

// --- E. panne du compteur durable ---
console.log('\n  E. panne du compteur durable');
// Sans secret, l'empreinte n'est pas derivable : le code emprunte exactement
// la branche « compteur indisponible ». C'est la panne, reproduite sans base.
const secret = process.env.TRACEFAB_RATE_LIMIT_SECRET;
delete process.env.TRACEFAB_RATE_LIMIT_SECRET;
resetMemory();
resetDatabaseBackoff();
// evaluate(path, req, now) — le troisieme parametre est un horodatage, pas la
// reponse. Lui passer autre chose rend `now` non numerique, la fenetre devient
// NaN, et le compteur memoire repart a 1 a chaque appel : le test passerait en
// croyant mesurer un plafond qui ne s'applique jamais.
const enPanne = async (path: string, method = 'GET', headers = {}) => {
  resetMemory();
  return evaluate(path, req(method, headers));
};
const dWallet = await enPanne(WALLET_PUBLIC);
const dEcriture = await enPanne(DEMANDE_ACCES, 'POST');
const dLecture = await enPanne(PUBLIC_DPP);
const dCred = await enPanne(ROUTE_APP, 'GET', PLAUSIBLE);
ok(dWallet.allowed === false && dWallet.enforcedBy === 'memoire',
  `wallet refuse pendant la panne (allowed=${dWallet.allowed})`);
ok(dEcriture.allowed === false,
  `ecriture anonyme refusee pendant la panne (allowed=${dEcriture.allowed})`);
ok(dLecture.allowed === true,
  `lecture publique toujours servie (allowed=${dLecture.allowed}) — degradation, pas coupure`);
ok(dCred.allowed === true,
  `console authentifiee toujours servie (allowed=${dCred.allowed})`);
if (secret) process.env.TRACEFAB_RATE_LIMIT_SECRET = secret;

// --- F. l'etage memoire plafonne toujours ---
console.log('\n  F. plafond en memoire pendant la panne');
resetMemory();
const limiteLecture = budgetFor('public-read').limit;
let dernier = true;
for (let i = 0; i < limiteLecture + 5; i += 1) {
  dernier = (await evaluate(PUBLIC_DPP, req('GET'))).allowed;
}
ok(dernier === false,
  `apres ${limiteLecture + 5} requetes, la lecture publique finit par etre refusee`);

console.log(echecs
  ? `\n  ${echecs} echec(s).\n`
  : '\n  Aucun budget ne s\'obtient par ajout d\'un en-tete.\n');
process.exit(echecs ? 1 : 0);
