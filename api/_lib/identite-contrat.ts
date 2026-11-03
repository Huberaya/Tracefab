/**
 * Contrat de sécurité de l'identité runtime — SANS dépendance à Prisma.
 *
 * POURQUOI CE FICHIER EST SÉPARÉ (P10.7)
 *
 * La comparaison vivait dans `readiness-probes.ts`, qui importe le client
 * Prisma. Un contrat qu'on ne peut pas exécuter sans base générée est un contrat
 * qu'on ne teste pas : il ne se vérifie alors qu'en production, c'est-à-dire
 * trop tard. Ici il n'y a qu'une fonction pure et un type — donc un test qui
 * tourne partout, y compris hors ligne.
 *
 * CE QU'IL AJOUTE À P10.5
 *
 * `current_user = tracefab_app`, `NOSUPERUSER`, `NOBYPASSRLS` ne suffisent pas.
 * Un rôle sans aucun attribut privilégié qui est MEMBRE d'un rôle qui en porte
 * un redevient privilégié par `SET ROLE` : la RLS n'est alors pas plus opposable
 * que si c'était lui qui portait l'attribut. La mesure des appartenances doit
 * donc être TRANSITIVE, et le contrat doit la refuser.
 */

export type IdentiteRuntime = {
  /** La sonde a-t-elle réellement interrogé la connexion du runtime ? */
  measured: boolean;
  currentUser: string | null;
  sessionUser: string | null;
  database: string | null;
  bypassesRls: boolean | null;
  isSuperuser: boolean | null;
  /** Rôles atteignables (directement ou non) qui portent SUPERUSER ou BYPASSRLS. */
  privilegedMemberships: string[];
  /** Vrai dès qu'un rôle atteignable est privilégié. */
  canEscalate: boolean;
  detail: string;
};

/** Le rôle que le runtime DOIT endosser. */
export const ROLE_RUNTIME_ATTENDU = 'tracefab_app';

/**
 * Le contrat. Volontairement strict : tout champ absent vaut refus.
 *
 * @param identite résultat de la sonde runtime (jamais une supposition)
 */
export function identiteRuntimeSure(identite: IdentiteRuntime | undefined | null): boolean {
  if (!identite || identite.measured !== true) return false;
  if (identite.currentUser !== ROLE_RUNTIME_ATTENDU) return false;
  if (identite.sessionUser !== ROLE_RUNTIME_ATTENDU) return false;
  if (identite.bypassesRls !== false) return false;
  if (identite.isSuperuser !== false) return false;
  // Un rôle atteignable privilégié rend le refus ci-dessus contournable par un
  // simple `SET ROLE` : on refuse, même si le rôle courant est irréprochable.
  if (identite.canEscalate !== false) return false;
  if (Array.isArray(identite.privilegedMemberships) && identite.privilegedMemberships.length > 0) return false;
  return true;
}

/** Écart lisible, sans valeur sensible : sert aux diagnostics et aux journaux. */
export function ecartIdentiteRuntime(identite: IdentiteRuntime | undefined | null): string[] {
  if (!identite || identite.measured !== true) return ['identité non mesurée'];
  const ecarts: string[] = [];
  if (identite.currentUser !== ROLE_RUNTIME_ATTENDU) ecarts.push(`current_user = ${identite.currentUser ?? 'inconnu'}`);
  if (identite.sessionUser !== ROLE_RUNTIME_ATTENDU) ecarts.push(`session_user = ${identite.sessionUser ?? 'inconnu'}`);
  if (identite.isSuperuser !== false) ecarts.push('SUPERUSER');
  if (identite.bypassesRls !== false) ecarts.push('BYPASSRLS');
  if (identite.canEscalate !== false || (identite.privilegedMemberships ?? []).length > 0) {
    ecarts.push(`appartenance privilégiée atteignable : ${(identite.privilegedMemberships ?? []).join(', ') || 'non détaillée'}`);
  }
  return ecarts;
}
