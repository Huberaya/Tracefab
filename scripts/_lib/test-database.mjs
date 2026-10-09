/**
 * Base de test PostgreSQL, partagée par les tests d'intégration.
 *
 * POURQUOI CE MODULE EXISTE
 *   Les tests `test:neon:*` faisaient chacun `new PrismaClient()` et se mettaient
 *   en SKIP sans DATABASE_URL. Deux problèmes distincts :
 *
 *   1. Le client est généré avec `engineType = "client"` (voir
 *      scripts/generate_prisma_client.mjs) : son compilateur de requêtes WASM
 *      exige un adaptateur de pilote. Sans lui, `new PrismaClient()` lève
 *      « Missing configured driver adapter » — pas un SKIP, une erreur.
 *   2. Aucune base n'était jamais démarrée.
 *
 *   Ce module résout les deux : il démarre un PostgreSQL réel (embedded-postgres,
 *   depuis PyPI), applique les migrations, et rend un PrismaClient muni de son
 *   adaptateur. Un seul endroit pour le faire — seize copies finiraient par
 *   diverger.
 *
 * ORDRE DE RÉSOLUTION
 *   1. `DATABASE_URL` déjà défini  → on l'utilise tel quel. C'est le chemin d'un
 *      environnement qui fournit sa base (CI, Neon, poste de développement).
 *   2. Sinon                      → démarrage d'une base locale jetable.
 *   3. Si le démarrage échoue     → `null`, et l'appelant doit se déclarer
 *      INDISPONIBLE (code de sortie 2, classé SKIP). Jamais un succès : une
 *      vérification qui n'a pas eu lieu ne doit pas ressembler à une
 *      vérification réussie.
 *
 * LE SOCKET, PAS TCP
 *   `embedded_postgres` démarre postgres avec `-h ""`, donc aucune écoute TCP.
 *   L'URI contient `?host=<répertoire de socket>`, que le pilote `pg` interprète
 *   comme un socket de domaine. Passer cet URI à autre chose qu'à `pg` échouerait.
 */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const at = (p) => join(root, p);

const VENV_PYTHON = at('.cache/pgvenv/bin/python');
const SERVER = at('scripts/test_database_server.py');

let serverProcess = null;
let client = null;
let adapter = null;

/**
 * Démarre la base si nécessaire et renvoie `{ prisma, uri, startedHere }`,
 * ou `null` si aucune base n'est disponible.
 */
export async function connectTestDatabase({ label = 'test' } = {}) {
  if (client) return { prisma: client, uri: process.env.DATABASE_URL ?? '', startedHere: false };

  const external = process.env.DATABASE_URL;
  let uri = external;
  let startedHere = false;

  if (!uri) {
    const started = await startLocalServer();
    if (!started) return null;
    uri = started;
    startedHere = true;
    process.env.DATABASE_URL = uri;
  }

  const { PrismaClient } = await import('@prisma/client');
  const { PrismaPg } = await import('@prisma/adapter-pg');
  /*
   * L'URL va DANS l'adaptateur. Prisma refuse explicitement de recevoir à la
   * fois un adaptateur et l'option `datasources` (« Custom datasource
   * configuration is not compatible with Prisma Driver Adapters »).
   */
  adapter = new PrismaPg({ connectionString: uri });
  client = new PrismaClient({ adapter });
  return { prisma: client, uri, startedHere };
}

/** Ferme le client, puis le serveur s'il a été démarré ici. */
export async function disconnectTestDatabase() {
  try { await client?.$disconnect(); } catch { /* déjà fermé */ }
  client = null;
  adapter = null;
  if (serverProcess) {
    /* Fermer stdin est le signal d'arrêt convenu avec le script Python. */
    try { serverProcess.stdin.end(); } catch { /* déjà clos */ }
    const exited = await new Promise((done) => {
      const timer = setTimeout(() => done(false), 15000);
      serverProcess.once('exit', () => { clearTimeout(timer); done(true); });
    });
    if (!exited) serverProcess.kill('SIGKILL');
    serverProcess = null;
  }
}

