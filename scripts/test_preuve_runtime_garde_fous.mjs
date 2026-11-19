#!/usr/bin/env node
/**
 * Garde-fous du script de preuve runtime P10.7 — non-regression sur deux faux
 * temoins trouves le 2026-11-19.
 *
 * DEFaut 1 : `C4.6` s ecrivait `Boolean(...) || true`. La condition etait vraie
 * quoi qu il arrive, donc le critere rendait PASS sans rien mesurer. C est le
 * faux temoin le plus dangereux : il est vert, donc personne ne le regarde.
 *
 * DEFaut 2 : `C4.4` testait `db.canAssumePrivilegedRole`, un champ qui n a
 * jamais existe dans la reponse de la route (le champ reel est `canEscalate`).
 * Le critere echouait donc TOUJOURS, mais pour un motif faux — il envoyait
 * chercher un defaut de privilege la ou il n y en avait pas.
 *
 * Ces deux tests lisent la SOURCE du script. C est volontaire : ils doivent
 * echouer si le motif revient, y compris si le reste du script est reecrit.
 */

import fs from 'node:fs';
import path from 'node:path';

const racine = path.resolve(import.meta.dirname, '..');
const brut = fs.readFileSync(path.join(racine, 'scripts', 'preuve_runtime_p107.mjs'), 'utf8');

// On analyse le CODE, pas les commentaires.
//
// Sans ce retrait, le test s auto-invalidait : les commentaires qui EXPLIQUENT
// les deux defauts citent forcement `|| true` et `canAssumePrivilegedRole`, donc
// le garde-fou les signalait comme des regressions. Un garde-fou qui interdit de
// documenter le defaut qu il protege finit par etre supprime — et le defaut
// revient avec lui.
const source = brut
  .replace(/\/\*[\s\S]*?\*\//g, '')   // blocs /* ... */
  .split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')) // commentaires de ligne
  .join('\n');

let echecs = 0;
const verifier = (cond, libelle, detail = '') => {
  if (cond) return;
  echecs += 1;
  console.error(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
};

// --- 1. Aucune condition artificiellement vraie ----------------------------
// On cherche `|| true` et `&& false` n importe ou dans le fichier.
verifier(!/\|\|\s*true\b/.test(source),
  'aucune condition `|| true` (faux temoin toujours vert)');
verifier(!/\)\s*&&\s*false\b/.test(source),
  'aucune condition `&& false` (faux temoin toujours rouge)');

// --- 2. Le champ reel de la reponse --------------------------------------
verifier(/db\.canEscalate\s*===\s*false/.test(source),
  'C4.4 teste le champ reel `canEscalate`');
verifier(!/canAssumePrivilegedRole/.test(source),
  'C4.4 ne teste plus le champ inexistant `canAssumePrivilegedRole`');

// --- 3. Quatre etats distincts, et l indetermine bloque ------------------
verifier(/INDETERMINATE/.test(source),
  'le script distingue l etat INDETERMINATE');
const blocVerdict = source.slice(source.indexOf('function verdict'), source.indexOf('function verdict') + 700);
verifier(/etat\s*!==\s*'PASS'/.test(blocVerdict),
  'un verdict non-PASS (dont INDETERMINATE) est bloquant');
verifier(/condition === null/.test(blocVerdict),
  '`null` est traite comme indetermine, pas comme FAIL ni comme PASS');

// --- 4. C4.6 ne peut plus rendre PASS sans mesure ------------------------
const ligneC46 = source.split('\n').filter((l) => l.includes("'C4.6'"));
verifier(ligneC46.length > 0, 'le critere C4.6 existe toujours');
// Le troisieme argument de l appel doit etre `null` : c est lui qui porte l etat.
const blocC46 = source.slice(source.indexOf("'C4.6'") - 200, source.indexOf("'C4.6'") + 400);
verifier(/\bnull\s*,/.test(blocC46),
  'C4.6 passe `null` (indetermine) et non une expression toujours vraie');

// --- 5. C4 est evalue AUSSI sur 503 ---------------------------------------
// Sortir avant d evaluer C4 transformait une mesure disponible en « non
// mesuree ». Le corps du 503 porte `databaseIdentity` : la preuve y est.
verifier(/evaluerC4\(sonde\.corps\.databaseIdentity\)/.test(source),
  'C4 est evalue sur un 503 quand le corps porte databaseIdentity');
verifier(/function evaluerC4/.test(source), 'la fonction evaluerC4 existe');
const nbC41 = (source.match(/'C4\.1'/g) || []).length;
verifier(nbC41 === 1, 'C4.1 n apparait qu une fois (pas de doublon)', `${nbC41} occurrence(s)`);

// --- 6. Tracabilite : la ref du workflow n'est pas le SHA du deploiement ----
verifier(/workflow_sha:/.test(source), 'la preuve enregistre workflow_sha');
verifier(/deployment_sha:/.test(source), 'la preuve enregistre deployment_sha');
verifier(/process\.env\.SHA_ATTENDU/.test(source),
  'deployment_sha est lu depuis SHA_ATTENDU (l input du workflow)');
verifier(/sha_traceabilite/.test(source),
  'la preuve explique ce que `sha` designe');

if (echecs === 0) {
  console.log('  Preuve runtime P10.7 : garde-fous anti-faux-temoin OK.');
  process.exit(0);
}
console.error(`  Preuve runtime P10.7 : ${echecs} echec(s).`);
process.exit(1);
