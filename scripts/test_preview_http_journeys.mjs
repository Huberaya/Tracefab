#!/usr/bin/env node
/**
 * PARCOURS HTTP AUTHENTIFIES SUR UNE VERITABLE PREVIEW.
 *
 * CE QUE CE SCRIPT FAIT — et pourquoi il existe
 *
 * `scripts/test_mission_http_integration.mjs` prouve le code contre des
 * services de TEST LOCAUX (Clerk compatible JWKS, bucket S3 en memoire,
 * antivirus local). C'est utile, mais ce n'est PAS une preuve d'integration
 * avec les services manages. Ce script est l'epreuve manquante : il ne
 * demarre AUCUN service. Toutes les requetes partent en HTTP vers l'URL d'une
 * Preview Vercel deployee ; les jetons viennent d'une VERITABLE instance
 * Clerk de test (`sk_test_...`) via la BAPI ; les octets du document vont
 * dans le VRAI bucket prive presigne ; le VRAI antivirus rend le verdict.
 *
 * Aucune fonction interne de l'API n'est importee. Aucun mock, aucun client
 * Prisma, aucune base locale. Si la Preview, Clerk, le stockage ou
 * l'antivirus ne sont pas configurables, le script le dit et sort en
 * BLOCKED (2) — il ne fabrique jamais un succes.
 *
 * GARDES — LE REFUS EST LE DEFAUT
 *
 *   - TF_PREVIEW_HARNESS=1 obligatoire, sinon REFUS (3) ;
 *   - aucun contexte de production (NODE_ENV / VERCEL_ENV) accepte ;
 *   - CLERK_SECRET_KEY doit etre une cle d'instance de TEST `sk_test_`.
 *     Une cle `sk_live_` est refusee sans etre affichee ;
 *   - TRACEFAB_STAGING_URL doit etre l'alias de branche HTTPS de Tracefab et
 *     correspondre exactement a TF_PREVIEW_EXPECTED_ORIGIN (approuvee par
 *     l'operateur dans l'environnement protege) ;
 *   - TF_PREVIEW_TEST_ENV_CONFIRMED=1 et la concordance du SHA atteste sont
 *     obligatoires avant tout appel. L'operateur doit confirmer separement
 *     que base, Clerk, bucket et antivirus sont de TEST : l'attestation est
 *     une precaution, PAS une preuve technique de leur isolation ;
 *   - deux organisations de test preexistantes et distinctes sont exigees
 *     et leurs adhesions sont verifiees via /api/me. Aucune organisation
 *     n'est creee automatiquement ;
 *   - la protection Vercel n'est JAMAIS desactivee : le secret de bypass
 *     autorise est envoye dans l'en-tete officiel
 *     `x-vercel-protection-bypass`, jamais desactive cote serveur.
 *
 * CE QUI EST JOURNALISE
 *
 * Un identifiant de run, une etiquette de cas, une methode, un GABARIT de
 * chemin (les UUID sont remplaces), le statut attendu, le statut obtenu, la
 * duree et un code d'erreur applicatif borne. JAMAIS de jeton, de secret,
 * de cookie, d'e-mail, de corps de reponse, de nom de produit ni d'UUID.
 * Le fichier de preuve est JSON, expurge par `redactEvidence()`.
 *
 * VARIABLES (noms uniquement — aucune valeur n'est lue ici dans un rapport)
 *   TF_PREVIEW_HARNESS=1                     obligatoire
 *   TRACEFAB_STAGING_URL                    URL https de la Preview
 *   CLERK_SECRET_KEY                        sk_test_... de l'instance de test
 *   TF_PREVIEW_USER_ALPHA / _BETA           e-mail ou identifiant Clerk de test
 *   TF_VERCEL_BYPASS                        secret de bypass AUTORISE requis ;
 *                                           la protection reste active
 *   TF_PREVIEW_ORG_ALPHA / _BETA            UUID des organisations de TEST
 *   TF_PREVIEW_EXPECTED_ORIGIN             origine HTTPS verifiee par l'admin
 *   TF_PREVIEW_STORAGE_HOST                hote du stockage de TEST verifie
 *   TF_PREVIEW_DEPLOYED_SHA                SHA de la Preview verifie par l'admin
 *   GITHUB_SHA / TF_PREVIEW_CODE_SHA       SHA du code execute
 *   TF_PREVIEW_TEST_ENV_CONFIRMED=1          attestation ADMIN des services de test
 *   TF_PREVIEW_EVIDENCE                     preuve JSON sous /tmp
 *   TF_PREVIEW_SELFTEST=1                   verification des gardes, SANS reseau
 *
 * CODES DE SORTIE : 0 tous PASS · 1 au moins un FAIL · 2 BLOCKED · 3 REFUS
 */
