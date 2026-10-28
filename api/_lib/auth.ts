import { createClerkClient, verifyToken } from '@clerk/backend';
import type { VercelRequest } from './vercel-types.js';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { withTracefabWorkerContext } from './context.js';

const clerkSecretKey = process.env.CLERK_SECRET_KEY;

function bearerToken(req: VercelRequest) {
  const value = req.headers.authorization;
  if (!value?.startsWith('Bearer ')) return null;
  return value.slice('Bearer '.length).trim();
}

/**
 * Provisionnement de l'utilisateur interne depuis l'identite Clerk.
 *
 * Ce point est critique pour la bascule RLS : `users` n'accepte l'INSERT que
 * dans le contexte worker (`users_insert_worker`, migration 20261009180000),
 * et l'UPDATE « soi-meme » exige `tracefab.user_id` — qui n'existe pas encore
 * au premier appel. Un upsert nu fonctionnait sous BYPASSRLS et cassait
 * silencieusement sous `tracefab_app` :
 *   - premiere connexion : l'INSERT est avale par la politique RLS ;
 *   - retour d'un utilisateur provisionne : le SELECT ne voit rien (RLS),
 *     l'INSERT derive alors en violation d'unicite sur clerk_user_id.
 *
 * Le provisionnement est un travail de synchronisation systeme : il emprunte
 * donc le contexte worker, comme le webhook Clerk (api/_routes/webhooks/clerk.ts)
 * qui utilise deja ce contexte pour les memes ecritures.
 */
export async function provisionUserFromClerk(params: {
  clerkUserId: string;
  email: string;
  fullName: string;
}): Promise<{ id: string; email: string; fullName: string; clerkUserId: string }> {
  return withTracefabWorkerContext(async (tx: Prisma.TransactionClient) => {
    // Fonction nommee et non requete Prisma : l'ecriture systeme ne passe plus
    // par un contexte de session falsifiable. La fonction ne rend que la ligne
    // ecrite, donc rien ne permet d'enumerer les utilisateurs a travers elle.
    const rows = await tx.$queryRaw<Array<{
      id: string; email: string; full_name: string; out_clerk_user_id: string;
    }>>`
      SELECT id, email, full_name, out_clerk_user_id
        FROM tracefab_upsert_clerk_user(${params.clerkUserId}, ${params.email}, ${params.fullName})
    `;
    const user = rows[0];
    if (!user) throw new Error('user_provisioning_failed');
    return { id: user.id, email: user.email, fullName: user.full_name, clerkUserId: user.out_clerk_user_id };
  });
}

export async function requireClerkUser(req: VercelRequest) {
  if (!clerkSecretKey) throw new Error('missing_clerk_secret_key');

  const token = bearerToken(req);
  if (!token) {
    const error = new Error('unauthorized');
    error.name = 'UnauthorizedError';
    throw error;
  }

  const authorizedParties = (process.env.TRACEFAB_AUTHORIZED_PARTIES || '')
    .split(',')
    .map((party) => party.trim())
    .filter(Boolean);
  if (process.env.NODE_ENV === 'production' && authorizedParties.length === 0) {
    throw new Error('authorized_parties_not_configured');
  }
  const claims = authorizedParties.length > 0
    ? await verifyToken(token, { secretKey: clerkSecretKey, authorizedParties })
    : await verifyToken(token, { secretKey: clerkSecretKey });
  if (!claims.sub) {
    const error = new Error('unauthorized');
    error.name = 'UnauthorizedError';
    throw error;
  }

  const clerk = createClerkClient({ secretKey: clerkSecretKey });
  const clerkUser = await clerk.users.getUser(claims.sub);
  const email = clerkUser.emailAddresses.find(({ id }) => id === clerkUser.primaryEmailAddressId)?.emailAddress;
  if (!email) throw new Error('clerk_email_required');

  const fullName = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || email;
  const user = await provisionUserFromClerk({
    clerkUserId: claims.sub,
    email,
    fullName,
  });

  return { clerkUser, user };
}

export function isUnauthorized(error: unknown) {
  return error instanceof Error && (error.name === 'UnauthorizedError' || error.message === 'unauthorized');
}
