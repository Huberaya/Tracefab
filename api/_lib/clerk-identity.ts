/**
 * Identité Clerk — la seule partie déterministe de `resolveClerkUser`.
 *
 * POURQUOI CE MODULE EXISTE
 * -------------------------
 * L'adresse e-mail renvoyée ici alimente `tracefab.user_email`, qui est la
 * SEULE barrière de la politique `passport_access_select` (migration
 * 20261006250000) : un demandeur externe voit ses propres demandes d'accès
 * fournisseur par égalité d'e-mail.
 *
 * Mesure du 28/10/2026, base jetable, rôle `tracefab_app` sans BYPASSRLS :
 *   sans GUC                       -> 0 ligne
 *   GUC = e-mail de la victime     -> 1 ligne
 *   GUC = un autre e-mail          -> 0 ligne
 *
 * Une adresse non vérifiée suffirait donc à lire la demande d'un tiers (nom,
 * société, e-mail). La règle est isolée dans une fonction pure, sans accès
 * base ni réseau, pour être éprouvée cas par cas plutôt que par assertion
 * statique sur le source de `auth.ts`.
 *
 * CE QUE LA FONCTION GARANTIT
 *   - l'adresse retenue est l'adresse PRIMAIRE (jamais une adresse secondaire) ;
 *   - elle est déclarée vérifiée par le fournisseur d'identité ;
 *   - elle n'est pas vide après normalisation ;
 *   - le refus porte un motif nommé, sans recopier l'adresse reçue : un message
 *     d'erreur ne doit pas divulguer de donnée personnelle.
 */

export type ClerkVerificationLike = { status?: string | null } | null | undefined;

export type ClerkEmailAddressLike = {
  id: string;
  emailAddress: string;
  verification?: ClerkVerificationLike;
};

export type ClerkUserLike = {
  emailAddresses: ClerkEmailAddressLike[];
  primaryEmailAddressId?: string | null;
};

/** Motif de refus : aucune adresse primaire exploitable. */
export const MOTIF_ADRESSE_ABSENTE = 'clerk_email_required';
/** Motif de refus : adresse primaire non vérifiée par le fournisseur. */
export const MOTIF_ADRESSE_NON_VERIFIEE = 'clerk_email_unverified';

/**
 * Rend l'adresse primaire vérifiée, ou lève une erreur au motif nommé.
 *
 * L'erreur ne contient jamais l'adresse : elle est journalisée et parfois
 * renvoyée telle quelle par la couche HTTP.
 */
export function verifiedPrimaryEmail(clerkUser: ClerkUserLike): string {
  const primary = (clerkUser.emailAddresses ?? []).find(
    ({ id }) => id === clerkUser.primaryEmailAddressId,
  );

  const adresse = (primary?.emailAddress ?? '').trim();
  if (adresse.length === 0) throw new Error(MOTIF_ADRESSE_ABSENTE);

  // `status` vaut 'verified' | 'unverified' | 'transferable' | 'failed'.
  // Seul 'verified' autorise la propagation vers `tracefab.user_email`.
  if (primary?.verification?.status !== 'verified') {
    throw new Error(MOTIF_ADRESSE_NON_VERIFIEE);
  }

  return adresse;
}