import { randomUUID, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { creerExpurgateur, gabarit, construireEntetes, validerOriginePreview,
  validerUrlStockage, eicarTestBytes, classifierProtection, attendreExpirationMs } from './lib/preview_harness_safety.mjs';

const EXIT = { PASS: 0, FAIL: 1, BLOCKED: 2, REFUS: 3 };
const RUN_ID = `pv-${randomUUID().slice(0, 12)}`;

class ArretPreview extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const refuser = (message) => { throw new ArretPreview(EXIT.REFUS, message); };
const bloquer = (message) => { throw new ArretPreview(EXIT.BLOCKED, message); };
const echouer = (message) => { throw new ArretPreview(EXIT.FAIL, message); };
const preuves = [];
let echecs = 0;
let clerkPourNettoyage = null;
const sessionsCreees = [];
let raisonArret = null;
const CAS_REQUIS = [
  'P0', 'P9', 'J1.1', 'J1.2', 'J1.3', 'J1.4',
  'J2.1', 'J2.2', 'J2.3', 'J2.4', 'J2.5', 'J2.6', 'J2.7',
  'J3.1', 'J3.2', 'J3.3', 'J3.4', 'J4.1', 'J4.2', 'J4.3',
  ...Array.from({ length: 5 }, (_, i) => `J5.${i + 1}`),
  'J6.1', 'J6.2', 'J6.3', 'J6.4', 'J7.0',
  ...Array.from({ length: 7 }, (_, i) => `J7.1.${i + 1}`),
  'J7.2', 'J7.3', 'J7.4', 'J7.5', 'J7.6', 'J7.7', 'J8.0', 'J8.1', 'J8.2',
];
const estSelftest = process.env.TF_PREVIEW_SELFTEST === '1';
const cheminPreuve = resolve(String(process.env.TF_PREVIEW_EVIDENCE || `/tmp/tf-preview-evidence-${RUN_ID}.json`));
// Seuls des fichiers locaux sous /tmp peuvent contenir les preuves epurees.
const preuveActive = process.env.TF_PREVIEW_HARNESS === '1' && !estSelftest
  && cheminPreuve.startsWith('/tmp/');

/* ---------------------------------------------------------------------------
 * Expurgation et en-tetes : implementation unique, testee unitairement.
 * Voir scripts/lib/preview_harness_safety.mjs. L'expurgateur est lie aux
 * valeurs REELLES des secrets du process apres leur lecture (plus bas), ce
 * qui couvre aussi les formes de secret non reconnues par les motifs.
 * ------------------------------------------------------------------------- */
let expurger = creerExpurgateur([]);
const redigerSur = (value) => expurger(value);
export function redactEvidence(value) {
  // Expurger AVANT JSON.stringify : les secrets contenant des guillemets ou
  // des retours a la ligne restent detectables sous leur forme originale.
  if (typeof value === 'string') return redigerSur(value);
  if (Array.isArray(value)) return value.map(redactEvidence);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactEvidence(item)]));
  }
  return value;
}

function ecrirePreuve(status, code) {
  if (!preuveActive) return;
  const rapport = redactEvidence({
    runId: RUN_ID,
    sha: process.env.GITHUB_SHA || process.env.TF_PREVIEW_CODE_SHA || null,
    cible: 'preview',
    status,
    exitCode: code,
    raison: raisonArret,
    total: preuves.length,
    echecs,
    cas: preuves,
  });
  writeFileSync(cheminPreuve, JSON.stringify(rapport, null, 2), { mode: 0o600 });
}

