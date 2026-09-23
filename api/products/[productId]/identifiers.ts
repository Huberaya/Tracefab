import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth';
import { withTracefabUserContext } from '../../_lib/context';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http';
import { sqlBusinessError } from '../../_lib/sql-errors';
import { activeBrandOrganizationIds, isUuid } from '../../_lib/products';

type IdentifierBody = {
  identifierType?: string;
  identifierValue?: string;
  isPrimary?: boolean;
};

type IdentifierRow = {
  id: string;
  product_id: string;
  identifier_type: string;
  identifier_value: string;
  is_primary: boolean;
  created_by: string | null;
  created_at: Date;
};

function routeParam(req: VercelRequest, key: string) {
  const value = req.query[key];
  return Array.isArray(value) ? value[0] : value;
}

function identifierType(value: unknown) {
  if (typeof value !== 'string' || !['gtin', 'ean', 'upc', 'internal'].includes(value.toLowerCase())) {
    throw new Error('invalid_identifier_type');
  }
  return value.toLowerCase();
}

function identifierValue(value: unknown) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 240) {
    throw new Error('invalid_identifier_value');
  }
  return value.trim();
}

function serializedIdentifier(row: IdentifierRow) {
  return {
    id: row.id,
    productId: row.product_id,
    type: row.identifier_type,
    value: row.identifier_value,
    isPrimary: row.is_primary,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'PATCH') {
    return methodNotAllowed(res, ['GET', 'POST', 'PATCH']);
  }

  try {
    const productId = routeParam(req, 'productId');
    if (!isUuid(productId)) return json(res, 400, { error: 'invalid_product_id' });
    const { user } = await requireClerkUser(req);

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const organizationIds = await activeBrandOrganizationIds(tx, user.id);
      const product = await tx.tracefab_products.findFirst({
        where: { id: productId, brand_organization_id: { in: organizationIds } },
        select: { id: true },
      });
      if (!product) return null;

      if (req.method === 'GET') {
        return { identifiers: await tx.product_identifiers.findMany({ where: { product_id: productId }, orderBy: { created_at: 'asc' } }) };
      }

      const body = await readJsonBody<IdentifierBody>(req);
      const value = identifierValue(body.identifierValue);
      const isPrimary = body.isPrimary ?? false;
      if (typeof isPrimary !== 'boolean') throw new Error('invalid_identifier_primary');

      if (req.method === 'POST') {
        const type = identifierType(body.identifierType);
        const rows = await tx.$queryRaw<IdentifierRow[]>`
          SELECT *
          FROM tracefab_add_product_identifier(
            ${productId}::uuid,
            ${type},
            ${value},
            ${isPrimary}
          )
        `;
        return { identifier: rows[0] };
      }

      const identifierId = routeParam(req, 'identifierId');
      if (!isUuid(identifierId)) throw new Error('invalid_identifier_id');
      const rows = await tx.$queryRaw<IdentifierRow[]>`
        SELECT *
        FROM tracefab_update_product_identifier(
          ${productId}::uuid,
          ${identifierId}::uuid,
          ${value},
          ${isPrimary}
        )
      `;
      return { identifier: rows[0] };
    });

    if (!result) return json(res, 404, { error: 'product_not_found' });
    if ('identifiers' in result) {
      return json(res, 200, { identifiers: result.identifiers.map(serializedIdentifier) });
    }
    if (!result.identifier) throw new Error('product_identifier_mutation_failed');
    return json(res, req.method === 'POST' ? 201 : 200, { identifier: serializedIdentifier(result.identifier) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return json(res, 409, { error: 'product_identifier_already_exists' });
    }
    if (error instanceof Error && /^invalid_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('GET/POST/PATCH /api/products/:productId/identifiers failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
