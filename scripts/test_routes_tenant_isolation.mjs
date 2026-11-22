#!/usr/bin/env node
/**
 * Routes metier — autorisation et isolation, prouvees par execution.
 *
 * POURQUOI CE FICHIER EXISTE
 *
 * Les trois routes de la console — /api/organizations, /api/products,
 * /api/suppliers — n'avaient jamais ete exercees avec une identite reelle. Ce
 * qui avait ete mesure etait leur REFUS (401 sans en-tete Authorization), pas
 * leur fonctionnement. Un refus mesure ne dit rien de ce qu'une route rend a
 * qui a le droit : c'est pourtant la que se joue l'isolation multi-locataire.
 *
 * CE QU'IL FAIT
 *
 * Il fabrique deux identites de TEST dans une instance Clerk DE TEST, il les
 * rattache aux deux locataires de la fixture du depot (« Maison Alpha » et
 * « Maison Beta », creees par npm run db:seed-rls), puis il appelle les routes
 * avec de vrais jetons de session Clerk — donc verifies par le vrai
 * `verifyToken` du code applicatif. Aucune doublure d'authentification n'est
 * posee : le code de production fait foi.
 *
 *   A1  acces autorise          jeton alpha -> GET /api/organizations : ses
 *                               organisations, et PAS celles de Beta
 *   A2  absence d'authentification  aucune en-tete -> 401 sur les trois routes
 *   A3  permissions insuffisantes   jeton alpha (adhesion « viewer » sur Beta)
 *                               -> POST /api/products sur Beta : 403
 *                               `brand_product_role_required`
 *   A4  isolation entre deux organisations  produits et fournisseurs d'Alpha
 *                               ne contiennent jamais ceux de Beta, et
 *                               l'inverse ; ?organizationId=<Beta> avec le
 *                               jeton alpha rend une liste VIDE, pas une fuite
 *
 * CE QU'IL REFUSE — LE REFUS EST LE DEFAUT
 *
 *   1. Sans TF_ROUTES_TEST_HARNESS=1, il ne fait rien (sortie 3).
 *   2. Il refuse tout contexte de deploiement de production (NODE_ENV ou
 *      VERCEL_ENV = production), meme avec un drapeau explicite.
 *   3. Il passe la cible par la garde du depot
 *      (scripts/lib/require-throwaway-db.mjs) : base locale jetable, ou
 *      distante explicitement autorisee. Un hote manage, un nom evoquant la
 *      production, une cible ambigue : refuses.
 *   4. Il exige une cle d'instance Clerk DE TEST (`sk_test_...`). Une cle de
 *      production (`sk_live_...`) est refusee sans etre affichee, et la cle
 *      n'est jamais imprimee ni journalisee.
 *   5. Il ne s'execute pas avec un client Prisma inutilisable : il le dit et
 *      sort en 2 plutot que de rendre un vert sans rien avoir prouve.
 *
 * CE QU'IL NE PROUVE PAS
 *
 * Il ne prouve pas la production, ni le rendu de la console, ni les autres
 * routes. Il ne remplace pas l'observation en preproduction.
 *
 * USAGE
 *
 *   TF_ROUTES_TEST_HARNESS=1 \
 *   DATABASE_URL=postgresql://postgres:...@127.0.0.1:5432/tracefab_test \
 *   CLERK_SECRET_KEY=sk_test_... \
 *   npx tsx scripts/test_routes_tenant_isolation.mjs
 *
 * La cle attendue est celle d'une instance de TEST (aucune donnee reelle).
 * Elle se fournit par un mecanisme securise, jamais dans un ticket, un
 * rapport ou un commit : le harnais ne l'imprime jamais, meme tronquee.
 *
 * CODES DE SORTIE : 0 tous les cas passent · 1 au moins un cas echoue ·
 *                   2 prerequis manquant (rien n'a tourne) · 3 refus
 */

import crypto from 'node:crypto';
import pg from 'pg';
import { createClerkClient } from '@clerk/backend';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';

const SORTIE_ECHEC = 1;
const SORTIE_PREREQUIS = 2;
const SORTIE_REFUS = 3;

const refuser = (message) => {
  console.error(`  REFUS — ${message}`);
  process.exit(SORTIE_REFUS);
};

const manquant = (message) => {
  console.error(`  NON EXECUTE — ${message}`);
  process.exit(SORTIE_PREREQUIS);
};

/* --- 1. gardes de contexte et de cible ------------------------------------ */

if (process.env.TF_ROUTES_TEST_HARNESS !== '1') {
  refuser(
    'ce harnais ne s execute pas par accident. Posez TF_ROUTES_TEST_HARNESS=1 en connaissance de cause.',
  );
}