async function main() {

/* ---------------------------------------------------------------------------
 * Auto-verification des gardes, sans aucun reseau.
 * ------------------------------------------------------------------------- */
if (estSelftest) {
  expurger = creerExpurgateur(['DUMMY_BYPASS_VALUE_123456']);
  const echantillon = {
    runId: RUN_ID,
    token: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.signature',
    cle: 'sk_test_abcdefghijklmnop',
    url: 'postgresql://user:pass@neon.tech/db',
    path: '/api/products/123e4567-e89b-12d3-a456-426614174000/dpp/preview',
    bypass: 'x-vercel-protection-bypass: DUMMY_BYPASS_VALUE_123456',
  };
  const nettoye = JSON.stringify(redactEvidence(echantillon));
  const controles = [
    [/eyJhbGciOi/, 'un jeton JWT est expurge'],
    [/sk_test_abcdefghijklmnop/, 'une cle Clerk de test est expurgee'],
    [/postgresql:\/\//, 'une chaine de connexion est expurgee'],
    [/426614174000/, 'un UUID est expurge'],
    [/DUMMY_BYPASS_VALUE_123456/, 'une valeur de bypass du process est expurgee'],
  ];
  let echecs = 0;
  for (const [motif, description] of controles) {
    const ok = !motif.test(nettoye);
    console.log(`  ${ok ? 'ok   ' : 'ECHEC'} ${description}`);
    if (!ok) echecs += 1;
  }
  console.log(`  ${gabarit('/api/products/123e4567-e89b-12d3-a456-426614174000/dpp/preview') === '/api/products/:id/dpp/preview' ? 'ok   ' : 'ECHEC'} les chemins sont journalises en gabarit`);
  if (gabarit('/api/products/123e4567-e89b-12d3-a456-426614174000/dpp/preview') !== '/api/products/:id/dpp/preview') echecs += 1;
  console.log(`\n  SELFTEST : ${echecs === 0 ? 'PASS' : 'FAIL'} (${6 - echecs}/6)`);
  if (echecs) process.exitCode = EXIT.FAIL;
  return;
}

/* ---------------------------------------------------------------------------
 * Gardes d'execution.
 * ------------------------------------------------------------------------- */
if (process.env.TF_PREVIEW_HARNESS !== '1') {
  refuser('TF_PREVIEW_HARNESS=1 absent : aucun appel reseau nest lance.');
}
if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') {
  refuser('contexte de production interdit.');
}
if (String(process.env.CLERK_SECRET_KEY || '').startsWith('sk_live_')) {
  refuser('cle Clerk de production detectee : refus (sk_live_ interdit).');
}

const CLE_CLERK = String(process.env.CLERK_SECRET_KEY || '').trim();
const BASE_BRUTE = String(process.env.TRACEFAB_STAGING_URL || '').trim();
const ORIGINE_APPROUVEE = String(process.env.TF_PREVIEW_EXPECTED_ORIGIN || '').trim();
const STORAGE_HOST = String(process.env.TF_PREVIEW_STORAGE_HOST || '').trim().toLowerCase();
const BYPASS = String(process.env.TF_VERCEL_BYPASS || '').trim();
const USER_ALPHA = String(process.env.TF_PREVIEW_USER_ALPHA || '').trim();
const USER_BETA = String(process.env.TF_PREVIEW_USER_BETA || '').trim();
const ORG_ALPHA = String(process.env.TF_PREVIEW_ORG_ALPHA || '').trim();
const ORG_BETA = String(process.env.TF_PREVIEW_ORG_BETA || '').trim();
const SHA_DEPLOYE = String(process.env.TF_PREVIEW_DEPLOYED_SHA || '').trim();
const SHA_CODE = String(process.env.GITHUB_SHA || process.env.TF_PREVIEW_CODE_SHA || '').trim();
const valeursSensibles = [BYPASS, CLE_CLERK, USER_ALPHA, USER_BETA, BASE_BRUTE,
  ORG_ALPHA, ORG_BETA];
expurger = creerExpurgateur(valeursSensibles);

// Le proprietaire de l'environnement doit verifier HORS de ce script que le
// deploiement, la base, Clerk, le bucket et l'antivirus sont tous de TEST.
// Cette attestation manuelle n'est PAS une preuve cryptographique d'isolation.
const MANQUANTS = [];
if (!CLE_CLERK.startsWith('sk_test_')) MANQUANTS.push('CLERK_SECRET_KEY (sk_test_ requis)');
if (!BASE_BRUTE) MANQUANTS.push('TRACEFAB_STAGING_URL');
if (!ORIGINE_APPROUVEE) MANQUANTS.push('TF_PREVIEW_EXPECTED_ORIGIN');
if (!STORAGE_HOST) MANQUANTS.push('TF_PREVIEW_STORAGE_HOST');
if (!BYPASS) MANQUANTS.push('TF_VERCEL_BYPASS');
if (!USER_ALPHA) MANQUANTS.push('TF_PREVIEW_USER_ALPHA');
if (!USER_BETA) MANQUANTS.push('TF_PREVIEW_USER_BETA');
if (!ORG_ALPHA) MANQUANTS.push('TF_PREVIEW_ORG_ALPHA');
if (!ORG_BETA) MANQUANTS.push('TF_PREVIEW_ORG_BETA');
if (!SHA_DEPLOYE) MANQUANTS.push('TF_PREVIEW_DEPLOYED_SHA');
if (!SHA_CODE) MANQUANTS.push('GITHUB_SHA ou TF_PREVIEW_CODE_SHA');
if (process.env.TF_PREVIEW_TEST_ENV_CONFIRMED !== '1') MANQUANTS.push('TF_PREVIEW_TEST_ENV_CONFIRMED=1');
if (MANQUANTS.length) {
  bloquer(`variables absentes ou invalides : ${MANQUANTS.join(', ')}. `
    + 'Aucune valeur ne doit figurer dans ce message.');
}
if (!preuveActive) refuser('TF_PREVIEW_EVIDENCE doit designer un fichier sous /tmp.');

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!uuid.test(ORG_ALPHA) || !uuid.test(ORG_BETA) || ORG_ALPHA === ORG_BETA) {
  refuser('deux UUID d organisations de TEST distinctes sont requis.');
}
if (USER_ALPHA === USER_BETA) refuser('deux identites Clerk de TEST distinctes sont requises.');
if (!BASE_BRUTE.startsWith('https://')) refuser('TRACEFAB_STAGING_URL doit etre en HTTPS.');
if (!/^[0-9a-f]{40}$/.test(SHA_DEPLOYE) || SHA_DEPLOYE !== SHA_CODE) {
  refuser('SHA du deploiement atteste different du SHA du code execute.');
}
let BASE;
try {
  BASE = validerOriginePreview(BASE_BRUTE, ORIGINE_APPROUVEE);
  // Ne pas attendre d'avoir deja ecrit en base pour detecter un hote invalide.
  validerUrlStockage(`https://${STORAGE_HOST}/`, STORAGE_HOST);
} catch (error) {
  const code = typeof error?.message === 'string' && /^[a-z_]+$/.test(error.message)
    ? error.message : 'invalid_configuration';
  refuser(`cible non autorisee (${code}) : origine Preview ou stockage invalide.`);
}
console.log(`  run=${RUN_ID} cible=<preview-approuvee> bypass=present`);

/* ---------------------------------------------------------------------------
 * Collecte des preuves.
 * ------------------------------------------------------------------------- */
const enregistrer = (cas, attendu, obtenu, reussi, detail, response, verdictOverride) => {
  const ligne = {
    runId: RUN_ID,
    cas,
    attendu: redigerSur(attendu).slice(0, 200),
    obtenu: redigerSur(obtenu).slice(0, 200),
    verdict: verdictOverride || (reussi ? 'PASS' : 'FAIL'),
    detail: detail ? redigerSur(detail).slice(0, 120) : undefined,
    ...(response ? {
      method: response.method,
      route: response.template,
      httpStatus: response.status,
      durationMs: response.ms,
    } : {}),
  };
  preuves.push(ligne);
  if (ligne.verdict === 'FAIL') echecs += 1;
  console.log(`  ${ligne.verdict.padEnd(7)} ${cas.padEnd(12)} attendu=${ligne.attendu} obtenu=${ligne.obtenu}`
    + (ligne.detail ? ` (${ligne.detail})` : ''));
};
const verifier = (cas, attendu, obtenu, condition, detail, response) =>
  enregistrer(cas, String(attendu), String(obtenu), Boolean(condition), detail, response);
const verifierHttp = (cas, attendu, response, condition, detail) =>
  verifier(cas, attendu, response.status, condition, detail, response);

