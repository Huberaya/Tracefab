/**
 * La table ne conserve pas d'attestation serveur identifiant le moteur
 * antivirus ni le chiffrement du fournisseur. `documents.metadata` est
 * modifiable par le client : elle n'est pas une source de preuve. Ne jamais
 * fabriquer un nom de moteur, un verdict ou un chiffrement constate.
 */
export function unavailableSecurityAttestations() {
  return {
    antivirus: {
      clean: null,
      status: 'not_attested',
      engine: null,
      verifiedAt: null,
      reason: 'server_attestation_not_recorded',
    },
    isEncryptedAtRest: null,
  };
}
