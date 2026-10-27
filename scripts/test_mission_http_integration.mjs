#!/usr/bin/env node
/**
 * Mission fonctionnelle — PARCOURS HTTP AUTHENTIFIES de bout en bout.
 *
 * CE QUE CE TEST PROUVE (aucune assertion simulee, aucun client factice) :
 *
 *   Le VRAI routeur `api/index.ts` est expose sur un vrai socket TCP. Les
 *   requetes sont de vraies requetes HTTP portant de vrais jetons de session
 *   RS256, verifies par le VRAI `verifyToken` de @clerk/backend. Le VRAI
 *   client Prisma se connecte sous `tracefab_app` (sans BYPASSRLS) a un vrai
 *   PostgreSQL. Le VRAI code de signature SigV4 et le VRAI protocole
 *   antivirus `tracefab-v1` sont executes contre des services de test locaux.
 *
 *   A. produit cree, modifie, relu apres une NOUVELLE requete (rechargement),
 *      present dans la liste du locataire ;
 *   B. intention de depot liee au produit, objet reellement ecrit dans le
 *      stockage prive, lien public non signe refuse, scan (integrite +
 *      antivirus), relecture du document, telechargement des octets exacts ;
 *   C. decision acceptee, rejet sans motif refuse, rejet avec motif,
 *      historique des decisions relu en base ;
 *   D. apercu DPP brouillon PRIVE (no-store/private/noindex), relisant les
 *      donnees persistees sans rien publier ;
 *   E. refus inter-locataires : Beta ne lit ni ne valide le produit, la
 *      preuve ou l'apercu d'Alpha ; un en-tete de locataire falsifie avec le
 *      jeton Alpha ne deplace pas le contexte ; l'association d'une preuve a
 *      un produit d'un autre locataire est refusee ;
 *   F. absence de jeton et jeton forge -> 401 ; fichier contenant la
 *      signature de test EICAR -> rejete par l'antivirus, jamais « clean ».
 *
 * CE QUE CE TEST NE PROUVE PAS — A NE PAS SURINTERPRETER
 *
 *   Le fournisseur d'identite, le bucket objet et l'antivirus sont des
 *   SERVICES DE TEST LOCAUX (voir scripts/lib/local_test_services.mjs).
 *   Ils valident le code et le protocole, PAS la configuration reelle de
 *   Clerk, du bucket R2/S3 ni de l'antivirus de preproduction. Ces trois
 *   integrations restent a valider sur un deploiement Preview avec les
 *   secrets de TEST de l'environnement. Ce test ne dit rien de la production.
 *
 * GARDES — LE REFUS EST LE DEFAUT
 *
 *   1. Sans TF_HTTP_INTEGRATION_HARNESS=1, rien ne s'execute (sortie 3).
 *   2. Tout contexte de production (NODE_ENV / VERCEL_ENV) est refuse.
 *   3. La cible passe par scripts/lib/require-throwaway-db.mjs.
 *   4. Une eventuelle cle Clerk `sk_live_...` presente dans l'environnement
 *      fait REFUSER le test ; il n'utilise que sa propre cle `sk_test_...`
 *      ephemere, et ne journalise jamais aucune valeur de secret.
 *   5. Le client Prisma doit lire la base cible sous le role applicatif ;
 *      sinon arret avant toute mesure (sortie 2).
 *
 * USAGE
 *
 *   NODE_ENV=test TF_HTTP_INTEGRATION_HARNESS=1 \
 *   DATABASE_URL=postgresql://<proprietaire>@127.0.0.1:<port>/tracefab_test \
 *   TF_RLS_APP_URL=postgresql://tracefab_app:...@127.0.0.1:<port>/tracefab_test \
 *   npx tsx scripts/test_mission_http_integration.mjs
 *
 * CODES DE SORTIE : 0 tout passe · 1 au moins un echec · 2 prerequis · 3 refus
 */
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';
import { eicarTestBytes } from './lib/preview_harness_safety.mjs';

const SORTIE_ECHEC = 1;
const SORTIE_PREREQUIS = 2;
const SORTIE_REFUS = 3;

