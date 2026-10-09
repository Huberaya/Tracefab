import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const globalForPrisma = globalThis as unknown as { tracefabPrisma?: PrismaClient };

/**
 * Instancie le client Prisma.
 *
 * UN ADAPTATEUR DE PILOTE, TOUJOURS
 *   Le générateur du schéma déclare `engineType = "client"` : le compilateur de
 *   requêtes est WASM et parle SQL par un adaptateur, jamais par un binaire natif.
 *   Un `new PrismaClient()` nu lève donc P2038 « Missing configured driver
 *   adapter » — et comme `engineType` vient du schéma, il n'existe aucune
 *   configuration où cette forme fonctionnerait.
 *
 *   LE FICHIER COMPTAIT DEUX CHEMINS, ET LES DEUX ÉTAIENT MORTS
 *     · sans variable, `new PrismaClient()` nu → P2038, faute d'adaptateur ;
 *     · avec `PRISMA_DRIVER_ADAPTER=pg`, un `require('@prisma/adapter-pg')` →
 *       « require is not defined in ES module scope », car le paquet déclare
 *       `"type": "module"`.
 *   Aucune configuration ne pouvait donc instancier le client. Les deux appels
 *   échouaient à la première requête, et le second donnait en plus l'illusion
 *   d'un repli fonctionnel. Ils sont remplacés par un import ESM statique :
 *   l'adaptateur n'est plus optionnel, il n'y a plus rien à brancher.
 *
 * PIÈGE À CONNAÎTRE
 *   Un adaptateur et l'option `datasources` sont incompatibles : Prisma lève
 *   « Custom datasource configuration is not compatible with Prisma Driver
 *   Adapters ». La chaîne de connexion se règle DANS l'adaptateur, et l'URL vient
 *   de DATABASE_URL comme partout ailleurs.
 */
function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL est requis : le client est généré avec engineType = "client", '
      + 'la chaîne de connexion se règle dans l\'adaptateur, pas via `datasources`.',
    );
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

function client(): PrismaClient {
  if (!globalForPrisma.tracefabPrisma) {
    globalForPrisma.tracefabPrisma = createPrismaClient();
  }
  return globalForPrisma.tracefabPrisma;
}

/**
 * Client paresseux.
 *
 * POURQUOI LA PARESSE EST NÉCESSAIRE, ET PAS UN CONFORT
 *   La version précédente construisait le client à l'évaluation du module. Or ce
 *   fichier est importé — de près ou de loin — par toute route de l'API. Une
 *   construction immédiate fait donc de DATABASE_URL une condition pour *charger*
 *   le moindre module, y compris ceux qui n'exécuteront jamais une requête :
 *   les tests unitaires des générateurs de passes Apple/Google Wallet et ceux du
 *   stockage cloud, qui vérifient des contrats de signature, se sont mis à
 *   échouer en exigeant une base.
 *
 *   Exiger la chaîne de connexion au premier usage et non à l'import est la
 *   condition pour qu'une erreur de configuration reste une erreur de
 *   configuration, au lieu de se déguiser en impossibilité de charger le code.
 *
 *   Un seul client pour tout le processus, conservé sur `globalThis` : en
 *   développement, le rechargement à chaud ne doit pas ouvrir un nouveau pool de
 *   connexions à chaque modification.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    return Reflect.get(client(), property, receiver);
  },
  has(_target, property) {
    return Reflect.has(client(), property);
  },
  set(_target, property, value) {
    return Reflect.set(client(), property, value);
  },
});
