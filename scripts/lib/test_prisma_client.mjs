/**
 * Client Prisma pour les tests bases de donnees, dans deux environnements :
 *
 *   - CI : les engines natifs Prisma sont installes (npm ci + reseau) — le
 *     client standard tourne tel quel ;
 *   - poste sans accès a binaries.prisma.sh : le client est genere en
 *     engineType "client" (moteur WASM) et alimente par l'adaptateur
 *     @prisma/adapter-pg. Aucune requete ne passe par un engine natif.
 *
 * Dans les deux cas, les requetes sont envoyees par le role fourni dans
 * l'URL — l'idee est que les tests tournent avec le role RUNTIME reel
 * (`tracefab_app`, sans BYPASSRLS), pas avec le proprietaire de la base.
 *
 * Les tests qui s'en servent injectent le client dans `globalThis.tracefabPrisma`
 * AVANT d'importer les modules de l'API : api/_lib/prisma.js reutilise alors
 * ce client au lieu d'en creer un.
 */

/**
 * @param {string} connectionString URL du role applicatif (ex. tracefab_app)
 * @returns {Promise<import('@prisma/client').PrismaClient>}
 */
export async function createTestPrisma(connectionString) {
  const { PrismaClient } = await import('@prisma/client');

  // Chemin CI / poste equipe : client standard (engine natif). L'URL du
  // role applicatif DOIT etre celle fournie — pas DATABASE_URL, qui est le
  // proprietaire et contourne la RLS : sans cela les assertions « refuse par
  // la politique » passent faux en CI et vraient localement.
  try {
    const standard = new PrismaClient({ datasourceUrl: connectionString });
    await standard.$queryRaw`SELECT 1`;
    console.log('  client Prisma : engine standard');
    return standard;
  } catch {
    // Chemin sans engine natif : moteur client (WASM) + adaptateur pg.
  }

  const { PrismaPg } = await import('@prisma/adapter-pg');
  const pg = await import('pg');
  const pool = new pg.Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  const client = new PrismaClient({ adapter });
  await client.$queryRaw`SELECT 1`;
  // MESURE DU 30/10 : sur ce chemin, `$disconnect()` ne ferme PAS le pool pg
  // (une connexion reste ouverte dans `pg_stat_activity`). Une suite qui
  // detruit ensuite sa base voyait alors ses connexions tuees par
  // `DROP DATABASE ... WITH (FORCE)` et mourait sur 57P01. On garde donc une
  // reference non enumerable, pour que `fermerPrismaDeTest` puisse le fermer.
  Object.defineProperty(client, '$poolPg', { value: pool, enumerable: false });
  console.log('  client Prisma : moteur client WASM + adaptateur pg');
  return client;
}

/**
 * Ferme le client ET le pool sous-jacent.
 *
 * A utiliser dans toute suite qui detruit la base a la fin : `$disconnect()`
 * seul laisse le pool pg ouvert sur le chemin WASM.
 */
export async function fermerPrismaDeTest(client) {
  if (!client) return;
  const pool = client.$poolPg;
  try {
    await client.$disconnect();
  } finally {
    if (pool) await pool.end();
  }
}

/**
 * Injecte le client comme singleton de api/_lib/prisma.js pour les modules
 * charges ensuite. Point d'injection existant du module (globalForPrisma).
 */
export function injectPrismaSingleton(client) {
  globalThis.tracefabPrisma = client;
}