const refuser = (message) => { console.error(`  REFUS — ${message}`); process.exit(SORTIE_REFUS); };
const manquant = (message) => { console.error(`  NON EXECUTE — ${message}`); process.exit(SORTIE_PREREQUIS); };

if (process.env.TF_HTTP_INTEGRATION_HARNESS !== '1') {
  refuser('drapeau TF_HTTP_INTEGRATION_HARNESS=1 absent : aucun parcours lance.');
}
if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') {
  refuser('contexte de production interdit pour ce harnais.');
}
if ((process.env.CLERK_SECRET_KEY || '').startsWith('sk_live_')) {
  refuser('une cle Clerk de production est presente : le harnais refuse de tourner.');
}

// @clerk/backend ne resout fetch dynamiquement que dans ce mode. La variable
// est posee ici, AVANT tout import d'un module de l'API.
process.env.NODE_ENV = 'test';

const URL_PROPRIETAIRE = process.env.DATABASE_URL;
const URL_APP = process.env.TF_RLS_APP_URL;
if (!URL_PROPRIETAIRE || !URL_APP) {
  manquant('DATABASE_URL (proprietaire jetable) et TF_RLS_APP_URL (role applicatif) sont requis.');
}
const garde = requireThrowawayDb({
  purpose: 'scripts/test_mission_http_integration.mjs',
  variables: ['DATABASE_URL', 'TF_RLS_APP_URL'],
});
for (const ligne of garde.summary) console.log(`  garde cible : ${ligne}`);

const { startClerkTestIdp, startPrivateStorageServices, applyLocalServiceEnv, startApiHttpServer } =
  await import('./lib/local_test_services.mjs');
const { createTestPrisma, injectPrismaSingleton } = await import('./lib/test_prisma_client.mjs');

let echecs = 0;
let total = 0;
const ok = (message) => { total += 1; console.log(`  ok    ${message}`); };
const ko = (message, detail) => {
  total += 1; echecs += 1;
  console.log(`  ECHEC ${message}${detail ? ` — ${detail}` : ''}`);
};
const verifier = (condition, message, detail) => (condition ? ok(message) : ko(message, detail));

const suffixe = randomUUID().slice(0, 8);
const identites = {
  alpha: { id: `user_test_alpha_${suffixe}`, email: `alpha-${suffixe}@example.test`, firstName: 'Alpha', lastName: 'Test' },
  beta: { id: `user_test_beta_${suffixe}`, email: `beta-${suffixe}@example.test`, firstName: 'Beta', lastName: 'Test' },
};
const orgAlpha = randomUUID();
const orgBeta = randomUUID();
const userAlpha = randomUUID();
const userBeta = randomUUID();

let clerk;
let stockage;
let api;
let proprietaire;
let prisma;

