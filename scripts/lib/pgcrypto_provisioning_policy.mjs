/**
 * Politique pure de classement des ACL pgcrypto avant provisionnement.
 *
 * Les résultats catalogues PostgreSQL sont fournis en entrée ; cette fonction
 * n'effectue aucune requête et ne modifie aucun état.
 */
export function determinerModePgcrypto({
  extensionPresente,
  extensionDisponible = false,
  peutInstaller = false,
  fonctions = [],
}) {
  if (!extensionPresente) {
    return extensionDisponible && peutInstaller
      ? { mode: 'install', reason: 'extension absente mais installable' }
      : { mode: null, reason: 'extension absente et installation non autorisée ou indisponible' };
  }

  if (!Array.isArray(fonctions) || fonctions.length === 0) {
    return { mode: null, reason: 'aucune fonction membre vérifiable' };
  }

  const publiques = fonctions.filter((f) => f.public_execute === true);
  if (publiques.length === 0 || publiques.every((f) => f.autorite_revoke === true)) {
    return { mode: 'modifiable', reason: 'ACL publiques absentes ou révocables par l’exécutant' };
  }

  const toutesPlateforme = publiques.every(
    (f) => f.proprietaire_superuser === true && f.autorite_revoke === false,
  );
  if (toutesPlateforme) {
    return {
      mode: 'managed-external',
      reason: 'ACL publiques préexistantes détenues par un superutilisateur externe non endossable',
    };
  }

  return {
    mode: null,
    reason: 'propriétaire externe non classé ou mélange de propriétaires publics',
  };
}
