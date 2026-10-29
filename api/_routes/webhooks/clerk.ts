import { createClerkClient } from '@clerk/backend';
import { verifyWebhook } from '@clerk/backend/webhooks';
import { membership_role, organization_type } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { withTracefabWorkerContext } from '../../_lib/context.js';
import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
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

async function upsertUserFromClerkEvent(tx: Prisma.TransactionClient, event: ClerkEventData) {
  const user = userFromEvent(event);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM tracefab_upsert_clerk_user(${user.clerkUserId}, ${user.email}, ${user.fullName})
  `;
  if (!rows[0]) throw new Error('clerk_user_sync_failed');
  return rows[0];
}

async function ensureUser(tx: Prisma.TransactionClient, clerkUserId: string, data: ClerkEventData) {
  // La lecture directe `user.findUnique` echouerait : sans drapeau worker, la
  // politique RLS des utilisateurs ne s'ouvre plus. On demande donc a une
  // fonction dediee de faire « creer si absent » — elle ne modifie jamais un
  // compte existant, comme le faisait le code d'origine.

  const publicUserData = data.public_user_data && typeof data.public_user_data === 'object' ? data.public_user_data as ClerkEventData : {};
  const identifier = stringValue(publicUserData.identifier);
  if (identifier?.includes('@')) {
    const fullName = [stringValue(publicUserData.first_name), stringValue(publicUserData.last_name)].filter(Boolean).join(' ') || identifier;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM tracefab_ensure_clerk_user(${clerkUserId}, ${identifier.toLowerCase()}, ${fullName})
    `;
    if (!rows[0]) throw new Error('clerk_user_sync_failed');
    return rows[0];
  }

  const secretKey = process.env.CLERK_SECRET_KEY?.trim();
  if (!secretKey) throw new Error('missing_clerk_secret_key');
  const clerkUser = await createClerkClient({ secretKey }).users.getUser(clerkUserId);
  const email = clerkUser.emailAddresses.find(({ id }) => id === clerkUser.primaryEmailAddressId)?.emailAddress;
  if (!email) throw new Error('clerk_primary_email_required');
  const fullName = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || email;
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM tracefab_ensure_clerk_user(${clerkUserId}, ${email}, ${fullName})
  `;
  if (!rows[0]) throw new Error('clerk_user_sync_failed');
  return rows[0];
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

async function syncOrganization(tx: Prisma.TransactionClient, data: ClerkEventData) {
  const org = organizationData(data);
  const rows = await tx.$queryRaw`SELECT * FROM tracefab_sync_clerk_organization(${org.clerkOrganizationId}, ${org.legalName}, ${org.displayName}, ${org.type}::organization_type)`;
  if (!Array.isArray(rows) || !rows[0]) throw new Error('clerk_organization_sync_failed');
  return rows[0];
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

async function syncMembership(tx: Prisma.TransactionClient, data: ClerkEventData) {
  const membership = membershipData(data);
  const user = await ensureUser(tx, membership.clerkUserId, data);
  // Lecture bornee a un identifiant : la requete directe sur `organizations`
  // ne s'ouvre plus sans contexte worker falsifiable, et n'a pas a s'ouvrir.
  const organizationRows = await tx.$queryRaw<Array<{ id: string | null }>>`
    SELECT tracefab_clerk_organization_uuid(${membership.clerkOrganizationId}) AS id
  `;
  const organization = organizationRows[0];
  if (!organization) throw new Error('clerk_organization_not_synced');
  const rows = await tx.$queryRaw`SELECT * FROM tracefab_sync_clerk_membership(${membership.clerkMembershipId}, ${organization.id}::uuid, ${user.id}::uuid, ${membership.role}::membership_role)`;
  if (!Array.isArray(rows) || !rows[0]) throw new Error('clerk_membership_sync_failed');
  return rows[0];
}

async function revokeMembership(tx: Prisma.TransactionClient, data: ClerkEventData) {
  const clerkMembershipId = stringValue(data.id);
  if (!clerkMembershipId) return;
  await tx.$executeRaw`SELECT tracefab_revoke_clerk_membership(${clerkMembershipId})`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!process.env.CLERK_WEBHOOK_SIGNING_SECRET?.trim()) return json(res, 503, { error: 'clerk_webhook_not_configured' });

  let eventType = 'unknown';
  let verified = false;
  try {
    const rawBody = bodyText(req);
    try {
      const unsignedPayload = JSON.parse(rawBody) as { type?: unknown };
      eventType = stringValue(unsignedPayload.type) ?? 'unknown';
    } catch {
      // Signature verification below remains authoritative; this only improves safe diagnostics.
    }
    const event = await verifyWebhook(requestForVerification(req, rawBody), { signingSecret: process.env.CLERK_WEBHOOK_SIGNING_SECRET.trim() }) as unknown as ClerkWebhookEvent;
    verified = true;
    eventType = event.type || eventType;
    // Clerk parle au nom du systeme, pas d'un utilisateur connecte. Les
    // ecritures passent desormais par des fonctions nommees : plus aucune
    // politique ne s'ouvre sur une variable de session que l'appelant pourrait
    // poser lui-meme.
    await withTracefabWorkerContext(async (tx) => {
      if (eventType === 'user.created' || eventType === 'user.updated') await upsertUserFromClerkEvent(tx, event.data);
      else if (eventType === 'user.deleted') {
        const clerkUserId = stringValue(event.data.id);
        if (clerkUserId) await tx.$executeRaw`
          SELECT tracefab_soft_delete_clerk_user(${clerkUserId})
        `;
      } else if (eventType === 'organization.created' || eventType === 'organization.updated') await syncOrganization(tx, event.data);
      else if (eventType === 'organization.deleted') {
        const organizationId = stringValue(event.data.id);
        if (organizationId) {
          await tx.$executeRaw`
            SELECT tracefab_archive_clerk_organization(${organizationId})
          `;
        }
      } else if (eventType === 'organizationMembership.created' || eventType === 'organizationMembership.updated') await syncMembership(tx, event.data);
      else if (eventType === 'organizationMembership.deleted') await revokeMembership(tx, event.data);
    });
    return json(res, 200, { ok: true, eventType });
  } catch (error) {
    const errorCode = error instanceof Error ? error.message : 'unknown_error';
    const databaseCode = typeof error === 'object' && error && 'code' in error && typeof error.code === 'string' && /^P\d+$/.test(error.code) ? `database_${error.code.toLowerCase()}` : null;
    const publicError = !verified
      ? 'invalid_clerk_webhook'
      : (errorCode.startsWith('clerk_') ? errorCode : databaseCode || 'clerk_sync_failed');
    console.error('POST /api/webhooks/clerk failed', { eventType, errorCode, databaseCode });
    return json(res, 400, { error: publicError, eventType });
  }
}
