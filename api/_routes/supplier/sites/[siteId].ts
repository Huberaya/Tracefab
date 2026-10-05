import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth';
import { withTracefabUserContext } from '../../../_lib/context';
import { json, methodNotAllowed, readJsonBody } from '../../../_lib/http';
import { sqlBusinessError } from '../../../_lib/sql-errors';
import { currentSupplier, requestedOrganizationId } from '../../../_lib/supplier-profile';
import { serializeSupplierSite, siteMutationValues, SUPPLIER_SITE_SELECT } from '../../../_lib/supplier-sites';

function routeSiteId(req: VercelRequest) {
  const value = req.query.siteId;
  return Array.isArray(value) ? value[0] : value;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'PATCH') return methodNotAllowed(res, ['PATCH']);
  try {
    const siteId = routeSiteId(req);
    if (!isUuid(siteId)) return json(res, 400, { error: 'invalid_site_id' });
    const { user } = await requireClerkUser(req);
    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const supplier = await currentSupplier(tx, user.id, requestedOrganizationId(req));
      if (!supplier) return null;
      const current = await tx.supplier_sites.findFirst({ where: { id: siteId, supplier_id: supplier.id }, select: SUPPLIER_SITE_SELECT });
      if (!current) return null;
      const body = await readJsonBody<Record<string, unknown>>(req);
      const values = siteMutationValues(body, current);
      const site = await tx.supplier_sites.update({
        where: { id: siteId },
        data: {
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
      return site;
    });
    if (!result) return json(res, 404, { error: 'supplier_site_not_found' });
    return json(res, 200, { site: serializeSupplierSite(result) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return json(res, 409, { error: 'supplier_site_already_exists' });
    if (error instanceof Error && /^invalid_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('PATCH /api/supplier/sites/:siteId failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
