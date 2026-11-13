#!/usr/bin/env node
/**
 * P10.7 — la moitie APPLICATIVE de l'identite systeme, eprouvee hors ligne.
 *
 * POURQUOI CE TEST EXISTE
 *
 * Le jeton systeme a deux moities : l'application SIGNE, la base VERIFIE. La
 * base est eprouvee par `test:p107:identite-systeme`, et cette suite-la exige
 * PostgreSQL, une cle provisionnee et un role applicatif sans privileges. Elle
 * mesure l'essentiel — le refus effectif — mais elle ne peut pas enumerer, cas
 * par cas, ce que « signature valide » veut dire : chaque refus y coute une
 * connexion et un aller-retour SQL.
 *
 * Ce test-ci prend l'autre bout : il appelle `signerIdentiteSysteme()` et
 * `jetonSystemeValide()` — le code exact que l'application executera — sur des
 * jetons fabriques a la main. Il ne remplace pas la mesure en base (une
 * verification applicative n'est pas une preuve d'autorisation cote base) ; il
 * fixe par ecrit le CONTRAT que la base doit retrouver, et il tourne partout,
 * y compris sans PostgreSQL.
 *
 * CHAQUE CAS EST UN DEFAUT REEL, PAS UNE VARIANTE COSMETIQUE
 *
 *   M1  jeton valide                        -> accepte
 *   M2  MAC modifie                         -> refuse
 *   M3  corps modifie, MAC conserve         -> refuse (la falsification la plus directe)
 *   M4  identite designee modifiee          -> refuse
 *   M5  echeance depassee / egale           -> refuse
 *   M6  signature absente, vide, nulle      -> refuse
 *   M7  cle absente                         -> aucune signature (pas de repli)
 *   M8  cle incorrecte                      -> refuse
 *   M9  usage du jeton UTILISATEUR          -> refuse (separation des usages)
 *   M10 version de protocole inconnue       -> refuse
 *   M11 champ obligatoire vide              -> refuse
 *   M12 serialisation ambigue               -> refuse (une seule ecriture admise)
 *   M13 jeton verifie contre une autre identite -> refuse
 *   M14 MAC en majuscules / non hexadecimal -> refuse
 *   M15 cle malformee                       -> etat « invalide », jamais « absente »
 *   M17 les deux usages ne se confondent pas, dans les deux sens
 *   M18 la cle n'apparait ni dans un jeton ni dans un message
 *
 * Env : aucune (la cle est tiree au hasard a chaque execution).
 * Sortie : 0 conforme · 1 regression.
 */
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import {
  etatCleSysteme,
  jetonSystemeValide,
  signerIdentiteSysteme,
  USAGE_IDENTITE_SYSTEME,
  IDENTITE_SYSTEME,
  DUREE_JETON_SYSTEME_SECONDES,
} from '../api/_lib/identite-systeme.ts';

let assertions = 0;
let echecs = 0;
const ok = (condition, libelle, detail = '') => {
  assertions += 1;
  console.log(`  ${condition ? 'ok   ' : 'ECHEC'} ${libelle}${detail ? ` — ${detail}` : ''}`);
  if (!condition) echecs += 1;
};

const CLE = randomBytes(32).toString('hex');
const MAINTENANT = 1_800_000_000;

/** Fabrique un jeton a la main : c'est le seul moyen de falsifier un champ isole. */
const forger = (cle, corps) => `${corps}.${createHmac('sha256', Buffer.from(cle, 'hex')).update(corps).digest('hex')}`;

assert.notEqual(typeof signerIdentiteSysteme, 'undefined', 'le module expose signerIdentiteSysteme');

console.log('\n  A. signature et verification nominales');

