#!/usr/bin/env node
/**
 * TRACEFAB — le limiteur de débit ne se négocie pas avec un en-tête.
 *
 * LE DÉFAUT QUE CE TEST INTERDIT
 *   `classify()` commençait par « la requête porte-t-elle un en-tête
 *   Authorization non vide ? → classe `credentialed` », AVANT de regarder le
 *   chemin. Rien n'était vérifié : la présence suffisait.
 *
 *   Un client qui ajoutait `Authorization: x` à un appel vers une route Wallet
 *   passait du budget `wallet` (20 / 60 s) au budget `credentialed` (600 / 60 s)
 *   — trente fois plus de signatures cryptographiques pour un seul en-tête. Sur
 *   une écriture anonyme (`public-write`, 10 / 300 s), le même en-tête donnait
 *   600 / 60 s, soit 60 fois le débit dans une fenêtre 5 fois plus courte.
 *
 *   Ce test exécute le VRAI module (api/_lib/rate-limit.ts, chargé par Node en
 *   suppression de types) — pas une réimplémentation. Un test qui recopierait la
 *   logique prouverait sa propre copie.
 *
 *   node --experimental-strip-types scripts/test_rate_limit_abuse.mjs
 *   La section F exige DATABASE_URL ; sans lui elle s'annonce NON EXÉCUTÉE.
 */
import assert from 'node:assert/strict';

process.env.TRACEFAB_RATE_LIMIT_SALT ||= 'sel-de-test-deterministe';

const rl = await import('../api/_lib/rate-limit.ts');
const { classify, budgetFor, degradedBudgetFor, evaluate, resetMemory, resetDatabaseBackoff } = rl;

let checks = 0;
let failures = 0;
const ok = (name) => { checks++; console.log(`  ok    ${name}`); };
const ko = (name, detail) => { failures++; console.error(`  FAIL  ${name}\n        ${detail}`); };

const req = ({ method = 'GET', authorization, cookie } = {}) => ({
  method,
  headers: {
    ...(authorization === undefined ? {} : { authorization }),
    ...(cookie === undefined ? {} : { cookie }),
  },
  socket: { remoteAddress: '203.0.113.7' },
});

/* ------------------------------------------------------------------ A ----- */
console.log('\nA. La classe d’une route ne dépend d’aucun en-tête');

/*
 * Le cœur du correctif. Pour chaque route sensible, la classe doit être
 * IDENTIQUE avec et sans justificatif — y compris un justificatif falsifié.
 */
const ROUTES = [
  ['dpp/0123456789012/apple-wallet', 'GET', 'wallet'],
  ['dpp/0123456789012/google-wallet', 'GET', 'wallet'],
  ['products/abc-123/wallet/apple', 'GET', 'wallet'],
  ['products/abc-123/wallet/google', 'GET', 'wallet'],
  ['passport/tok_abc/request-access', 'POST', 'public-write'],
  ['dpp/0123456789012', 'GET', 'public-read'],
  ['catalog/schemas', 'GET', 'public-read'],
  ['materials', 'GET', 'credentialed'],
  ['suppliers/xyz/documents', 'POST', 'credentialed'],
];

const FORGED = [
  ['aucun justificatif', req],
  ['Authorization: x', (o) => req({ ...o, authorization: 'x' })],
  ['Authorization: Bearer faux', (o) => req({ ...o, authorization: 'Bearer faux.jeton.signe' })],
  ['Cookie __session faux', (o) => req({ ...o, cookie: '__session=faux; autre=1' })],
  ['les trois à la fois', (o) => req({ ...o, authorization: 'Bearer faux', cookie: '__session=faux' })],
];

for (const [path, method, expected] of ROUTES) {
  const classes = FORGED.map(([label, build]) => [label, classify(path, build({ method }))]);
  const distinct = [...new Set(classes.map(([, c]) => c))];
  if (distinct.length === 1 && distinct[0] === expected) {
    ok(`${method} ${path} → ${expected}, quel que soit le justificatif`);
  } else {
    ko(`${method} ${path} doit rester ${expected} quel que soit l’en-tête`,
      classes.map(([l, c]) => `${l}=${c}`).join(' · '));
  }
}

/* ------------------------------------------------------------------ B ----- */
console.log('\nB. Le gain d’un faux jeton est nul, mesuré en requêtes');

