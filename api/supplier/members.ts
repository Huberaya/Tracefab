import { randomBytes, createHash } from 'node:crypto';
import { Prisma, membership_role, membership_status } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../_lib/auth';
import { withTracefabUserContext } from '../_lib/context';
import { manualInvitationFallbackAllowed, sendOrganizationMemberInvitationEmail } from '../_lib/email';
import { json, methodNotAllowed, readJsonBody } from '../_lib/http';
import { sqlBusinessError } from '../_lib/sql-errors';
import { currentSupplier, requestedOrganizationId } from '../_lib/supplier-profile';

const INVITABLE_ROLES = new Set(['admin', 'manager', 'contributor', 'viewer', 'auditor']);
const MEMBER_STATUSES = new Set(['active', 'suspended', 'revoked']);

type MembersBody = {
  email?: unknown;
  targetRole?: unknown;
  membershipId?: unknown;
  role?: unknown;
  status?: unknown;
};

function serializeMember(member: {
  id: string;
  organization_id: string;
  user_id: string;
  role: membership_role;
  status: membership_status;
  invited_by: string | null;
  joined_at: Date | null;
  created_at: Date;
  users_organization_memberships_user_idTousers: { email: string; fullName: string };
}) {
  return {
    id: member.id,
    organizationId: member.organization_id,
    userId: member.user_id,
    role: member.role,
    status: member.status,
    invitedBy: member.invited_by,
    joinedAt: member.joined_at,
    createdAt: member.created_at,
    user: member.users_organization_memberships_user_idTousers,
  };
}

function validEmail(value: unknown) {
  if (typeof value !== 'string' || value.trim().length > 320 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim())) throw new Error('invalid_member_email');
  return value.trim().toLowerCase();
}

