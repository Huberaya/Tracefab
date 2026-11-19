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
      // Mesure du 2026-11-17 : la sonde publie l etat de la BASE meme quand la
      // cle runtime manque, pour que l operateur sache si provisionner est
      // necessaire ou si une version active existe deja.
      baseIdentite: { table_presente: true, table_vue_par_pg_class: true, prisma_migrations_presente: true, tables_publiques: 87, fonction_posterieure_presente: true, identite_base: { base_oid: 16384, base_nom: 'neondb', hote_empreinte: '0123456789ab', schemas_empreinte: 'abcdef012345', sondes_p107: { tracefab_identity_cles: true }, hote_conforme: true, hote_attendu_declare: true }, rls_forcee: true, mode_strict: false },
    });
  }
  if (scenario === 'app503-contexte-ok' || scenario === 'app503-contexte-faux') {
    // C4.6 — le contexte tenant MESURE. Deux variantes, et la seconde est la
    // plus importante : une sonde qui ne saurait rendre que des verts ne
    // prouverait rien. `...-faux` simule une base qui ACCEPTE un jeton signe
    // pour une AUTRE organisation, c'est-a-dire exactement le defaut que le
    // controle negatif doit detecter.
    const correct = scenario === 'app503-contexte-ok';
    return reponse(503, {
      schema: 'tracefab-p2-readiness-v1',
      ready: false,
      configurationOnly: true,
      configurationSuffisante: false,
      identiteSaine: true,
      services: { privateStorage: { configured: false, missing: ['PRIVATE_STORAGE_ENDPOINT'] } },
      identityTokens: { configured: true, mode: 'signe' },
      identitySysteme: { configured: true, mode: 'signe', usage: 'tracefab_system',
        verifiee_par_la_base: true, verification: 'aller_retour_reussi' },
      databaseIdentity: { measured: true, currentUser: 'tracefab_app', sessionUser: 'tracefab_app',
        database: 'neondb', bypassesRls: false, isSuperuser: false,
        privilegedMemberships: [], canEscalate: false, detail: 'identite lue' },
      contexteTenant: {
        measured: true,
        jetonAccepte: true,
        identiteLue: true,
        organisationEtrangereRefusee: correct,
        gucRemisAZero: true,
        detail: 'contexte tenant pose puis relu',
      },
    });
  }
  if (scenario === 'app503-contexte-non-mesure') {
    // Le champ existe mais la mesure a echoue : C4.6 doit rendre INDETERMINATE,
    // surtout pas PASS ni FAIL.
    return reponse(503, {
      schema: 'tracefab-p2-readiness-v1',
      ready: false,
      configurationOnly: true,
      configurationSuffisante: false,
      services: {},
      identityTokens: { configured: true, mode: 'signe' },
      identitySysteme: { configured: true, mode: 'signe', usage: 'tracefab_system',
        verifiee_par_la_base: true, verification: 'aller_retour_reussi' },
      databaseIdentity: { measured: true, currentUser: 'tracefab_app', sessionUser: 'tracefab_app',
        database: 'neondb', bypassesRls: false, isSuperuser: false,
        privilegedMemberships: [], canEscalate: false, detail: 'identite lue' },
      contexteTenant: { measured: false, jetonAccepte: null, identiteLue: null,
        organisationEtrangereRefusee: null, gucRemisAZero: null, detail: 'transaction en erreur' },
    });
  }
  if (scenario === 'app503-rattachement-ok' || scenario === 'app503-rattachement-faux') {
    // C5 — le rattachement. `...-faux` simule un deploiement qui joint un AUTRE
    // hote que celui declare : c'est le seul cas ou l'operateur doit refuser de
    // considerer la base comme la bonne.
    const correct = scenario === 'app503-rattachement-ok';
    return reponse(503, {
      schema: 'tracefab-p2-readiness-v1',
      ready: false,
      configurationOnly: true,
      configurationSuffisante: false,
      services: {},
      identityTokens: { configured: true, mode: 'signe' },
      identitySysteme: { configured: true, mode: 'signe', usage: 'tracefab_system',
        verifiee_par_la_base: true, verification: 'aller_retour_reussi' },
      baseIdentite: {
        table_presente: true, table_vue_par_pg_class: true, prisma_migrations_presente: true,
        tables_publiques: 87, fonction_posterieure_presente: true,
        identite_base: {
          base_oid: 16396, base_nom: 'neondb', hote_empreinte: '55c809d501c6',
          schemas_empreinte: '4a145f39b5da', sondes_p107: { tracefab_identity_cles: true },
          hote_conforme: correct, hote_attendu_declare: true,
          hote: correct
            ? 'ep-bonne-branche-123.eu-central-1.aws.neon.tech'
            : 'ep-autre-branche-999.eu-central-1.aws.neon.tech',
          hote_est_pooler: false,
        },
        rls_forcee: true, mode_strict: false,
      },
      contexteTenant: { measured: true, jetonAccepte: true, identiteLue: true,
        organisationEtrangereRefusee: true, gucRemisAZero: true, detail: 'ok' },
    });
  }
  if (scenario === 'app503-rattachement-non-declare') {
    // Aucun endpoint declare : C5.2 et C5.3 doivent etre INDETERMINATE, et
    // surtout pas PASS — ne pas mesurer n'est pas mesurer juste.
    return reponse(503, {
      schema: 'tracefab-p2-readiness-v1', ready: false, configurationOnly: true,
      configurationSuffisante: false, services: {},
      identityTokens: { configured: true, mode: 'signe' },
      identitySysteme: { configured: true, mode: 'signe', usage: 'tracefab_system',
        verifiee_par_la_base: true, verification: 'aller_retour_reussi' },
      baseIdentite: {
        table_presente: true, table_vue_par_pg_class: true, prisma_migrations_presente: true,
        tables_publiques: 87, fonction_posterieure_presente: true,
        identite_base: {
          base_oid: 16396, base_nom: 'neondb', hote_empreinte: '55c809d501c6',
          schemas_empreinte: '4a145f39b5da', sondes_p107: { tracefab_identity_cles: true },
          hote_conforme: null, hote_attendu_declare: false,
          hote: 'ep-inconnue-456.eu-central-1.aws.neon.tech', hote_est_pooler: false,
        },
        rls_forcee: true, mode_strict: false,
      },
      contexteTenant: { measured: true, jetonAccepte: true, identiteLue: true,
        organisationEtrangereRefusee: true, gucRemisAZero: true, detail: 'ok' },
    });
  }
  if (scenario === 'app503-hote-avec-mot-de-passe' || scenario === 'app503-hote-propre') {
    // P10.8 — l'hote est publie pour rendre le rattachement decidable. Le
    // premier scenario simule une extraction RATEE qui verserait la chaine de
    // connexion ; la preuve doit alors etre RETIREE, jamais publiee.
    const hote = scenario === 'app503-hote-propre'
      ? 'ep-exemple-123.eu-central-1.aws.neon.tech'
      : 'tracefab_app:MOTDEPASSE_FACTICE@ep-exemple-123.eu-central-1.aws.neon.tech';
    return reponse(503, {
      schema: 'tracefab-p2-readiness-v1',
      ready: false,
      configurationOnly: true,
      configurationSuffisante: false,
      services: {},
      identityTokens: { configured: true, mode: 'signe' },
      identitySysteme: { configured: true, mode: 'signe', usage: 'tracefab_system',
        verifiee_par_la_base: true, verification: 'aller_retour_reussi' },
      identityEcarts: [],
      baseIdentite: {
        table_presente: true, table_vue_par_pg_class: true, prisma_migrations_presente: true,
        tables_publiques: 87, fonction_posterieure_presente: true,
        identite_base: {
          base_oid: 16396, base_nom: 'neondb', hote_empreinte: '55c809d501c6',
          schemas_empreinte: '4a145f39b5da', sondes_p107: { tracefab_identity_cles: true },
          hote_conforme: null, hote_attendu_declare: false,
          hote, hote_est_pooler: false,
        },
        rls_forcee: true, mode_strict: false,
      },
      contexteTenant: { measured: true, jetonAccepte: true, identiteLue: true,
        organisationEtrangereRefusee: true, gucRemisAZero: true, detail: 'ok' },
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
