#!/usr/bin/env node
/**
 * Generation d'une cle d'identite HMAC pour un environnement DONNE.
 *
 * POURQUOI CE SCRIPT EXISTE
 * -------------------------
 * La procedure de generation vivait uniquement dans un message d'erreur de
 * `provisionner_cle_identite.mjs` :
 *
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Une commande citee dans un message d'erreur n'est pas une procedure : elle
 * n'est ni testable, ni retrouvable, et elle n'impose aucune des precautions
 * qui font qu'une cle reste une cle. Ce script les impose.
 *
 * CE QU'IL GARANTIT
 *   - 32 octets tires par `crypto.randomBytes` (CSPRNG du systeme), jamais
 *     `Math.random` ni une source derivee d'une date ;
 *   - le format EXACT attendu par le runtime : 64 caracteres hexadecimaux
 *     minuscules (`etatCleSysteme` exige une longueur paire >= 64) ;
 *   - la valeur n'est ecrite NI sur disque, NI dans l'historique du shell, NI
 *     dans un journal : elle est ecrite sur la SORTIE STANDARD, a destination
 *     de l'operateur, qui la colle directement dans le gestionnaire de secrets ;
 *   - un rappel explicite de ce qu'il faut faire ensuite, et de ce qu'il ne
 *     faut PAS faire (copier d'un environnement a l'autre).
 *
 * CE QU'IL NE FAIT PAS, VOLONTAIREMENT
 *   - il n'ecrit PAS dans `tracefab_identity_cles` : c'est le role de
 *     `provisionner_cle_identite.mjs`, qui exige une confirmation explicite ;
 *   - il n'ecrit pas dans Vercel ni dans GitHub : aucun script ne doit pouvoir
 *     poser un secret sans une action humaine deliberee.
 *
 * USAGE
 *   node scripts/generer_cle_identite.mjs --environnement preview
 *   node scripts/generer_cle_identite.mjs --environnement preview --longueur 32
 *
 * L'option `--environnement` n'est pas decorative : elle n'entre PAS dans la
 * valeur produite (deux environnements doivent avoir des cles independantes),
 * elle sert a imprimer la procedure exacte pour cet environnement-la, afin
 * qu'une cle de Preview ne soit pas collee dans Production par inadvertance.
 */
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const lireOption = (nom, defaut) => {
  const i = args.indexOf(`--${nom}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : defaut;
};

const environnement = lireOption('environnement', '');
const longueurOctets = Number(lireOption('longueur', '32'));

// Un environnement nomme evite la faute la plus courante : poser la cle de
// Preview dans Production (ou l'inverse) parce qu'on ne sait plus laquelle on
// vient de generer.
if (!['preview', 'preproduction', 'production', 'local'].includes(environnement)) {
  console.error('  REFUS — --environnement doit valoir preview, preproduction, production ou local.');
  console.error('  Exemple : node scripts/generer_cle_identite.mjs --environnement preview');
  process.exit(3);
}

if (!Number.isInteger(longueurOctets) || longueurOctets < 32 || longueurOctets > 64) {
  console.error('  REFUS — --longueur doit etre un entier entre 32 et 64 octets.');
  console.error('  32 octets (64 caracteres hex) est la valeur attendue par le runtime.');
  process.exit(3);
}

const cle = randomBytes(longueurOctets).toString('hex');

// La valeur part sur stdout, SEULE. Aucun prefixe, aucun suffixe : l'operateur
// peut la capturer directement (`| pbcopy`, `| xclip`) sans la voir passer par
// un fichier ou l'historique du shell.
process.stdout.write(`${cle}\n`);

// Tout le reste part sur stderr, pour ne jamais contaminer la valeur.
console.error('');
console.error(`  Cle generee pour l environnement : ${environnement}`);
console.error(`  Longueur : ${longueurOctets} octets (${cle.length} caracteres hexadecimaux)`);
console.error(`  Empreinte de controle (non secrete) : la valeur commence par "${cle.slice(0, 2)}"`);
console.error('');
console.error('  ETAPES SUIVANTES — dans cet ordre');
console.error('');
console.error(`    1. Poser la valeur comme variable Vercel, environnement ${environnement.toUpperCase()}.`);
console.error('       Vercel > Settings > Environment Variables > Add');
console.error('       Nom : TRACEFAB_IDENTITY_KEY');
console.error(`       Cible : ${environnement === 'local' ? 'Development' : environnement === 'preproduction' ? 'Preview (branche de preproduction)' : environnement === 'production' ? 'Production' : 'Preview'}`);
console.error('       Ne JAMAIS committer la valeur, ni l ecrire dans un fichier du depot.');
console.error('');
console.error('    2. Poser la MEME valeur en base, dans l environnement correspondant :');
console.error('         TF_ALLOW_PROVISIONING=oui \\');
console.error('         TF_IDENTITY_KEY_HEX=<la valeur> \\');
console.error('         DATABASE_ADMIN_URL=<url admin DE CET ENVIRONNEMENT> \\');
console.error('           node scripts/provisionner_cle_identite.mjs --version <n>');
console.error('');
console.error('    3. Verifier le contrat (lecture seule) :');
console.error('         DATABASE_ADMIN_URL=<url admin DE CET ENVIRONNEMENT> \\');
console.error('           node scripts/provisionner_cle_identite.mjs --verifier');
console.error('');
console.error('  CE QU IL NE FAUT PAS FAIRE');
console.error('    - Copier une cle d un environnement a un autre : une rotation');
console.error('      deviendrait un incident simultane sur les deux.');
console.error('    - Reutiliser une valeur ayant figure dans un journal, une capture');
console.error('      ou une conversation : elle est compromise, meme si personne ne');
console.error('      l a utilisee.');
console.error('    - Ecrire la valeur dans ce depot, dans un fichier `.env` versionne,');
console.error('      ou dans un ticket.');
console.error('');