// Le bypass Vercel et le jeton Clerk ne sont JAMAIS envoyes a une origine
// tierce (URL presignee S3/R2). construireEntetes() applique cette regle.

/**
 * Vrai appel HTTP. `chemin` contient les identifiants reels ; seul
 * `gabarit(chemin)` est conserve dans les preuves.
 */
async function requete(opts) {
  const {
    cas, method = 'GET', chemin, token, org, corps, brut,
    entetes = {}, redirect = 'manual', externe = false, binary = false,
  } = opts;
  const url = externe ? validerUrlStockage(chemin, STORAGE_HOST).href : `${BASE}${chemin}`;
  const headers = construireEntetes({
    externe, jeton: token, organisation: org, entetes, bypass: BYPASS,
  });
  let body;
  if (brut !== undefined) body = brut;
  else if (corps !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(corps); }
  const debut = Date.now();
  const response = await fetch(url, { method, headers, body, redirect });
  const bytes = binary ? Buffer.from(await response.arrayBuffer()) : null;
  const texte = binary ? '' : await response.text();
  let donnees = null;
  try { donnees = texte ? JSON.parse(texte) : null; } catch { donnees = null; }
  return {
    cas,
    method,
    status: response.status,
    body: donnees,
    digest: bytes ? createHash('sha256').update(bytes).digest('hex') : null,
    texte: redigerSur(texte).slice(0, 400),
    headers: response.headers,
    template: externe ? '<url-presignee>' : gabarit(chemin),
    ms: Date.now() - debut,
  };
}

const codeErreur = (r) => {
  const valeur = r?.body?.error;
  return typeof valeur === 'string' && /^[a-z0-9_]{1,80}$/.test(valeur) ? valeur : undefined;
};

/* ---------------------------------------------------------------------------
 * Pre-vol : la cible doit repondre comme l'application, pas comme la
 * protection Vercel. Aucun contournement : sans le bypass autorise, on
 * s'arrete en BLOCKED.
 * ------------------------------------------------------------------------- */
function estPageProtection(r) {
  if ([301, 302, 307, 308].includes(r.status)) {
    const location = r.headers.get('location') || '';
    return /vercel\.com|\/sso-api|login/i.test(location);
  }
  return /Protected Deployment|Log in to Vercel|vercel_auth_enabled/i.test(r.texte);
}

let health;
try {
  health = await requete({ cas: 'P0', chemin: '/api/health' });
} catch (error) {
  bloquer(`pre-vol : la Preview est injoignable (${redigerSur(error.message).slice(0, 120)}). `
    + 'Si la sortie reseau du poste est filtree, executer ce harnais depuis le '
    + 'workflow GitHub `.github/workflows/preview-http-journeys.yml` '
    + '(workflow_dispatch + environnement approuve), jamais depuis un poste '
    + 'qui ne peut pas joindre la Preview.');
}
if (estPageProtection(health)) {
  enregistrer('P0', 200, health.status, false, 'protection atteinte malgre le bypass', health, 'BLOCKED');
  bloquer('pre-vol : protection Vercel active et secret de bypass absent ou invalide. '
    + 'Configurer VERCEL_AUTOMATION_BYPASS_SECRET dans l environnement de test ; '
    + 'la protection n est PAS desactivee.');
}
if (health.status === 503) {
  enregistrer('P0', 200, health.status, false, 'base indisponible', health, 'BLOCKED');
  bloquer('pre-vol : l application repond mais sa base est indisponible '
    + '(503 database_unavailable). Verifier DATABASE_URL de test sur la Preview.');
}
if (health.status !== 200 || health.body?.ok !== true) {
  enregistrer('P0', 200, health.status, false, 'reponse non reconnue', health, 'BLOCKED');
  bloquer(`pre-vol : /api/health a repondu ${health.status} sans corps applicatif valide.`);
}
verifierHttp('P0', 200, health, true, 'sante HTTP uniquement ; isolation de la base non prouvee');
console.log('  pre-vol : application atteinte ; isolation de la base non prouvee par ce test.');

/* --- P9 : la protection Vercel doit rester active SANS le secret --------- */
{
  const debut = Date.now();
  const response = await fetch(`${BASE}/api/health`, { redirect: 'manual' });
  const location = response.headers.get('location') || '';
  let lieu = '', chemin = '';
  try { if (location) { const url = new URL(location, BASE); lieu = url.hostname; chemin = url.pathname; } } catch { /* inclassable */ }
  const result = classifierProtection({ statut: response.status, lieu, chemin,
    typeContenu: response.headers.get('content-type') || '',
    corps: redigerSur(await response.text()).slice(0, 2000) });
  const meta = { method: 'GET', template: '/api/health', status: response.status, ms: Date.now() - debut };
  if (result.verdict === 'BLOCKED') {
    enregistrer('P9', 'protection Vercel active', result.verdict, false,
      'reponse inclassable sans bypass', meta, 'BLOCKED');
    bloquer('protection Vercel non confirmee ; aucune ecriture ne sera tentee.');
  }
  verifier('P9', 'protection Vercel active', result.verdict, result.verdict === 'PASS',
    'requete sans bypass ; aucun 401 generique ni redirection tierce ne suffit', meta);
  if (result.verdict === 'FAIL') echouer('la Preview repond sans protection ; aucune ecriture ne sera tentee.');
}

/* ---------------------------------------------------------------------------
 * Identites REELLES : BAPI Clerk de test, jetons de session reels.
 * ------------------------------------------------------------------------- */
const { createClerkClient } = await import('@clerk/backend');
const clerk = createClerkClient({ secretKey: CLE_CLERK });
clerkPourNettoyage = clerk;

