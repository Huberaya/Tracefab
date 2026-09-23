import { randomBytes, createHash } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Prisma } from '@prisma/client';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth';
import { withTracefabUserContext } from '../../_lib/context';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http';
import { sqlBusinessError } from '../../_lib/sql-errors';
import { sendSupplierInvitationEmail } from '../../_lib/email';

type InviteSupplierBody = {
  email?: string;
  legalName?: string;
  displayName?: string;
  countryCode?: string;
};

type InvitationRow = {
  relationship_id: string;
  supplier_organization_id: string;
  supplier_id: string;
  invitation_id: string;
  expires_at: Date;
};

type InvitationTransactionResult = {
  invitation: InvitationRow;
  brandName: string;
};

function routeOrganizationId(req: VercelRequest) {
  const value = req.query.organizationId;
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const organizationId = routeOrganizationId(req);
    if (!organizationId || !/^[0-9a-f-]{36}$/i.test(organizationId)) {
      return json(res, 400, { error: 'invalid_organization_id' });
    }

    const { user } = await requireClerkUser(req);
    const body = await readJsonBody<InviteSupplierBody>(req);
    const email = body.email?.trim().toLowerCase();
    const legalName = body.legalName?.trim();
    const displayName = body.displayName?.trim() || null;
    const countryCode = body.countryCode?.trim().toUpperCase() || null;

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 320) {
      return json(res, 400, { error: 'invalid_supplier_email' });
    }
    if (!legalName || legalName.length > 180) {
      return json(res, 400, { error: 'invalid_supplier_legal_name' });
    }
    if (displayName && displayName.length > 180) {
      return json(res, 400, { error: 'invalid_supplier_display_name' });
    }
    if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) {
      return json(res, 400, { error: 'invalid_country_code' });
    }

    // The raw token is generated and retained only in this request. Only its
    // SHA-256 hash crosses the SQL boundary; the caller must deliver this
    // one-time value through its email provider without persisting it here.
    const invitationToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(invitationToken).digest('hex');

    const transactionResult = await withTracefabUserContext(user.id, user.email, async (tx): Promise<InvitationTransactionResult> => {
      const brand = await tx.organizations.findUnique({
        where: { id: organizationId },
        select: { legal_name: true, display_name: true },
      });
      const rows = await tx.$queryRaw<InvitationRow[]>`
        SELECT *
        FROM tracefab_invite_supplier(
          ${organizationId}::uuid,
          ${email},
          ${legalName},
          ${displayName},
          ${countryCode},
          ${tokenHash}
        )
      `;
      const row = rows[0];
      if (!row) throw new Error('invitation_creation_failed');
      return {
        invitation: row,
        brandName: brand?.display_name || brand?.legal_name || 'A Tracefab organization',
      };
    });

    const invitation = transactionResult.invitation;
    const delivery = await sendSupplierInvitationEmail({
      to: email,
      supplierName: displayName || legalName,
      brandName: transactionResult.brandName,
      invitationToken,
      expiresAt: invitation.expires_at,
    });
    const response = {
      invitation: {
        id: invitation.invitation_id,
        relationshipId: invitation.relationship_id,
        supplierOrganizationId: invitation.supplier_organization_id,
        supplierId: invitation.supplier_id,
        expiresAt: invitation.expires_at,
      },
      delivery: delivery.status === 'sent'
        ? { status: delivery.status, providerId: delivery.providerId }
        : { status: delivery.status },
    };

    res.setHeader('Cache-Control', 'no-store');
    if (delivery.status === 'sent') return json(res, 201, response);

    // When delivery is not configured or fails, return the one-time token to
    // the trusted caller so it can be delivered manually. It never enters SQL
    // and is never logged by this API.
    return json(res, delivery.status === 'failed' ? 502 : 201, {
      ...response,
      invitationToken,
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return json(res, 409, { error: 'active_supplier_invitation_exists' });
    }
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('POST /api/organizations/:organizationId/invitations failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
