#!/usr/bin/env node
/**
 * P10.7 — LA REGLE « CET HOTE EST-IL LA PRODUCTION ? » EST-ELLE VRAIE ?
 *
 * POURQUOI CE TEST EXISTE.
 *
 * C5.4 rend FAIL sur `hote_est_production === true`. C'est un controle qui ne
 * vaut que ce que vaut le calcul qui l'alimente : si `estHoteProduction`
 * repondait toujours `false`, C5.4 serait vert toujours, et personne ne le
 * verrait — un controle qui ne peut pas echouer n'est pas un controle.
 *
 * Le test eprouve donc le CALCUL, pas le verdict : la route n'est qu'un
 * appelant. Il tourne sans base, sans Prisma et sans reseau, donc il tourne a
 * chaque passage.
 *
 * LE CAS CENTRAL, ET CELUI QUI A MOTIVE CE FICHIER.
 *
 * L'hote de Production et l'hote de Preview sont tous deux des endpoints Neon.
 * Une regle qui refuserait « tout hote *.neon.tech » serait inutilisable — elle
 * rendrait C5.4 rouge sur une Preview parfaitement rattachee. La regle doit
 * donc distinguer deux hotes du meme fournisseur et de la meme forme : c'est
 * exactement ce qu'on verifie ici, dans les deux sens.
 *
 * SORTIE : 0 conforme · 1 defaut.
 */
import { normaliserHote, hotesProduction, estHoteProduction } from '../api/_lib/hote-production.ts';

let echecs = 0;
function verifier(condition, label, detail = '') {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    echecs += 1;
    console.log(`  ECHEC ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const PRODUCTION = 'ep-polished-night-b1jc5941.c-5.eu-central-1.aws.neon.tech';
const PREVIEW_POOLER = 'ep-lively-field-b1wicg4v-pooler.c-5.eu-central-1.aws.neon.tech';
const PREVIEW_DIRECT = 'ep-lively-field-b1wicg4v.c-5.eu-central-1.aws.neon.tech';

console.log('\n=== P10.7 — hote de production : la regle discrimine-t-elle ? ===\n');

// --- 1. Le sens positif : la Production est reconnue ------------------------
verifier(estHoteProduction(PRODUCTION) === true,
  'l hote de Production du depot est reconnu comme tel');

// --- 2. LE SENS NEGATIF : une Preview Neon n'est PAS la Production ---------
// C'est le cas qui rend la regle utilisable. Un refus trop large (« tout
// neon.tech ») rendrait C5.4 rouge sur une Preview saine.
verifier(estHoteProduction(PREVIEW_POOLER) === false,
  'un endpoint de Preview (pooler) n est PAS la Production');
verifier(estHoteProduction(PREVIEW_DIRECT) === false,
  'un endpoint de Preview (direct) n est PAS la Production');
verifier(estHoteProduction('db.exemple.test') === false,
  'un hote quelconque n est PAS la Production');

// --- 3. Les variations de saisie ne changent pas la reponse ----------------
// Un operateur saisit rarement l'hote exactement comme il figure dans la doc.
// Si la casse ou un point final faisaient perdre la reconnaissance, la garde
// serait contournee par une faute de frappe — et personne ne le saurait.
verifier(estHoteProduction(PRODUCTION.toUpperCase()) === true,
  'la casse ne neutralise pas la reconnaissance');
verifier(estHoteProduction(`  ${PRODUCTION}  `.trim()) === true,
  'les espaces de saisie ne neutralisent pas la reconnaissance');
verifier(estHoteProduction(`${PRODUCTION}.`) === true,
  'un point final ne neutralise pas la reconnaissance');
verifier(estHoteProduction('') === false,
  'un hote vide n est pas la Production (rien a comparer)');

// --- 4. Le suffixe -pooler est une difference SIGNIFICATIVE ----------------
// L'hote direct de Production n'est pas l'hote pooler. Confondre les deux
// ferait passer une Preview rattachee par un autre chemin ; les traiter comme
// identiques serait une commodite qui masque une difference reelle.
verifier(normaliserHote('ep-x-pooler.c-5.neon.tech') !== normaliserHote('ep-x.c-5.neon.tech'),
  'pooler et direct restent deux hotes distincts');
verifier(hotesProduction().includes(normaliserHote(PRODUCTION)),
  'la liste des hotes de Production contient bien l hote connu');
verifier(!hotesProduction().includes(normaliserHote(PREVIEW_POOLER)),
  'la liste des hotes de Production ne contient PAS l hote de Preview');

// --- 5. La liste est EXTENSIBLE sans redeploiement ------------------------
// L'operateur peut declarer d'autres hotes de Production ; la variable ne
// doit ni desactiver le connu, ni introduire de doublon.
const etendue = hotesProduction(` autre-production.test , ${PRODUCTION} ,, `);
verifier(etendue.includes('autre-production.test'),
  'une variable peut declarer un hote supplementaire');
verifier(etendue.filter((h) => h === normaliserHote(PRODUCTION)).length === 1,
  'un hote declare en double ne produit pas de doublon');
verifier(etendue.includes(normaliserHote(PRODUCTION)),
  'declarer un hote n efface PAS l hote de Production connu');
verifier(hotesProduction(undefined).includes(normaliserHote(PRODUCTION)),
  'une variable ABSENTE ne desactive pas la garde');

console.log(echecs === 0
  ? '\n  Hote de production : la regle discrimine, dans les deux sens.\n'
  : `\n  Hote de production : ${echecs} echec(s).\n`);
process.exit(echecs === 0 ? 0 : 1);
