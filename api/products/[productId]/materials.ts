import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../_lib/auth';
import { withTracefabUserContext } from '../../_lib/context';
import { json, methodNotAllowed, readJsonBody } from '../../_lib/http';
import { sqlBusinessError } from '../../_lib/sql-errors';
import { activeBrandOrganizationIds, isUuid } from '../../_lib/products';

type MaterialBody = {
  materialId?: string;
  materialRole?: string;
  productVersion?: number;
  percentage?: number | null;
  unit?: string;
};

type MaterialRow = {
  product_id: string;
  material_id: string;
  material_role: string;
  percentage: Prisma.Decimal | null;
  unit: string;
  product_version: number;
  created_at: Date;
  materials: {
    id: string;
    material_type: string;
    name: string;
    normalized_name: string | null;
    origin_country_code: string | null;
  };
};

function routeParam(req: VercelRequest, key: string) {
  const value = req.query[key];
  return Array.isArray(value) ? value[0] : value;
}

function materialRole(value: unknown) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 80) {
    throw new Error('invalid_material_role');
  }
  return value.trim();
}

function materialPercentage(value: unknown) {
  if (value === undefined) return null;
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100)) {
    throw new Error('invalid_material_percentage');
  }
  return value;
}

function materialUnit(value: unknown) {
  if (value === undefined || value === null) return '%';
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 20) {
    throw new Error('invalid_material_unit');
  }
  return value.trim();
}

function serializedMaterial(row: MaterialRow) {
  return {
    productId: row.product_id,
    materialId: row.material_id,
    role: row.material_role,
    percentage: row.percentage === null ? null : String(row.percentage),
    unit: row.unit,
    productVersion: row.product_version,
    createdAt: row.created_at,
    material: row.materials,
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
        select: { id: true, version: true },
      });
      if (!product) return null;

      if (req.method === 'GET') {
        const materials = await tx.product_materials.findMany({
          where: { product_id: productId },
          select: {
            product_id: true,
            material_id: true,
            material_role: true,
            percentage: true,
            unit: true,
            product_version: true,
            created_at: true,
            materials: { select: { id: true, material_type: true, name: true, normalized_name: true, origin_country_code: true } },
          },
          orderBy: [{ product_version: 'desc' }, { material_role: 'asc' }],
        });
        return { materials };
      }

      const body = await readJsonBody<MaterialBody>(req);
      const materialId = body.materialId;
      if (!isUuid(materialId)) throw new Error('invalid_material_id');
      const role = materialRole(body.materialRole);
      const percentage = materialPercentage(body.percentage);
      const unit = materialUnit(body.unit);

      if (req.method === 'POST') {
        const rows = await tx.$queryRaw<MaterialRow[]>`
          SELECT *
          FROM tracefab_add_product_material(
            ${productId}::uuid,
            ${materialId}::uuid,
            ${role},
            ${percentage},
            ${unit}
          )
        `;
        return { material: rows[0] };
      }

      if (!Number.isInteger(body.productVersion) || body.productVersion !== product.version) {
        throw new Error('invalid_product_version');
      }
      const rows = await tx.$queryRaw<MaterialRow[]>`
        SELECT *
        FROM tracefab_update_product_material(
          ${productId}::uuid,
          ${materialId}::uuid,
          ${role},
          ${body.productVersion},
          ${percentage},
          ${unit}
        )
      `;
      return { material: rows[0] };
    });

    if (!result) return json(res, 404, { error: 'product_not_found' });
    if ('materials' in result) return json(res, 200, { materials: result.materials.map(serializedMaterial) });
    if (!result.material) throw new Error('product_material_mutation_failed');
    return json(res, req.method === 'POST' ? 201 : 200, { material: serializedMaterial(result.material) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return json(res, 409, { error: 'product_material_already_exists' });
    }
    if (error instanceof Error && /^invalid_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('GET/POST/PATCH /api/products/:productId/materials failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
