import { PrismaClient } from '@prisma/client';

/**
 * Plafond de lignes.
 *
 * 36 appels `findMany` des routes n'avaient aucun `take`. Les corriger un par
 * un aurait laisse le probleme entier : le 37e, ecrit demain, serait
 * illimite lui aussi. Le plafond est donc pose sur le client, pas sur les
 * appels — il couvre ce qui existe et ce qui n'est pas encore ecrit.
 *
 * 5 000 est un filet, pas une pagination. Aucun locataire actuel n'en
 * approche : le plus gros jeu de demonstration compte 1 248 produits. Le but
 * n'est pas de decouper les reponses en pages, c'est d'empecher qu'une
 * requete serialise une table entiere et fasse tomber la fonction.
 *
 * La troncature n'est pas silencieuse. Quand elle mord vraiment — le
 * resultat atteint exactement le plafond — une ligne de journal structuree
 * est emise. Un plafond qui se declenche sans que personne ne le sache est
 * une perte de donnees deguisee en lenteur resolue.
 */
const ROW_CEILING = (() => {
  const raw = Number.parseInt(process.env.TRACEFAB_QUERY_ROW_CEILING || '', 10);
  if (!Number.isFinite(raw)) return 5000;
  return Math.min(100000, Math.max(100, raw));
})();

function createClient() {
  return new PrismaClient().$extends({
    name: 'tracefab-row-ceiling',
    query: {
      $allModels: {
        async findMany({ args, query, model, operation }) {
          if (args.take !== undefined) return query(args);
          const bounded = { ...args, take: ROW_CEILING };
          const rows = await query(bounded);
          if (Array.isArray(rows) && rows.length >= ROW_CEILING) {
            console.warn(
              JSON.stringify({
                schema: 'tracefab-row-ceiling-v1',
                level: 'warn',
                model,
                operation,
                ceiling: ROW_CEILING,
                message: 'collection tronquee par le plafond de lignes',
              }),
            );
          }
          return rows;
        },
      },
    },
  });
}

/**
 * L'extension est reexposee avec le type du client nu.
 *
 * Une extension `query` ne change ni les methodes ni la forme des resultats :
 * elle n'ajoute qu'une marque interne aux types d'arguments. Mais cette
 * marque suffit a rendre le client etendu non assignable a `PrismaClient`,
 * et cinq modules declarent `type PrismaTx = PrismaClient |
 * Prisma.TransactionClient`. Elargir l'alias produit une union de deux
 * clients dont les surcharges sont incompatibles — le remede serait pire.
 *
 * On restreint donc le mensonge a une seule ligne, ici, plutot que de le
 * repandre dans cinq fichiers. La surface appelable est rigoureusement la
 * meme ; seule la marque differe.
 */
const globalForPrisma = globalThis as unknown as { tracefabPrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.tracefabPrisma ?? (createClient() as unknown as PrismaClient);

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.tracefabPrisma = prisma;
}

/**
 * TEMPORARY production identity probe. Enabled only by a dedicated Vercel
 * environment flag; logs role metadata, never credentials or tenant data.
 * Remove immediately after one successful production measurement.
 */
if (process.env.TRACEFAB_RUNTIME_IDENTITY_PROBE === 'enabled') {
  void prisma.$queryRaw<Array<{
    connected_role: string;
    session_role: string;
    bypass_rls: boolean;
    superuser: boolean;
  }>>`
    SELECT current_user AS connected_role,
           session_user AS session_role,
           COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false) AS bypass_rls,
           COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS superuser
  `.then((rows) => {
    console.info(JSON.stringify({
      event: 'tracefab_runtime_identity_probe',
      ...rows[0],
    }));
  }).catch((error: unknown) => {
    console.error(JSON.stringify({
      event: 'tracefab_runtime_identity_probe_failed',
      message: error instanceof Error ? error.message : 'unknown error',
    }));
  });
}
