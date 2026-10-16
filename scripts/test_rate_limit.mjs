/**
 * Tests du limiteur de debit — classification, budgets et politique de panne.
 *
 * Ce que ce fichier veut DEMONTRER, point par point du chantier 1A-D :
 *   1. un en-tete Authorization non vide ne reclasse pas la requete ;
 *   2. un faux jeton n'ouvre jamais un budget plus permissif ;
 *   3. les routes anonymes de demande d'accès gardent leur budget restrictif ;
 *   4. les routes Wallet gardent leur budget de cout, meme avec faux jeton ;
 *   5-6. la panne du compteur partage a un comportement PAR CLASSE,
 *        explicite et refuse pour les classes sensibles ;
 *   7. chaque cas est couvert : anonyme, authentifie verifie, faux jeton,
 *      panne du compteur.
 *
 * Sans base et sans reseau : la verification de jeton est injectee, le
 * compteur partage est injecte. Ce qui est teste ici, c'est la POLICE, pas
 * la disponibilite de Clerk ou de PostgreSQL.
 */
import assert from 'node:assert/strict';
import {
  budgetFor,
  classify,
  evaluate,
  resetMemory,
  resetDatabaseBackoff,
  setCredentialVerifier,
  setDatabaseCounter,
  failOpenWhenCounterUnavailable,
  presentedToken,
  credentialIsVerified,
} from '../api/_lib/rate-limit.ts';

// Sel d'empreinte : sans lui (aucun secret en environnement), l'etage base
// est inutilisable par conception — la table ne doit pas contenir d'adresse
// en clair — et les classes sensibles basculent en fail-closed. Le test vise
// la POLICE, pas la derivation du sel.
process.env.TRACEFAB_RATE_LIMIT_SALT = 'sel-de-test-1a';

let echecs = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const ko = (m) => { console.log(`  ECHEC ${m}`); echecs += 1; };

function req({ method = 'GET', headers = {} } = {}) {
  return {
    method,
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    socket: { remoteAddress: '203.0.113.7' },
    url: '/api/test',
    query: {},
  };
}

const JETON_VALIDE = 'jwt.valide.test';
const JETON_FAUX = 'jwt.faux.test';

// Compteur partage de reference : incremente, ou panne selon le mode.
let compteurMode = 'ok';
let compteurHits = 0;
setDatabaseCounter(async () => {
  if (compteurMode === 'panne') return null;
  compteurHits += 1;
  return compteurHits;
});

// Verificateur de jetons de reference : seul JETON_VALIDE passe.
setCredentialVerifier(async (token) => token === JETON_VALIDE);

/* ------------------------------------------------- 1. classification pure */

console.log('\n  A. un en-tete ne reclasse pas une requete');

resetMemory();
assert.equal(classify('dpp/3760123456789', req()), 'public-read');
assert.equal(classify('passport/abc/request-access', req({ method: 'POST' })), 'public-write');
assert.equal(classify('products/p1/wallet/apple', req()), 'wallet');
assert.equal(classify('dpp/3760123456789/apple-wallet', req()), 'wallet');

// Avec un faux jeton : meme classe qu'en anonyme.
const reqFaux = req({ method: 'POST', headers: { Authorization: 'Bearer ' + JETON_FAUX } });
assert.equal(classify('passport/abc/request-access', reqFaux), 'public-write');
assert.equal(classify('products/p1/wallet/google', reqFaux), 'wallet');
assert.equal(classify('dpp/3760123456789/google-wallet', reqFaux), 'wallet');
const reqFauxGet = req({ method: 'GET', headers: { Authorization: 'Bearer ' + JETON_FAUX } });
assert.equal(classify('dpp/3760123456789', reqFauxGet), 'public-read');
ok('en-tete Authorization present, faux ou non : la classe suit la route');

// Authentification VERIFIEE seule reclasse.
assert.equal(classify('products', req(), true), 'credentialed');
assert.equal(classify('products', req(), false), 'public-read');
ok('seule une authentification verifiee reclasse en credentialed');

assert.equal(classify('health', req()), 'exempt');
assert.equal(classify('internal/notification-outbox/run', req({ method: 'POST' })), 'exempt');
ok('les dispenses existantes sont preservees');

/* ------------------------------------------------- 2. budgets par classe */

console.log('\n  B. aucun budget permissif obtenu par simple en-tete');

const budgetAnonyme = budgetFor('public-write');
const budgetWallet = budgetFor('wallet');
const budgetCred = budgetFor('credentialed');
assert.equal(budgetAnonyme.limit, 10);
assert.equal(budgetAnonyme.windowSeconds, 300);
assert.equal(budgetWallet.limit, 20);
assert.ok(budgetCred.limit > budgetAnonyme.limit);
ok(`budgets : ecriture anonyme ${budgetAnonyme.limit}/${budgetAnonyme.windowSeconds}s, wallet ${budgetWallet.limit}/${budgetWallet.windowSeconds}s, credentialed ${budgetCred.limit}/${budgetCred.windowSeconds}s`);

// Le budget reellement applique suit la classe : un faux jeton sur
// request-access reste dans les 10/300s.
resetMemory(); compteurHits = 0; compteurMode = 'ok';
for (let i = 0; i < 10; i += 1) {
  const d = await evaluate('passport/abc/request-access', reqFaux);
  assert.equal(d.allowed, true, `requete ${i + 1} devrait passer`);
}
const refus = await evaluate('passport/abc/request-access', reqFaux);
assert.equal(refus.allowed, false);
assert.equal(refus.klass, 'public-write');
assert.equal(refus.reason, 'over_budget');
assert.equal(refus.limit, 10);
ok('10 ecritures anonymes avec faux jeton, puis refus : le budget restrictif tient');

