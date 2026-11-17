/**
 * Doublure de reseau pour les tests hors ligne du script de preuve P10.7.
 *
 * Reproduit les deux situations reellement observees sur la Preview, sans
 * joindre aucun hote. Chaque situation vient d'une mesure, pas d'une envie :
 *
 *   sso302  -> releve du 2026-11-16 : la Preview repond 302 vers
 *              vercel.com/sso-api et la requete n'atteint jamais l'application.
 *   app401  -> contrat de la route : sans jeton de sonde, l'application refuse.
 *   app200  -> application joignable et jeton accepte (chemin nominal complet).
 *
 * La doublure ne sert qu'aux tests : le script de preuve reel n'injecte jamais
 * ce module.
 */

/** Reponse minimale compatible avec ce que le script lit (status, text, headers). */
const reponse = (statut, corps, entetes = {}) => ({
  status: statut,
  headers: { get: (nom) => entetes[nom.toLowerCase()] ?? null },
  text: async () => (typeof corps === 'string' ? corps : JSON.stringify(corps)),
});

const CORPS_SSO = {
  error: 'vercel_auth_enabled',
  message: 'Protected by Vercel Authentication',
};

const CORPS_REFUS = { erreur: 'jeton de sonde absent ou invalide' };

export async function fetchSimule(url) {
  const scenario = process.env.TF_DOUBLURE_SCENARIO || 'sso302';

  if (scenario === 'sso302') {
    return reponse(302, '', { location: `https://vercel.com/sso-api?url=${encodeURIComponent(url)}` });
  }
  if (scenario === 'app401') {
    return reponse(401, CORPS_REFUS);
  }
  if (scenario === 'app503') {
    // Forme reelle relevee au run 44074983675 (SHA c0f8d6f) : la sonde est
    // ouverte, mais le runtime se declare non pret. Ce corps contient des
    // champs de diagnostic UTILES, et aucun secret.
    return reponse(503, {
      schema: 'tracefab-p2-readiness-v1',
      ready: false,
      configurationOnly: true,
      configurationSuffisante: false,
      identiteSaine: true,
      services: { privateStorage: { configured: false, missing: ['PRIVATE_STORAGE_ENDPOINT'] } },
      identityTokens: { configured: false, mode: 'non_configure' },
    });
  }
  if (scenario === 'app200') {
    return reponse(200, {
      identite: 'tracefab_runtime',
      hmac: 'chargee',
      sha: process.env.GITHUB_SHA || null,
    });
  }
  throw new Error(`scenario inconnu: ${scenario}`);
}
