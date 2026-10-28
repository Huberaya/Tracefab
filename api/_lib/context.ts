import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import type { VercelRequest } from './vercel-types.js';
import { requestedTenantId } from './tenant.js';

/**
 * Execute tenant-scoped queries in one transaction with the Clerk-resolved
 * internal user UUID and email available to PostgreSQL RLS and SECURITY
 * DEFINER functions.
 */
/**
 * Execute une operation de synchronisation systeme.
 *
 * CE QUE CETTE FONCTION NE FAIT PLUS, ET POURQUOI
 *
 * Jusqu'au 27/10/2026, elle posait `set_config('tracefab.worker_context')` et
 * onze politiques RLS s'ouvraient sur ce drapeau. Le drapeau etait falsifiable :
 * mesure sur base jetable, `tracefab_app` seul voyait 0 ligne, puis 2 / 2 / 2
 * (organisations, utilisateurs, adhesions) apres avoir pose le GUC lui-meme.
 * L'isolation de ces tables ne tenait donc pas a la base mais au code.
 *
 * Desormais le privilege ne vient plus d'un etat de session, mais de fonctions
 * nommees, possedees par l'identite `tracefab_worker` et declarees au registre
 * runtime (migrations 20261028120000 et 20261028120100). Cette enveloppe reste
 * le point d'entree unique des operations systeme — les garde-fous
 * `test_route_context_coverage` et `test_context_integrity` s'appuient dessus —
 * mais elle n'accorde plus aucun droit par elle-meme.
 *
 * Consequence assumee : si une requete ecrite ici lit une table gardee par une
 * politique worker, elle rendra zero ligne. C'est le comportement voulu — le
 * silence vaut mieux qu'une fuite — et `test:neon:worker-non-forgeable` le verifie.
 */
export async function withTracefabWorkerContext<T>(
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return prisma.$transaction(callback);
}

/**
 * Execute an anonymous public read in one transaction with the public context
 * flag armed.
 *
 * Public routes must use this. Without it, every tenant table returns zero
 * rows once the application connects as `tracefab_app` — which is the point:
 * nothing is public unless a policy says so, and no policy grants anything
 * unless this flag is set.
 *
 * The flag is transaction-local (`set_config(..., true)`), so a pooled
 * connection can never carry it into the next request.
 */
export async function withTracefabPublicContext<T>(
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('tracefab.public_context', 'true', true)`;
    try {
      return await callback(tx);
    } finally {
      try {
        await tx.$executeRaw`SELECT set_config('tracefab.public_context', 'false', true)`;
      } catch {
        // Preserve the original transaction error if PostgreSQL has already
        // marked the transaction as aborted.
      }
    }
  });
}

/**
 * Variante orientee requete : le locataire actif est lu dans la requete elle
 * meme (en-tete `X-Tracefab-Organization-Id`, puis query string, puis corps).
 *
 * Elle existe pour que l'armement du locataire ne depende pas de la discipline
 * de chaque point d'appel. `withTracefabUserContext` prend le locataire en
 * quatrieme argument facultatif : un appel qui l'oublie arme une valeur vide,
 * et `tracefab_in_active_tenant()` est alors fausse partout — la requete ne
 * retourne rien. C'est fail-closed, mais silencieux. Cette variante rend
 * l'oubli impossible a ecrire.
 */
export async function withTracefabRequestContext<T>(
  req: VercelRequest,
  user: { id: string; email: string },
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return withTracefabUserContext(user.id, user.email, callback, requestedTenantId(req));
}

export async function withTracefabUserContext<T>(
  userId: string,
  userEmail: string,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  activeOrganizationId?: string | null,
) {
  return prisma.$transaction(async (tx) => {
    // Workflow trigger guards use this connection-local flag. Reset it before
    // every request so a failed prior transaction cannot leave a permissive
    // value on a pooled connection.
    await tx.$executeRaw`SELECT set_config('tracefab.internal_data_collection_update', 'false', false)`;
    await tx.$executeRaw`SELECT set_config('tracefab.user_id', ${userId}, true)`;
    await tx.$executeRaw`SELECT set_config('tracefab.user_email', ${userEmail.toLowerCase()}, true)`;
    // Locataire actif. Toujours ecrit, y compris vide : une connexion rendue au
    // pool ne doit jamais conserver le locataire de la requete precedente. La
    // valeur vide signifie « aucun locataire actif », et
    // `tracefab_active_organization_id()` la rend en NULL — jamais en repli sur
    // les autres organisations du compte.
    await tx.$executeRaw`SELECT set_config('tracefab.active_organization_id', ${activeOrganizationId ?? ''}, true)`;
    try {
      return await callback(tx);
    } finally {
      try {
        await tx.$executeRaw`SELECT set_config('tracefab.internal_data_collection_update', 'false', false)`;
      } catch {
        // Preserve the original transaction error if PostgreSQL has already
        // marked the transaction as aborted.
      }
    }
  });
}
