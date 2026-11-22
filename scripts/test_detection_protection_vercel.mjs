#!/usr/bin/env node
/**
 * Non-regression : une reponse de Vercel Authentication n'est pas un refus applicatif.
 *
 * Le defaut corrige ici a ete mesure, pas suppose. Run 43850436311 du
 * 2026-11-16 : la Preview repondait 302 vers vercel.com/sso-api, et le script
 * de preuve comptait ce 302 comme un echec de C3.1-C3.3. La requete
 * n'atteignait pas l'application ; le verdict accusait donc l'application a
 * tort. Ce test fixe la frontiere entre les deux origines pour toujours.
 *
 * Chaque cas correspond a une forme reellement observee ou explicitement
 * attendue ; aucun cas n'est decoratif.
 */
import { estProtectionVercel, CODE_ACCES_ABSENT } from './detecter_protection_vercel.mjs';

let echecs = 0;
const verifier = (condition, nom, detail = '') => {
  if (condition) {
    console.log(`  ok    ${nom}`);
  } else {
    console.log(`  ECHEC ${nom}${detail ? ` — ${detail}` : ''}`);
    echecs += 1;
  }
};

console.log('Detection de la protection Vercel');

// 302 : forme exacte relevee sur la Preview le 2026-11-16.
verifier(
  estProtectionVercel({
    statut: 302,
    texte: '',
    entetes: { location: 'https://vercel.com/sso-api?url=https%3A%2F%2Ftracefab-preview.vercel.app' },
  }),
  'un 302 vers le SSO Vercel est reconnu comme une protection',
);

// Corps reel : `vercel_auth_enabled` peut tomber loin dans le JSON.
const corpsLong = `${'x'.repeat(400)}"vercel_auth_enabled":true,"other":"y"}`;
verifier(
  estProtectionVercel({ statut: 401, texte: corpsLong, entetes: {} }),
  'vercel_auth_enabled est trouve au-dela de 400 caracteres',
);

verifier(
  estProtectionVercel({ statut: 401, texte: 'Protected by Vercel Authentication', entetes: {} }),
  'le message « Protected by Vercel Authentication » est reconnu',
);

// Contre-epreuve : un refus reel de l'application ne doit PAS etre classe
// comme une protection, sinon on masquerait une vraie regression de securite.
verifier(
  !estProtectionVercel({
    statut: 401,
    texte: '{"erreur":"jeton de sonde absent ou invalide"}',
    entetes: {},
  }),
  'un 401 applicatif reste un refus de l application (pas une protection)',
);

verifier(
  !estProtectionVercel({ statut: 200, texte: '{"identite":"tracefab_runtime"}', entetes: {} }),
  'un 200 de l application n est pas une protection',
);

verifier(
  !estProtectionVercel({ statut: 503, texte: '{"erreur":"worker indisponible"}', entetes: {} }),
  'un 503 de l application n est pas une protection',
);

// Le code de sortie distingue « acces manquant » de « critere en echec » :
// sans cette distinction, un acces absent se confond avec une preuve negative.
verifier(
  CODE_ACCES_ABSENT === 3,
  'le code de sortie d acces absent reste distinct du code d echec (2)',
  `recu ${CODE_ACCES_ABSENT}`,
);

console.log(echecs === 0 ? '  Detection : OK.' : `  Detection : ${echecs} echec(s).`);
process.exit(echecs === 0 ? 0 : 1);
