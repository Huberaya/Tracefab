/**
 * Garde-fou des identites de test utilisees par le harnais P1.
 *
 * POURQUOI CE MODULE EXISTE
 *   La preparation des sessions Clerk cree trois comptes de test dans
 *   l'instance de TEST. Toute adresse qui sortirait de ce perimetre
 *   risquerait d'ecrire sur une vraie boite (spam, fuite d'identite de test,
 *   usage interdit). Le perimetre est donc une liste EXPLICITE de domaines,
 *   partagee entre le script de preparation et ses tests de non-regression :
 *   un seul module, une seule source de verite.
 *
 * POURQUOI CES DOMAINES
 *   `example.com`, `example.org` et `example.net` sont reserveres a la
 *   documentation par la RFC 2606 : ils n'ont jamais ete destines a recevoir
 *   du courrier reel, et ce sont les domaines pris comme exemple par la
 *   documentation officielle de Clerk pour la creation de comptes.
 *
 *   Le domaine historique `tracefab.test` (TLD special-use `.test`, RFC 6761)
 *   a ete RETIRE du perimetre : le 2026-10-24, l'API Clerk de l'instance de
 *   test a refuse `p1-brand-a@tracefab.test` en 422
 *   `form_param_format_invalid` (« Email address must be a valid email
 *   address. », paramName `email_address`) — mesuree sur le run
 *   https://github.com/Huberaya/Tracefab/actions/runs/40043764425. Un
 *   validateur de format qui refuse un domaine special-use peut rejeter
 *   n'importe quel TLD rare : les candidats offerts au script sont donc
 *   bornes aux trois domaines RFC 2606, dans cet ordre.
 *
 * CE QUE CE MODULE NE FAIT PAS
 *   il ne contacte aucune API, ne lit aucun secret, ne cree rien : c'est une
 *   fonction pure, testable hors ligne.
 */

/** Domaines autorises pour toute identite de test, dans l'ordre des candidats. */
export const DOMAINES_IDENTITES_DE_TEST = Object.freeze([
  'example.com',
  'example.org',
  'example.net',
]);

/**
 * Vrai uniquement pour une adresse dont le domaine est EXACTEMENT l'un des
 * domaines autorises (apres normalisation en minuscules). Pas de sous-domaine
 * implicite, pas de suffixe partiel : `user@sub.example.com` est refuse,
 * `user@notexample.com` est refuse, `user@gmail.com` est refuse.
 *
 * @param {unknown} adresse
 * @returns {boolean}
 */
export function adresseAutorisee(adresse) {
  if (typeof adresse !== 'string') return false;
  const canonique = adresse.trim().toLowerCase();
  if (!canonique || /\s/.test(canonique)) return false;
  const parties = canonique.split('@');
  if (parties.length !== 2) return false;
  const [local, domaine] = parties;
  if (!local || !domaine) return false;
  return DOMAINES_IDENTITES_DE_TEST.includes(domaine);
}

/**
 * Les candidats d'identite pour un persona, dans l'ordre d'essai : le
 * premier que l'instance Clerk accepte devient l'adresse retenue.
 *
 * @param {string} base partie locale du persona (ex. `p1-brand-a`)
 * @returns {string[]}
 */
export function candidatsIdentite(base) {
  if (typeof base !== 'string' || !base || /\s|@/.test(base)) {
    throw new Error('base_identite_invalide');
  }
  return DOMAINES_IDENTITES_DE_TEST.map((domaine) => `${base}@${domaine}`);
}