{
  const signe = signerIdentiteSysteme({ cle: CLE, maintenant: MAINTENANT, dureeSecondes: 60 });
  ok(signe !== null, 'une cle valide produit un jeton');
  ok(typeof signe?.jeton === 'string' && signe.jeton.includes('.'), 'le jeton porte un corps et un MAC');
  ok(signe?.expiration === MAINTENANT + 60, 'l echeance annoncee est celle du corps', String(signe?.expiration));
  ok(jetonSystemeValide(signe?.jeton, { cle: CLE, maintenant: MAINTENANT }), 'M1 un jeton valide est accepte');
  ok(
    signe.jeton.startsWith(`v1|${USAGE_IDENTITE_SYSTEME}|${IDENTITE_SYSTEME}|`),
    'le corps commence par version, usage et identite systeme',
  );
  ok(DUREE_JETON_SYSTEME_SECONDES <= 120, 'la duree de vie par defaut reste courte', `${DUREE_JETON_SYSTEME_SECONDES}s`);
}

console.log('\n  B. falsifications refusees');

{
  const signe = signerIdentiteSysteme({ cle: CLE, maintenant: MAINTENANT, dureeSecondes: 60 });
  const coupe = signe.jeton.lastIndexOf('.');
  const corps = signe.jeton.slice(0, coupe);
  const mac = signe.jeton.slice(coupe + 1);
  const echeance = MAINTENANT + 60;

  // MUTATION GARANTIE, ET POURQUOI PAS « les deux derniers octets a 00 ».
  //
  // La version precedente ecrivait `${mac.slice(0,-2)}00`. Quand le MAC se
  // terminait DEJA par `00` — ce qui arrive une fois sur 256 — la « mutation »
  // reproduisait le jeton d'origine, et l'assertion echouait en annoncant que
  // la verification acceptait un MAC modifie. Elle etait en realite correcte.
  //
  // Mesure du 2026-11-06 : une execution sur ~30 a echoue ainsi, alors que la
  // meme suite passait cinq fois de suite. Un test de securite intermittent
  // n'est pas un test : il apprend a relancer plutot qu'a lire.
  //
  // On force donc un caractere STRICTEMENT different du dernier.
  const dernierInverse = mac.slice(-1) === '0' ? '1' : '0';
  const macMute = mac.slice(0, -1) + dernierInverse;
  ok(macMute !== mac, 'M2 la mutation du MAC change reellement la valeur');
  ok(!jetonSystemeValide(`${corps}.${macMute}`, { cle: CLE, maintenant: MAINTENANT }),
    'M2 MAC modifie : refuse');
  ok(!jetonSystemeValide(`${corps.replace(IDENTITE_SYSTEME, 'postgres')}.${mac}`, { cle: CLE, maintenant: MAINTENANT }),
    'M3 corps modifie, MAC conserve : refuse');
  ok(!jetonSystemeValide(forger(CLE, `v1|${USAGE_IDENTITE_SYSTEME}|postgres|${echeance}`), { cle: CLE, maintenant: MAINTENANT }),
    'M4 identite designee modifiee : refuse');
  ok(!jetonSystemeValide(forger(CLE, `v1|${USAGE_IDENTITE_SYSTEME}||${echeance}`), { cle: CLE, maintenant: MAINTENANT }),
    'M11 champ obligatoire vide : refuse');

  ok(!jetonSystemeValide(forger(CLE, `v1|${USAGE_IDENTITE_SYSTEME}|${IDENTITE_SYSTEME}|${MAINTENANT - 1}`), { cle: CLE, maintenant: MAINTENANT }),
    'M5 echeance depassee : refuse');
  ok(!jetonSystemeValide(forger(CLE, `v1|${USAGE_IDENTITE_SYSTEME}|${IDENTITE_SYSTEME}|${MAINTENANT}`), { cle: CLE, maintenant: MAINTENANT }),
    'M5 bis echeance EGALE a l instant present : refuse (aucune tolerance implicite)');

  ok(!jetonSystemeValide(corps, { cle: CLE, maintenant: MAINTENANT }), 'M6 signature absente : refuse');
  ok(!jetonSystemeValide('', { cle: CLE, maintenant: MAINTENANT }), 'M6 bis jeton vide : refuse');
  ok(!jetonSystemeValide(undefined, { cle: CLE, maintenant: MAINTENANT }), 'M6 ter jeton undefined : refuse');
  ok(!jetonSystemeValide(null, { cle: CLE, maintenant: MAINTENANT }), 'M6 quater jeton null : refuse');

  ok(!jetonSystemeValide(signe.jeton, { cle: randomBytes(32).toString('hex'), maintenant: MAINTENANT }),
    'M8 cle incorrecte : refuse');
  ok(!jetonSystemeValide(forger(CLE, `v1|tracefab_identity|${IDENTITE_SYSTEME}|${echeance}`), { cle: CLE, maintenant: MAINTENANT }),
    'M9 usage du jeton UTILISATEUR presente comme systeme : refuse');
  ok(!jetonSystemeValide(forger(CLE, `v2|${USAGE_IDENTITE_SYSTEME}|${IDENTITE_SYSTEME}|${echeance}`), { cle: CLE, maintenant: MAINTENANT }),
    'M10 version de protocole inconnue : refuse');

  // Deux ecritures d'un meme droit = deux occasions de desaccord entre
  // l'application et la base. Une seule est admise, et ses bornes sont verifiees.
  ok(!jetonSystemeValide(`${signe.jeton}.surcharge`, { cle: CLE, maintenant: MAINTENANT }),
    'M12 serialisation ambigue (suffixe apres le MAC) : refuse');
  ok(!jetonSystemeValide(`${signe.jeton} `, { cle: CLE, maintenant: MAINTENANT }), 'M12 bis espace final : refuse');
  ok(!jetonSystemeValide(` ${signe.jeton}`, { cle: CLE, maintenant: MAINTENANT }), 'M12 ter espace initial : refuse');

  ok(!jetonSystemeValide(signe.jeton.toUpperCase(), { cle: CLE, maintenant: MAINTENANT }),
    'M14 MAC en majuscules : refuse (une seule ecriture admise)');
  ok(!jetonSystemeValide(`${corps}.${mac.slice(0, 63)}z`, { cle: CLE, maintenant: MAINTENANT }),
    'M14 bis MAC non hexadecimal : refuse');
  ok(!jetonSystemeValide(`${corps}.${mac}0`, { cle: CLE, maintenant: MAINTENANT }),
    'M14 ter MAC trop long : refuse');

  ok(!jetonSystemeValide(signe.jeton, { cle: CLE, maintenant: MAINTENANT, identite: 'autre_role' }),
    'M13 verifie contre une AUTRE identite systeme : refuse');
}

