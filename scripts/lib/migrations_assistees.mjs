/**
 * Aucune migration de la chaîne courante ne requiert SUPERUSER.
 *
 * 20261028120100_worker_identity_not_forgeable est compatible avec un rôle
 * de migration non-superutilisateur disposant de CREATEROLE et propriétaire
 * des fonctions : création worker avec attributs minimaux, GRANT explicite
 * INHERIT/SET, CREATE temporaire sur public pour le transfert de fonctions,
 * puis REVOKE CREATE. L'appartenance SET reste au rôle de migration pour les
 * migrations suivantes ; ADMIN OPTION n'est jamais accordée.
 *
 * Le test P10.5 exécute cette migration avec tracefab_migrator NOSUPERUSER.
 */
export const MIGRATIONS_ASSISTEES = Object.freeze({});

export function exigeAssistance(nom) {
  return Object.prototype.hasOwnProperty.call(MIGRATIONS_ASSISTEES, nom);
}

export async function preparerAppartenance() {
  return { revoques: [] };
}
