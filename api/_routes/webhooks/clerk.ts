import { createClerkClient } from '@clerk/backend';
import { verifyWebhook } from '@clerk/backend/webhooks';
import { membership_role, organization_type } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../_lib/prisma.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json, methodNotAllowed } from '../../_lib/http.js';

type ClerkEmailAddress = { id?: unknown; email_address?: unknown };
type ClerkEventData = Record<string, unknown>;
type ClerkWebhookEvent = { type: string; data: ClerkEventData };

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function bodyText(req: VercelRequest) {
  if (typeof req.body === 'string') return req.body;
  return JSON.stringify(req.body ?? {});
}

function requestForVerification(req: VercelRequest, body: string) {
  const headers = new Headers();
  for (const name of ['svix-id', 'svix-timestamp', 'svix-signature', 'webhook-id', 'webhook-timestamp', 'webhook-signature']) {
    const value = req.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  return new Request(`https://${req.headers.host || 'tracefab.local'}/api/webhooks/clerk`, { method: 'POST', headers, body });
}

function userFromEvent(event: ClerkEventData) {
  const clerkUserId = stringValue(event.id);
  const addresses = Array.isArray(event.email_addresses) ? event.email_addresses as ClerkEmailAddress[] : [];
  const primaryId = stringValue(event.primary_email_address_id);
  const email = stringValue(addresses.find((address) => address.id === primaryId)?.email_address)?.toLowerCase() ?? null;
  if (!clerkUserId || !email) throw new Error('clerk_primary_email_required');
  const names: string[] = [];
  const firstName = stringValue(event.first_name);
  const lastName = stringValue(event.last_name);
  if (firstName) names.push(firstName);
  if (lastName) names.push(lastName);
  return { clerkUserId, email, fullName: names.join(' ') || email };
}

async function upsertUserFromClerkEvent(event: ClerkEventData) {
  const user = userFromEvent(event);
  return prisma.user.upsert({
    where: { clerkUserId: user.clerkUserId },
    create: user,
    update: { email: user.email, fullName: user.fullName },
  });
}

async function ensureUser(clerkUserId: string, data: ClerkEventData) {
  const existing = await prisma.user.findUnique({ where: { clerkUserId } });
  if (existing) return existing;
  const secretKey = process.env.CLERK_SECRET_KEY?.trim();
  if (!secretKey) throw new Error('missing_clerk_secret_key');
  const clerkUser = await createClerkClient({ secretKey }).users.getUser(clerkUserId);
  const email = clerkUser.emailAddresses.find(({ id }) => id === clerkUser.primaryEmailAddressId)?.emailAddress;
  if (!email) throw new Error('clerk_primary_email_required');
  const fullName = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || email;
  return prisma.user.upsert({
    where: { clerkUserId },
    create: { clerkUserId, email, fullName },
    update: { email, fullName },
  });
}

function organizationData(data: ClerkEventData) {
  const nested = data.organization && typeof data.organization === 'object' ? data.organization as ClerkEventData : data;
  const clerkOrganizationId = stringValue(nested.id) ?? stringValue(data.organization_id);
  if (!clerkOrganizationId) throw new Error('clerk_organization_id_required');
  const displayName = stringValue(nested.name) ?? clerkOrganizationId;
  const slug = stringValue(nested.slug);
  const metadata = nested.public_metadata && typeof nested.public_metadata === 'object' ? nested.public_metadata as ClerkEventData : {};
  const requestedType = stringValue(metadata.tracefab_organization_type);
  const type = requestedType && Object.values(organization_type).includes(requestedType as organization_type)
    ? requestedType as organization_type
    : organization_type.brand;
  return { clerkOrganizationId, displayName, legalName: stringValue(metadata.legal_name) ?? displayName, slug, type };
}

async function syncOrganization(data: ClerkEventData) {
  const org = organizationData(data);
  return prisma.organizations.upsert({
    where: { clerkOrganizationId: org.clerkOrganizationId },
    create: {
      clerkOrganizationId: org.clerkOrganizationId,
      type: org.type,
      legal_name: org.legalName,
      display_name: org.displayName,
      status: 'active',
    },
    update: { legal_name: org.legalName, display_name: org.displayName, status: 'active' },
  });
}

function membershipData(data: ClerkEventData) {
  const nestedOrg = data.organization && typeof data.organization === 'object' ? data.organization as ClerkEventData : {};
  const clerkOrganizationId = stringValue(nestedOrg.id) ?? stringValue(data.organization_id);
  const clerkUserId = stringValue((data.public_user_data as ClerkEventData | undefined)?.user_id) ?? stringValue(data.user_id);
  const clerkMembershipId = stringValue(data.id);
  if (!clerkOrganizationId || !clerkUserId || !clerkMembershipId) throw new Error('clerk_membership_identifiers_required');
  const clerkRole = stringValue(data.role);
  const role = clerkRole === 'org:admin' ? membership_role.admin : membership_role.viewer;
  return { clerkOrganizationId, clerkUserId, clerkMembershipId, role };
}

async function logDirectoryAudit(organizationId: string, actorUserId: string | null, action: string, entityId: string | null, metadata: Record<string, unknown>) {
  await prisma.audit_logs.create({ data: { organization_id: organizationId, actor_user_id: actorUserId, action, entity_type: 'clerk_directory', entity_id: entityId, metadata: metadata as Prisma.InputJsonValue } });
}

async function syncMembership(data: ClerkEventData) {
  const membership = membershipData(data);
  const user = await ensureUser(membership.clerkUserId, data);
  const organization = await prisma.organizations.findUnique({ where: { clerkOrganizationId: membership.clerkOrganizationId } });
  if (!organization) throw new Error('clerk_organization_not_synced');
  const existing = await prisma.organization_memberships.findUnique({ where: { clerkMembershipId: membership.clerkMembershipId } });
  if (existing) {
    const result = await prisma.organization_memberships.update({
      where: { id: existing.id },
      data: { organization_id: organization.id, user_id: user.id, status: 'active', joined_at: existing.joined_at ?? new Date() },
    });
    await logDirectoryAudit(organization.id, user.id, 'clerk.membership.sync', result.id, { source: 'clerk_webhook', clerkMembershipId: membership.clerkMembershipId });
    return result;
  }
  const byUser = await prisma.organization_memberships.findUnique({ where: { organization_id_user_id: { organization_id: organization.id, user_id: user.id } } });
  if (byUser) {
    const result = await prisma.organization_memberships.update({
      where: { id: byUser.id },
      data: { clerkMembershipId: membership.clerkMembershipId, status: 'active', joined_at: byUser.joined_at ?? new Date() },
    });
    await logDirectoryAudit(organization.id, user.id, 'clerk.membership.sync', result.id, { source: 'clerk_webhook', clerkMembershipId: membership.clerkMembershipId });
    return result;
  }
  const result = await prisma.organization_memberships.create({
    data: { clerkMembershipId: membership.clerkMembershipId, organization_id: organization.id, user_id: user.id, role: membership.role, status: 'active', joined_at: new Date() },
  });
  await logDirectoryAudit(organization.id, user.id, 'clerk.membership.created', result.id, { source: 'clerk_webhook', clerkMembershipId: membership.clerkMembershipId });
  return result;
}

async function revokeMembership(data: ClerkEventData) {
  const clerkMembershipId = stringValue(data.id);
  if (!clerkMembershipId) return;
  const membership = await prisma.organization_memberships.findUnique({ where: { clerkMembershipId }, select: { id: true, organization_id: true, user_id: true } });
  if (!membership) return;
  await prisma.organization_memberships.update({ where: { id: membership.id }, data: { status: 'revoked' } });
  await logDirectoryAudit(membership.organization_id, membership.user_id, 'clerk.membership.revoked', membership.id, { source: 'clerk_webhook', clerkMembershipId });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!process.env.CLERK_WEBHOOK_SIGNING_SECRET?.trim()) return json(res, 503, { error: 'clerk_webhook_not_configured' });

  let eventType = 'unknown';
  try {
    const event = await verifyWebhook(requestForVerification(req, bodyText(req)), { signingSecret: process.env.CLERK_WEBHOOK_SIGNING_SECRET.trim() }) as unknown as ClerkWebhookEvent;
    eventType = event.type || 'unknown';
    if (eventType === 'user.created' || eventType === 'user.updated') await upsertUserFromClerkEvent(event.data);
    else if (eventType === 'user.deleted') {
      const clerkUserId = stringValue(event.data.id);
      if (clerkUserId) await prisma.user.updateMany({ where: { clerkUserId }, data: { email: `deleted+${clerkUserId}@invalid.tracefab.local`, fullName: 'Deleted Clerk user' } });
    } else if (eventType === 'organization.created' || eventType === 'organization.updated') await syncOrganization(event.data);
    else if (eventType === 'organization.deleted') {
      const organizationId = stringValue(event.data.id);
      if (organizationId) {
        const organization = await prisma.organizations.findUnique({ where: { clerkOrganizationId: organizationId }, select: { id: true } });
        if (organization) {
          await prisma.organizations.update({ where: { id: organization.id }, data: { status: 'archived' } });
          await prisma.organization_memberships.updateMany({ where: { organization_id: organization.id }, data: { status: 'revoked' } });
        }
      }
    } else if (eventType === 'organizationMembership.created' || eventType === 'organizationMembership.updated') await syncMembership(event.data);
    else if (eventType === 'organizationMembership.deleted') await revokeMembership(event.data);
    return json(res, 200, { ok: true, eventType });
  } catch (error) {
    const errorCode = error instanceof Error ? error.message : 'unknown_error';
    console.error('POST /api/webhooks/clerk failed', { eventType, errorCode });
    return json(res, 400, { error: 'invalid_clerk_webhook' });
  }
}
