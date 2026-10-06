import { data_type, data_value_status, Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import {
  DATA_POINT_DEFINITIONS,
  DATA_POINT_SELECT,
  productDataPointMutation,
  serializeDataPoint,
} from '../../../_lib/data-points.js';
import { json, methodNotAllowed, readJsonBody } from '../../../_lib/http.js';
import { activeBrandOrganizationIds, isUuid } from '../../../_lib/products.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';

function routeProductId(req: VercelRequest) {
  const value = req.query.productId;
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

  try {
    const productId = routeProductId(req);
    if (!isUuid(productId)) return json(res, 400, { error: 'invalid_product_id' });
    const { user } = await requireClerkUser(req);

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const brandOrgIds = await activeBrandOrganizationIds(tx, user.id);
      const product = await tx.tracefab_products.findFirst({
        where: { id: productId, brand_organization_id: { in: brandOrgIds } },
        select: { id: true, brand_organization_id: true, version: true },
      });
      if (!product) return null;

      if (req.method === 'GET') {
        const dataKey = Array.isArray(req.query.dataKey) ? req.query.dataKey[0] : req.query.dataKey;
        const points = await tx.data_points.findMany({
          where: {
            product_id: productId,
            ...(dataKey ? { data_key: dataKey } : {}),
          },
          select: DATA_POINT_SELECT,
          orderBy: [{ data_key: 'asc' }, { version: 'desc' }],
        });
        return { points };
      }

      // POST - requires mutation role
      const membership = await tx.organization_memberships.findFirst({
        where: {
          organization_id: product.brand_organization_id,
          user_id: user.id,
          status: 'active',
          role: { in: ['owner', 'admin', 'manager', 'contributor'] },
        },
        select: { id: true },
      });
      if (!membership) throw new Error('brand_product_role_required');

      const body = await readJsonBody<Record<string, unknown>>(req);
      const values = productDataPointMutation(body);

      if (values.sourceDocumentId) {
        const accessRows = await tx.$queryRaw<Array<{ can_access: boolean }>>`
          SELECT tracefab_can_access_document(${values.sourceDocumentId}::uuid) AS can_access
        `;
        if (!accessRows[0]?.can_access) throw new Error('invalid_source_document_id');
      }

      const current = await tx.data_points.findFirst({
        where: { product_id: productId, data_key: values.dataKey },
        orderBy: { version: 'desc' },
        select: { id: true, version: true },
      });

      const point = await tx.data_points.create({
        data: {
          owner_organization_id: product.brand_organization_id,
          product_id: productId,
          data_key: values.dataKey,
          value: values.value as Prisma.InputJsonValue,
          data_type: values.dataType as data_type,
          status: values.sourceDocumentId ? data_value_status.documented : data_value_status.declared,
          source_document_id: values.sourceDocumentId,
          declared_by: user.id,
          valid_from: values.validFrom,
          valid_until: values.validUntil,
          version: current ? current.version + 1 : 1,
          supersedes_id: current ? current.id : null,
        },
        select: DATA_POINT_SELECT,
      });

      return { point };
    });

    if (!result) return json(res, 404, { error: 'product_not_found' });
    if ('points' in result && result.points) {
      return json(res, 200, {
        dataPoints: result.points.map(serializeDataPoint),
        definitions: DATA_POINT_DEFINITIONS,
      });
    }
    return json(res, 201, { dataPoint: serializeDataPoint(result.point) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return json(res, 409, { error: 'data_point_conflict' });
    }
    if (error instanceof Error && (/^invalid_|^data_point_/.test(error.message))) {
      return json(res, 400, { error: error.message });
    }
    if (error instanceof Error && error.message === 'brand_product_role_required') {
      return json(res, 403, { error: 'brand_product_role_required' });
    }
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error(`${req.method} /api/products/:productId/data-points failed`, error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
