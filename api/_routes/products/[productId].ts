import { validateProductPatch, ProductFieldError, type UpdateProductBody } from '../../_lib/product-edit.js';
import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth.js';
import { withTracefabUserContext } from '../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http.js';
import { sqlBusinessError } from '../../_lib/sql-errors.js';
import { activeBrandOrganizationIds, isUuid, PRODUCT_SELECT, serializeProduct } from '../../_lib/products.js';


const DETAIL_SELECT = {
  ...PRODUCT_SELECT,
  product_identifiers: {
    select: { id: true, identifier_type: true, identifier_value: true, is_primary: true, created_by: true, created_at: true },
    orderBy: { created_at: 'asc' },
  },
  product_materials: {
    select: {
      material_id: true,
      material_role: true,
      percentage: true,
      unit: true,
      product_version: true,
      created_at: true,
      materials: { select: { id: true, material_type: true, name: true, normalized_name: true, origin_country_code: true } },
    },
    orderBy: [{ product_version: 'desc' }, { material_role: 'asc' }],
  },
} satisfies Prisma.tracefab_productsSelect;

type ProductDetail = Prisma.tracefab_productsGetPayload<{ select: typeof DETAIL_SELECT }>;

function routeProductId(req: VercelRequest) {
  const value = req.query.productId;
  return Array.isArray(value) ? value[0] : value;
}


function productDetailPayload(product: ProductDetail) {
  return {
    product: serializeProduct(product),
    identifiers: product.product_identifiers.map((identifier) => ({
      id: identifier.id,
      type: identifier.identifier_type,
      value: identifier.identifier_value,
      isPrimary: identifier.is_primary,
      createdBy: identifier.created_by,
      createdAt: identifier.created_at,
    })),
    materials: product.product_materials.map((entry) => ({
      materialId: entry.material_id,
      role: entry.material_role,
      percentage: entry.percentage === null ? null : String(entry.percentage),
      unit: entry.unit,
      productVersion: entry.product_version,
      createdAt: entry.created_at,
      material: entry.materials,
    })),
  };
}

export function createProductHandler(deps = { requireClerkUser, withTracefabUserContext }) {
return async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'PATCH') return methodNotAllowed(res, ['GET', 'PATCH']);

  try {
    const productId = routeProductId(req);
    if (!isUuid(productId)) return json(res, 400, { error: 'invalid_product_id' });
    const { user } = await deps.requireClerkUser(req);

    const result = await deps.withTracefabUserContext(user.id, user.email, async (tx) => {
      const organizationIds = await activeBrandOrganizationIds(tx, user.id);
      const current = await tx.tracefab_products.findFirst({
        where: { id: productId, brand_organization_id: { in: organizationIds } },
        select: DETAIL_SELECT,
      });
      if (!current) return null;
      if (req.method === 'GET') return current;

      const body = await readJsonBody<UpdateProductBody>(req);
      const { reference, sku, name, category, description, productFamily, colorName, sizeRange, countryOfDesign, countryOfManufacture, weightGrams, careInstructions } = validateProductPatch(body, current);

      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM tracefab_update_product_data(
          ${productId}::uuid,
          ${reference},
          ${sku},
          ${name},
          ${category},
          ${description},
          ${productFamily},
          ${colorName},
          ${sizeRange}::text[],
          ${countryOfDesign},
          ${countryOfManufacture},
          ${weightGrams},
          ${JSON.stringify(careInstructions)}::jsonb
        )
      `;
      if (!rows[0]?.id) throw new Error('product_update_failed');
      const updated = await tx.tracefab_products.findFirst({ where: { id: productId, brand_organization_id: { in: organizationIds } }, select: DETAIL_SELECT });
      if (!updated) throw new Error('product_update_failed');
      return updated;
    });

    if (!result) return json(res, 404, { error: 'product_not_found' });
    return json(res, 200, productDetailPayload(result));
  } catch (error) {
    if (error instanceof ProductFieldError) return json(res, 400, { error: 'invalid_product_field', field: error.field, message: `${error.field} : ${error.message}` });
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
    console.error('GET/PATCH /api/products/:productId failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}

}

const productHandler = createProductHandler();
export default async function handler(req: VercelRequest, res: VercelResponse) {
  return productHandler(req, res);
}
