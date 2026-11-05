/**
 * Comment un point d'appel arme le locataire actif.
 *
 * Deux formes sont legitimes, et une seule chose compte : le locataire est
 * ecrit dans la transaction SQL AVANT la premiere lecture metier.
 *
 *   1. `withTracefabUserContext(id, email, cb, tenant)` — le locataire est
 *      passe en quatrieme argument.
 *   2. `withTracefabRequestContext(req, user, cb)` — le locataire est lu dans
 *      la requete (en-tete `X-Tracefab-Organization-Id`, puis query string)
 *      par le helper lui-meme.
 *
 * Les contrats statiques ecrits avant le 2026-11-05 ne connaissaient que la
 * premiere forme : ils refusaient la seconde alors qu'elle arme davantage —
 * elle rend l'oubli impossible a ecrire. Ce module donne une seule definition,
 * utilisee par tous les contrats, pour que la reconnaissance des deux formes
 * ne se reduise pas a un `includes` recopie dans chaque fichier.
 *
 * Ce que la reconnaissance NE fait PAS : considerer comme arme un appel qui
 * n'ecrit aucun locataire. Un `withTracefabUserContext` a trois arguments
 * reste non arme, et c'est exactement ce que ces contrats doivent refuser.
 */

/** Formes d'armement explicite du locataire, en quatrieme argument. */
const ARGUMENT_FORMS = [
  /},\s*requestedTenantId\(req\),?\s*\)/,
  /},\s*activeOrganizationId,?\s*\)/,
  /},\s*organizationId,?\s*\)/,
  /},\s*requestedOrgId,?\s*\)/,
  /},\s*requestedOrganizationId,?\s*\)/,
  /},\s*tenant\.organizationId,?\s*\)/,
];

/** Variante orientee requete : elle arme `requestedTenantId(req)` par construction. */
const REQUEST_FORM = /\bwithTracefabRequestContext\(\s*req\s*,/;

/** Le source arme-t-il le locataire actif dans sa transaction ? */
export function armeLeTenant(source) {
  return REQUEST_FORM.test(source) || ARGUMENT_FORMS.some((form) => form.test(source));
}

/** Nombre d'armements visibles dans le source, toutes formes confondues. */
export function nombreArmements(source) {
  const parArgument = ARGUMENT_FORMS.reduce(
    (total, form) => total + (source.match(new RegExp(form.source, 'g')) || []).length,
    0,
  );
  const parRequete = (source.match(new RegExp(REQUEST_FORM.source, 'g')) || []).length;
  return parArgument + parRequete;
}
