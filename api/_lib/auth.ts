import { createClerkClient, verifyToken } from '@clerk/backend';
import type { VercelRequest } from './vercel-types.js';
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

  /*
   * Le provisionnement s'execute en contexte worker, et lui seul.
   *
   * `users` ne peut pas avoir de politique INSERT « soi-même » : on ne peut pas
   * être soi-même avant d'exister. La seule politique INSERT est
   * `users_insert_worker`, armée par `tracefab.worker_context`. Sans ce
   * contexte, la PREMIÈRE connexion d'un utilisateur échoue dès que
   * l'application est connectée avec un rôle sans BYPASSRLS.
   *
   * Mesuré sur une base PostgreSQL réelle, rôle `tracefab_app`
   * (BYPASSRLS=false) :
   *   INSERT sans contexte  -> 42501 new row violates row-level security
   *                            policy for table "users"
   *   INSERT en contexte    -> autorisé
   * Un utilisateur déjà provisionné, lui, passait : son SELECT et son UPDATE
   * tombent sur `users_select_self` / `users_update_self`.
   *
   * Le défaut restait invisible parce que le rôle de connexion de production
   * (`neondb_owner`) porte BYPASSRLS : aucune politique n'était évaluée.
   *
   * Le contexte est borné à cette seule instruction. Les valeurs écrites
   * viennent d'un jeton Clerk vérifié — `claims.sub` et les adresses ne sont
   * pas contrôlables par l'appelant — donc élever cette instruction n'ouvre
   * aucune écriture que l'utilisateur puisse choisir. Le reste de la requête
   * continue sous le contexte utilisateur, avec ses propres politiques.
   */
  const user = await withTracefabWorkerContext((tx) =>
    tx.user.upsert({
      where: { clerkUserId: claims.sub },
      create: { clerkUserId: claims.sub, email, fullName },
      update: { email, fullName },
    }),
  );

  return { clerkUser, user };
}

export function isUnauthorized(error: unknown) {
  return error instanceof Error && (error.name === 'UnauthorizedError' || error.message === 'unauthorized');
}
