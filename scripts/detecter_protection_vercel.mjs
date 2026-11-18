/**
 * Distinguer une reponse de Vercel Authentication d'une reponse de l'application.
 *
 * POURQUOI CE MODULE EXISTE
 * -------------------------
 * Mesure du 2026-11-16, run 43850436311 : la Preview repondait 302 vers
 * `vercel.com/sso-api`. Le script de preuve lisait ce 302 comme un echec des
 * criteres C3.1 a C3.3, alors que la requete n'atteignait jamais l'application.
 * Un 302 n'est pas un refus : c'est une absence d'acces. Confondre les deux
 * produit un faux negatif — on declare l'application fautive quand c'est
 * l'observateur qui n'a pas le droit d'entrer. C'est exactement ce que la
 * mission interdit : « ne jamais transformer un inconnu en echec ni en succes ».
 *
 * La regle est volontairement stricte sur les deux marques observees :
 *   - redirection 302 (Vercel Authentication renvoie vers son SSO) ;
 *   - corps ou en-tete portant `vercel_auth_enabled` /
 *     `Protected by Vercel Authentication` / `vercel.com/sso-api`.
 *
 * Un 401 SANS ces marques est un refus de l'application : il reste un echec
 * legitime du critere qui l'attendait.
 */

const MARQUE_CORPS = /vercel_auth_enabled|Protected by Vercel Authentication/i;
const MARQUE_LOCATION = /vercel\.com\/sso-api/i;

/**
 * @param {{statut?: number, texte?: string, entetes?: Headers|object}} reponse
 * @returns {boolean} vrai si l'obstacle vient de Vercel, pas de l'application
 */
export function estProtectionVercel(reponse) {
  if (!reponse || typeof reponse !== 'object') return false;
  if (reponse.statut === 302) return true;

  if (MARQUE_CORPS.test(reponse.texte || '')) return true;

  const entetes = reponse.entetes;
  let location = '';
  if (entetes && typeof entetes.get === 'function') location = entetes.get('location') || '';
  else if (entetes && typeof entetes === 'object') location = entetes.location || '';
  return MARQUE_LOCATION.test(String(location));
}

/** Code de sortie conventionnel : 3 = acces manquant, distinct de 2 = echec. */
export const CODE_ACCES_ABSENT = 3;
