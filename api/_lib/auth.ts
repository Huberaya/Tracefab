import { createClerkClient, verifyToken } from '@clerk/backend';
import type { VercelRequest } from './vercel-types.js';
import { prisma } from './prisma.js';

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
  const user = await prisma.user.upsert({
    where: { clerkUserId: claims.sub },
    create: { clerkUserId: claims.sub, email, fullName },
    update: { email, fullName },
  });

  return { clerkUser, user };
}

export function isUnauthorized(error: unknown) {
  return error instanceof Error && (error.name === 'UnauthorizedError' || error.message === 'unauthorized');
}