for (const [path, method, expected] of ROUTES) {
  const nu = budgetFor(classify(path, req({ method })));
  const faux = budgetFor(classify(path, req({ method, authorization: 'Bearer faux.jeton.signe' })));
  if (nu.limit === faux.limit && nu.windowSeconds === faux.windowSeconds) {
    ok(`${path} : ${nu.limit}/${nu.windowSeconds}s avec ou sans faux jeton`);
  } else {
    ko(`${path} : un faux jeton modifie le budget`,
      `${nu.limit}/${nu.windowSeconds}s → ${faux.limit}/${faux.windowSeconds}s`);
  }
}

/* Le chiffre qui a motivé le correctif, épinglé pour qu'il ne revienne pas. */
const wallet = budgetFor('wallet');
const cred = budgetFor('credentialed');
if (cred.limit > wallet.limit) {
  const classe = classify('dpp/x/apple-wallet', req({ authorization: 'Bearer faux' }));
  if (classe === 'wallet') {
    ok(`une route Wallet ne peut plus obtenir le budget credentialed (${wallet.limit} au lieu de ${cred.limit})`);
  } else {
    ko('une route Wallet obtient encore le budget credentialed avec un faux jeton', `classe = ${classe}`);
  }
}

/* ------------------------------------------------------------------ C ----- */
console.log('\nC. Les écritures anonymes gardent leur budget restrictif');

const ecriture = budgetFor(classify('passport/tok/request-access', req({ method: 'POST', authorization: 'Bearer faux' })));
const nominal = budgetFor('public-write');
if (ecriture.limit === nominal.limit && ecriture.windowSeconds === nominal.windowSeconds) {
  ok(`demande d’accès anonyme : ${ecriture.limit}/${ecriture.windowSeconds}s même avec un faux jeton`);
} else {
  ko('la demande d’accès anonyme a obtenu un budget plus large',
    `${ecriture.limit}/${ecriture.windowSeconds}s au lieu de ${nominal.limit}/${nominal.windowSeconds}s`);
}

/* Une route non déclarée retombe sur le modèle le plus contraint, pas le plus large. */
const inconnue = classify('route/jamais/declarée', req({ authorization: 'Bearer faux' }));
if (inconnue === 'credentialed') {
  ok('une route non déclarée n’est pas traitée comme publique');
} else {
  ko('une route non déclarée obtient une classe inattendue', inconnue);
}

/* Les dispenses ne sont plus accordées par préfixe. */
const internalInconnu = classify('internal/chemin/non/declaro', req());
if (internalInconnu !== 'exempt') {
  ok('un chemin internal/ non déclaré n’est plus dispensé de plafond');
} else {
  ko('internal/ dispense encore tout ce qui commence par ce préfixe', internalInconnu);
}

/* ------------------------------------------------------------------ D ----- */
console.log('\nD. Panne du compteur : la dégradation dépend de la criticité');

for (const classe of ['wallet', 'public-write', 'public-read', 'credentialed']) {
  const nominalC = budgetFor(classe);
  const degrade = degradedBudgetFor(classe);
  const sensible = classe === 'wallet' || classe === 'public-write';
  if (sensible) {
    if (degrade.limit < nominalC.limit && degrade.limit >= 1 && degrade.windowSeconds === nominalC.windowSeconds) {
      ok(`${classe} : budget dégradé ${degrade.limit}/${degrade.windowSeconds}s (nominal ${nominalC.limit})`);
    } else {
      ko(`${classe} doit être réduit quand la base est indisponible`,
        `${degrade.limit}/${degrade.windowSeconds}s pour un nominal de ${nominalC.limit}`);
    }
  } else if (degrade.limit === nominalC.limit && degrade.windowSeconds === nominalC.windowSeconds) {
    ok(`${classe} : nominal conservé en mode dégradé (la disponibilité prime)`);
  } else {
    ko(`${classe} ne doit pas être dégradé`, `${degrade.limit} au lieu de ${nominalC.limit}`);
  }
}

/* ------------------------------------------------------------------ E ----- */
console.log('\nE. En panne de base, l’étage mémoire décide — il ne laisse pas tout passer');

/*
 * Sans DATABASE_URL, touchDatabase renvoie null : c'est exactement la panne.
 * Avant le correctif, evaluate renvoyait alors `allowed: true` sans condition.
 */
