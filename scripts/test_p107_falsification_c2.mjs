#!/usr/bin/env node
/**
 * P10.7 — C2 : l'identite systeme est-elle FALSIFIABLE ?
 *
 * POURQUOI CE TEST EXISTE
 * -----------------------
 * Les scenarios de falsification vivaient dans `scripts/preuve_c1c2c3_p107.mjs`
 * (13 cas, C3.1 a C3.13), qui exige une connexion PostgreSQL. Ils ne tournent
 * donc PAS en CI, et une regression dans la verification du jeton ne serait vue
 * qu'au moment de la campagne de preuve — c'est-a-dire trop tard.
 *
 * Ce test exerce les MEMES fonctions pures (`signerIdentiteSysteme`,
 * `jetonSystemeValide`) sans aucune base : le contrat de signature est
 * entierement cote application. Il rend les cas negatifs reproductibles en CI.
 *
 * CE QU'IL NE REMPLACE PAS
 * ------------------------
 * La verification faite par la BASE (`tracefab_identite_systeme_jeton_valide`)
 * a ses propres regles : plafond de duree de vie de 600 s, forme canonique du
 * MAC, comparaison a temps constant en SQL. Ce test ne mesure que le cote
 * application. Les deux doivent etre verts, et ils sont distincts.
 *
 * CAS COUVERTS — tous negatifs sauf le premier
 *   C2.1  jeton valide -> accepte (le temoin : sans lui, tout refus passerait)
 *   C2.2  corps modifie apres signature -> refuse
 *   C2.3  MAC falsifie (un caractere change) -> refuse
 *   C2.4  MAC en MAJUSCULES -> refuse (forme canonique unique)
 *   C2.5  MAC tronque -> refuse
 *   C2.6  jeton a deux points -> refuse (serialisation non ambigue)
 *   C2.7  jeton absent / vide -> refuse
 *   C2.8  jeton expire -> refuse
 *   C2.9  jeton a duree de vie d'un an -> refuse cote application
 *   C2.10 jeton UTILISATEUR presente comme SYSTEME -> refuse
 *   C2.11 signature avec une AUTRE cle -> refuse
 *   C2.12 cle absente -> aucune signature produite (refus ferme, pas de repli)
 *   C2.13 cle malformee -> signer rend null, jetonSystemeValide refuse
 *   C2.14 le jeton ne porte JAMAIS la cle
 */
import { randomBytes } from 'node:crypto';
import { signerIdentiteSysteme, jetonSystemeValide, etatCleSysteme } from '../api/_lib/identite-systeme.ts';

let echecs = 0;
let verifies = 0;
const ok = (id, libelle, cond, detail = '') => {
  verifies += 1;
  if (!cond) echecs += 1;
  console.log(`  ${cond ? 'PASS ' : 'ECHEC'} ${id} ${libelle}${detail ? ` — ${detail}` : ''}`);
};

// Deux cles distinctes, generees ici : elles ne sortent jamais de ce processus
// et ne sont pas des secrets d'environnement.
const CLE = randomBytes(32).toString('hex');
const AUTRE_CLE = randomBytes(32).toString('hex');
const MAINTENANT = 1_800_000_000;

const jeton = signerIdentiteSysteme({ cle: CLE, maintenant: MAINTENANT });
const valide = (j, opts = {}) => jetonSystemeValide(j, { cle: CLE, maintenant: MAINTENANT, ...opts });

// --- C2.1 Le temoin --------------------------------------------------------
ok('C2.1', 'un jeton valide est ACCEPTE (temoin : sinon tout refus passerait)',
  jeton !== null && valide(jeton.jeton), jeton ? 'jeton produit' : 'aucun jeton');

const corps = jeton.jeton.slice(0, jeton.jeton.lastIndexOf('.'));
const mac = jeton.jeton.slice(jeton.jeton.lastIndexOf('.') + 1);

// --- C2.2 Corps modifie ----------------------------------------------------
const corpsModifie = corps.replace('tracefab_system', 'tracefab_systemX');
ok('C2.2', 'corps MODIFIE apres signature -> REFUSE',
  !valide(`${corpsModifie}.${mac}`));

// --- C2.3 MAC falsifie -----------------------------------------------------
const macFalsifie = (mac[0] === 'a' ? 'b' : 'a') + mac.slice(1);
ok('C2.3', 'MAC falsifie (un caractere change) -> REFUSE',
  !valide(`${corps}.${macFalsifie}`));