async function resoudreUtilisateur(reference, etiquette) {
  try {
    if (reference.includes('@')) {
      const page = await clerk.users.getUserList({ emailAddress: [reference], limit: 1 });
      const trouve = page?.data?.[0];
      if (!trouve) bloquer(`identite de test ${etiquette} introuvable dans l instance Clerk de test.`);
      return trouve.id;
    }
    const utilisateur = await clerk.users.getUser(reference);
    if (!utilisateur?.id) bloquer(`identite de test ${etiquette} introuvable.`);
    return utilisateur.id;
  } catch (error) {
    if (error instanceof ArretPreview) throw error;
    bloquer(`acces a l instance Clerk de test impossible pour ${etiquette} (details sensibles non journalises).`);
  }
}

async function jeterSession(userId, expiresInSeconds) {
  const session = await clerk.sessions.createSession({ userId });
  if (!session?.id) throw new Error('session_id_missing');
  sessionsCreees.push(session.id);
  const jeton = await clerk.sessions.getToken(session.id, undefined, expiresInSeconds);
  const jwt = typeof jeton === 'string' ? jeton : jeton?.jwt;
  if (!jwt) throw new Error('session_token_empty');
  // Couvrir aussi les jetons dont le format ne correspond pas au motif JWT.
  valeursSensibles.push(jwt);
  expurger = creerExpurgateur(valeursSensibles);
  return jwt;
}

const idAlpha = await resoudreUtilisateur(USER_ALPHA, 'ALPHA');
const idBeta = await resoudreUtilisateur(USER_BETA, 'BETA');
if (idAlpha === idBeta) bloquer('ALPHA et BETA designent la meme identite Clerk : isolation impossible.');

// Cache court : un jeton de session Clerk est de courte duree ; on le
// renouvelle avant son expiration pour ne pas transformer un parcours
// valide en faux 401.
const cacheJetons = new Map();
async function jetonPour(etiquette, userId) {
  const entree = cacheJetons.get(etiquette);
  if (entree && Date.now() - entree.at < 30000) return entree.jwt;
  const jwt = await jeterSession(userId);
  cacheJetons.set(etiquette, { jwt, at: Date.now() });
  return jwt;
}
const alphaToken = () => jetonPour('ALPHA', idAlpha);
const betaToken = () => jetonPour('BETA', idBeta);

/* --- Organisations de test explicitement fournies et verifiees via /api/me. */
async function membresDeTest(etiquette, userId, organisation) {
  const token = await jetonPour(etiquette, userId);
  const me = await requete({ cas: `ORG-${etiquette}`, chemin: '/api/me', token });
  if (me.status !== 200) {
    bloquer(`GET /api/me a repondu ${me.status} pour ${etiquette} (code=${codeErreur(me) || 'inconnu'}).`);
  }
  const actives = (me.body?.memberships || []).filter((m) => m.status === 'active');
  const choisie = actives.find((m) => m.organization_id === organisation);
  const autorises = ['owner', 'admin', 'manager', 'contributor'];
  if (!choisie || choisie.organizations?.type !== 'brand' || !autorises.includes(choisie.role)) {
    bloquer(`organisation de test ${etiquette} absente, non-brand ou sans role ecrivain.`);
  }
  return actives.map((m) => m.organization_id);
}
const membershipsAlpha = await membresDeTest('ALPHA', idAlpha, ORG_ALPHA);
const membershipsBeta = await membresDeTest('BETA', idBeta, ORG_BETA);
if (membershipsAlpha.includes(ORG_BETA) || membershipsBeta.includes(ORG_ALPHA)) {
  bloquer('les identites de test ont des organisations croisees : isolation non mesurable.');
}
const orgAlpha = ORG_ALPHA;
const orgBeta = ORG_BETA;
console.log('  deux organisations de test distinctes confirmees par /api/me.');

// Raccourcis explicites pour garder les appels lisibles.
const A = async (method, chemin, corps, opts = {}) =>
  requete({ method, chemin, corps, token: await alphaToken(), org: orgAlpha, ...opts });
const B = async (method, chemin, corps, opts = {}) =>
  requete({ method, chemin, corps, token: await betaToken(), org: orgBeta, ...opts });

const suffixe = RUN_ID.replace(/[^a-z0-9]/gi, '');

/* ---------------------------------------------------------------------------
 * 1. Produit : creation, modification, relecture apres nouvelle requete.
 * ------------------------------------------------------------------------- */
console.log('\n  1 — produit : creation, modification, rechargement');
const cree = await A('POST', '/api/products', {
  brandOrganizationId: orgAlpha,
  reference: `PREVIEW-${suffixe}`,
  name: `Produit Preview ${suffixe}`,
  category: 'T-shirt',
  sku: `PV-${suffixe}`,
});
const produit = cree.body?.product?.id;
verifierHttp('J1.1', 201, cree, cree.status === 201 && Boolean(produit), codeErreur(cree));
if (!produit) echouer('produit non cree : les parcours suivants ne peuvent pas etre executes.');

const description = `Persistance reelle sur Preview — ${RUN_ID}.`;
const modifie = await A('PATCH', `/api/products/${produit}`, { description });
verifierHttp('J1.2', 200, modifie, modifie.status === 200 && modifie.body?.product?.description === description, codeErreur(modifie));
const relu = await A('GET', `/api/products/${produit}`);
verifierHttp('J1.3', 200, relu, relu.status === 200 && relu.body?.product?.description === description, codeErreur(relu));
const liste = await A('GET', '/api/products');
verifierHttp('J1.4', 200, liste, liste.status === 200 && (liste.body?.products || []).some((p) => p.id === produit), codeErreur(liste));