console.log('\n  C. cle absente ou malformee : un etat, jamais un mode permissif');

{
  // M7 est MESURE AVEC LA VARIABLE D ENVIRONNEMENT POSEE *ET* ABSENTE, et c'est
  // le cas « posee » qui compte : c'est lui qui a revele le defaut du 06/11.
  // `signerIdentiteSysteme({ cle: undefined })` veut dire « je n'ai pas de cle ».
  // Une valeur par defaut sur `etatCleSysteme(brute = process.env...)` confondait
  // cet appel avec « lis la variable » : la fonction declarait alors la cle
  // VALIDE, puis dereferencait `undefined` et levait un TypeError. Un appel cense
  // rendre `null` (repli ferme) produisait une exception — un symptome qui ne
  // ressemble pas a « pas de cle », mais a une panne.
  const cleEnvironnement = process.env.TRACEFAB_IDENTITY_KEY;
  process.env.TRACEFAB_IDENTITY_KEY = CLE;
  try {
    ok(signerIdentiteSysteme({ cle: undefined, maintenant: MAINTENANT }) === null,
      'M7 cle absente alors que l environnement en porte une : aucune signature (null), jamais un repli');
    ok(etatCleSysteme(undefined) === 'absente',
      'M7 quater etat d une cle explicitement absente, environnement pose : absente (les deux appels ne se confondent pas)');
    ok(etatCleSysteme() === 'valide',
      'M7 quinquies etat SANS argument, environnement pose : valide (l autre sens est preserve)');
  } finally {
    if (cleEnvironnement === undefined) delete process.env.TRACEFAB_IDENTITY_KEY;
    else process.env.TRACEFAB_IDENTITY_KEY = cleEnvironnement;
  }
  ok(signerIdentiteSysteme({ cle: undefined, maintenant: MAINTENANT }) === null,
    'M7 ter cle absente et environnement absent : aucune signature (null)');
  ok(signerIdentiteSysteme({ cle: '   ', maintenant: MAINTENANT }) === null, 'M7 bis cle blanche : aucune signature');
  ok(!jetonSystemeValide(forger(CLE, `v1|${USAGE_IDENTITE_SYSTEME}|${IDENTITE_SYSTEME}|${MAINTENANT + 60}`), { cle: undefined, maintenant: MAINTENANT }),
    'M7 sexies verification sans cle : refuse');

  ok(etatCleSysteme(undefined) === 'absente', 'etat : undefined = absente');
  ok(etatCleSysteme('') === 'absente', 'etat : vide = absente');
  ok(etatCleSysteme(CLE) === 'valide', 'etat : 32 octets hexadecimaux = valide');
  ok(etatCleSysteme('a'.repeat(64)) === 'valide', 'etat : 64 caracteres = valide');
  ok(etatCleSysteme('a'.repeat(63)) === 'invalide', 'etat : trop courte = invalide (jamais completee)');
  ok(etatCleSysteme('a'.repeat(65)) === 'invalide', 'etat : longueur impaire = invalide (jamais tronquee)');
  ok(etatCleSysteme('z'.repeat(64)) === 'invalide', 'etat : non hexadecimal = invalide');

  // M15 : une cle PRESENTE mais inutilisable ne doit jamais etre confondue avec
  // une cle absente. Les deux se ressemblent a l'execution (aucun jeton n'est
  // produit), mais pas a l'exploitation : « absente » est un etat normal avant
  // provisionnement, « invalide » est une panne qui doit se voir dans la
  // readiness et arreter les operations systeme.
  ok(etatCleSysteme('z'.repeat(64)) !== 'absente', 'M15 une cle malformee n est PAS rapportee comme absente');
}

