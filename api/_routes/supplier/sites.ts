import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';
import { currentSupplier, requestedOrganizationId } from '../../_lib/supplier-profile.js';
import { serializeSupplierSite, siteMutationValues, SUPPLIER_SITE_SELECT, type SupplierSiteRecord } from '../../_lib/supplier-sites.js';

type SiteBody = Record<string, unknown>;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

  try {
    const { user } = await requireClerkUser(req);
    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const supplier = await currentSupplier(tx, user.id, requestedOrganizationId(req));
      if (!supplier) return null;
      if (req.method === 'GET') {
        const sites = await tx.supplier_sites.findMany({
          where: { supplier_id: supplier.id },
          select: SUPPLIER_SITE_SELECT,
          orderBy: [{ is_active: 'desc' }, { name: 'asc' }],
        });
        return { sites };
      }

      const body = await readJsonBody<SiteBody>(req);
      const values = siteMutationValues(body);
      const site = await tx.supplier_sites.create({
        data: {
          supplier_id: supplier.id,
          name: values.name,
          country_code: values.countryCode,
          address: values.address,
          city: values.city,
          postal_code: values.postalCode,
          latitude: values.latitude,
          longitude: values.longitude,
          activity_types: values.activityTypes,
          is_active: values.isActive,
        },
        select: SUPPLIER_SITE_SELECT,
      });
      return { site };
    });

    if (!result) return json(res, 404, { error: 'supplier_profile_not_found' });
    if ('sites' in result) return json(res, 200, { sites: result.sites!.map(serializeSupplierSite) });
    return json(res, 201, { site: serializeSupplierSite(result.site as SupplierSiteRecord) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return json(res, 409, { error: 'supplier_site_already_exists' });
    if (error instanceof Error && /^invalid_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error(`${req.method} /api/supplier/sites failed`, error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