/* ---------------------------------------------------------------------------
 * 2. Document : URL signee, VRAI transfert, scan, integrite.
 * ------------------------------------------------------------------------- */
console.log('\n  2 — document : stockage prive manage, antivirus, integrite');
const octets = Buffer.from(`Tracefab Preview — preuve ${RUN_ID}\n`, 'utf8');
const intention = await A('POST', '/api/documents/upload-intent', {
  originalFilename: `preuve-${suffixe}.txt`, contentType: 'text/plain',
  byteSize: octets.byteLength, kind: 'certificate',
  metadata: { productId: produit, category: 'transfer', issuer: 'Preview Test' },
});
const documentId = intention.body?.document?.id;
verifierHttp('J2.1', 201, intention, intention.status === 201 && Boolean(documentId) && Boolean(intention.body?.upload?.url), codeErreur(intention));
if (!documentId || !intention.body?.upload?.url) {
  if (intention.status === 503) bloquer('stockage prive ou antivirus de test indisponible.');
  echouer('intention de depot sans document ou URL signee.');
}
verifier('J2.2', 'uploaded', intention.body?.document?.status, intention.body?.document?.status === 'uploaded', 'aucun document nest available avant scan', intention);

const depot = await requete({ cas: 'J2.3', method: 'PUT', chemin: intention.body.upload.url, brut: octets,
  entetes: intention.body.upload.headers || {}, externe: true });
verifierHttp('J2.3', 200, depot, depot.status === 200, 'PUT presigne vers le stockage prive manage');

const urlPublique = intention.body.upload.url.split('?')[0];
const lienPublic = await requete({ cas: 'J2.4', chemin: urlPublique, externe: true });
verifierHttp('J2.4', '401/403/404', lienPublic, [401, 403, 404].includes(lienPublic.status),
  'lien non signe refuse ; une erreur 5xx ne prouve pas la confidentialite');

const scan = await A('POST', `/api/documents/${documentId}/scan`);
verifierHttp('J2.5', 200, scan, scan.status === 200 && scan.body?.document?.status === 'available'
  && scan.body?.scan?.status === 'clean', codeErreur(scan));

const telechargement = await A('GET', `/api/documents/${documentId}/download`);
verifierHttp('J2.6', 200, telechargement, telechargement.status === 200 && Boolean(telechargement.body?.download?.url), codeErreur(telechargement));
if (telechargement.status === 200 && telechargement.body?.download?.url) {
  const objet = await requete({ cas: 'J2.7', chemin: telechargement.body.download.url,
    externe: true, binary: true });
  const integre = objet.status === 200 && objet.digest === createHash('sha256').update(octets).digest('hex');
  verifier('J2.7', 'HTTP 200 + SHA256 identique', integre ? 'identique' : 'different',
    integre, 'aucun octet ou URL signee journalise', objet);
} else {
  preuves.push({ runId: RUN_ID, cas: 'J2.7', verdict: 'NOT RUN', detail: 'telechargement indisponible' });
}

/* ---------------------------------------------------------------------------
 * 3. Decisions : acceptee, rejet motive, historique relu par HTTP.
 * ------------------------------------------------------------------------- */
console.log('\n  3 — decisions : acceptation, rejet motive, historique');
const motifAcceptation = `Lot coherent ${RUN_ID}.`;
const accepte = await A('POST', `/api/documents/${documentId}/validation`,
  { decision: 'accepted', reason: motifAcceptation });
verifierHttp('J3.1', 200, accepte, accepte.status === 200 && accepte.body?.evidence?.verification_result === 'accepted', codeErreur(accepte));
const sansMotif = await A('POST', `/api/documents/${documentId}/validation`, { decision: 'rejected' });
verifierHttp('J3.2', 400, sansMotif, sansMotif.status === 400 && sansMotif.body?.error === 'document_rejection_reason_required', codeErreur(sansMotif));
await new Promise((resolve) => setTimeout(resolve, 25));
const motifRejet = `Incoherence constatee ${RUN_ID}.`;
const rejete = await A('POST', `/api/documents/${documentId}/validation`,
  { decision: 'rejected', reason: motifRejet });
verifierHttp('J3.3', 200, rejete, rejete.status === 200 && rejete.body?.evidence?.verification_result === 'rejected' && rejete.body?.evidence?.verification_reason === motifRejet, codeErreur(rejete));
const claims = await A('GET', `/api/products/${produit}/dpp/claims`);
const evenements = (claims.body?.claims || []).flatMap((c) => c.evidence || [])
  .filter((e) => e.documentId === documentId);
const acceptationRelue = evenements.some((e) => e.verificationResult === 'accepted'
  && e.verificationReason === motifAcceptation);
const rejetRelu = evenements.some((e) => e.verificationResult === 'rejected'
  && e.verificationReason === motifRejet);
verifier('J3.4', 'acceptation et rejet avec motifs', acceptationRelue && rejetRelu ? 'retrouves' : 'incomplet',
  claims.status === 200 && acceptationRelue && rejetRelu,
  'historique de CE document relu par HTTP', claims);

/* ---------------------------------------------------------------------------
 * 4. Apercu DPP brouillon prive.
 * ------------------------------------------------------------------------- */
console.log('\n  4 — apercu DPP brouillon prive');
const apercu = await A('GET', `/api/products/${produit}/dpp/preview`);
const cache = apercu.headers.get('cache-control') || '';
const robots = apercu.headers.get('x-robots-tag') || '';
verifierHttp('J4.1', 200, apercu, apercu.status === 200 && apercu.body?.private === true && apercu.body?.published === false, codeErreur(apercu));
verifier('J4.2', 'no-store private noindex', `${cache || '-'} / ${robots || '-'}`,
  /no-store/i.test(cache) && /private/i.test(cache) && /noindex/i.test(robots), 'en-tetes de confidentialite', apercu);
