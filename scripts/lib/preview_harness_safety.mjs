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
import { isIP } from 'node:net';

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

/**
 * Autorise UNIQUEMENT l'origine de la Preview de branche attes­tee par
 * l'operateur. Le suffixe vercel.app seul ne prouve pas qu'une URL n'est
 * pas celle d'un deploiement de production. Cette garde est necessaire mais
 * ne prouve PAS que les services pointent vers des ressources de test.
 */
export function validerOriginePreview(raw, approvedOrigin) {
  let candidate, approved;
  try {
    candidate = new URL(raw);
    approved = new URL(approvedOrigin);
  } catch {
    throw new Error('preview_origin_invalid');
  }
  const canonicalOrigin = (u) => u.protocol === 'https:' && !u.username && !u.password
    && !u.port && u.pathname === '/' && !u.search && !u.hash;
  if (!canonicalOrigin(candidate) || !canonicalOrigin(approved)) {
    throw new Error('preview_origin_invalid');
  }
  // Alias de branche pour une branche Arena du projet tracefab, et non
  // l'alias generique tracefab.vercel.app ni l'alias de production main.
  if (!/^tracefab-git-arena-[a-z0-9-]+\.vercel\.app$/.test(candidate.hostname)) {
    throw new Error('preview_origin_not_branch_alias');
  }
  if (candidate.origin !== approved.origin) throw new Error('preview_origin_not_approved');
  return candidate.origin;
}

/**
 * N'autorise les URL presignees qu'en HTTPS, sur l'hote de stockage de TEST
 * prealablement fixe par l'operateur. Ne renvoie jamais l'URL dans une erreur.
 */
export function validerUrlStockage(raw, expectedHost) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('storage_url_invalid'); }
  const host = String(expectedHost || '').trim().toLowerCase();
  if (!host || host !== url.hostname || url.protocol !== 'https:' || url.username || url.password
      || url.port || isIP(url.hostname.replace(/^\[|\]$/g, '')) || url.hostname === 'localhost'
      || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')) {
    throw new Error('storage_origin_not_approved');
  }
  return url;
}

/** Les 68 octets canoniques EICAR, construits sans ecrire de fichier. */
export function eicarTestBytes() {
  return Buffer.from([
    'X5O!P%@AP[4', '\\', 'PZX54(P^)7CC)7}$',
    'EICAR', '-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
  ].join(''), 'ascii');
}

/**
 * Calcule l'attente jusqu'apres l'expiration reelle d'un JWT Clerk. Le
 * payload n'est pas utilise pour authentifier : seul l'appel HTTP exercera
 * la vraie validation. Une marge de 7 s couvre le clock skew de Clerk (5 s).
 */
export function attendreExpirationMs(jwt, nowMs = Date.now()) {
  let exp;
  try { exp = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).exp; }
  catch { throw new Error('token_expiration_unreadable'); }
  if (!Number.isSafeInteger(exp) || exp <= 0) throw new Error('token_expiration_unreadable');
  const attente = Math.max(0, exp * 1000 + 7000 - nowMs);
  if (attente > 180000) throw new Error('token_expiration_too_far');
  return attente;
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
export function classifierProtection({ statut = 0, lieu = '', chemin = '', typeContenu = '', corps = '' } = {}) {
  // Une redirection quelconque, ou un 401 de l'API, ne prouve PAS que la
  // protection Vercel est active. Il faut un indicateur specifique a Vercel.
  const hoteVercel = lieu === 'vercel.com' || lieu.endsWith('.vercel.com');
  const cheminSso = /^\/(sso-api|login)(\/|$)/.test(chemin);
  const redirectionVercel = [301, 302, 307, 308].includes(statut) && hoteVercel && cheminSso;
  const pageVercel = /Protected Deployment.{0,100}Vercel|vercel_auth_enabled|Log in to Vercel/i.test(corps);
  const pageProtection = redirectionVercel || pageVercel;
  const reponseApplicative = statut === 200 && /application\/json/.test(typeContenu)
    && /"ok"\s*:\s*true/.test(corps);
  const verdict = reponseApplicative && !pageProtection ? 'FAIL'
    : pageProtection ? 'PASS' : 'BLOCKED';
  return { pageProtection, reponseApplicative, verdict };
}