// Meme preuve sur une route Wallet.
resetMemory(); compteurHits = 0;
for (let i = 0; i < 20; i += 1) {
  const d = await evaluate('products/p1/wallet/apple', reqFaux);
  assert.equal(d.allowed, true);
}
const refusWallet = await evaluate('products/p1/wallet/apple', reqFaux);
assert.equal(refusWallet.allowed, false);
assert.equal(refusWallet.klass, 'wallet');
assert.equal(refusWallet.limit, 20);
ok('20 generations Wallet avec faux jeton, puis refus : le budget de cout tient');

/* ------------------------------------------------- 3. jeton verifie */

console.log('\n  C. authentification verifiee et verification de jeton');

resetMemory(); compteurHits = 0;
const reqValide = req({ headers: { Authorization: 'Bearer ' + JETON_VALIDE } });
const dValide = await evaluate('products', reqValide);
assert.equal(dValide.klass, 'credentialed');
assert.equal(dValide.allowed, true);
assert.equal(dValide.limit, budgetCred.limit);
ok('jeton verifie : budget credentialed');

const dFaux = await evaluate('products', reqFauxGet);
assert.equal(dFaux.klass, 'public-read');
ok('jeton faux sur route de lecture : reste dans public-read');

// Cookie de session : meme regle.
resetMemory();
const reqCookie = req({ headers: { Cookie: `__session=${JETON_VALIDE}; other=1` } });
assert.equal(presentedToken(reqCookie), JETON_VALIDE);
const dCookie = await evaluate('products', reqCookie);
assert.equal(dCookie.klass, 'credentialed');
ok('cookie __session verifie : meme traitement que Bearer');

// Sans verificateur (deploiement sans cle Clerk) : rien n'est jamais
// authentifie, meme avec un jeton de la bonne forme.
setCredentialVerifier(null);
process.env.CLERK_SECRET_KEY = '';
assert.equal(await credentialIsVerified(JETON_VALIDE), false);
setCredentialVerifier(async (token) => token === JETON_VALIDE);
ok('sans cle de verification, aucun jeton ne reclasse (sens de securite)');

/* ------------------------------------------------- 4. panne du compteur */

console.log('\n  D. panne du compteur partage : comportement par criticite');

assert.equal(failOpenWhenCounterUnavailable('public-read'), true);
assert.equal(failOpenWhenCounterUnavailable('credentialed'), true);
assert.equal(failOpenWhenCounterUnavailable('public-write'), false);
assert.equal(failOpenWhenCounterUnavailable('wallet'), false);
ok('politique declaree : lectures et authentifies passent, ecritures et Wallet refusent');

compteurMode = 'panne';
resetMemory(); resetDatabaseBackoff();

const panneLecture = await evaluate('dpp/3760123456789', req());
assert.equal(panneLecture.allowed, true, 'lecture publique fail-open');
assert.equal(panneLecture.enforcedBy, 'memoire');
ok('lecture publique pendant la panne : servie par l etage memoire');

const panneCred = await evaluate('products', reqValide);
assert.equal(panneCred.allowed, true);
assert.equal(panneCred.enforcedBy, 'memoire');
ok('utilisateur verifie pendant la panne : servi, freine par la memoire');

const panneEcriture = await evaluate('passport/abc/request-access', req({ method: 'POST' }));
assert.equal(panneEcriture.allowed, false);
assert.equal(panneEcriture.reason, 'counter_unavailable');
ok('ecriture anonyme pendant la panne : refusee en fail-closed (503 attendu)');

const panneWallet = await evaluate('products/p1/wallet/apple', req());
assert.equal(panneWallet.allowed, false);
assert.equal(panneWallet.reason, 'counter_unavailable');
ok('Wallet pendant la panne : refuse en fail-closed (503 attendu)');

// Meme avec un faux jeton : pas de fail-open par en-tete interpose.
const panneEcritureFaux = await evaluate('passport/abc/request-access', req({ method: 'POST', headers: { Authorization: 'Bearer ' + JETON_FAUX } }));
assert.equal(panneEcritureFaux.allowed, false);
assert.equal(panneEcritureFaux.reason, 'counter_unavailable');
ok('faux jeton pendant la panne : toujours refuse');

// L'etage memoire reste actif pendant la panne (fail-open limite).
resetMemory();
for (let i = 0; i < 120; i += 1) await evaluate('dpp/3760123456789', req());
const douzieme = await evaluate('dpp/3760123456789', req());
assert.equal(douzieme.allowed, false);
assert.equal(douzieme.reason, 'over_budget');
ok('fail-open limite : la rafale memoire au-dela du budget reste refusee');

// Retour a la normale.
compteurMode = 'ok'; compteurHits = 0; resetMemory(); resetDatabaseBackoff();
const normal = await evaluate('passport/abc/request-access', req({ method: 'POST' }));
assert.equal(normal.allowed, true);
assert.equal(normal.enforcedBy, 'base');
ok('compteur revenu : la classe ecriture est de nouveau servie');

/* ------------------------------------------------- resultat */

if (echecs) {
  console.log(`\n  ${echecs} echec(s).`);
  process.exit(1);
}
console.log('\n  Aucun budget ne s obtient par simple en-tete. Panne explicite par classe.');
