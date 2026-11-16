#!/usr/bin/env node
/**
 * Non-regression : le script de preuve ne conclut jamais sur une cible qu'il
 * n'a pas atteinte, et il distingue trois situations qui ne doivent jamais
 * etre confondues.
 *
 * POURQUOI CE TEST EXISTE — deux defauts reels, pas des hypotheses
 * -----------------------------------------------------------------
 * 1. Le run du SHA a7f34aa a publie une preuve disant « BYPASS is not defined ».
 *    Le script avait raison de refuser de conclure, mais une ReferenceError
 *    ressemblait a un diagnostic valide.
 * 2. La premiere version de CE test dependait du DNS : elle joignait un faux
 *    hote `.vercel.app`. Il passait en local et echouait en CI, parce que le
 *    runner resout le wildcard Vercel et pas l'environnement d'analyse. Un test
 *    hors ligne qui depend du reseau n'est pas un test hors ligne.
 *
 * Le test injecte donc une doublure (scripts/doublure_vercel_p107.mjs) et
 * n'emet AUCUNE requete.
 *
 * Les trois situations viennent de mesures :
 *   sso302 -> la Preview repond 302 vers vercel.com/sso-api (releve du 2026-11-16)
 *   app401 -> l'application refuse une requete sans jeton (contrat de la route)
 *   app200 -> application joignable et jeton accepte (chemin nominal)
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const racine = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(racine, 'scripts', 'preuve_runtime_p107.mjs');
const doublure = path.join(racine, 'scripts', 'doublure_vercel_p107.mjs');

let echecs = 0;
const verifier = (condition, nom, detail = '') => {
  if (condition) console.log(`  ok    ${nom}`);
  else { console.log(`  ECHEC ${nom}${detail ? ` — ${detail}` : ''}`); echecs += 1; }
};

/** Lance le script contre la doublure et rend { code, sortie, preuve }. */
const executer = (scenario, env = {}) => new Promise((resolve) => {
  const travail = mkdtempSync(path.join(tmpdir(), 'p107-'));
  const enfant = spawn(process.execPath, [script], {
    cwd: travail,
    env: {
      ...process.env,
      TF_BASE: 'https://preuve-test.vercel.app',
      TF_PREUVE_FETCH_INJECTE: doublure,
      TF_DOUBLURE_SCENARIO: scenario,
      // Aucun jeton par defaut : le chemin « sans jeton » doit etre celui teste.
      TRACEFAB_RUNTIME_PROBE_TOKEN: '',
      VERCEL_AUTOMATION_BYPASS_SECRET: '',
      ...env,
    },
  });
  let sortie = '';
  const capturer = (d) => { sortie += d; };
  enfant.stdout.on('data', capturer);
  enfant.stderr.on('data', capturer);
  enfant.on('close', (code) => {
    let preuve = '';
    try {
      preuve = readFileSync(
        path.join(travail, 'livrables-finalisation', 'preuves', 'p107-runtime-preuves.json'), 'utf8');
    } catch { /* aucune preuve ecrite */ }
    resolve({ code, sortie, preuve });
  });
});

console.log('Script de preuve — bout en bout, hors ligne');

// --- 1. Preview derriere Vercel Authentication ------------------------------
// C'est LE cas du 2026-11-16. Il doit donner un ACCES ABSENT (code 3), jamais
// un echec de C3 : la requete n'atteint pas l'application.
const sso = await executer('sso302');
verifier(sso.code === 3, 'un 302 SSO donne le code « acces absent » (3)', `code ${sso.code}`);
verifier(/INDETERMINE/.test(sso.sortie) || /INACCESSIBLE/.test(sso.preuve),
  'le resultat est nomme indetermine/inaccessible');
verifier(!/"resultats": \[\s*\{\s*"id": "C3\.1"/.test(sso.preuve),
  'aucun verdict C3.1 n est rendu alors que la requete n a pas atteint l application');
verifier(/x-vercel-protection-bypass/.test(sso.preuve + sso.sortie),
  'la voie officielle de contournement est nommee pour l humain');

// --- 2. Application joignable, refus sans jeton -----------------------------
// Ici la requete ATTEINT l'application : le refus est legitime et doit produire
// un verdict C3, pas un indetermine.
const refus = await executer('app401');
verifier(refus.code !== 3, 'un refus applicatif n est pas classe « acces absent »', `code ${refus.code}`);
verifier(/"id": "C3\.1"/.test(refus.preuve), 'un verdict C3.1 est rendu quand l application repond');
verifier(/"verdict": "PASS"/.test(refus.preuve),
  'le refus sans jeton est un PASS du critere, pas un echec',
  refus.preuve.slice(0, 300));

// --- 3. Aucune exception deguisee en diagnostic ----------------------------
// Le defaut de a7f34aa : une ReferenceError ressemblait a une conclusion.
for (const [nom, r] of [['sso302', sso], ['app401', refus]]) {
  verifier(!/\bis not defined\b/.test(r.preuve + r.sortie),
    `aucune ReferenceError deguisee en diagnostic (${nom})`);
}

// --- 4. Garde de cible : un runtime local n'est pas une preuve --------------
const locale = await executer('app200', { TF_BASE: 'http://127.0.0.1:3000' });
verifier(locale.code !== 0, 'une cible locale est refusee', `code ${locale.code}`);
verifier(/n'est pas une URL de deploiement Vercel|runtime local/i.test(locale.sortie),
  'le refus nomme la raison');

console.log(echecs === 0 ? '  Bout en bout : OK.' : `  Bout en bout : ${echecs} echec(s).`);
process.exit(echecs === 0 ? 0 : 1);