console.log('\n  D. separation des usages, dans les deux sens');

{
  const signe = signerIdentiteSysteme({ cle: CLE, maintenant: MAINTENANT, dureeSecondes: 60 });
  const parties = signe.jeton.slice(0, signe.jeton.lastIndexOf('.')).split('|');
  ok(parties.length === 4, 'le corps systeme a QUATRE champs', `champs=${parties.length}`);
  ok(parties[1] === USAGE_IDENTITE_SYSTEME, 'le deuxieme champ est l usage systeme', parties[1]);
  ok(parties[1] !== 'tracefab_identity', 'M17 l usage systeme differe de l usage utilisateur');

  // Le jeton UTILISATEUR porte un identifiant et une organisation : cinq champs.
  // Un jeton systeme a quatre champs, donc les deux formats ne peuvent pas
  // coincider, quelle que soit la valeur des champs.
  const corpsUtilisateur = `v1|11111111-1111-1111-1111-111111111111||tracefab_identity|${MAINTENANT + 60}`;
  ok(!jetonSystemeValide(forger(CLE, corpsUtilisateur), { cle: CLE, maintenant: MAINTENANT }),
    'M17 bis un jeton utilisateur a cinq champs est refuse par la verification systeme');
}

console.log('\n  E. aucune fuite de la cle');

{
  const signe = signerIdentiteSysteme({ cle: CLE, maintenant: MAINTENANT, dureeSecondes: 60 });
  ok(!signe.jeton.includes(CLE), 'M18 le jeton ne contient pas la cle');
  ok(!signe.jeton.includes(CLE.slice(0, 16)), 'M18 bis aucun fragment de la cle dans le jeton');

  // Une cle malformee ne doit pas se retrouver recopiee dans un message : un
  // journal d'erreur est lisible par bien plus de monde que la variable.
  const malformee = `zz${randomBytes(16).toString('hex')}`;
  let message = '';
  try {
    signerIdentiteSysteme({ cle: malformee, maintenant: MAINTENANT });
  } catch (erreur) {
    message = erreur instanceof Error ? erreur.message : String(erreur);
  }
  ok(!message.includes(malformee.slice(0, 10)), 'M18 ter une cle malformee n est pas recopiee dans un message', message.slice(0, 48));
}

console.log(`\n  P10.7 — module d identite systeme : ${assertions - echecs}/${assertions} assertions vertes`);
if (echecs > 0) console.log(`  ${echecs} echec(s)`);
process.exit(echecs === 0 ? 0 : 1);
