import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../_lib/auth';
import { withTracefabUserContext } from '../_lib/context';
import { json, methodNotAllowed, readJsonBody } from '../_lib/http';
import { sqlBusinessError } from '../_lib/sql-errors';
import { activeBrandOrganizationIds, isUuid, PRODUCT_SELECT, serializeProduct } from '../_lib/products';

type UpdateProductBody = {
  reference?: string;
  sku?: string | null;
  name?: string;
  category?: string | null;
  description?: string | null;
  productFamily?: string | null;
  colorName?: string | null;
  sizeRange?: string[];
  countryOfDesign?: string | null;
  countryOfManufacture?: string | null;
  weightGrams?: number | null;
  careInstructions?: Record<string, unknown> | null;
};

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

function countryCode(value: unknown, field: string) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value.trim())) throw new Error(`invalid_${field}`);
  return value.trim().toUpperCase();
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'PATCH') return methodNotAllowed(res, ['GET', 'PATCH']);

  try {
    const productId = routeProductId(req);
    if (!isUuid(productId)) return json(res, 400, { error: 'invalid_product_id' });
    const { user } = await requireClerkUser(req);

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const organizationIds = await activeBrandOrganizationIds(tx, user.id);
      const current = await tx.tracefab_products.findFirst({
        where: { id: productId, brand_organization_id: { in: organizationIds } },
        select: DETAIL_SELECT,
      });
      if (!current) return null;
      if (req.method === 'GET') return current;

      const body = await readJsonBody<UpdateProductBody>(req);
      const allowedKeys = new Set([
        'reference', 'sku', 'name', 'category', 'description', 'productFamily',
        'colorName', 'sizeRange', 'countryOfDesign', 'countryOfManufacture',
        'weightGrams', 'careInstructions',
      ]);
      if (Object.keys(body).some((key) => !allowedKeys.has(key))) throw new Error('invalid_product_fields');

      const reference = Object.prototype.hasOwnProperty.call(body, 'reference')
        ? requiredString(body.reference, 'product_reference', 180)
        : current.reference;
      const name = Object.prototype.hasOwnProperty.call(body, 'name')
        ? requiredString(body.name, 'product_name', 240)
        : current.name;
      const sku = Object.prototype.hasOwnProperty.call(body, 'sku')
        ? optionalString(body.sku, 'product_sku', 120)
        : current.sku;
      const category = Object.prototype.hasOwnProperty.call(body, 'category')
        ? optionalString(body.category, 'product_category', 180)
        : current.category;
      const description = Object.prototype.hasOwnProperty.call(body, 'description')
        ? optionalString(body.description, 'product_description', 10000)
        : current.description;
      const productFamily = Object.prototype.hasOwnProperty.call(body, 'productFamily')
        ? optionalString(body.productFamily, 'product_family', 180)
        : current.product_family;
      const colorName = Object.prototype.hasOwnProperty.call(body, 'colorName')
        ? optionalString(body.colorName, 'color_name', 120)
        : current.color_name;
      const sizeRange = Object.prototype.hasOwnProperty.call(body, 'sizeRange') ? body.sizeRange : current.size_range;
      const countryOfDesign = Object.prototype.hasOwnProperty.call(body, 'countryOfDesign')
        ? countryCode(body.countryOfDesign, 'country_of_design')
        : current.country_of_design;
      const countryOfManufacture = Object.prototype.hasOwnProperty.call(body, 'countryOfManufacture')
        ? countryCode(body.countryOfManufacture, 'country_of_manufacture')
        : current.country_of_manufacture;
      const weightGrams = Object.prototype.hasOwnProperty.call(body, 'weightGrams')
        ? body.weightGrams ?? null
        : current.weight_grams === null ? null : Number(current.weight_grams);
      const careInstructions = Object.prototype.hasOwnProperty.call(body, 'careInstructions')
        ? body.careInstructions ?? {}
        : current.care_instructions;

      if (!Array.isArray(sizeRange) || sizeRange.length > 50 || sizeRange.some((value) => typeof value !== 'string' || value.trim().length === 0 || value.length > 40)) {
        throw new Error('invalid_size_range');
      }
      if (weightGrams !== null && (typeof weightGrams !== 'number' || !Number.isFinite(weightGrams) || weightGrams < 0 || weightGrams > 1000000)) {
        throw new Error('invalid_weight_grams');
      }
      if (typeof careInstructions !== 'object' || careInstructions === null || Array.isArray(careInstructions)) {
        throw new Error('invalid_care_instructions');
      }

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