if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') {
  refuser('contexte de deploiement de production : une eprouve locale n a rien a y faire.');
}

const garde = requireThrowawayDb({ purpose: 'scripts/test_routes_tenant_isolation.mjs' });
for (const ligne of garde.summary) console.log(`  garde cible : ${ligne}`);

const cleClerk = process.env.CLERK_SECRET_KEY || '';
if (!cleClerk) {
  manquant(
    'CLERK_SECRET_KEY absente. Fournissez la cle d une instance Clerk DE TEST par un mecanisme securise (jamais dans un ticket ni un rapport).',
  );
}
if (!cleClerk.startsWith('sk_test_')) {
  // Pas de valeur affichee, meme tronquee : un prefixe suffit a decider.
  refuser(
    'CLERK_SECRET_KEY ne porte pas le prefixe d une instance de test (`sk_test_`). Une cle de production est refusee ici, par principe.',
  );
}

const URL_PROPRIO = process.env.DATABASE_URL;

/* --- 2. client Prisma reellement utilisable ? ----------------------------- */

process.env.CLERK_SECRET_KEY = cleClerk;

let handler;
try {
  ({ default: handler } = await import('../api/index.ts'));
} catch (error) {
  manquant(
    `le routeur applicatif n a pas pu etre charge (${String(error?.message).split('\n')[0]}). `
    + 'Ce fichier importe du TypeScript : lancez-le avec `npx tsx`, apres `npm ci`.',
  );
}

let prisma;
try {
  ({ prisma } = await import('../api/_lib/prisma.ts'));
} catch (error) {
  manquant(
    'client Prisma inutilisable contre la base cible '
    + `(${String(error?.message).split('\n')[0]}). Un client non genere — moteur absent — `
    + 'ne prouve rien : lancez `npm ci` puis `npm run db:generate` dans un environnement reseau.',
  );
}