async function memberContext(tx: Prisma.TransactionClient, userId: string, organizationId: string | null) {
  const supplier = await currentSupplier(tx, userId, organizationId);
  if (!supplier) return null;
  const actor = await tx.organization_memberships.findUnique({
    where: { organization_id_user_id: { organization_id: supplier.organization_id, user_id: userId } },
    select: { role: true, status: true },
  });
  if (!actor || actor.status !== 'active') return null;
  return { supplier, actor };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!['GET', 'POST', 'PATCH'].includes(req.method || '')) return methodNotAllowed(res, ['GET', 'POST', 'PATCH']);
  try {
    const { user } = await requireClerkUser(req);
    const organizationId = requestedOrganizationId(req);
    if (req.method === 'GET') {
      const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
        const context = await memberContext(tx, user.id, organizationId);
        if (!context) return null;
        const [members, invitations] = await Promise.all([
          tx.organization_memberships.findMany({
            where: { organization_id: context.supplier.organization_id },
            select: {
              id: true,
              organization_id: true,
              user_id: true,
              role: true,
              status: true,
              invited_by: true,
              joined_at: true,
              created_at: true,
              users_organization_memberships_user_idTousers: { select: { email: true, fullName: true } },
            },
            orderBy: [{ status: 'asc' }, { created_at: 'asc' }],
          }),
          tx.organization_invitations.findMany({
            where: { organization_id: context.supplier.organization_id, accepted_at: null, expires_at: { gt: new Date() } },
            select: { id: true, email: true, target_role: true, expires_at: true, created_at: true },
            orderBy: { created_at: 'desc' },
          }),
        ]);
        return { members, invitations, canManage: ['owner', 'admin'].includes(context.actor.role) };
      });
      if (!result) return json(res, 404, { error: 'supplier_organization_not_found' });
      return json(res, 200, {
        canManage: result.canManage,
        members: result.members.map(serializeMember),
        invitations: result.invitations.map((invitation) => ({ id: invitation.id, email: invitation.email, targetRole: invitation.target_role, expiresAt: invitation.expires_at, createdAt: invitation.created_at })),
      });
    }

    const body = await readJsonBody<MembersBody>(req);
    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const context = await memberContext(tx, user.id, organizationId);
      if (!context) return null;
      if (!['owner', 'admin'].includes(context.actor.role)) throw new Error('member_management_role_required');

      if (req.method === 'POST') {
        const email = validEmail(body.email);
        if (typeof body.targetRole !== 'string' || !INVITABLE_ROLES.has(body.targetRole)) throw new Error('invalid_member_role');
        const invitedUser = await tx.user.findUnique({ where: { email }, select: { id: true } });
        if (invitedUser) {
          const existingMembership = await tx.organization_memberships.findUnique({ where: { organization_id_user_id: { organization_id: context.supplier.organization_id, user_id: invitedUser.id } }, select: { status: true } });
          if (existingMembership && existingMembership.status !== 'revoked') throw new Error('member_already_exists');
        }
        const existingInvitation = await tx.organization_invitations.findFirst({ where: { organization_id: context.supplier.organization_id, email, accepted_at: null, expires_at: { gt: new Date() } }, select: { id: true } });
        if (existingInvitation) throw new Error('active_member_invitation_exists');
        const invitationToken = randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const invitation = await tx.organization_invitations.create({
          data: {
            organization_id: context.supplier.organization_id,
            email,
            target_role: body.targetRole as membership_role,
            token_hash: createHash('sha256').update(invitationToken).digest('hex'),
            invited_by: user.id,
            expires_at: expiresAt,
          },
          select: { id: true, email: true, target_role: true, expires_at: true },
        });
        const organization = await tx.organizations.findUnique({ where: { id: context.supplier.organization_id }, select: { display_name: true, legal_name: true } });
        return { invitation, invitationToken, organizationName: organization?.display_name || organization?.legal_name || 'Tracefab supplier organization' };
      }

      if (typeof body.membershipId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.membershipId)) throw new Error('invalid_membership_id');
      const target = await tx.organization_memberships.findFirst({ where: { id: body.membershipId, organization_id: context.supplier.organization_id }, select: { id: true, user_id: true, role: true, status: true } });
      if (!target) throw new Error('membership_not_found');
      if (target.user_id === user.id) throw new Error('cannot_modify_self_membership');
      const nextRole = body.role === undefined ? target.role : body.role;
      const nextStatus = body.status === undefined ? target.status : body.status;
      if (typeof nextRole !== 'string' || (!INVITABLE_ROLES.has(nextRole) && !(target.role === 'owner' && nextRole === 'owner'))) throw new Error('invalid_member_role');
      if (typeof nextStatus !== 'string' || !MEMBER_STATUSES.has(nextStatus)) throw new Error('invalid_member_status');
      if (target.role === 'owner' && (nextRole !== 'owner' || nextStatus !== 'active')) {
        const activeOwners = await tx.organization_memberships.count({ where: { organization_id: context.supplier.organization_id, role: 'owner', status: 'active' } });
        if (activeOwners <= 1) throw new Error('last_owner_membership_required');
      }
      const member = await tx.organization_memberships.update({
        where: { id: target.id },
        data: { role: nextRole as membership_role, status: nextStatus as membership_status },
        select: {
          id: true,
          organization_id: true,
          user_id: true,
          role: true,
          status: true,
          invited_by: true,
          joined_at: true,
          created_at: true,
          users_organization_memberships_user_idTousers: { select: { email: true, fullName: true } },
        },
      });
      return { member };
    });

    if (!result) return json(res, 404, { error: 'supplier_organization_not_found' });
    if (req.method === 'PATCH') return json(res, 200, { member: serializeMember(result.member!) });

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
    if (delivery.status === 'sent') return json(res, 201, payload);
    if (!manualInvitationFallbackAllowed()) return json(res, 503, payload);
    return json(res, delivery.status === 'failed' ? 502 : 201, { ...payload, invitationToken: result.invitationToken });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return json(res, 409, { error: 'active_member_invitation_exists' });
    if (error instanceof Error && /^(invalid_|member_|membership_|cannot_|last_owner_)/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error(`${req.method} /api/supplier/members failed`, error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
