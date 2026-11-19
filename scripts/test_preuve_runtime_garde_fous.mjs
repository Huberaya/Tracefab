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

// --- 4. C4.6 ne peut pas rendre PASS sans mesure ------------------------
//
// L assertion d origine exigeait un `null` LITTERAL : « C4.6 passe `null` et
// non une expression toujours vraie ». Elle a fait son travail — elle a tue le
// `Boolean(...) || true` — puis elle est devenue un obstacle : le `null` en dur
// declarait la mesure IMPOSSIBLE, alors que le contexte tenant se mesure en
// lecture seule. Une assertion qui exige un `null` litteral protege desormais
// le defaut qu elle avait corrige.
//
// Ce qui doit rester vrai, et qui est verifie ici, est plus precis : C4.6 doit
// dependre d une CONDITION LUE, et valoir `null` quand cette condition manque.
const ligneC46 = source.split('\n').filter((l) => l.includes("'C4.6'"));
verifier(ligneC46.length > 0, 'le critere C4.6 existe toujours');
verifier(/ct && ct\.measured === true/.test(source),
  'C4.6 est conditionne par `measured` : sans mesure, pas de verdict');
verifier(/contexteTenant/.test(source),
  'C4.6 lit le champ `contexteTenant` publie par la route');
verifier(/ct\.organisationEtrangereRefusee === true/.test(source),
  'C4.6 exige le CONTROLE NEGATIF (organisation etrangere refusee), pas seulement le positif');
// Une expression toujours vraie resterait un faux temoin, meme bien nommee.
const blocC46 = source.slice(source.indexOf("'C4.6'"), source.indexOf("'C4.6'") + 900);
verifier(!/\|\|\s*true/.test(blocC46), 'C4.6 ne contient aucune disjonction toujours vraie');

// --- 5. C4 est evalue AUSSI sur 503 ---------------------------------------
// Sortir avant d evaluer C4 transformait une mesure disponible en « non
// mesuree ». Le corps du 503 porte `databaseIdentity` : la preuve y est.
// La forme exacte a change (C4.6 mesure desormais `contexteTenant`, donc
// l appel passe deux arguments). Ce qui est verifie ici est la PROPRIETE :
// l appel existe dans la branche 503, precede la sortie en 2, et n est pas
// conditionne a `databaseIdentity` seul — sans quoi un corps portant
// uniquement `contexteTenant` rendrait C4 indetermine par contagion.
const posExit = source.indexOf('process.exit(2)', source.indexOf('sonde.statut === 503'));
const posAppel = source.indexOf('evaluerC4(sonde.corps.databaseIdentity');
verifier(posAppel !== -1 && posAppel < posExit,
  'C4 est evalue sur un 503 avant la sortie en 2', `appel=${posAppel} exit=${posExit}`);
verifier(/sonde\.corps\?\.databaseIdentity \|\| sonde\.corps\?\.contexteTenant/.test(source),
  'C4 est evalue des que databaseIdentity OU contexteTenant est present');
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

// --- 7. C1 et C2 sont evalues AUSSI sur un statut != 200 -------------------
// Defaut trouve sur le run 44483815489 : le corps du 503 portait
// `identitySysteme.verifiee_par_la_base: true` / `aller_retour_reussi`, et le
// script sortait avant de lire. Six verdicts declares inatteignables alors que
// la mesure etait dans la main — meme classe que le defaut C4 corrige plus haut.
verifier(/function evaluerC1C2/.test(source), 'la fonction evaluerC1C2 existe');
const nbC12 = (source.match(/'C1\.2'/g) || []).length;
verifier(nbC12 === 1, 'C1.2 n apparait qu une fois (pas de doublon)', `${nbC12} occurrence(s)`);
verifier(/evaluerC1C2\(sonde\.corps\)/.test(source),
  'C1/C2 sont evalues sur un 503 quand le corps porte les champs d identite');

// L appel doit etre DANS la branche 503, pas apres le `process.exit(2)`.
const posExit503 = source.indexOf('process.exit(2)', source.indexOf('sonde.statut === 503'));
const posAppelC1C2 = source.indexOf('evaluerC1C2(sonde.corps)');
verifier(posAppelC1C2 !== -1 && posExit503 !== -1 && posAppelC1C2 < posExit503,
  'l evaluation C1/C2 precede la sortie en 2 (sinon elle ne s execute jamais)',
  `appel=${posAppelC1C2} exit=${posExit503}`);

// --- 8. Un `null` de verification ne peut pas devenir un PASS -------------
// `verifiee_par_la_base` vaut true / false / null. Seul `true` est un PASS.
verifier(/verifiee_par_la_base === true \? true/.test(source)
  || /verifiee_par_la_base === true/.test(source),
  'C1.2 exige strictement `verifiee_par_la_base === true`');
verifier(!/'C1\.2'[^;]*verifiee_par_la_base !== false/.test(source),
  'C1.2 ne se contente pas de « non faux » (un null n est pas une preuve)');

// --- 9. Aucune cause recopiee en dur dans l interpretation du 503 ---------
// L ancienne ligne affirmait « cle d identite absente » sans lire le corps.
verifier(!/cle d identite absente\)/.test(source)
  && !/'runtime non pret \(cle d identite absente\)/.test(source),
  'l interpretation du 503 n affirme plus une cause non lue');
verifier(/const clePresente = utilisateur\?\.configured === true/.test(source),
  'l interpretation du 503 se deduit de `identityTokens.configured`');

if (echecs === 0) {
  console.log('  Preuve runtime P10.7 : garde-fous anti-faux-temoin OK.');
  process.exit(0);
}
console.error(`  Preuve runtime P10.7 : ${echecs} echec(s).`);
process.exit(1);