/** Renvoie l'URI de la base locale, ou null si le serveur n'a pas pu démarrer. */
async function startLocalServer() {
  const { existsSync } = await import('node:fs');
  if (!existsSync(VENV_PYTHON) || !existsSync(SERVER)) {
    console.error('POSTGRES_SERVER_UNAVAILABLE: venv ou script de serveur absent');
    console.error('  à faire : python3 -m venv .cache/pgvenv && .cache/pgvenv/bin/pip install pglast embedded-postgres');
    return null;
  }

  const child = spawn(VENV_PYTHON, [SERVER], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  serverProcess = child;

  /*
   * `unref()` est indispensable.
   *
   * Sans lui, l'enfant Python maintient la boucle d'événements Node ouverte :
   * le test affichait « passed » puis restait pendu jusqu'à ce que `timeout` le
   * tue — 400 s pour un test qui en dure 2. Avec `unref()`, Node peut sortir dès
   * que le test a fini ; la fermeture du descripteur stdin fait alors revenir
   * `sys.stdin.read()` côté Python, qui arrête proprement PostgreSQL.
   */
  child.unref();
  /*
   * `unref()` sur l'enfant ne suffit pas : ses trois flux stdio sont des
   * descripteurs distincts (mesuré : 5 PipeWrap encore actifs après
   * $disconnect(), donc le processus ne sortait jamais). Les détacher aussi.
   */
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try { stream.unref?.(); } catch { /* selon la version de Node */ }
  }

  let out = '';
  return new Promise((done) => {
    const timer = setTimeout(() => {
      console.error('POSTGRES_SERVER_UNAVAILABLE: délai dépassé en attendant l\'URI de la base');
      console.error(out.split('\n').slice(-6).join('\n'));
      try { child.kill('SIGKILL'); } catch { /* déjà mort */ }
      serverProcess = null;
      done(null);
    }, 300000);

    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      for (const line of out.split('\n')) {
        if (line.startsWith('TRACEFAB_TEST_DB_URI=')) {
          clearTimeout(timer);
          done(line.slice('TRACEFAB_TEST_DB_URI='.length).trim());
          return;
        }
        if (line.startsWith('POSTGRES_SERVER_UNAVAILABLE')) {
          clearTimeout(timer);
          console.error(line);
          serverProcess = null;
          done(null);
          return;
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      /* Le avertissement platformdirs sur XDG_RUNTIME_DIR est attendu et sans effet. */
      if (!/RuntimeDirWarning|return Path\(/.test(text)) process.stderr.write(text);
    });
    child.on('exit', (code) => {
      if (code !== 0 && !out.includes('TRACEFAB_TEST_DB_URI=')) {
        clearTimeout(timer);
        console.error(out.split('\n').filter(Boolean).slice(-4).join('\n'));
        serverProcess = null;
        done(null);
      }
    });
  });
}

/**
 * En-tête commun aux tests d'intégration : connexion, ou SKIP propre.
 *
 * À appeler en tête de test ; renvoie le client. En cas d'indisponibilité,
 * affiche le marqueur et sort en code 2 — le runner classe ce cas en SKIP.
 */
export async function requireTestDatabase(label) {
  const db = await connectTestDatabase({ label });
  if (!db) {
    console.error('DATABASE_UNAVAILABLE: aucune base de test joignable');
    process.exit(2);
  }
  return db;
}

/**
 * Fixture minimale : un utilisateur, une organisation de marque et son
 * propriétaire actif.
 *
 * POURQUOI
 *   `test_neon_green_claims` et `test_neon_pef` cherchent un
 *   `organization_memberships` avec `role: 'owner', status: 'active'` et
 *   s'arrêtent s'il n'y en a pas. Contre une base Neon déjà peuplée ils en
 *   trouvent un ; contre une base de test freshly migrée, il n'y a aucune ligne
 *   et les deux échouent sur « Must have at least one brand owner ».
 *
 *   Ces tests vérifient des allégations environnementales et un score PEF, pas
 *   la création d'organisation : leur faire créer leur propre contexte noierait
 *   ce qu'ils mesurent. D'où cette fixture partagée plutôt que deux copies.
 *
 * IDEMPOTENTE
 *   La base est réutilisée d'un test à l'autre. Sans recherche préalable, chaque
 *   exécution ajouterait un utilisateur et une organisation — et un test qui
 *   compte les organisations verrait son résultat dépendre du nombre de runs.
 *
 * Les valeurs sont explicitement marquées comme données de test.
 */
export async function ensureBrandOwnerFixture(prisma, {
  email = 'brand-owner.test@tracefab.local',
  legalName = 'Marque de test TRACEFAB',
} = {}) {
  const existing = await prisma.organization_memberships.findFirst({
    where: { role: 'owner', status: 'active' },
    include: { organizations: true, users_organization_memberships_user_idTousers: true },
  });
  if (existing) {
    return {
      userId: existing.user_id,
      organizationId: existing.organization_id,
      email: existing.users_organization_memberships_user_idTousers?.email ?? email,
      created: false,
    };
  }

  /*
   * Le modèle s'appelle `User` (table `users` via @@map) : le délégué est donc
   * `prisma.user`, pas `prisma.users`. Et `clerkUserId` est obligatoire et
   * unique — l'omettre fait échouer la création sans message évident.
   */
  const user = await prisma.user.create({
    data: {
      clerkUserId: `test-brand-owner-${email.replace(/[^a-z0-9]/gi, '_')}`,
      email,
      fullName: 'Propriétaire de test',
    },
    select: { id: true, email: true },
  });
  const organization = await prisma.organizations.create({
    data: { type: 'brand', legal_name: legalName, status: 'active', created_by: user.id },
    select: { id: true },
  });
  await prisma.organization_memberships.create({
    data: { organization_id: organization.id, user_id: user.id, role: 'owner', status: 'active' },
  });
  return { userId: user.id, organizationId: organization.id, email: user.email, created: true };
}

/**
 * Fixture : un produit rattaché à une organisation, avec une composition.
 *
 * POURQUOI
 *   `test_neon_wallet_chantier9` cherche `tracefab_products` ayant au moins un
 *   `product_materials` et s'arrête sinon. Sur une base fraîchement migrée il n'y
 *   en a aucun.
 *
 *   Ce test passait auparavant PAR ACCIDENT : il tournait après
 *   test:neon:bulk:chantier8, qui crée des produits. Une dépendance à l'ordre
 *   d'exécution n'est pas une propriété du test — elle a disparu dès que la base
 *   a été recréée, et le test s'est mis à échouer sans qu'aucun code du wallet
 *   ait changé.
 *
 * Idempotente, pour les mêmes raisons que ensureBrandOwnerFixture.
 */
export async function ensureProductWithMaterialsFixture(prisma, {
  reference = 'TF-FIXTURE-01',
} = {}) {
  const brand = await ensureBrandOwnerFixture(prisma);
  const organizationId = brand.organizationId;

  const existing = await prisma.tracefab_products.findFirst({
    where: { product_materials: { some: {} } },
    select: { id: true, reference: true },
  });
  if (existing) return { ...existing, created: false };

  const material = await prisma.materials.create({
    data: {
      owner_organization_id: organizationId,
      material_type: 'fiber',
      name: 'Coton biologique de test',
    },
    select: { id: true },
  });
  const product = await prisma.tracefab_products.create({
    data: {
      brand_organization_id: organizationId,
      reference,
      name: 'Produit de test avec composition',
    },
    select: { id: true, reference: true },
  });
  await prisma.product_materials.create({
    data: {
      product_id: product.id,
      material_id: material.id,
      material_role: 'shell',
      percentage: 100,
      unit: '%',
    },
  });
  return { id: product.id, reference: product.reference, created: true };
}
