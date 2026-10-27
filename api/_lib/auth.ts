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

function unauthorizedError() {
  const error = new Error('unauthorized');
  error.name = 'UnauthorizedError';
  return error;
}

/**
 * Raisons pour lesquelles c'est le JETON du client qui est mauvais.
 *
 * `@clerk/backend` leve `TokenVerificationError` avec un champ `reason`
 * tant pour un jeton forgé que pour une panne d'infrastructure (JWKS
 * injoignable, cle secrete invalide, JWK absente). Tout transformer en 401
 * masquerait une panne serveur reelle derriere un « non autorise » : les
 * tableaux de bord d'incident ne verraient plus rien et un declassement de
 * securite passerait inapercu.
 *
 * Seules les raisons liees au jeton deviennent 401. Les raisons
 * d'exploitation (`secret-key-invalid`, `jwk-remote-failed-to-load`,
 * `jwk-remote-invalid`, `jwk-remote-missing`, `jwk-local-missing`,
 * `jwk-failed-to-resolve`) sont RELEVEES telles quelles : les routes les
 * classent alors en 500, journalisables et alertables. Les valeurs sont
 * celles de `TokenVerificationErrorReason` (@clerk/backend 3.x) ; elles
 * sont testees explicitement par `scripts/test_mission_http_integration.mjs`.
 */
const CLIENT_TOKEN_VERIFICATION_REASONS = new Set([
  'token-expired',
  'token-invalid',
  'token-invalid-algorithm',
  'token-invalid-authorized-parties',
  'token-invalid-signature',
  'token-not-active-yet',
  'token-iat-in-the-future',
  'token-verification-failed',
  'jwk-kid-mismatch',
]);

/** Exporte pour etre eprouve sans jamais accepter un jeton non verifie. */
export function isRejectedTokenVerification(error: unknown): boolean {
  const reason = (error as { reason?: unknown } | null)?.reason;
  return typeof reason === 'string' && CLIENT_TOKEN_VERIFICATION_REASONS.has(reason);
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
    const user = await tx.user.upsert({
      where: { clerkUserId: params.clerkUserId },
      create: {
        clerkUserId: params.clerkUserId,
        email: params.email,
        fullName: params.fullName,
      },
      update: { email: params.email, fullName: params.fullName },
    });
    return { id: user.id, email: user.email, fullName: user.fullName, clerkUserId: user.clerkUserId };
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
  /**
   * `verifyToken` est exporte via `withLegacyReturn` : toute erreur de
   * verification est LEVEE, pas retournee dans `claims.errors`. Sans ce catch,
   * une route renvoyait 500 `internal_server_error` face a un jeton forge —
   * un refus opaque, impossible a distinguer d'une panne applicative.
   *
   * Le catch est VOLONTAIREMENT ETROIT : seules les erreurs dont la raison
   * designe le jeton lui-meme deviennent 401. Une panne JWKS ou une cle
   * serveur invalide est reactualisee en exception inattendue (500), pour ne
   * jamais deguiser un incident d'exploitation en erreur client. Dans tous
   * les cas, aucun jeton non verifie n'est accepte et `claims.sub` reste
   * exige avant la moindre lecture de donnees.
   */
  let claims: { sub?: string };
  try {
    claims = authorizedParties.length > 0
      ? await verifyToken(token, { secretKey: clerkSecretKey, authorizedParties })
      : await verifyToken(token, { secretKey: clerkSecretKey });
  } catch (error) {
    if (isRejectedTokenVerification(error)) throw unauthorizedError();
    throw error;
  }
  if (!claims?.sub) throw unauthorizedError();

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