// La verification ne se contente pas d'un aller-retour : elle exige que le
// client lise LA base declaree et qu'il y trouve la fixture. Une doublure de
// client rend des resultats vides et franchirait un simple `SELECT 1` — c'est
// exactement ainsi qu'un harnais se met a mesurer sa propre doublure.
try {
  const [{ d } = {}] = await prisma.$queryRaw`SELECT current_database() AS d`;
  const attendue = decodeURIComponent(new URL(URL_PROPRIO.replace('@/', '@___DUMMY___/')).pathname.replace(/^\//, ''));
  if (d !== attendue) {
    refuser(
      `le client Prisma lit la base « ${d ?? 'inconnue'} » alors que la cible declaree est « ${attendue} » : arret avant toute mesure.`,
    );
  }
  const [{ n } = {}] = await prisma.$queryRaw`SELECT count(*)::int AS n FROM organizations`;
  if (!Number.isInteger(n) || n < 2) {
    manquant(
      `le client Prisma ne lit pas la fixture (organisations lues : ${n ?? 'aucune'}). `
      + 'Lancez `npm run db:seed-rls` sur cette meme base jetable, puis relancez.',
    );
  }
} catch (error) {
  manquant(
    'client Prisma inutilisable ou incapable de lire la base cible '
    + `(${String(error?.message).split('\n')[0]}). Doublure de client, moteur absent ou base non preparee : `
    + 'lancez `npm ci`, `npm run db:generate` puis `npm run db:seed-rls` dans un environnement reseau.',
  );
}

/* --- 3. identites de test dans l instance Clerk DE TEST ------------------- */

const clerk = createClerkClient({ secretKey: cleClerk });

const LOCATAIRES = [
  { cle: 'alpha', email: 'alpha@rls.fixture.test', prenom: 'Alpha', nom: 'Test' },
  { cle: 'beta', email: 'beta@rls.fixture.test', prenom: 'Beta', nom: 'Test' },
];

async function identiteDeTest({ email, prenom, nom }) {
  const page = await clerk.users.getUserList({ emailAddress: [email], limit: 1 });
  const existant = page?.data?.[0];
  if (existant) return existant;
  return clerk.users.createUser({
    emailAddress: [email],
    firstName: prenom,
    lastName: nom,
    password: `Tf-${crypto.randomBytes(18).toString('base64url')}`,
  });
}

async function jetonDeSession(userId) {
  const session = await clerk.sessions.createSession({ userId });
  const jeton = await clerk.sessions.getToken(session.id);
  const jwt = typeof jeton === 'string' ? jeton : jeton?.jwt;
  if (!jwt) throw new Error('jeton de session vide');
  return { jwt, sessionId: session.id };
}

/* --- 4. fixtures : les deux locataires du depot, rattaches aux identites -- */

// Identifiants deterministes du seed du depot (scripts/seed_rls_fixture.mjs) :
// le harnais ne fabrique pas sa propre fixture, il reutilise la seule qui
// existe, et il la rattache aux identites de test par l'email.
const uuidFixture = (graine) => {
  const h = crypto.createHash('sha1').update(`tracefab-rls-${graine}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const ORG = { alpha: uuidFixture('org-alpha'), beta: uuidFixture('org-beta') };
const USER_FIXTURE = { alpha: uuidFixture('user-alpha'), beta: uuidFixture('user-beta') };

const base = new pg.Client({
  connectionString: URL_PROPRIO,
  ssl: /sslmode=(require|verify-full|verify-ca)/.test(URL_PROPRIO) ? { rejectUnauthorized: true } : undefined,
});
await base.connect();

const comptes = await base.query('select count(*)::int n from organizations');
if (comptes.rows[0].n < 2) {
  manquant(
    'la fixture est absente : lancez d abord `npm run db:seed-rls` sur cette meme base jetable.',
  );
}

const identites = {};
try {
for (const locataire of LOCATAIRES) {
  const utilisateurClerk = await identiteDeTest(locataire);
  // Rattachement : le code applicatif upsert l utilisateur par `clerk_user_id`
  // et `email` est unique. La ligne de fixture doit donc porter l identifiant
  // Clerk de l instance de test, sans quoi l upsert violerait l unicite.
  await base.query('update users set clerk_user_id = $1 where id = $2', [
    utilisateurClerk.id,
    USER_FIXTURE[locataire.cle],
  ]);
  identites[locataire.cle] = { ...locataire, clerkUserId: utilisateurClerk.id };
}
} catch (error) {
  manquant(
    'instance Clerk de test injoignable ou refusante '
    + `(${String(error?.errors?.[0]?.code ?? error?.message).split('\n')[0]}). `
    + 'Verifiez la cle d instance de test et l acces reseau vers api.clerk.com : '
    + 'aucun cas n a ete mesure, rien n est declare reussi.',
  );
}

const jetons = {};
for (const cle of ['alpha', 'beta']) jetons[cle] = await jetonDeSession(identites[cle].clerkUserId);

/* --- 5. doubles de requete et de reponse ---------------------------------- */

function reponse() {
  const entetes = {};
  const res = {
    statusCode: 200,
    emitted: null,
    getHeader: (n) => entetes[String(n).toLowerCase()],
    setHeader: (n, v) => {
      entetes[String(n).toLowerCase()] = v;
      return res;
    },
    status(c) {
      res.statusCode = c;
      return res;
    },
    json(p) {
      res.emitted = p;
      return res;
    },
    send(p) {
      res.emitted = p;
      return res;
    },
    end() {
      return res;
    },
    set() {
      return res;
    },
    on() {
      return res;
    },
  };
  return res;
}

function requete({ url, methode = 'GET', jeton, corps }) {
  const [, chemin, interro] = url.match(/^([^?]*)(?:\?(.*))?$/) || [];
  const query = {};
  for (const paire of (interro || '').split('&').filter(Boolean)) {
    const [c, v] = paire.split('=');
    query[decodeURIComponent(c)] = decodeURIComponent(v ?? '');
  }
  return {
    url,
    method: methode,
    query,
    body: corps,
    headers: {
      host: 'tracefab.test',
      'user-agent': 'epreuve-isolation-locale',
      ...(jeton ? { authorization: `Bearer ${jeton}` } : {}),
    },
    socket: { remoteAddress: '203.0.113.10' },
    on() {},
    once() {},
    removeListener() {},
  };
}

const appeler = async (options) => {
  const res = reponse();
  const journaux = [];
  const vraiError = console.error;
  console.error = (...a) => journaux.push(a.map(String).join(' '));
  try {
    await handler(requete(options), res);
  } finally {
    console.error = vraiError;
  }
  return { statut: res.statusCode, corps: res.emitted, journaux };
};

/* --- 6. les cas ------------------------------------------------------------ */

const resultats = [];
const verifier = (nom, attendu, condition, observe) => {
  resultats.push({ nom, attendu, verdict: condition ? 'ok' : 'ECHEC', observe });
};

// A1 — acces autorise.
{
  const { statut, corps } = await appeler({ url: '/api/organizations', jeton: jetons.alpha.jwt });
  const ids = Array.isArray(corps?.organizations) ? corps.organizations.map((m) => m?.organization?.id) : [];
  verifier(
    'A1 acces autorise — jeton alpha, GET /api/organizations',
    '200, contient org-alpha, ne contient pas org-beta',
    statut === 200 && ids.includes(ORG.alpha) && !ids.includes(ORG.beta),
    `statut=${statut} organisations=${ids.length} alpha=${ids.includes(ORG.alpha)} beta=${ids.includes(ORG.beta)}`,
  );
}

// A2 — absence d'authentification, sur les trois routes.
{
  const routes = ['/api/organizations', '/api/products', '/api/suppliers'];
  for (const url of routes) {
    const { statut, corps } = await appeler({ url });
    verifier(
      `A2 sans jeton — GET ${url}`,
      '401 unauthorized',
      statut === 401 && corps?.error === 'unauthorized',
      `statut=${statut} erreur=${corps?.error}`,
    );
  }
}

// Adhesion a role faible : alpha devient « viewer » de Beta. C est ce qui
// distingue « membre sans droit d ecriture » de « non-membre ».
await base.query(
  `insert into organization_memberships (id, organization_id, user_id, role)
   values ($1, $2, $3, 'viewer')
   on conflict (id) do update set role = 'viewer'`,
  [uuidFixture('mem-alpha-beta-viewer'), ORG.beta, USER_FIXTURE.alpha],
);

// A3 — permissions insuffisantes : viewer de Beta ne cree pas de produit.
{
  const { statut, corps } = await appeler({
    url: '/api/products',
    methode: 'POST',
    jeton: jetons.alpha.jwt,
    corps: { brandOrganizationId: ORG.beta, reference: 'HARNAIS-001', name: 'Article refuse' },
  });
  verifier(
    'A3 permissions insuffisantes — jeton alpha (viewer de Beta), POST /api/products',
    '403 brand_product_role_required',
    statut === 403 && corps?.error === 'brand_product_role_required',
    `statut=${statut} erreur=${corps?.error}`,
  );
}

// A4 — isolation entre deux organisations.
{
  const alpha = await appeler({ url: '/api/products', jeton: jetons.alpha.jwt });
  const beta = await appeler({ url: '/api/products', jeton: jetons.beta.jwt });
  const idsAlpha = new Set((alpha.corps?.products || []).map((p) => p?.brandOrganizationId ?? p?.brand_organization_id));
  const idsBeta = new Set((beta.corps?.products || []).map((p) => p?.brandOrganizationId ?? p?.brand_organization_id));
  const intersection = [...idsAlpha].filter((id) => idsBeta.has(id));
  verifier(
    'A4a isolation produits — jeton alpha vs jeton beta',
    'aucune organisation en commun, aucun produit rendu par les deux',
    alpha.statut === 200 && beta.statut === 200
      && idsAlpha.has(ORG.alpha) && !idsAlpha.has(ORG.beta)
      && idsBeta.has(ORG.beta) && !idsBeta.has(ORG.alpha)
      && intersection.length === 0,
    `alpha=${[...idsAlpha].length} org(s) beta=${[...idsBeta].length} org(s) intersection=${intersection.length}`,
  );

  const cibleBeta = await appeler({ url: `/api/products?organizationId=${ORG.beta}`, jeton: jetons.alpha.jwt });
  const produitsVus = Array.isArray(cibleBeta.corps?.products) ? cibleBeta.corps.products.length : -1;
  verifier(
    'A4b fuite ? — jeton alpha, GET /api/products?organizationId=<Beta>',
    '200 avec une liste VIDE (jamais un produit de Beta)',
    cibleBeta.statut === 200 && produitsVus === 0,
    `statut=${cibleBeta.statut} produits=${produitsVus}`,
  );

  const fournisseurs = await appeler({ url: '/api/suppliers', jeton: jetons.alpha.jwt });
  const organisationsFournisseurs = Array.isArray(fournisseurs.corps?.suppliers)
    ? [...new Set(fournisseurs.corps.suppliers.map((s) => s?.organizationId ?? s?.organization_id))]
    : null;
  verifier(
    'A4c isolation fournisseurs — jeton alpha, GET /api/suppliers',
    '200, aucun fournisseur de Beta',
    fournisseurs.statut === 200 && Array.isArray(organisationsFournisseurs)
      && organisationsFournisseurs.length > 0 && !organisationsFournisseurs.includes(ORG.beta),
    `statut=${fournisseurs.statut} organisations=${organisationsFournisseurs?.length ?? 'n/a'} beta=${organisationsFournisseurs?.includes(ORG.beta)}`,
  );
}

/* --- 7. bilan -------------------------------------------------------------- */

console.log('');
for (const r of resultats) {
  console.log(`  ${r.verdict.padEnd(5)} ${r.nom}`);
  console.log(`        attendu : ${r.attendu}`);
  console.log(`        observe : ${r.observe}`);
}

const echecs = resultats.filter((r) => r.verdict === 'ECHEC').length;
console.log('');
console.log(`  ${resultats.length} cas · ${resultats.length - echecs} ok · ${echecs} echec(s)`);

await base.end();
process.exit(echecs > 0 ? SORTIE_ECHEC : 0);