// --- C2.4 MAC en majuscules ------------------------------------------------
// `decode(mac,'hex')` accepte les majuscules : sans ce controle, le meme jeton
// aurait deux ecritures valides — une ambiguite de serialisation.
ok('C2.4', 'MAC en MAJUSCULES -> REFUSE (forme canonique unique)',
  !valide(`${corps}.${mac.toUpperCase()}`));

// --- C2.5 MAC tronque ------------------------------------------------------
ok('C2.5', 'MAC tronque -> REFUSE', !valide(`${corps}.${mac.slice(0, 32)}`));

// --- C2.6 Deux points ------------------------------------------------------
ok('C2.6', 'jeton a DEUX points -> REFUSE (serialisation non ambigue)',
  !valide(`${jeton.jeton}.nimporte_quoi`));

// --- C2.7 Absent / vide ----------------------------------------------------
ok('C2.7', 'jeton ABSENT ou VIDE -> REFUSE', !valide(null) && !valide('') && !valide(undefined));

// --- C2.8 Expire -----------------------------------------------------------
ok('C2.8', 'jeton EXPIRE -> REFUSE', !valide(jeton.jeton, { maintenant: MAINTENANT + 3600 }));

// --- C2.9 Duree de vie d'un an ---------------------------------------------
// Le plafond de 600 s est applique par la BASE. Cote application, l'emission
// est bornee : on verifie qu'un jeton forge a un an dans le futur ne passe pas
// la verification applicative avec l'horloge courante.
const an = signerIdentiteSysteme({ cle: CLE, maintenant: MAINTENANT, dureeSecondes: 365 * 24 * 3600 });
ok('C2.9', 'jeton a duree de vie d un AN -> REFUSE cote application',
  an === null || !valide(an?.jeton), an === null ? 'emission refusee' : 'verification refusee');

// --- C2.10 Usage detourne --------------------------------------------------
// Un jeton utilisateur porte `tracefab_identity`, pas `tracefab_system`.
const jetonUtilisateur = corps.replace('tracefab_system', 'tracefab_identity');
ok('C2.10', 'jeton UTILISATEUR presente comme SYSTEME -> REFUSE',
  !valide(`${jetonUtilisateur}.${mac}`));

// --- C2.11 Autre cle -------------------------------------------------------
ok('C2.11', 'signature produite avec une AUTRE cle -> REFUSE',
  !valide(jeton.jeton, { cle: AUTRE_CLE }));

// --- C2.12 Cle absente : refus FERME --------------------------------------
// Aucun repli vers un mode permissif : sans cle, il n'y a pas de jeton.
ok('C2.12', 'cle ABSENTE -> aucune signature produite (refus ferme, pas de repli)',
  signerIdentiteSysteme({ cle: undefined, maintenant: MAINTENANT }) === null
  && etatCleSysteme(undefined) === 'absente');

// --- C2.13 Cle malformee ---------------------------------------------------
const malformee = 'zz'.repeat(32);
ok('C2.13', 'cle MALFORMEE -> ni signature ni acceptation',
  signerIdentiteSysteme({ cle: malformee, maintenant: MAINTENANT }) === null
  && !jetonSystemeValide(jeton.jeton, { cle: malformee, maintenant: MAINTENANT })
  && etatCleSysteme(malformee) === 'invalide');

// --- C2.14 La cle ne fuit jamais dans le jeton ----------------------------
// Un jeton qui contiendrait la cle, meme partiellement, la rendrait lisible par
// quiconque l'intercepte.
const partiesInferees = jeton.jeton.split('');
const fuite = CLE.split('').every((c, i) => partiesInferees.includes(c)) && jeton.jeton.includes(CLE.slice(0, 16));
ok('C2.14', 'le jeton ne contient JAMAIS la cle ni un fragment reconnaissable',
  !fuite && !jeton.jeton.includes(CLE) && !jeton.jeton.includes(CLE.slice(0, 16)));

console.log(echecs === 0
  ? `  Falsification C2 : OK (${verifies} contrôles).`
  : `  Falsification C2 : ${echecs} echec(s) sur ${verifies}.`);
process.exit(echecs === 0 ? 0 : 1);
