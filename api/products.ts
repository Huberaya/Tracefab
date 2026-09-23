import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from './_lib/auth';
import { withTracefabUserContext } from './_lib/context';
import { json, methodNotAllowed, readJsonBody } from './_lib/http';
import { sqlBusinessError } from './_lib/sql-errors';
import { activeBrandOrganizationIds, isUuid, PRODUCT_SELECT, serializeProduct } from './_lib/products';

type CreateProductBody = {
  brandOrganizationId?: string;
  reference?: string;
  name?: string;
  category?: string | null;
  sku?: string | null;
};

function queryOrganizationId(req: VercelRequest) {
  const value = req.query.organizationId;
  return Array.isArray(value) ? value[0] : value;
}

function requiredString(value: unknown, field: string, maxLength: number) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxLength) {
    throw new Error(`invalid_${field}`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, maxLength: number) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length > maxLength) throw new Error(`invalid_${field}`);
  return value.trim() || null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

  try {
    const { user } = await requireClerkUser(req);

    if (req.method === 'GET') {
      const requestedOrganizationId = queryOrganizationId(req);
      if (requestedOrganizationId && !isUuid(requestedOrganizationId)) {
        return json(res, 400, { error: 'invalid_organization_id' });
      }

      const products = await withTracefabUserContext(user.id, user.email, async (tx) => {
        const organizationIds = await activeBrandOrganizationIds(tx, user.id);
        if (requestedOrganizationId && !organizationIds.includes(requestedOrganizationId)) {
          return [];
        }
        return tx.tracefab_products.findMany({
          where: {
            brand_organization_id: requestedOrganizationId
              ? requestedOrganizationId
              : { in: organizationIds },
          },
          select: PRODUCT_SELECT,
          orderBy: { created_at: 'desc' },
        });
      });

      return json(res, 200, { products: products.map(serializeProduct) });
    }

    const body = await readJsonBody<CreateProductBody>(req);
    if (!isUuid(body.brandOrganizationId)) return json(res, 400, { error: 'invalid_brand_organization_id' });
    const reference = requiredString(body.reference, 'product_reference', 180);
    const name = requiredString(body.name, 'product_name', 240);
    const category = optionalString(body.category, 'product_category', 180);
    const sku = optionalString(body.sku, 'product_sku', 120);

    const product = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM tracefab_create_product(
          ${body.brandOrganizationId}::uuid,
          ${reference},
          ${name},
          ${category},
          ${sku}
        )
      `;
      const id = rows[0]?.id;
      if (!id) throw new Error('product_creation_failed');
      const created = await tx.tracefab_products.findUnique({ where: { id }, select: PRODUCT_SELECT });
      if (!created) throw new Error('product_creation_failed');
      return created;
    });

    return json(res, 201, { product: serializeProduct(product) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return json(res, 409, { error: 'product_reference_already_exists' });
    }
    if (error instanceof Error && /^invalid_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error(`${req.method} /api/products failed`, error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
