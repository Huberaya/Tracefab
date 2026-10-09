import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { tracefabPrisma?: PrismaClient };

/**
 * Instancie le client Prisma.
 *
 * DEUX MODES DE MOTEUR, UN SEUL POINT D'ENTRÉE
 *   Par défaut, `new PrismaClient()` : le moteur natif « library », celui qu'un
 *   déploiement standard utilise.
 *
 *   `PRISMA_DRIVER_ADAPTER=pg` bascule sur un adaptateur de pilote. C'est
 *   obligatoire quand le client a été généré avec `engineType = "client"` — son
 *   compilateur de requêtes WASM parle SQL par un adaptateur, pas par un binaire
 *   natif. Sans adaptateur, ce mode lève « Missing configured driver adapter ».
 *
 *   Pourquoi ce mode existe : les binaires Prisma ne sont publiés que sur
 *   binaries.prisma.sh. Dans un environnement qui n'y a pas accès, le client est
 *   généré hors ligne (`npm run prisma:generate:offline`) en mode « client », et
 *   c'est cette variable qui le rend utilisable.
 *
 * PIÈGE À CONNAÎTRE
 *   Un adaptateur et l'option `datasources` sont incompatibles : Prisma lève
 *   « Custom datasource configuration is not compatible with Prisma Driver
 *   Adapters ». La chaîne de connexion se règle DANS l'adaptateur, et l'URL vient
 *   de DATABASE_URL comme partout ailleurs.
 */
function createPrismaClient(): PrismaClient {
  if (process.env.PRISMA_DRIVER_ADAPTER !== 'pg') return new PrismaClient();

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'PRISMA_DRIVER_ADAPTER=pg exige DATABASE_URL : '
      + 'la chaîne de connexion se règle dans l\'adaptateur, pas via `datasources`.',
    );
  }
  /* Import dynamique : `pg` et l'adaptateur sont des dépendances de
     développement, un déploiement standard ne doit pas avoir à les embarquer. */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaPg } = require('@prisma/adapter-pg') as typeof import('@prisma/adapter-pg');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export const prisma = globalForPrisma.tracefabPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.tracefabPrisma = prisma;
}
