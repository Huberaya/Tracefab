import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { cleIdentite, signerIdentite } from './identite-jeton.js';
import type { VercelRequest } from './vercel-types.js';
import { requireActiveTenant, requestedTenantId, type ActiveTenant, type TenantScope } from './tenant.js';

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
 *
 * VALIDATION OBLIGATOIRE (mission isolation globale, PR #109) : armer le GUC
 * avec une valeur fournie par le client ne suffit pas. Les politiques RLS et
 * les anciens predicats bornent l'UTILISATEUR (union de ses adhesions), pas le
 * LOCATAIRE ACTIF ; mesure sur PostgreSQL jetable, un compte membre de A, B et
 * S avec le tenant A arme lisait les documents des trois organisations. Chaque
 * requete metier ouverte par cette enveloppe exige donc une adhesion ACTIVE au
 * tenant demande, resolue et verifiee en base avant le callback. Un tenant
 * absent, mal forme ou non membre leve `TenantError` (400/404) avant toute
 * requete metier ; la barriere d'erreur centrale du routeur le traduit.
 *
 * Le scope optionnel permet aux routes qui doivent rester mono-type de le dire
 * explicitement ; par defaut toute adhesion active est admise, ce qui ne
 * dispense aucune requete SQL d'etre bornee au tenant actif.
 */
export async function withTracefabRequestContext<T>(
  req: VercelRequest,
  user: { id: string; email: string },
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  scope: TenantScope = {},
) {
  const activeOrganizationId = requestedTenantId(req);
  return withTracefabUserContext(user.id, user.email, async (tx) => {
    const tenant = await requireActiveTenant(tx, req, user.id, scope);
    // Le tenant valide n'est pas expose au callback : les routes qui ont besoin
    // de filtrer une colonne utilisent `withTracefabTenantContext`, qui le
    // retourne. Ici, la validation precede toutes les requetes SQL, y compris
    // les gardes `tracefab_*_in_active_tenant` et les politiques RLS.
    void tenant;
    return callback(tx);
  }, activeOrganizationId);
}

/**
 * Execute une requete privee dans le tenant explicitement demande.
 *
 * Le GUC et le jeton signe sont armes AVANT la validation et toute requete
 * metier. L'absence de tenant, un UUID invalide, une adhesion inactive ou un
 * role/type non autorise echouent avant l'acces aux donnees.
 */
export async function withTracefabTenantContext<T>(
  req: VercelRequest,
  user: { id: string; email: string },
  scope: TenantScope,
  callback: (tx: Prisma.TransactionClient, tenant: ActiveTenant) => Promise<T>,
) {
  const activeOrganizationId = requestedTenantId(req);
  return withTracefabUserContext(user.id, user.email, async (tx) => {
    const tenant = await requireActiveTenant(tx, req, user.id, scope);
    return callback(tx, tenant);
  }, activeOrganizationId);
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
    // Jeton d'identité signé — P10.5.
    //
    // Posé APRÈS le locataire actif, parce que l'organisation fait partie du
    // corps signé : l'ordre inverse signerait une valeur que la base ne
    // retrouverait pas dans la session, et le jeton serait refusé.
    //
    // Si aucune clé n'est configurée, rien n'est posé : la base reste en mode
    // permissif et se comporte comme avant. Ce n'est pas un repli silencieux
    // dangereux — c'est le mode de déploiement progressif décrit dans
    // docs/security/2026-10-31-p105-hmac.md. Le passage en mode strict est une
    // décision d'exploitation, prise côté base, pas ici.
    const signe = signerIdentite({
      userId,
      organizationId: activeOrganizationId ?? '',
      cle: cleIdentite(),
    });
    await tx.$executeRaw`SELECT set_config('tracefab.identity', ${signe?.jeton ?? ''}, true)`;
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
