import type { VercelRequest, VercelResponse } from '../_lib/vercel-types.js';
import { Prisma } from '@prisma/client';
import { requireClerkUser, isUnauthorized } from '.././_lib/auth.js';
import { withTracefabUserContext } from '.././_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '.././_lib/http.js';
import { sqlBusinessError } from '.././_lib/sql-errors.js';
import { isUuid } from '.././_lib/products.js';
import { isTenantError, requireActiveTenant, requestedTenantId } from '.././_lib/tenant.js';

type MaterialBody = {
  ownerOrganizationId?: string;
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
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

  try {
    const { user } = await requireClerkUser(req);
    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      // Locataire actif obligatoire. Le repli precedent listait les matieres de
      // toutes les organisations du compte. Le partage explicite entre
      // organisations est conserve : il passe par
      // `tracefab_can_access_shared_subject`, un mecanisme audite distinct du
      // simple fait d'etre membre de plusieurs tenants.
      const tenant = await requireActiveTenant(tx, req, user.id);

      if (req.method === 'GET') {
        const materials = await tx.$queryRaw<MaterialRow[]>`
          SELECT m.*
          FROM materials m
          WHERE (
            m.owner_organization_id = ${tenant.organizationId}::uuid
            OR tracefab_can_access_shared_subject(m.owner_organization_id, 'material', m.id)
          )
          ORDER BY m.updated_at DESC
        `;
        return { materials };
      }

      const body = await readJsonBody<MaterialBody>(req);
      if (body.ownerOrganizationId !== tenant.organizationId) {
        throw new Error('invalid_owner_organization_id');
      }
      const materialType = requiredString(body.materialType, 'material_type', 120);
      const name = requiredString(body.name, 'material_name', 240);
      const materialComposition = composition(body.composition);
      const originCountryCode = optionalCountry(body.originCountryCode);
      const rows = await tx.$queryRaw<MaterialRow[]>`
        SELECT *
        FROM tracefab_create_material(
          ${body.ownerOrganizationId}::uuid,
          ${materialType},
          ${name},
          ${JSON.stringify(materialComposition)}::jsonb,
          ${originCountryCode}
        )
      `;
      return { material: rows[0] };
    }, requestedTenantId(req));

    if ('materials' in result) return json(res, 200, { materials: result.materials!.map(serializedMaterial) });
    if (!result.material) throw new Error('material_creation_failed');
    return json(res, 201, { material: serializedMaterial(result.material) });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isTenantError(error)) return json(res, error.status, { error: error.message });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return json(res, 409, { error: 'material_already_exists' });
    }
    if (error instanceof Error && /^invalid_/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') {
      return json(res, 503, { error: 'clerk_not_configured' });
    }
    console.error(`${req.method} /api/materials failed`, error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
