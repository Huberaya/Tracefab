/**
 * Signature d'un jeton d'identite SYSTEME, pour les suites de test.
 *
 * La cle est lue depuis `TRACEFAB_IDENTITY_KEY` (la meme variable que
 * l'application) : aucune valeur n'est ecrite dans ce depot, et aucune suite ne
 * peut « reussir » avec une cle inventee, puisque la base compare a la cle
 * reellement provisionnee dans `tracefab_identity_cles`.
 *
 * Ce module ne sert QU'AUX TESTS : il signe ce que l'application signe, pour
 * pouvoir eprouver les deux cotes de la chaine sans deployer une application.
 */
import { createHmac } from 'node:crypto';

export const USAGE_SYSTEME = 'tracefab_system';
export const IDENTITE_SYSTEME = 'tracefab_worker';

/** Corps canonique + MAC. `cle` explicite pour les tests de rotation. */
export function signerJetonSysteme({ cle, expiration, identite = IDENTITE_SYSTEME, usage = USAGE_SYSTEME }) {
  if (typeof cle !== 'string' || cle.trim() === '') {
    throw new Error('cle absente : poser TRACEFAB_IDENTITY_KEY avant de signer');
  }
  const corps = `v1|${usage}|${identite}|${expiration}`;
  const mac = createHmac('sha256', Buffer.from(cle.trim(), 'hex')).update(corps).digest('hex');
  return `${corps}.${mac}`;
}

/** Jeton valide pour `dureeSecondes` (defaut 60). */
export function jetonSystemeValide({ cle, dureeSecondes = 60, maintenant = Math.floor(Date.now() / 1000) }) {
  return signerJetonSysteme({ cle, expiration: maintenant + dureeSecondes });
}
