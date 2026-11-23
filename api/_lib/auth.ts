import { createClerkClient, verifyToken } from '@clerk/backend';
import type { VercelRequest } from './vercel-types.js';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { withTracefabWorkerContext } from './contexte-systeme.js';
import { verifiedPrimaryEmail } from './clerk-identity.js';

const clerkSecretKey = process.env.CLERK_SECRET_KEY;

function bearerToken(req: VercelRequest) {
  const value = req.headers.authorization;
  if (!value?.startsWith('Bearer ')) return null;
  return value.slice('Bearer '.length).trim();
}

/**
 * Raisons pour lesquelles c'est le JETON du client qui est mauvais.
 *
 * `@clerk/backend` leve une erreur avec un champ `reason` tant pour un jeton
 * forge que pour une panne d'infrastructure (JWKS injoignable, cle secrete
 * invalide, JWK absente). Tout transformer en 401 masquerait une panne serveur
 * reelle derriere un « non autorise » : les tableaux de bord d'incident ne
 * verraient plus rien, et un declassement de securite passerait inapercu.
 *
 * Seules les raisons liees au jeton deviennent 401. Les raisons
 * d'exploitation (`secret-key-invalid`, `jwk-remote-failed-to-load`,
 * `jwk-remote-invalid`, `jwk-remote-missing`, `jwk-local-missing`,
 * `jwk-failed-to-resolve`) sont RELEVEES telles quelles : les routes les
 * classent alors en 500, journalisables et alertables.
 *
 * Les valeurs sont celles de `TokenVerificationErrorReason`
 * (@clerk/backend 3.x). Une raison inconnue n'est PAS traitee comme un refus
 * client : elle reste une exception serveur, ce qui est le sens sur.
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
  // `verifyToken` LEVE ses erreurs : sans ce catch, un jeton forge remontait
  // en 500 `internal_server_error` — un refus opaque, indistinguable d'une
  // panne applicative. Le catch est volontairement etroit : seules les
  // erreurs dont la raison designe le jeton deviennent 401. Une panne JWKS ou
  // une cle serveur invalide reste une exception inattendue (500), pour ne
  // jamais deguiser un incident d'exploitation en erreur client. Dans tous
  // les cas, aucun jeton non verifie n'est accepte, et `claims.sub` reste
  // exige avant la moindre lecture de donnees.
  let claims: { sub?: string };
  try {
    claims = authorizedParties.length > 0
      ? await verifyToken(token, { secretKey: clerkSecretKey, authorizedParties })
      : await verifyToken(token, { secretKey: clerkSecretKey });
  } catch (error) {
    if (isRejectedTokenVerification(error)) {
      const refus = new Error('unauthorized');
      refus.name = 'UnauthorizedError';
      throw refus;
    }
    throw error;
  }
  if (!claims?.sub) {
    const error = new Error('unauthorized');
    error.name = 'UnauthorizedError';
    throw error;
  }

  const clerk = createClerkClient({ secretKey: clerkSecretKey });
  const clerkUser = await clerk.users.getUser(claims.sub);
  // L'adresse alimente `tracefab.user_email`, seule barriere de la politique
  // `passport_access_select`. La regle vit dans un module pur, eprouve cas par
  // cas par `scripts/test_clerk_identity.mjs` : adresse primaire, verifiee,
  // non vide, et refus a motif nomme sans recopier l'adresse recue.
  const email = verifiedPrimaryEmail(clerkUser);

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