verifier('J4.3', 'description persistee', apercu.body?.product?.description === description ? 'identique' : 'differente',
  apercu.body?.product?.description === description, 'aucune donnee de demonstration', apercu);

/* ---------------------------------------------------------------------------
 * 5 et 6. Refus d authentification.
 * ------------------------------------------------------------------------- */
console.log('\n  5/6 — anonymes, jetons forges, expires, malformes');
const anonymes = [
  ['GET', `/api/products/${produit}`],
  ['POST', '/api/documents/upload-intent'],
  ['GET', '/api/documents'],
  ['GET', `/api/documents/${documentId}/download`],
  ['GET', `/api/products/${produit}/dpp/preview`],
];
for (const [index, [method, chemin]] of anonymes.entries()) {
  const r = await requete({ cas: `J5.${index + 1}`, method, chemin, org: orgAlpha });
  verifierHttp(`J5.${index + 1}`, 401, r, r.status === 401, 'sans Authorization');
}

const jetonValide = await alphaToken();
const forge = jetonValide.slice(0, -3) + (jetonValide.endsWith('AAA') ? 'BBB' : 'AAA');
const forgeR = await requete({ cas: 'J6.1', chemin: `/api/products/${produit}`, token: forge, org: orgAlpha });
verifierHttp('J6.1', 401, forgeR, forgeR.status === 401, 'signature falsifiee');
const malformeR = await requete({ cas: 'J6.2', chemin: `/api/products/${produit}`, token: 'not-a-jwt', org: orgAlpha });
verifierHttp('J6.2', 401, malformeR, malformeR.status === 401, 'structure invalide');

// Jeton EXPIRE : la vraie BAPI signe le jeton. On lit uniquement son `exp`
// pour attendre son expiration REELLE plus la marge de clock skew du SDK;
// cette lecture ne remplace pas la verification HTTP cote application.
let jetonExpire;
try { jetonExpire = await jeterSession(idAlpha, 5); }
catch { jetonExpire = await jeterSession(idAlpha); }
let attenteMs;
try { attenteMs = attendreExpirationMs(jetonExpire); }
catch { bloquer('expiration du jeton Clerk impossible a determiner en moins de 180 secondes.'); }
console.log(`  attente expiration du jeton Clerk : ${Math.ceil(attenteMs / 1000)}s`);
await new Promise((resolve) => setTimeout(resolve, attenteMs));
const expireR = await requete({ cas: 'J6.3', chemin: `/api/products/${produit}`, token: jetonExpire, org: orgAlpha });
verifierHttp('J6.3', 401, expireR, expireR.status === 401, 'jeton reel expire, aucun mock');
const encoreValide = await A('GET', `/api/products/${produit}`);
verifierHttp('J6.4', 200, encoreValide, encoreValide.status === 200, 'le jeton valide reste accepte');

/* ---------------------------------------------------------------------------
 * 7. Isolation Alpha/Beta par HTTP authentifie.
 * ------------------------------------------------------------------------- */
console.log('\n  7 — isolation Alpha / Beta par HTTP');
const produitBeta = await B('POST', '/api/products', {
  brandOrganizationId: orgBeta, reference: `BETA-${suffixe}`,
  name: `Produit Beta ${suffixe}`, category: 'Accessoire', sku: `B-${suffixe}`,
});
verifierHttp('J7.0', 201, produitBeta, produitBeta.status === 201 && Boolean(produitBeta.body?.product?.id), 'fixture du second locataire creee par HTTP');
const betaId = produitBeta.body?.product?.id;
const intrusions = [
  ['GET', `/api/products/${produit}`, undefined, 404],
  ['GET', `/api/documents?productId=${produit}`, undefined, 200],
  ['PATCH', `/api/products/${produit}`, { description: 'cross-tenant-denied' }, 404],
  ['GET', `/api/documents/${documentId}/download`, undefined, 404],
  ['POST', `/api/documents/${documentId}/validation`, { decision: 'accepted' }, 404],
  ['POST', `/api/documents/${documentId}/scan`, undefined, 404],
  ['GET', `/api/products/${produit}/dpp/preview`, undefined, 404],
];
for (const [index, [method, chemin, corps, attendu]] of intrusions.entries()) {
  const r = await B(method, chemin, corps);
  const listeVide = index !== 1 || (Array.isArray(r.body?.documents) && r.body.documents.length === 0);
  verifierHttp(`J7.1.${index + 1}`, attendu, r, r.status === attendu && listeVide,
    'Beta ne lit ni ne modifie les donnees Alpha');
}
const docsBeta = await B('GET', `/api/documents?productId=${produit}`);
verifier('J7.2', 0, (docsBeta.body?.documents || []).length,
  docsBeta.status === 200 && (docsBeta.body?.documents || []).length === 0, 'liste documentaire vide', docsBeta);
const usurpation = await requete({ cas: 'J7.3', chemin: `/api/products/${produit}`,
  token: await alphaToken(), org: orgBeta });
