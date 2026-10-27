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
 *   - TRACEFAB_STAGING_URL doit etre HTTPS, sur un hote `.vercel.app` ou
 *     explicitement autorise par TF_PREVIEW_ALLOWED_HOST. Aucune URL de
 *     production ne peut etre ciblee par inadvertance ;
 *   - la creation d'organisations de test sur la Preview exige
 *     TF_PREVIEW_ALLOW_PROVISION=1 ;
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
 *   TF_VERCEL_BYPASS                        secret de bypass AUTORISE (optionnel
 *                                           si la Preview n'est pas protegee)
 *   TF_PREVIEW_ORG_ALPHA / _BETA            UUID d'organisation de test
 *                                           (optionnel : decouverte via /api/me)
 *   TF_PREVIEW_ALLOW_PROVISION=1            autorise POST /api/organizations
 *   TF_PREVIEW_ALLOWED_HOST                 hote supplementaire autorise
 *   TF_PREVIEW_EVIDENCE                     chemin du fichier de preuve JSON
 *   TF_PREVIEW_SELFTEST=1                   verification des gardes, SANS reseau
 *
 * CODES DE SORTIE : 0 tous PASS · 1 au moins un FAIL · 2 BLOCKED · 3 REFUS
 */
import { randomUUID, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { creerExpurgateur, gabarit, construireEntetes } from './lib/preview_harness_safety.mjs';

const EXIT = { PASS: 0, FAIL: 1, BLOCKED: 2, REFUS: 3 };
const RUN_ID = `pv-${randomUUID().slice(0, 12)}`;

const refuser = (message) => { console.error(`  REFUS — ${message}`); process.exit(EXIT.REFUS); };
const bloquer = (message) => { console.error(`  BLOCKED — ${message}`); process.exit(EXIT.BLOCKED); };

/* ---------------------------------------------------------------------------
 * Expurgation et en-tetes : implementation unique, testee unitairement.
 * Voir scripts/lib/preview_harness_safety.mjs. L'expurgateur est lie aux
 * valeurs REELLES des secrets du process apres leur lecture (plus bas), ce
 * qui couvre aussi les formes de secret non reconnues par les motifs.
 * ------------------------------------------------------------------------- */
let expurger = creerExpurgateur([]);
const redigerSur = (value) => expurger(value);
export const redactEvidence = (evidence) => JSON.parse(redigerSur(JSON.stringify(evidence)));

/* ---------------------------------------------------------------------------
 * Auto-verification des gardes, sans aucun reseau.
 * ------------------------------------------------------------------------- */
if (process.env.TF_PREVIEW_SELFTEST === '1') {
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
  process.exit(echecs === 0 ? EXIT.PASS : EXIT.FAIL);
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
const BYPASS = String(process.env.TF_VERCEL_BYPASS || '').trim();
const USER_ALPHA = String(process.env.TF_PREVIEW_USER_ALPHA || '').trim();
const USER_BETA = String(process.env.TF_PREVIEW_USER_BETA || '').trim();
expurger = creerExpurgateur([BYPASS, CLE_CLERK, USER_ALPHA, USER_BETA, BASE_BRUTE]);

const MANQUANTS = [];
if (!CLE_CLERK) MANQUANTS.push('CLERK_SECRET_KEY');
if (!CLE_CLERK.startsWith('sk_test_')) MANQUANTS.push('CLERK_SECRET_KEY (doit etre sk_test_...)');
if (!BASE_BRUTE) MANQUANTS.push('TRACEFAB_STAGING_URL');
if (!USER_ALPHA) MANQUANTS.push('TF_PREVIEW_USER_ALPHA');
if (!USER_BETA) MANQUANTS.push('TF_PREVIEW_USER_BETA');
if (MANQUANTS.length) {
  bloquer(`variables absentes ou invalides : ${[...new Set(MANQUANTS)].join(', ')}. `
    + 'Aucune valeur ne doit figurer dans ce message.');
}

let base;
try { base = new URL(BASE_BRUTE); } catch { refuser('TRACEFAB_STAGING_URL invalide.'); }
if (base.protocol !== 'https:') refuser('TRACEFAB_STAGING_URL doit etre en HTTPS.');
const hoteAutorise = String(process.env.TF_PREVIEW_ALLOWED_HOST || '').trim();
if (!base.hostname.endsWith('.vercel.app') && base.hostname !== hoteAutorise) {
  refuser('hote non autorise : seule une Preview .vercel.app est acceptee '
    + '(ou TF_PREVIEW_ALLOWED_HOST explicite). Aucune cible de production.');
}
const BASE = base.origin;
console.log(`  run=${RUN_ID} cible=${BASE.replace(/^https:\/\//, '').replace(BASE.hostname, '<preview>')} `
  + `bypass=${BYPASS ? 'present' : 'absent'}`);

/* ---------------------------------------------------------------------------
 * Collecte des preuves.
 * ------------------------------------------------------------------------- */
const preuves = [];
let echecs = 0;
const enregistrer = (cas, attendu, obtenu, reussi, detail) => {
  const ligne = {
    runId: RUN_ID,
    cas,
    attendu,
    obtenu,
    verdict: reussi ? 'PASS' : 'FAIL',
    detail: detail ? redigerSur(detail).slice(0, 120) : undefined,
  };
  preuves.push(ligne);
  if (!reussi) echecs += 1;
  console.log(`  ${reussi ? 'ok    ' : 'ECHEC '} ${cas.padEnd(12)} attendu=${attendu} obtenu=${obtenu}`
    + (ligne.detail ? ` (${ligne.detail})` : ''));
};
const verifier = (cas, attendu, obtenu, condition, detail) =>
  enregistrer(cas, String(attendu), String(obtenu), Boolean(condition), detail);

// Le bypass Vercel et le jeton Clerk ne sont JAMAIS envoyes a une origine
// tierce (URL presignee S3/R2). construireEntetes() applique cette regle.

/**
 * Vrai appel HTTP. `chemin` contient les identifiants reels ; seul
 * `gabarit(chemin)` est conserve dans les preuves.
 */
async function requete(opts) {
  const {
    cas, method = 'GET', chemin, token, org, corps, brut,
    entetes = {}, redirect = 'manual', externe = false,
  } = opts;
  const url = externe ? chemin : `${BASE}${chemin}`;
  const headers = construireEntetes({
    externe, jeton: token, organisation: org, entetes, bypass: BYPASS,
  });
  let body;
  if (brut !== undefined) body = brut;
  else if (corps !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(corps); }
  const debut = Date.now();
  const response = await fetch(url, { method, headers, body, redirect });
  const texte = await response.text();
  let donnees = null;
  try { donnees = texte ? JSON.parse(texte) : null; } catch { donnees = null; }
  return {
    cas,
    status: response.status,
    body: donnees,
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
  bloquer('pre-vol : protection Vercel active et secret de bypass absent ou invalide. '
    + 'Configurer VERCEL_AUTOMATION_BYPASS_SECRET dans l environnement de test ; '
    + 'la protection n est PAS desactivee.');
}
if (health.status === 503) {
  bloquer('pre-vol : l application repond mais sa base de test est indisponible '
    + '(503 database_unavailable). Configurer DATABASE_URL de test sur la Preview.');
}
if (health.status !== 200 || health.body?.ok !== true) {
  bloquer(`pre-vol : /api/health a repondu ${health.status} sans corps applicatif valide.`);
}
console.log('  pre-vol : application atteinte, base de test repond.');

/* --- P9 : la protection Vercel doit rester active SANS le secret --------- */
{
  const sansBypass = await fetch(`${BASE}/api/health`, { redirect: 'manual' })
    .then(async (response) => ({
      status: response.status,
      headers: response.headers,
      texte: redigerSur(await response.text()).slice(0, 400),
    }));
  const pageProtection = estPageProtection(sansBypass) || sansBypass.status === 401 || sansBypass.status === 403;
  verifier('P9', 'protection active (pas de 200 applicatif)',
    pageProtection ? 'protection' : `HTTP ${sansBypass.status}`, pageProtection,
    'requete sans bypass : aucune reponse applicative 200 nest attendue');
}

/* ---------------------------------------------------------------------------
 * Identites REELLES : BAPI Clerk de test, jetons de session reels.
 * ------------------------------------------------------------------------- */
const { createClerkClient } = await import('@clerk/backend');
const clerk = createClerkClient({ secretKey: CLE_CLERK });

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
    bloquer(`acces a l instance Clerk de test impossible pour ${etiquette} `
      + `(${redigerSur(error.message).slice(0, 120)}).`);
  }
}

async function jeterSession(userId, expiresInSeconds) {
  const session = await clerk.sessions.createSession({ userId });
  const jeton = await clerk.sessions.getToken(session.id, undefined, expiresInSeconds);
  const jwt = typeof jeton === 'string' ? jeton : jeton?.jwt;
  if (!jwt) throw new Error('session_token_empty');
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

/* --- Organisation de test : decouverte via HTTP, ou provisionnement ------- */
async function organisationDeTest(etiquette, userId, fournie) {
  if (fournie) return fournie;
  const token = await jetonPour(etiquette, userId);
  const me = await requete({ cas: `ORG-${etiquette}`, chemin: '/api/me', token });
  if (me.status !== 200) {
    bloquer(`GET /api/me a repondu ${me.status} pour ${etiquette} (code=${codeErreur(me) || 'inconnu'}).`);
  }
  const existantes = (me.body?.memberships || []).map((m) => m.organization_id).filter(Boolean);
  if (existantes.length > 0) return existantes[0];
  if (process.env.TF_PREVIEW_ALLOW_PROVISION !== '1') {
    bloquer(`aucune organisation de test pour ${etiquette}. Fournir TF_PREVIEW_ORG_${etiquette} `
      + 'ou autoriser TF_PREVIEW_ALLOW_PROVISION=1 (POST /api/organizations sur la base de test).');
  }
  const cree = await requete({
    cas: `ORG-${etiquette}`, method: 'POST', chemin: '/api/organizations', token,
    corps: { legalName: `Preview Test ${etiquette} ${RUN_ID}`, type: 'brand', countryCode: 'FR' },
  });
  if (cree.status !== 201 || !cree.body?.organization?.id) {
    bloquer(`provisionnement de l organisation de test ${etiquette} impossible (HTTP ${cree.status}).`);
  }
  return cree.body.organization.id;
}

const orgAlpha = await organisationDeTest('ALPHA', idAlpha, String(process.env.TF_PREVIEW_ORG_ALPHA || '').trim());
const orgBeta = await organisationDeTest('BETA', idBeta, String(process.env.TF_PREVIEW_ORG_BETA || '').trim());
if (orgAlpha === orgBeta) bloquer('ALPHA et BETA partagent la meme organisation : isolation impossible.');
console.log('  deux organisations de test distinctes resolues via HTTP authentifie.');

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
verifier('J1.1', 201, cree.status, cree.status === 201 && Boolean(produit), codeErreur(cree));
if (!produit) bloquer('produit non cree : les parcours suivants dependent de son identifiant.');

const description = `Persistance reelle sur Preview — ${RUN_ID}.`;
const modifie = await A('PATCH', `/api/products/${produit}`, { description });
verifier('J1.2', 200, modifie.status, modifie.status === 200 && modifie.body?.product?.description === description, codeErreur(modifie));
const relu = await A('GET', `/api/products/${produit}`);
verifier('J1.3', 200, relu.status, relu.status === 200 && relu.body?.product?.description === description, codeErreur(relu));
const liste = await A('GET', '/api/products');
verifier('J1.4', 200, liste.status, liste.status === 200 && (liste.body?.products || []).some((p) => p.id === produit), codeErreur(liste));

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
verifier('J2.1', 201, intention.status, intention.status === 201 && Boolean(documentId) && Boolean(intention.body?.upload?.url), codeErreur(intention));
if (!documentId) bloquer('intention de depot impossible : stockage prive manage non configure.');
verifier('J2.2', 'uploaded', intention.body?.document?.status, intention.body?.document?.status === 'uploaded', 'aucun document nest available avant scan');

const depot = await requete({ cas: 'J2.3', method: 'PUT', chemin: intention.body.upload.url, brut: octets,
  entetes: intention.body.upload.headers || {}, externe: true });
verifier('J2.3', 200, depot.status, depot.status === 200, 'PUT presigne vers le stockage prive manage');

const urlPublique = intention.body.upload.url.split('?')[0];
const lienPublic = await requete({ cas: 'J2.4', chemin: urlPublique, externe: true });
verifier('J2.4', '>=400', lienPublic.status, lienPublic.status >= 400, 'aucun lien public non signe');

const scan = await A('POST', `/api/documents/${documentId}/scan`);
verifier('J2.5', 200, scan.status, scan.status === 200 && scan.body?.document?.status === 'available'
  && scan.body?.scan?.status === 'clean', codeErreur(scan) || scan.body?.scan?.status);

const telechargement = await A('GET', `/api/documents/${documentId}/download`);
verifier('J2.6', 200, telechargement.status, telechargement.status === 200 && Boolean(telechargement.body?.download?.url), codeErreur(telechargement));
if (telechargement.status === 200) {
  const objet = await requete({ cas: 'J2.7', chemin: telechargement.body.download.url, externe: true });
  // `requete()` lit le corps en texte ; l integrite est verifiee par empreinte
  // sur un second appel binaire, sans journaliser le contenu.
  let integre = false;
  try {
    const brut = await fetch(telechargement.body.download.url, {
      headers: construireEntetes({ externe: true }),
    });
    const recu = Buffer.from(await brut.arrayBuffer());
    integre = brut.status === 200 && createHash('sha256').update(recu).digest('hex')
      === createHash('sha256').update(octets).digest('hex');
  } catch { integre = false; }
  verifier('J2.7', 'sha256 identique', objet.status === 200 && integre ? 'identique' : 'different',
    objet.status === 200 && integre, 'aucun octet journalise');
} else {
  enregistrer('J2.7', 'sha256 identique', 'non execute', false, 'telechargement indisponible');
}

/* ---------------------------------------------------------------------------
 * 3. Decisions : acceptee, rejet motive, historique relu par HTTP.
 * ------------------------------------------------------------------------- */
console.log('\n  3 — decisions : acceptation, rejet motive, historique');
const accepte = await A('POST', `/api/documents/${documentId}/validation`,
  { decision: 'accepted', reason: `Lot coherent ${RUN_ID}.` });
verifier('J3.1', 200, accepte.status, accepte.status === 200 && accepte.body?.evidence?.verification_result === 'accepted', codeErreur(accepte));
const sansMotif = await A('POST', `/api/documents/${documentId}/validation`, { decision: 'rejected' });
verifier('J3.2', 400, sansMotif.status, sansMotif.status === 400 && sansMotif.body?.error === 'document_rejection_reason_required', codeErreur(sansMotif));
await new Promise((resolve) => setTimeout(resolve, 25));
const motifRejet = `Incoherence constatee ${RUN_ID}.`;
const rejete = await A('POST', `/api/documents/${documentId}/validation`,
  { decision: 'rejected', reason: motifRejet });
verifier('J3.3', 200, rejete.status, rejete.status === 200 && rejete.body?.evidence?.verification_reason === motifRejet, codeErreur(rejete));
const claims = await A('GET', `/api/products/${produit}/dpp/claims`);
const evenements = (claims.body?.claims || []).flatMap((c) => c.evidence || []);
verifier('J3.4', '>=2 decisions', evenements.length, claims.status === 200 && evenements.length >= 2,
  'historique relu par HTTP, jamais par un acces direct a la base');

/* ---------------------------------------------------------------------------
 * 4. Apercu DPP brouillon prive.
 * ------------------------------------------------------------------------- */
console.log('\n  4 — apercu DPP brouillon prive');
const apercu = await A('GET', `/api/products/${produit}/dpp/preview`);
const cache = apercu.headers.get('cache-control') || '';
const robots = apercu.headers.get('x-robots-tag') || '';
verifier('J4.1', 200, apercu.status, apercu.status === 200 && apercu.body?.private === true && apercu.body?.published === false, codeErreur(apercu));
verifier('J4.2', 'no-store private noindex', `${cache || '-'} / ${robots || '-'}`,
  /no-store/i.test(cache) && /private/i.test(cache) && /noindex/i.test(robots), 'en-tetes de confidentialite');
verifier('J4.3', 'description persistee', apercu.body?.product?.description === description ? 'identique' : 'differente',
  apercu.body?.product?.description === description, 'aucune donnee de demonstration');

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
let anonymesOk = 0;
for (const [method, chemin] of anonymes) {
  const r = await requete({ cas: 'J5', method, chemin, org: orgAlpha });
  if (r.status === 401) anonymesOk += 1;
}
verifier('J5', 5, anonymesOk, anonymesOk === 5, 'requetes sans en-tete Authorization');

const jetonValide = await alphaToken();
const forge = jetonValide.slice(0, -3) + (jetonValide.endsWith('AAA') ? 'BBB' : 'AAA');
const forgeR = await requete({ cas: 'J6.1', chemin: `/api/products/${produit}`, token: forge, org: orgAlpha });
verifier('J6.1', 401, forgeR.status, forgeR.status === 401, 'signature falsifiee');
const malformeR = await requete({ cas: 'J6.2', chemin: `/api/products/${produit}`, token: 'not-a-jwt', org: orgAlpha });
verifier('J6.2', 401, malformeR.status, malformeR.status === 401, 'structure invalide');

// Jeton EXPIRE : on demande a la vraie BAPI un jeton de courte duree, puis
// on attend son expiration. Aucune horloge ni signature n'est simulee.
let jetonExpire;
let attente;
const courteDuree = Number(process.env.TF_PREVIEW_SHORT_TOKEN_SECONDS || 5);
try {
  jetonExpire = await jeterSession(idAlpha, courteDuree);
  attente = courteDuree + 3;
} catch {
  jetonExpire = await jeterSession(idAlpha);
  attente = Number(process.env.TF_PREVIEW_EXPIRY_WAIT_SECONDS || 65);
}
console.log(`  attente expiration du jeton Clerk : ${attente}s`);
await new Promise((resolve) => setTimeout(resolve, attente * 1000));
const expireR = await requete({ cas: 'J6.3', chemin: `/api/products/${produit}`, token: jetonExpire, org: orgAlpha });
verifier('J6.3', 401, expireR.status, expireR.status === 401, 'jeton reel expire, aucun mock');
const encoreValide = await A('GET', `/api/products/${produit}`);
verifier('J6.4', 200, encoreValide.status, encoreValide.status === 200, 'le jeton valide reste accepte');

/* ---------------------------------------------------------------------------
 * 7. Isolation Alpha/Beta par HTTP authentifie.
 * ------------------------------------------------------------------------- */
console.log('\n  7 — isolation Alpha / Beta par HTTP');
const produitBeta = await B('POST', '/api/products', {
  brandOrganizationId: orgBeta, reference: `BETA-${suffixe}`,
  name: `Produit Beta ${suffixe}`, category: 'Accessoire', sku: `B-${suffixe}`,
});
verifier('J7.0', 201, produitBeta.status, produitBeta.status === 201, 'fixture du second locataire creee par HTTP');
const intrusions = [
  ['GET', `/api/products/${produit}`, undefined, 404],
  ['GET', `/api/documents?productId=${produit}`, undefined, 200],
  ['GET', `/api/documents/${documentId}/download`, undefined, 404],
  ['POST', `/api/documents/${documentId}/validation`, { decision: 'accepted' }, 404],
  ['POST', `/api/documents/${documentId}/scan`, undefined, 404],
  ['GET', `/api/products/${produit}/dpp/preview`, undefined, 404],
];
let refusOk = 0;
for (const [method, chemin, corps, attendu] of intrusions) {
  const r = await B(method, chemin, corps);
  if (r.status === attendu) refusOk += 1;
}
verifier('J7.1', 6, refusOk, refusOk === 6, 'Beta ne lit ni ne modifie les donnees Alpha');
const docsBeta = await B('GET', `/api/documents?productId=${produit}`);
verifier('J7.2', 0, (docsBeta.body?.documents || []).length,
  docsBeta.status === 200 && (docsBeta.body?.documents || []).length === 0, 'liste documentaire vide');
const usurpation = await requete({ cas: 'J7.3', chemin: `/api/products/${produit}`,
  token: await alphaToken(), org: orgBeta });
verifier('J7.3', 404, usurpation.status, usurpation.status === 404, 'jeton Alpha + locataire Beta refuses');
const lienEtranger = await A('POST', '/api/documents/upload-intent', {
  originalFilename: `intrusion-${suffixe}.txt`, contentType: 'text/plain', byteSize: 12,
  kind: 'other', metadata: { productId: produitBeta.body?.product?.id },
});
verifier('J7.4', 404, lienEtranger.status, lienEtranger.status === 404, 'association inter-locataire refusee');

/* ---------------------------------------------------------------------------
 * 8. EICAR : le VRAI antivirus managé doit rejeter.
 * ------------------------------------------------------------------------- */
console.log('\n  8 — EICAR : rejet par l antivirus manage');
const infecte = Buffer.from(['EICAR', '-STANDARD', '-ANTIVIRUS', '-TEST', '-FILE'].join('') + `\n${RUN_ID}\n`);
const intentionInfectee = await A('POST', '/api/documents/upload-intent', {
  originalFilename: `infecte-${suffixe}.txt`, contentType: 'text/plain',
  byteSize: infecte.byteLength, kind: 'other', metadata: { productId: produit },
});
const docInfecte = intentionInfectee.body?.document?.id;
if (intentionInfectee.status !== 201 || !docInfecte) {
  verifier('J8.1', 'rejected', 'depot impossible', false, codeErreur(intentionInfectee));
  enregistrer('J8.2', 404, 'non execute', false, 'document infecte non cree');
} else {
  await requete({ cas: 'J8', method: 'PUT', chemin: intentionInfectee.body.upload.url,
    brut: infecte, entetes: intentionInfectee.body.upload.headers || {}, externe: true });
  const scanInfecte = await A('POST', `/api/documents/${docInfecte}/scan`);
  verifier('J8.1', 'rejected', scanInfecte.body?.scan?.status || scanInfecte.status,
    scanInfecte.status === 200 && scanInfecte.body?.scan?.status === 'rejected'
      && scanInfecte.body?.document?.status === 'rejected', 'antivirus manage, aucun mock');
  const downloadInfecte = await A('GET', `/api/documents/${docInfecte}/download`);
  verifier('J8.2', 404, downloadInfecte.status, downloadInfecte.status === 404, 'document rejete non telechargeable');
}

/* ---------------------------------------------------------------------------
 * Preuves et verdict.
 * ------------------------------------------------------------------------- */
const cheminPreuve = String(process.env.TF_PREVIEW_EVIDENCE || `/tmp/tf-preview-evidence-${RUN_ID}.json`).trim();
const rapport = redactEvidence({
  runId: RUN_ID,
  sha: process.env.GITHUB_SHA || null,
  cible: 'preview',
  bypassUtilise: Boolean(BYPASS),
  total: preuves.length,
  reussis: preuves.length - echecs,
  echecs,
  cas: preuves,
});
try { writeFileSync(cheminPreuve, JSON.stringify(rapport, null, 2)); } catch { /* evidence best effort */ }

console.log(`\n  PREUVES : ${cheminPreuve} (expurge — aucun jeton, secret, UUID ni corps)`);
console.log(`  RESULTAT : ${preuves.length - echecs}/${preuves.length} controles HTTP sur Preview`);
if (echecs > 0) {
  console.error(`  ${echecs} ECHEC(S). Voir les lignes ci-dessus ; aucun succes nest declare pour les cas en echec.`);
  process.exit(EXIT.FAIL);
}
