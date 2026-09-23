import { organization_type, Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from './_lib/auth';
import { withTracefabUserContext } from './_lib/context';
import { json, methodNotAllowed, readJsonBody } from './_lib/http';

type CreateOrganizationBody = {
  type?: string;
  legalName?: string;
  displayName?: string;
  countryCode?: string;
  registrationNumber?: string;
  website?: string;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

  try {
    const { user } = await requireClerkUser(req);

    if (req.method === 'GET') {
      const memberships = await withTracefabUserContext(user.id, user.email, (tx) =>
        tx.organization_memberships.findMany({
          where: { user_id: user.id, status: 'active' },
          select: {
            organization_id: true,
            role: true,
            organizations: {
              select: { id: true, type: true, legal_name: true, display_name: true, country_code: true, status: true },
            },
          },
          orderBy: { created_at: 'asc' },
        }),
      );
      return json(res, 200, { organizations: memberships });
    }

    const body = await readJsonBody<CreateOrganizationBody>(req);
    const legalName = body.legalName?.trim();
    const type = Object.values(organization_type).includes(body.type as organization_type)
      ? body.type as organization_type
      : organization_type.brand;
    const countryCode = body.countryCode?.trim().toUpperCase();

    if (!legalName || legalName.length > 180 || (countryCode && !/^[A-Z]{2}$/.test(countryCode))) {
      return json(res, 400, { error: 'invalid_organization' });
    }

    const organization = await withTracefabUserContext(user.id, user.email, async (tx) => {
      // The trusted SQL function creates the organization and its first owner
      // membership atomically; a direct membership insert would not pass the
      // normal admin-only membership policy before an owner exists.
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM tracefab_create_organization(
          ${type}::organization_type,
          ${legalName},
          ${body.displayName?.trim() || null},
          ${countryCode || null}
        )
      `;
      const createdId = rows[0]?.id;
      if (!createdId) throw new Error('organization_creation_failed');

      return tx.organizations.update({
        where: { id: createdId },
        data: {
          registration_number: body.registrationNumber?.trim() || null,
          website: body.website?.trim() || null,
        },
      });
    });

    return json(res, 201, { organization });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return json(res, 409, { error: 'organization_already_exists' });
    }
    console.error(`${req.method} /api/organizations failed`, error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
