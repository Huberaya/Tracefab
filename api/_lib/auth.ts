import { createClerkClient, verifyToken } from '@clerk/backend';
import type { VercelRequest } from './vercel-types.js';
import { prisma } from './prisma.js';
import { withTracefabWorkerContext } from './context.js';

const clerkSecretKey = process.env.CLERK_SECRET_KEY;

function bearerToken(req: VercelRequest) {
  const value = req.headers.authorization;
  if (!value?.startsWith('Bearer ')) return null;
  return value.slice('Bearer '.length).trim();
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

  // Le provisionnement s'execute dans un contexte worker, et uniquement lui.
  //
  // POURQUOI. Les politiques de `users` n'autorisent l'INSERT que sous
  // `tracefab.worker_context` (policy users_insert_worker), et la lecture que
  // sous ce meme drapeau ou pour soi-meme (users_select_self). Hors contexte,
  // sous le role applicatif reel `tracefab_app` — NOBYPASSRLS, et la table
  // porte FORCE ROW LEVEL SECURITY — cet upsert echouait sur
  // « new row violates row-level security policy for table "users" ».
  // La reconnexion d'un utilisateur deja provisionne n'allait pas mieux : la
  // lecture prealable ne voyait aucune ligne, donc Prisma tentait un INSERT
  // qui butait a son tour sur la politique.
  //
  // Le contexte utilisateur ne peut pas servir ici : il faut connaitre
  // l'utilisateur pour l'armer, et c'est justement ce que cette requete
  // etablit. Le contexte worker est donc le seul choix correct. Comme il est
  // large — users_worker_select voit tous les utilisateurs — la fenetre est
  // reduite au strict minimum : une seule instruction, aucun autre acces, et
  // le drapeau est transactionnel donc il ne survit pas a la connexion poolee.
  const user = await withTracefabWorkerContext((tx) => tx.user.upsert({
    where: { clerkUserId: claims.sub },
    create: { clerkUserId: claims.sub, email, fullName },
    update: { email, fullName },
  }));

  return { clerkUser, user };
}

export function isUnauthorized(error: unknown) {
  return error instanceof Error && (error.name === 'UnauthorizedError' || error.message === 'unauthorized');
}
