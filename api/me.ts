import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from './_lib/auth';
import { withTracefabUserContext } from './_lib/context';
import { json, methodNotAllowed } from './_lib/http';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const { clerkUser, user } = await requireClerkUser(req);
    const memberships = await withTracefabUserContext(user.id, (tx) =>
      tx.organization_memberships.findMany({
        where: { user_id: user.id, status: 'active' },
        select: {
          organization_id: true,
          role: true,
          status: true,
          organizations: {
            select: { id: true, type: true, legal_name: true, display_name: true, status: true },
          },
        },
        orderBy: { created_at: 'asc' },
      }),
    );

    return json(res, 200, {
      user: {
        id: user.id,
        clerkUserId: clerkUser.id,
        email: user.email,
        fullName: user.fullName,
      },
      memberships,
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('GET /api/me failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
