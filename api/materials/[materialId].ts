import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../_lib/auth';
import { withTracefabUserContext } from '../_lib/context';
import { json, methodNotAllowed, readJsonBody } from '../_lib/http';
import { sqlBusinessError } from '../_lib/sql-errors';
import { activeOrganizationIds, isUuid } from '../_lib/products';

type MaterialBody = {
  materialType?: string;
  name?: string;
  composition?: Record<string, unknown> | null;
  originCountryCode?: string | null;
};

type MaterialRow = {
  id: string;
  owner_organization_id: string;
  material_type: string;
  name: string;
  normalized_name: string | null;
  composition: unknown;
  origin_country_code: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

function routeMaterialId(req: VercelRequest) {
  const value = req.query.materialId;
  return Array.isArray(value) ? value[0] : value;
}

function requiredString(value: unknown, field: string, maxLength: number) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxLength) throw new Error(`invalid_${field}`);
  return value.trim();
}

function optionalCountry(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value.trim())) throw new Error('invalid_origin_country_code');
  return value.trim().toUpperCase();
}

function composition(value: unknown) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_material_composition');
  return value as Record<string, unknown>;
}

function serializedMaterial(material: MaterialRow) {
  return {
    id: material.id,
    ownerOrganizationId: material.owner_organization_id,
    materialType: material.material_type,
    name: material.name,
    normalizedName: material.normalized_name,
    composition: material.composition,
    originCountryCode: material.origin_country_code,
    createdBy: material.created_by,
    createdAt: material.created_at,
    updatedAt: material.updated_at,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'PATCH') return methodNotAllowed(res, ['GET', 'PATCH']);

  try {
    const materialId = routeMaterialId(req);
    if (!isUuid(materialId)) return json(res, 400, { error: 'invalid_material_id' });
    const { user } = await requireClerkUser(req);

    const material = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const organizationIds = await activeOrganizationIds(tx, user.id);
      if (organizationIds.length === 0) return null;
      const current = await tx.$queryRaw<MaterialRow[]>`
        SELECT m.*
        FROM materials m
        WHERE m.id = ${materialId}::uuid
          AND (
            m.owner_organization_id = ANY(${organizationIds}::uuid[])
            OR tracefab_can_access_shared_subject(m.owner_organization_id, 'material', m.id)
          )
      `;
      if (!current[0]) return null;
      if (req.method === 'GET') return current[0];

      const body = await readJsonBody<MaterialBody>(req);
      const allowedKeys = new Set(['materialType', 'name', 'composition', 'originCountryCode']);
      if (Object.keys(body).some((key) => !allowedKeys.has(key))) throw new Error('invalid_material_fields');
      const materialType = Object.prototype.hasOwnProperty.call(body, 'materialType')
        ? requiredString(body.materialType, 'material_type', 120)
        : current[0].material_type;
      const name = Object.prototype.hasOwnProperty.call(body, 'name')
        ? requiredString(body.name, 'material_name', 240)
        : current[0].name;
      const materialComposition = Object.prototype.hasOwnProperty.call(body, 'composition')
        ? composition(body.composition)
        : current[0].composition;
      const originCountryCode = Object.prototype.hasOwnProperty.call(body, 'originCountryCode')
        ? optionalCountry(body.originCountryCode)
        : current[0].origin_country_code;

      const rows = await tx.$queryRaw<MaterialRow[]>`
        SELECT *
        FROM tracefab_update_material(
          ${materialId}::uuid,
          ${materialType},
          ${name},
          ${JSON.stringify(materialComposition)}::jsonb,
          ${originCountryCode}
        )
      `;
      return rows[0] ?? null;
    });

    if (!material) return json(res, 404, { error: 'material_not_found' });
    return json(res, 200, { material: serializedMaterial(material) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return json(res, 409, { error: 'material_already_exists' });
    }
    if (error instanceof Error && /^invalid_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error('GET/PATCH /api/materials/:materialId failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