try {
  /* --- 0. services de test + client reel ---------------------------------- */
  clerk = startClerkTestIdp([identites.alpha, identites.beta]);
  stockage = await startPrivateStorageServices();
  applyLocalServiceEnv({ clerk, storage: stockage });
  console.log(`  instance Clerk de TEST locale : ${clerk.stats().interceptions} appel(s) BAPI pour l'instant`);
  console.log(`  stockage prive de TEST : ${stockage.endpoint} (bucket ${stockage.bucket})`);

  proprietaire = new pg.Client({ connectionString: URL_PROPRIETAIRE });
  await proprietaire.connect();
  const role = await proprietaire.query('select current_user as role');
  console.log(`  base jetable : ${role.rows[0].role} (fixture ecrite en proprietaire, lectures API en tracefab_app)`);

  // La fixture est celle du depot : deux organisations independantes, deux
  // proprietaires. Les identites Clerk de test sont liees aux utilisateurs
  // internes par clerk_user_id, exactement comme le webhook de production.
  await proprietaire.query(
    `insert into users (id, clerk_user_id, email, full_name) values
       ($1, $2, $3, 'Mission HTTP Alpha'), ($4, $5, $6, 'Mission HTTP Beta')`,
    [userAlpha, identites.alpha.id, identites.alpha.email, userBeta, identites.beta.id, identites.beta.email],
  );
  await proprietaire.query(
    `insert into organizations (id, type, legal_name, country_code, created_by) values
       ($1, 'brand', 'Mission HTTP Alpha', 'FR', $2), ($3, 'brand', 'Mission HTTP Beta', 'PT', $4)`,
    [orgAlpha, userAlpha, orgBeta, userBeta],
  );
  await proprietaire.query(
    `insert into organization_memberships (organization_id, user_id, role, status) values
       ($1, $2, 'owner', 'active'), ($3, $4, 'owner', 'active')`,
    [orgAlpha, userAlpha, orgBeta, userBeta],
  );

  prisma = await createTestPrisma(URL_APP);
  injectPrismaSingleton(prisma);
  const connexion = await prisma.$queryRaw`select current_user::text as role, (select rolbypassrls from pg_roles where rolname = current_user) as bypass`;
  const ligneRole = Array.isArray(connexion) ? connexion[0] : null;
  if (!ligneRole || ligneRole.bypass !== false) {
    manquant(`le client API ne tourne pas sous un role sans BYPASSRLS (observe : ${JSON.stringify(ligneRole)}).`);
  }
  console.log(`  client Prisma de l'API : ${ligneRole.role}, bypassrls=${ligneRole.bypass}`);

  const { default: handler } = await import('../api/index.ts');
  api = await startApiHttpServer(handler);
  console.log(`  routeur applicatif reel : ${api.baseUrl}/api/...`);

  const jetonAlpha = clerk.issueToken(identites.alpha.id);
  const jetonBeta = clerk.issueToken(identites.beta.id);
  const jetonForge = clerk.issueForgedToken(identites.alpha.id);
  const jetonExpire = clerk.issueExpiredToken(identites.alpha.id);
  const jetonsMalformes = clerk.issueMalformedTokens();
  const { isRejectedTokenVerification } = await import('../api/_lib/auth.ts');

  /** Vraie requete HTTP contre le vrai routeur. */
  const appeler = async (method, path, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.org) headers['X-Tracefab-Organization-Id'] = options.org;
    let body;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const response = await fetch(`${api.baseUrl}${path}`, { method, headers, body });
    const text = await response.text();
    let donnees = null;
    try { donnees = text ? JSON.parse(text) : null; } catch { donnees = null; }
    return { status: response.status, headers: response.headers, body: donnees, text };
  };

  const alpha = (method, path, body, extra = {}) => appeler(method, path, { token: jetonAlpha, org: orgAlpha, body, ...extra });
  const beta = (method, path, body, extra = {}) => appeler(method, path, { token: jetonBeta, org: orgBeta, body, ...extra });

  /* --- A. produit : creation, modification, rechargement ----------------- */
  console.log('\n  A — produit cree, modifie, relu apres rechargement');
  const reference = `HTTP-${suffixe}`;
  const cree = await alpha('POST', '/api/products', {
    brandOrganizationId: orgAlpha, reference, name: 'T-shirt Mission HTTP', category: 'T-shirt', sku: `SKU-${suffixe}`,
  });
  const produit = cree.body?.product?.id;
  verifier(cree.status === 201 && typeof produit === 'string' && produit.length === 36,
    'A1 POST /api/products -> 201 avec un UUID reel', `statut=${cree.status} corps=${cree.text.slice(0, 200)}`);
  if (!produit) throw new Error('produit non cree : la suite ne peut pas continuer');

  const description = `Description persistee apres rechargement — ${suffixe}.`;
  const modifie = await alpha('PATCH', `/api/products/${produit}`, { description });
  verifier(modifie.status === 200 && modifie.body?.product?.description === description,
    'A2 PATCH /api/products/:id ecrit la description', `statut=${modifie.status} corps=${modifie.text.slice(0, 200)}`);

  // Nouvelle requete = nouvelle authentification / rechargement de page.
  const relu = await alpha('GET', `/api/products/${produit}`);
  verifier(relu.status === 200 && relu.body?.product?.description === description,
    'A3 nouvelle requete GET relit la description persistee (pas de demo)',
    `statut=${relu.status} description=${relu.body?.product?.description}`);
  const liste = await alpha('GET', '/api/products');
  verifier(liste.status === 200 && (liste.body?.products || []).some((p) => p.id === produit),
    'A4 GET /api/products retrouve le produit du locataire actif');
  verifier((liste.body?.products || []).every((p) => p.brandOrganizationId === orgAlpha),
    'A5 la liste ne contient aucune organisation etrangere');

  /* --- B. cycle de vie documentaire REEL -------------------------------- */
  console.log('\n  B — depot, stockage prive, scan, relecture des octets');
  const octets = Buffer.from(`Tracefab — preuve documentaire de test ${suffixe}\n`, 'utf8');
  const intention = await alpha('POST', '/api/documents/upload-intent', {
    originalFilename: `certificat-${suffixe}.txt`,
    contentType: 'text/plain',
    byteSize: octets.byteLength,
    kind: 'certificate',
    metadata: { productId: produit, category: 'transfer', issuer: 'Mission Lab' },
  });
  const documentId = intention.body?.document?.id;
  verifier(intention.status === 201 && typeof documentId === 'string' && Boolean(intention.body?.upload?.url),
    'B1 intention de depot -> 201, document lie au produit et URL presignee',
    `statut=${intention.status} corps=${intention.text.slice(0, 250)}`);
  if (!documentId) throw new Error('intention de depot echouee : la suite ne peut pas continuer');
  verifier(intention.body.document.status === 'uploaded',
    'B2 document enregistre en statut « uploaded », jamais « available » avant scan');

  const depot = await fetch(intention.body.upload.url, {
    method: 'PUT',
    headers: intention.body.upload.headers,
    body: octets,
  });
  verifier(depot.status === 200,
    'B3 PUT presigne SigV4 accepte par le stockage prive (signature verifiee)', `statut=${depot.status}`);
  verifier(stockage.objects.size === 1,
    'B4 un seul objet reellement ecrit dans le bucket prive');

  // Lien public : la meme URL SANS signature ne doit jamais donner l'objet.
  const urlPublique = intention.body.upload.url.split('?')[0];
  const publicSansSignature = await fetch(urlPublique);
  const publicFalsifie = await fetch(intention.body.upload.url.replace(/X-Amz-Signature=[^&]+/, 'X-Amz-Signature=deadbeef'));
  verifier(publicSansSignature.status === 403 && publicFalsifie.status === 403,
    'B5 aucun lien public : URL non signee et signature falsifiee -> 403',
    `non_signee=${publicSansSignature.status} falsifiee=${publicFalsifie.status}`);

  const scan = await alpha('POST', `/api/documents/${documentId}/scan`, undefined);
  verifier(scan.status === 200 && scan.body?.scan?.status === 'clean' && scan.body?.document?.status === 'available',
    'B6 scan reel (HEAD + GET + antivirus) -> document « available »',
    `statut=${scan.status} corps=${scan.text.slice(0, 250)}`);
  const statsApresScan = stockage.stats();
  verifier(statsApresScan.scans.length === 1 && statsApresScan.scans[0].clean === true
    && statsApresScan.scans[0].protocol === 'tracefab-v1',
    'B7 antivirus appele une fois avec le protocole tracefab-v1 et un verdict propre');

  const listeDocuments = await alpha('GET', `/api/documents?productId=${produit}`);
  const documentRelu = (listeDocuments.body?.documents || []).find((d) => d.id === documentId);
  verifier(listeDocuments.status === 200 && documentRelu?.status === 'available'
    && documentRelu?.metadata?.productId === produit,
    'B8 GET /api/documents relit la preuve liee au bon produit avec son statut reel');

  const telechargement = await alpha('GET', `/api/documents/${documentId}/download`);
  verifier(telechargement.status === 200 && Boolean(telechargement.body?.download?.url),
    'B9 URL de telechargement privee delivree au proprietaire');
  if (telechargement.status === 200) {
    const objetRelu = await fetch(telechargement.body.download.url);
    const contenu = Buffer.from(await objetRelu.arrayBuffer());
    verifier(objetRelu.status === 200 && contenu.equals(octets),
      'B10 relecture des octets exacts depuis le stockage prive (integrite)',
      `statut=${objetRelu.status} taille=${contenu.byteLength}/${octets.byteLength}`);
  } else {
    ko('B10 relecture des octets exacts depuis le stockage prive', 'telechargement indisponible');
  }

  /* --- C. decisions humaines et historique ------------------------------- */
  console.log('\n  C — acceptation, rejet motive, historique');
  const accepte = await alpha('POST', `/api/documents/${documentId}/validation`, {
    decision: 'accepted', reason: `Certificat coherent avec le lot ${suffixe}.`,
  });
  verifier(accepte.status === 200 && accepte.body?.decision === 'accepted'
    && accepte.body?.evidence?.verification_result === 'accepted',
    'C1 decision « acceptee » enregistree avec motif',
    `statut=${accepte.status} corps=${accepte.text.slice(0, 220)}`);

  const rejetSansMotif = await alpha('POST', `/api/documents/${documentId}/validation`, { decision: 'rejected' });
  verifier(rejetSansMotif.status === 400 && rejetSansMotif.body?.error === 'document_rejection_reason_required',
    'C2 rejet sans motif refuse (400), aucune decision enregistree');

  await new Promise((resolve) => setTimeout(resolve, 8));
  const motifRejet = `Incoherence de lot constatee — ${suffixe}.`;
  const rejete = await alpha('POST', `/api/documents/${documentId}/validation`, {
    decision: 'rejected', reason: motifRejet,
  });
  verifier(rejete.status === 200 && rejete.body?.evidence?.verification_reason === motifRejet,
    'C3 rejet motive enregistre avec son motif exact',
    `statut=${rejete.status} corps=${rejete.text.slice(0, 220)}`);

  const historique = await proprietaire.query(
    'select count(*)::int as n from dpp_claim_evidence where document_id = $1::uuid', [documentId]);
  verifier(historique.rows[0].n >= 2,
    'C4 historique append-only relu en base : au moins deux decisions', `lignes=${historique.rows[0].n}`);

  /* --- D. apercu DPP brouillon prive ------------------------------------ */
  console.log('\n  D — apercu prive du passeport brouillon');
  const apercu = await alpha('GET', `/api/products/${produit}/dpp/preview`);
  verifier(apercu.status === 200 && apercu.body?.preview === true && apercu.body?.private === true,
    'D1 apercu prive deliver au proprietaire');
  verifier(apercu.body?.product?.description === description,
    'D2 apercu relit la description persistee, pas un objet de demonstration');
  verifier(apercu.body?.published === false && !apercu.body?.product?.publicSlug,
    'D3 simple consultation ne publie rien et ne cree aucun slug public');
  verifier((apercu.body?.documents || []).some((d) => d.id === documentId && d.status === 'available'),
    'D4 apercu lie la preuve du bon produit avec son statut reel');
  verifier(/no-store/i.test(apercu.headers.get('cache-control') || '')
    && /private/i.test(apercu.headers.get('cache-control') || '')
    && /noindex/i.test(apercu.headers.get('x-robots-tag') || ''),
    'D5 en-tetes prives : Cache-Control no-store/private + X-Robots-Tag noindex',
    `cache=${apercu.headers.get('cache-control')} robots=${apercu.headers.get('x-robots-tag')}`);

  /* --- E. isolation inter-locataires par HTTP ---------------------------- */
  console.log('\n  E — refus inter-locataires mesures par HTTP');
  const produitBeta = await beta('POST', '/api/products', {
    brandOrganizationId: orgBeta, reference: `BETA-${suffixe}`, name: 'Produit Beta', category: 'Accessoire', sku: `B-${suffixe}`,
  });
  verifier(produitBeta.status === 201,
    'E0 Beta cree son propre produit (la fixture des deux tenants est reelle)');

  const intrusions = [
    ['GET', `/api/products/${produit}`, undefined, 404],
    ['GET', `/api/documents?productId=${produit}`, undefined, 200],
    ['GET', `/api/documents/${documentId}/download`, undefined, 404],
    ['POST', `/api/documents/${documentId}/validation`, { decision: 'accepted' }, 404],
    ['POST', `/api/documents/${documentId}/scan`, undefined, 404],
    ['GET', `/api/products/${produit}/dpp/preview`, undefined, 404],
  ];
  const resultatsIntrusion = [];
  for (const [method, path, body, attendu] of intrusions) {
    const r = await beta(method, path, body);
    resultatsIntrusion.push(`${method} ${path.split('?')[0]}=${r.status}`);
    verifier(r.status === attendu,
      `E-${method} ${path.split('?')[0]} -> ${attendu} attendu`, `observe=${r.status} corps=${r.text.slice(0, 120)}`);
  }
  const listeBeta = await beta('GET', `/api/documents?productId=${produit}`);
  verifier(listeBeta.status === 200 && (listeBeta.body?.documents || []).length === 0,
    'E7 la liste documentaire de Beta ne contient aucune preuve d Alpha');
  const catalogueBeta = await beta('GET', '/api/products');
  verifier((catalogueBeta.body?.products || []).every((p) => p.brandOrganizationId === orgBeta),
    'E8 le catalogue de Beta ne contient aucun produit d Alpha');

  // Un en-tete de tenant falsifie avec le jeton Alpha ne deplace pas le contexte.
  const usurpation = await appeler('GET', `/api/products/${produit}`, { token: jetonAlpha, org: orgBeta });
  verifier(usurpation.status === 404,
    'E9 jeton Alpha + locataire Beta -> 404 (le serveur ne suit pas un tenant non autorise)',
    `observe=${usurpation.status}`);

  const lienEtranger = await alpha('POST', '/api/documents/upload-intent', {
    originalFilename: `intrusion-${suffixe}.txt`, contentType: 'text/plain', byteSize: 12,
    kind: 'other', metadata: { productId: produitBeta.body?.product?.id },
  });
  verifier(lienEtranger.status === 404 && lienEtranger.body?.error === 'product_not_found',
    'E10 association d une preuve a un produit d un autre tenant refusee',
    `statut=${lienEtranger.status} corps=${lienEtranger.text.slice(0, 160)}`);

  /* --- F. authentification et antivirus en echec ------------------------ */
  console.log('\n  F — authentification et antivirus');
  const anonymes = [
    ['GET', `/api/products/${produit}`],
    ['POST', '/api/documents/upload-intent'],
    ['GET', '/api/documents'],
    ['GET', `/api/documents/${documentId}/download`],
    ['GET', `/api/products/${produit}/dpp/preview`],
  ];
  for (const [method, path] of anonymes) {
    const r = await appeler(method, path, { org: orgAlpha });
    verifier(r.status === 401, `F-${method} ${path.split('?')[0]} sans jeton -> 401`, `observe=${r.status}`);
  }
  const forge = await appeler('GET', `/api/products/${produit}`, { token: jetonForge, org: orgAlpha });
  verifier(forge.status === 401,
    'F6 jeton RS256 signe par une cle etrangere -> 401 (verification reelle)', `observe=${forge.status}`);

  const expire = await appeler('GET', `/api/products/${produit}`, { token: jetonExpire, org: orgAlpha });
  verifier(expire.status === 401,
    'F10 jeton correctement signe mais EXPIRE -> 401', `observe=${expire.status}`);

  let malformesRefuses = 0;
  for (const [index, jeton] of jetonsMalformes.entries()) {
    const r = await appeler('GET', `/api/products/${produit}`, { token: jeton, org: orgAlpha });
    if (r.status === 401) malformesRefuses += 1;
    verifier(r.status === 401,
      `F11.${index + 1} jeton malforme -> 401`, `observe=${r.status} corps=${r.text.slice(0, 90)}`);
  }
  verifier(malformesRefuses === 3,
    'F11 les trois formes malformees (structure, base64, algorithme) sont rejetees');

  // Le jeton valide reste accepte APRES tous ces refus : le durcissement ne
  // transforme pas l'authentification en refus permanent.
  const encoreValide = await alpha('GET', `/api/products/${produit}`);
  verifier(encoreValide.status === 200 && encoreValide.body?.product?.id === produit,
    'F12 le jeton valide est toujours accepte apres les refus (pas de fail-closed global)');

  // Une panne d'infrastructure (JWKS injoignable, cle serveur invalide) ne
  // doit PAS etre deguisee en 401 : elle doit rester une erreur serveur.
  const RAISONS_JETON = [
    'token-expired', 'token-invalid', 'token-invalid-algorithm',
    'token-invalid-authorized-parties', 'token-invalid-signature',
    'token-not-active-yet', 'token-iat-in-the-future',
    'token-verification-failed', 'jwk-kid-mismatch',
  ];
  const RAISONS_SERVEUR = [
    'secret-key-invalid', 'jwk-local-missing', 'jwk-remote-failed-to-load',
    'jwk-remote-invalid', 'jwk-remote-missing', 'jwk-failed-to-resolve',
  ];
  verifier(RAISONS_JETON.every((r) => isRejectedTokenVerification({ reason: r })),
    'F13 les 9 raisons liees au jeton sont classifiees 401');
  verifier(RAISONS_SERVEUR.every((r) => !isRejectedTokenVerification({ reason: r })),
    'F14 les 6 raisons d exploitation restent des erreurs serveur (jamais 401)');
  verifier(!isRejectedTokenVerification(new Error('unexpected')) && !isRejectedTokenVerification(null),
    'F15 une exception inattendue ou une valeur nulle n est pas masquee en 401');

  // Fichier contenant la signature de test EICAR : l'antivirus doit le
  // declarer infecte et le document doit basculer en « rejected ».
  const infecte = eicarTestBytes();
  const intentionInfectee = await alpha('POST', '/api/documents/upload-intent', {
    originalFilename: `infecte-${suffixe}.txt`, contentType: 'text/plain', byteSize: infecte.byteLength,
    kind: 'other', metadata: { productId: produit },
  });
  const documentInfecte = intentionInfectee.body?.document?.id;
  if (intentionInfectee.status === 201 && documentInfecte) {
    await fetch(intentionInfectee.body.upload.url, {
      method: 'PUT', headers: intentionInfectee.body.upload.headers, body: infecte,
    });
    const scanInfecte = await alpha('POST', `/api/documents/${documentInfecte}/scan`, undefined);
    verifier(scanInfecte.status === 200 && scanInfecte.body?.document?.status === 'rejected',
      'F7 fichier EICAR rejete par l antivirus, jamais declare « clean »',
      `statut=${scanInfecte.status} corps=${scanInfecte.text.slice(0, 220)}`);
    const downloadInfecte = await alpha('GET', `/api/documents/${documentInfecte}/download`);
    verifier(downloadInfecte.status === 404,
      'F8 document rejete non telechargeable', `observe=${downloadInfecte.status}`);
    const statsFinales = stockage.stats();
    verifier(statsFinales.scans.some((s) => s.clean === false),
      'F9 le service antivirus a bien rendu un verdict « infecte » au moins une fois');
  } else {
    ko('F7 fichier EICAR rejete par l antivirus', `intention statut=${intentionInfectee.status}`);
    ko('F8 document rejete non telechargeable', 'non execute faute de document');
    ko('F9 verdict antivirus infecte', 'non execute faute de document');
  }

  const stats = stockage.stats();
  console.log(`\n  stockage : ${stats.stored} objet(s), ${stats.lectures.length} lecture(s) signee(s), `
    + `${stats.refus.length} refus de signature, ${stats.scans.length} analyse(s) antivirus`);
  console.log(`  Clerk de test : ${JSON.stringify(clerk.stats())}`);
} catch (error) {
  ko('execution de la suite', String(error?.stack || error).split('\n').slice(0, 14).join(' | '));
} finally {
  if (api) await api.stop().catch(() => {});
  if (stockage) await stockage.stop().catch(() => {});
  if (clerk) clerk.stop();
  if (prisma) await prisma.$disconnect().catch(() => {});
  if (proprietaire) await proprietaire.end().catch(() => {});
}

console.log(`\n  RESULTAT : ${total - echecs}/${total} controles reels reussis`);
if (echecs > 0) {
  console.error(`  ${echecs} ECHEC(S) — voir les lignes ci-dessus. Aucun vert n'est declare pour les controles en echec.`);
  process.exit(SORTIE_ECHEC);
}
console.log('  Tous les controles executes sont PASS. Rappel : les services externes sont LOCAUX —');
console.log('  la validation Clerk / stockage managed / antivirus de PREPRODUCTION reste a faire.');
