/**
 * Securite du harnais Preview — expurgation et construction des en-tetes.
 *
 * CE MODULE EST TESTE UNITAIREMENT par
 * `scripts/test_preview_journeys_guards.mjs`, sans reseau ni secret.
 *
 * REGLE 1 — une URL presignee est une ORIGINE TIERCE.
 * Le secret de bypass Vercel, le jeton Clerk et l'identifiant de locataire ne
 * doivent JAMAIS y etre envoyes : l'en-tete `x-vercel-protection-bypass`
 * contient un secret, et `Authorization` contient un jeton de session. Les
 * envoyer au bucket S3/R2 reviendrait a les divulguer a un autre service.
 * Seul un petit ensemble d'en-tetes inoffensifs (Content-Type) est autorise
 * sur ces requetes.
 *
 * REGLE 2 — aucune preuve ne contient de valeur sensible.
 * Les motifs couvrent jetons JWT, cles Clerk, URLs de base, UUID et en-tetes
 * Bearer. Les valeurs de secrets REELLES du process (bypass, cle, identites)
 * sont en plus retirees litteralement, quelle que soit leur forme.
 */
const MOTIFS_SENSIBLES = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /sk_(?:test|live)_[A-Za-z0-9_-]{6,}/g,
  /x-vercel-protection-bypass\s*[:=]\s*[^\s,;"']+/gi,
  /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
  /postgresql?:\/\/[^\s"']+/gi,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
];

/** Cree une fonction d'expurgation liee aux valeurs de secrets du process. */
export function creerExpurgateur(valeurs = []) {
  const supplementaires = valeurs.filter((v) => typeof v === 'string' && v.length >= 8);
  return function expurger(value) {
    let texte = String(value ?? '');
    for (const motif of MOTIFS_SENSIBLES) texte = texte.replace(motif, '[redacted]');
    for (const valeur of supplementaires) texte = texte.split(valeur).join('[redacted]');
    return texte;
  };
}

/** Gabarit de chemin : aucun identifiant concret n'est journalise. */
export function gabarit(path) {
  return String(path)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ':id')
    .replace(/\?.*$/, '');
}

/** En-tetes autorises sur une requete vers une URL presignee (origine tierce). */
const EN_TETES_EXTERNES_AUTORISES = new Set(['content-type']);

/**
 * Construit les en-tetes d'une requete du harnais.
 *
 * @param {object} opts
 * @param {boolean} opts.externe      true = URL presignee S3/R2, pas la Preview
 * @param {string}  [opts.jeton]      jeton de session Clerk (interne seulement)
 * @param {string}  [opts.organisation] identifiant du locataire (interne seulement)
 * @param {object}  [opts.entetes]   en-tetes supplementaires (filtres si externe)
 * @param {string}  [opts.bypass]    secret de bypass Vercel autorise (interne seulement)
 */
export function construireEntetes({ externe = false, jeton, organisation, entetes = {}, bypass = '' } = {}) {
  if (externe) {
    if (jeton || organisation) {
      throw new Error('external_request_must_not_carry_identity');
    }
    const propres = {};
    for (const [cle, valeur] of Object.entries(entetes || {})) {
      if (EN_TETES_EXTERNES_AUTORISES.has(String(cle).toLowerCase())) propres[cle] = valeur;
    }
    return propres;
  }
  const resultat = {};
  if (bypass) {
    resultat['x-vercel-protection-bypass'] = bypass;
    resultat['x-vercel-set-bypass-cookie'] = 'true';
  }
  Object.assign(resultat, entetes || {});
  if (jeton) resultat.Authorization = `Bearer ${jeton}`;
  if (organisation) resultat['X-Tracefab-Organization-Id'] = organisation;
  return resultat;
}

/**
 * Classifie une reponse /api/health obtenue SANS bypass.
 * Fonction pure : les cas sont eprouves unitairement (ce ne sont PAS des
 * preuves de Preview, seulement la logique de la sonde).
 */
export function classifierProtection({ statut = 0, lieu = '', typeContenu = '', corps = '' } = {}) {
  const pageProtection = /Protected Deployment|Log in to Vercel|vercel_auth_enabled|sso-api/i.test(corps)
    || /vercel\.com|sso-api/i.test(lieu)
    || [401, 403].includes(statut)
    || ([301, 302, 307, 308].includes(statut) && String(lieu).length > 0);
  const reponseApplicative = statut === 200 && /application\/json/.test(typeContenu)
    && /"ok"\s*:\s*true/.test(corps);
  const verdict = reponseApplicative && !pageProtection ? 'FAIL'
    : pageProtection ? 'PASS' : 'BLOCKED';
  return { pageProtection, reponseApplicative, verdict };
}
