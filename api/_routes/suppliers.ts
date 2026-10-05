import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '.././_lib/auth';
import { withTracefabUserContext } from '.././_lib/context';
import { json, methodNotAllowed } from '.././_lib/http';
import { activeBrandOrganizationIds } from '.././_lib/products';

type SupplierRow = {
  supplier_id: string;
  organization_id: string;
  relationship_id: string;
  legal_name: string;
  display_name: string | null;
  country_code: string | null;
  organization_status: string;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const { user } = await requireClerkUser(req);
    const suppliers = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const brandIds = await activeBrandOrganizationIds(tx, user.id);
      if (brandIds.length === 0) return [];
      const rows = await tx.$queryRaw<SupplierRow[]>`
        SELECT
          s.id AS supplier_id,
          s.organization_id,
          r.id AS relationship_id,
          o.legal_name,
          o.display_name,
          o.country_code,
          o.status AS organization_status
        FROM suppliers s
        JOIN organizations o ON o.id = s.organization_id
        JOIN brand_supplier_relationships r
          ON r.supplier_organization_id = s.organization_id
         AND r.brand_organization_id = ANY(${brandIds}::uuid[])
         AND r.status = 'active'
        ORDER BY COALESCE(o.display_name, o.legal_name)
      `;
      return rows.map((row) => ({
        id: row.supplier_id,
        organization_id: row.organization_id,
        relationship_id: row.relationship_id,
        organizations: {
          id: row.organization_id,
          legal_name: row.legal_name,
          display_name: row.display_name,
          country_code: row.country_code,
          status: row.organization_status,
          type: 'supplier',
        },
      }));
    });
    return json(res, 200, { suppliers });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('GET /api/suppliers failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
