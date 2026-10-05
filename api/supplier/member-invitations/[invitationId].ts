import { createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth';
import { withTracefabUserContext } from '../../_lib/context';
import { manualInvitationFallbackAllowed, sendOrganizationMemberInvitationEmail } from '../../_lib/email';
import { json, methodNotAllowed } from '../../_lib/http';
import { sqlBusinessError } from '../../_lib/sql-errors';
import { currentSupplier, requestedOrganizationId } from '../../_lib/supplier-profile';

const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

function routeInvitationId(req: VercelRequest) {
  const value = req.query.invitationId;
  return Array.isArray(value) ? value[0] : value;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST' && req.method !== 'DELETE') return methodNotAllowed(res, ['POST', 'DELETE']);
  try {
    const invitationId = routeInvitationId(req);
    if (!isUuid(invitationId)) return json(res, 400, { error: 'invalid_invitation_id' });
    const { user } = await requireClerkUser(req);
    const organizationId = requestedOrganizationId(req);

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const supplier = await currentSupplier(tx, user.id, organizationId);
      if (!supplier) return null;
      const actor = await tx.organization_memberships.findUnique({
        where: { organization_id_user_id: { organization_id: supplier.organization_id, user_id: user.id } },
        select: { role: true, status: true },
      });
      if (!actor || actor.status !== 'active' || !['owner', 'admin'].includes(actor.role)) throw new Error('invitation_management_role_required');

      const invitation = await tx.organization_invitations.findFirst({
        where: { id: invitationId, organization_id: supplier.organization_id },
        select: { id: true, email: true, target_role: true, accepted_at: true, expires_at: true },
      });
      if (!invitation) return null;
      if (invitation.accepted_at) throw new Error('invitation_already_accepted');

      if (req.method === 'DELETE') {
        await tx.organization_invitations.update({ where: { id: invitation.id }, data: { expires_at: new Date() } });
        return { action: 'revoked' as const, invitation };
      }

      const invitationToken = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + INVITATION_LIFETIME_MS);
      const updated = await tx.organization_invitations.update({
        where: { id: invitation.id },
        data: { token_hash: createHash('sha256').update(invitationToken).digest('hex'), expires_at: expiresAt },
        select: { id: true, email: true, target_role: true, expires_at: true },
      });
      const organization = await tx.organizations.findUnique({ where: { id: supplier.organization_id }, select: { display_name: true, legal_name: true } });
      return {
        action: 'resent' as const,
        invitation: updated,
        invitationToken,
        organizationName: organization?.display_name || organization?.legal_name || 'Tracefab supplier organization',
      };
    });

    if (!result) return json(res, 404, { error: 'invitation_not_found' });
    if (result.action === 'revoked') return json(res, 200, { invitation: { id: result.invitation.id }, status: 'revoked' });

    const delivery = await sendOrganizationMemberInvitationEmail({
      to: result.invitation.email,
      organizationName: result.organizationName,
      targetRole: result.invitation.target_role,
      invitationToken: result.invitationToken,
      expiresAt: result.invitation.expires_at,
    });
    const payload = {
      invitation: { id: result.invitation.id, email: result.invitation.email, targetRole: result.invitation.target_role, expiresAt: result.invitation.expires_at },
      delivery: delivery.status === 'sent' ? { status: delivery.status, providerId: delivery.providerId } : { status: delivery.status },
    };
    if (delivery.status === 'sent') return json(res, 200, payload);
    if (!manualInvitationFallbackAllowed()) return json(res, 503, payload);
    return json(res, delivery.status === 'failed' ? 502 : 200, { ...payload, invitationToken: result.invitationToken });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return json(res, 409, { error: 'active_member_invitation_exists' });
    if (error instanceof Error && (/^invalid_/.test(error.message) || /^invitation_/.test(error.message))) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error(`${req.method} /api/supplier/member-invitations/:invitationId failed`, error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
