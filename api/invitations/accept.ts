import { createHash } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../_lib/auth';
import { withTracefabUserContext } from '../_lib/context';
import { json, methodNotAllowed, readJsonBody } from '../_lib/http';
import { sqlBusinessError } from '../_lib/sql-errors';

type AcceptInvitationBody = { invitationToken?: string };

type AcceptanceRow = {
  organization_id: string;
  membership_id: string;
  relationship_id: string | null;
  supplier_id: string | null;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const { user } = await requireClerkUser(req);
    const body = await readJsonBody<AcceptInvitationBody>(req);
    const invitationToken = body.invitationToken?.trim();
    if (!invitationToken || invitationToken.length > 256) {
      return json(res, 400, { error: 'invalid_invitation_token' });
    }

    const tokenHash = createHash('sha256').update(invitationToken).digest('hex');
    const acceptance = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const rows = await tx.$queryRaw<AcceptanceRow[]>`
        SELECT *
        FROM tracefab_accept_organization_invitation(${tokenHash})
      `;
      const row = rows[0];
      if (!row) throw new Error('invitation_acceptance_failed');
      return row;
    });

    return json(res, 200, { acceptance });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('POST /api/invitations/accept failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