delete process.env.DATABASE_URL;
resetDatabaseBackoff();

for (const [path, method, expected] of ROUTES.filter(([p]) => p.includes('wallet'))) {
  resetMemory();
  const limite = degradedBudgetFor(classify(path, req({ method }))).limit;
  let premierRefus = null;
  let derniereDecision = null;
  for (let i = 1; i <= limite + 3; i += 1) {
    derniereDecision = await evaluate(path, req({ method, authorization: 'Bearer faux' }));
    if (!derniereDecision.allowed && premierRefus === null) premierRefus = i;
  }
  if (premierRefus === limite + 1) {
    ok(`${path} : refus dès la ${premierRefus}ᵉ requête en panne de base (limite dégradée ${limite})`);
  } else {
    ko(`${path} : le refus en panne de base n’arrive pas au bon moment`,
      `premier refus à ${premierRefus}, attendu ${limite + 1}`);
  }
  if (derniereDecision && derniereDecision.enforcedBy === 'memoire-degrade') {
    ok(`${path} : la décision se déclare « memoire-degrade », pas un succès ordinaire`);
  } else {
    ko(`${path} : enforcedBy n’annonce pas la dégradation`,
      String(derniereDecision && derniereDecision.enforcedBy));
  }
  break; // un cas suffit : les autres routes Wallet partagent la classe
}

/* Une lecture publique ne doit PAS être coupée par la panne de base. */
resetMemory();
const lectureLimite = budgetFor('public-read').limit;
let lectureRefusee = false;
for (let i = 0; i < Math.min(lectureLimite, 20); i += 1) {
  const d = await evaluate('dpp/0123456789012', req());
  if (!d.allowed) lectureRefusee = true;
}
if (!lectureRefusee) {
  ok(`une lecture publique reste servie en panne de base (${Math.min(lectureLimite, 20)} requêtes acceptées)`);
} else {
  ko('une lecture publique a été refusée pendant la panne de base',
    'la dégradation ne doit toucher que wallet et public-write');
}

/* ------------------------------------------------------------------ F ----- */
console.log('\nF. L’étage base : incrémentation atomique partagée');

if (!process.env.TRACEFAB_DATABASE_URL_PROBE) {
  console.log('  NON EXECUTE — DATABASE_URL absent : l’incrémentation atomique de');
  console.log('  rate_limit_counters n’a pas été mesurée dans cet environnement.');
} else {
  const pg = (await import('pg')).default;
  const c = new pg.Client({ connectionString: process.env.TRACEFAB_DATABASE_URL_PROBE });
  await c.connect();
  const cle = `probe-${Date.now()}`;
  const debut = new Date(Math.floor(Date.now() / 60000) * 60000);
  const fin = new Date(debut.getTime() + 120000);
  const increment = () => c.query(
    `INSERT INTO rate_limit_counters (bucket_key, window_start, hits, expires_at)
     VALUES ($1, $2, 1, $3)
     ON CONFLICT (bucket_key, window_start) DO UPDATE SET hits = rate_limit_counters.hits + 1
     RETURNING hits`,
    [cle, debut, fin],
  );
  /* Dix incréments concurrents : s'ils lisaient la même valeur, on verrait des
     doublons. La contrainte d'unicité et RETURNING rendent cela impossible. */
  const valeurs = (await Promise.all(Array.from({ length: 10 }, increment))).map((r) => r.rows[0].hits);
  const uniques = new Set(valeurs);
  if (uniques.size === 10 && Math.max(...valeurs) === 10) {
    ok(`10 incréments concurrents → 10 valeurs distinctes (1..${Math.max(...valeurs)})`);
  } else {
    ko('l’incrémentation atomique rend des valeurs en double', valeurs.join(','));
  }
  await c.query('DELETE FROM rate_limit_counters WHERE bucket_key = $1', [cle]);
  await c.end();
}

/* ------------------------------------------------------------------------ */
console.log(`\n${'='.repeat(64)}`);
if (failures) {
  console.error(`test:rate-limit:abuse FAILED — ${failures} échec(s), ${checks} contrôle(s) réussi(s).`);
  process.exit(1);
}
console.log(`test:rate-limit:abuse passed — ${checks} contrôles, 0 échec.`);
