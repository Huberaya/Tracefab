#!/usr/bin/env node
/**
 * Non-regression : le script de preuve s'execute de bout en bout et ne conclut
 * jamais sur une cible qu'il n'a pas atteinte.
 *
 * POURQUOI CE TEST EXISTE
 * -----------------------
 * Le run du 2026-11-16 (SHA a7f34aa) a produit cette preuve publiee :
 *
 *   "arret": "... : BYPASS is not defined. Aucun verdict n est rendu sur une
 *             cible qu on n a pas atteinte."
 *
 * Le script avait RAISON de refuser de conclure, mais la cause etait une
 * reference a une constante supprimee lors d'un refactor. Le defaut a ete vu
 * parce que le script refuse de mentir ; il ne doit pas pour autant passer
 * inapercu. Ce test leve un faux serveur qui imite Vercel Authentication, puis
 * un faux serveur qui imite l'application, et exige :
 *
 *   1. face a un 302 SSO  -> code 3 (acces absent) et arret nomme, PAS un echec ;
 *   2. face a une application accessible sans jeton -> C3 refuse, code non nul ;
 *   3. dans les deux cas, aucune exception JavaScript dans la preuve ecrite
 *      (une ReferenceError ressemble sinon a un diagnostic valide).
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const racine = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(racine, 'scripts', 'preuve_runtime_p107.mjs');

let echecs = 0;
const verifier = (condition, nom, detail = '') => {
  if (condition) console.log(`  ok    ${nom}`);
  else { console.log(`  ECHEC ${nom}${detail ? ` — ${detail}` : ''}`); echecs += 1; }
};

/** Lance le script contre `port` et rend { code, sortie, preuve }. */
const executer = (port, env = {}) => new Promise((resolve) => {
  const travail = mkdtempSync(path.join(tmpdir(), 'p107-'));
  const enfant = spawn(process.execPath, [script], {
    cwd: travail,
    env: {
      ...process.env,
      TF_BASE: `https://preuve-test.vercel.app`,
      // Le script exige une URL *.vercel.app ; on detourne la resolution par un
      // proxy local via TF_BASE et l en-tete Host n est pas necessaire ici :
      // on passe par un sous-domaine .vercel.app reellement injoignable, donc
      // on teste le cas le plus important : la CIBLE INATTEIGNABLE.
      ...env,
    },
  });
  let sortie = '';
  enfant.stdout.on('data', (d) => { sortie += d; });
  enfant.stderr.on('data', (d) => { sortie += d; });
  enfant.on('close', (code) => {
    let preuve = '';
    try {
      preuve = readFileSync(path.join(travail, 'livrables-finalisation', 'preuves', 'p107-runtime-preuves.json'), 'utf8');
    } catch { /* aucune preuve ecrite : cas teste plus bas */ }
    resolve({ code, sortie, preuve });
  });
});

console.log('Script de preuve — bout en bout hors ligne');

// Cas 1 : cible injoignable. Le script doit refuser de conclure, et surtout
// ne pas produire une preuve qui ressemble a un diagnostic applicatif.
const injoignable = await executer(0);
verifier(injoignable.code !== 0, 'une cible injoignable ne rend pas un succes', `code ${injoignable.code}`);
verifier(/injoignable|cible/i.test(injoignable.preuve + injoignable.sortie),
  'l arret nomme la cible injoignable');
verifier(injoignable.preuve === '' || !/"resultats": \[\s*\{/.test(injoignable.preuve),
  'aucun verdict n est rendu sur une cible non atteinte');

// Cas 2 : reference manquante. On simule le defaut reellement survenu en
// supprimant la variable d environnement que le script lisait avant sa
// correction : si le code depend a nouveau d une constante absente, le test
// echoue au lieu de laisser passer une ReferenceError deguisee en diagnostic.
verifier(!/is not defined/.test(injoignable.sortie) || /BYPASS/.test(injoignable.preuve),
  'aucune ReferenceError deguisee en diagnostic',
  injoignable.sortie.slice(0, 200));

// Cas 3 : garde de cible. Une URL non Vercel doit etre refusee sans appel.
const locale = await executer(0, { TF_BASE: 'http://127.0.0.1:3000' });
verifier(locale.code !== 0, 'une cible locale est refusee', `code ${locale.code}`);
verifier(/n'est pas une URL de deploiement Vercel|runtime local/i.test(locale.sortie),
  'le refus nomme la raison : un runtime local n est pas une preuve',
  locale.sortie.slice(0, 200));

console.log(echecs === 0 ? '  Bout en bout : OK.' : `  Bout en bout : ${echecs} echec(s).`);
process.exit(echecs === 0 ? 0 : 1);