verifierHttp('J7.3', 404, usurpation, usurpation.status === 404, 'jeton Alpha + locataire Beta refuses');
if (betaId) {
  const lienEtranger = await A('POST', '/api/documents/upload-intent', {
    originalFilename: `intrusion-${suffixe}.txt`, contentType: 'text/plain', byteSize: 12,
    kind: 'other', metadata: { productId: betaId },
  });
  verifierHttp('J7.4', 404, lienEtranger, lienEtranger.status === 404, 'association inter-locataire refusee');
  const alphaLitBeta = await A('GET', `/api/products/${betaId}`);
  verifierHttp('J7.5', 404, alphaLitBeta, alphaLitBeta.status === 404, 'Alpha ne lit pas le produit Beta');
  const alphaModifieBeta = await A('PATCH', `/api/products/${betaId}`, { description: 'cross-tenant-denied' });
  verifierHttp('J7.6', 404, alphaModifieBeta, alphaModifieBeta.status === 404, 'Alpha ne modifie pas le produit Beta');
  const betaLitBeta = await B('GET', `/api/products/${betaId}`);
  verifierHttp('J7.7', 200, betaLitBeta, betaLitBeta.status === 200 && betaLitBeta.body?.product?.id === betaId,
    'controle positif : Beta lit son propre produit');
}

/* ---------------------------------------------------------------------------
 * 8. EICAR : le VRAI antivirus managé doit rejeter.
 * ------------------------------------------------------------------------- */
console.log('\n  8 — EICAR : rejet par l antivirus manage');
const infecte = eicarTestBytes();
const intentionInfectee = await A('POST', '/api/documents/upload-intent', {
  originalFilename: `infecte-${suffixe}.txt`, contentType: 'text/plain',
  byteSize: infecte.byteLength, kind: 'other', metadata: { productId: produit },
});
const docInfecte = intentionInfectee.body?.document?.id;
if (intentionInfectee.status !== 201 || !docInfecte || !intentionInfectee.body?.upload?.url) {
  verifierHttp('J8.0', 201, intentionInfectee, false, codeErreur(intentionInfectee));
} else {
  const depotEicar = await requete({ cas: 'J8.0', method: 'PUT', chemin: intentionInfectee.body.upload.url,
    brut: infecte, entetes: intentionInfectee.body.upload.headers || {}, externe: true });
  verifierHttp('J8.0', 200, depotEicar, depotEicar.status === 200, 'EICAR canonique, 68 octets');
  if (depotEicar.status === 200) {
    const scanInfecte = await A('POST', `/api/documents/${docInfecte}/scan`);
    verifier('J8.1', 'HTTP 200 + rejected', scanInfecte.body?.scan?.status || scanInfecte.status,
      scanInfecte.status === 200 && scanInfecte.body?.scan?.status === 'rejected'
        && scanInfecte.body?.document?.status === 'rejected', 'antivirus manage, aucun mock', scanInfecte);
    const downloadInfecte = await A('GET', `/api/documents/${docInfecte}/download`);
    verifierHttp('J8.2', 404, downloadInfecte, downloadInfecte.status === 404, 'document rejete non telechargeable');
  }
}

/* ---------------------------------------------------------------------------
 * Preuves et verdict.
 * ------------------------------------------------------------------------- */
console.log(`\n  RESULTAT : ${preuves.length - echecs}/${preuves.length} controles HTTP sur Preview`);
if (echecs > 0) {
  console.error(`  ${echecs} ECHEC(S). Voir les lignes ci-dessus ; aucun succes nest declare pour les cas en echec.`);
  process.exitCode = EXIT.FAIL;
}
} // main

try {
  await main();
} catch (error) {
  if (error instanceof ArretPreview) {
    const label = error.code === EXIT.REFUS ? 'REFUS' : error.code === EXIT.BLOCKED ? 'BLOCKED' : 'FAIL';
    raisonArret = redigerSur(error.message);
    console.error(`  ${label} — ${raisonArret}`);
    process.exitCode = error.code;
  } else {
    // Aucune exception inconnue (qui pourrait contenir une URL signee ou un
    // secret) n'est imprimee brute. Les statuts HTTP sont dans la preuve.
    raisonArret = 'erreur inattendue du harnais (details sensibles non journalises)';
    console.error(`  FAIL — ${raisonArret}.`);
    process.exitCode = EXIT.FAIL;
  }
} finally {
  if (clerkPourNettoyage && sessionsCreees.length) {
    let nettoyees = 0;
    for (const id of sessionsCreees) {
      try { await clerkPourNettoyage.sessions.revokeSession(id); nettoyees += 1; } catch { /* compte ci-dessous */ }
    }
    const ok = nettoyees === sessionsCreees.length;
    preuves.push({ runId: RUN_ID, cas: 'NETTOYAGE-SESSIONS', attendu: sessionsCreees.length,
      obtenu: nettoyees, verdict: ok ? 'PASS' : 'FAIL' });
    if (!ok) { echecs += 1; process.exitCode = EXIT.FAIL; }
    console.log(`  sessions de test revoquees : ${nettoyees}/${sessionsCreees.length}`);
  }
  if (!estSelftest && process.env.TF_PREVIEW_HARNESS === '1') {
    const executes = new Set(preuves.map((p) => p.cas));
    for (const cas of CAS_REQUIS) {
      if (!executes.has(cas)) preuves.push({ runId: RUN_ID, cas, verdict: 'NOT RUN' });
    }
    // Un code zero avec des parcours non executes serait un faux vert.
    if (!process.exitCode && preuves.some((p) => p.verdict === 'NOT RUN')) {
      raisonArret = 'au moins un parcours obligatoire non execute';
      process.exitCode = EXIT.FAIL;
    }
  }
  const code = process.exitCode || EXIT.PASS;
  const status = code === EXIT.PASS ? 'PASS' : code === EXIT.BLOCKED ? 'BLOCKED'
    : code === EXIT.REFUS ? 'NOT RUN' : 'FAIL';
  try {
    ecrirePreuve(status, code);
    if (preuveActive) console.log('  preuve JSON epuree ecrite dans /tmp.');
  } catch {
    console.error('  FAIL — impossible de conserver la preuve epuree.');
    process.exitCode = EXIT.FAIL;
  }
}
