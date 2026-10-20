import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { isTenantError, requireActiveTenant, requestedTenantId } from '../../../_lib/tenant.js';
import { csvCell, CATALOG_EXPORT_HEADERS } from '../../../_lib/catalog-importer.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';

type ExportRow = {
  reference: string;
  name: string;
  category: string | null;
  sku: string | null;
  description: string | null;
  product_family: string | null;
  color_name: string | null;
  size_range: string[];
  country_of_design: string | null;
  country_of_manufacture: string | null;
  weight_grams: string | number | null;
  care_instructions: unknown;
  data_readiness: string;
  data_completion: string | number;
  version: number;
  composition_json: unknown;
};

function csvRow(row: ExportRow) {
  return [
    row.reference,
    row.name,
    row.category,
    row.sku,
    row.description,
    row.product_family,
    row.color_name,
    row.size_range.join('|'),
    row.country_of_design,
    row.country_of_manufacture,
    row.weight_grams,
    JSON.stringify(row.care_instructions ?? {}),
    row.data_readiness,
    row.data_completion,
    row.version,
    JSON.stringify(row.composition_json ?? []),
  ].map(csvCell).join(',');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const { user } = await requireClerkUser(req);

    const rows = await withTracefabUserContext(user.id, user.email, async (tx) => {
      // Locataire actif obligatoire. Un export est une sortie de donnees : le
      // repli sur `{ in: organizationIds }` produisait un CSV melangeant les
      // produits de toutes les organisations du compte, hors du tenant affiche.
      const tenant = await requireActiveTenant(tx, req, user.id, { types: ['brand'] });
      const scopedOrganizations = [tenant.organizationId];
      return tx.$queryRaw<ExportRow[]>`
        SELECT
          p.reference,
          p.name,
          p.category,
          p.sku,
          p.description,
          p.product_family,
          p.color_name,
          p.size_range,
          p.country_of_design,
          p.country_of_manufacture,
          p.weight_grams,
          p.care_instructions,
          p.data_readiness,
          p.data_completion,
          p.version,
          COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'name', m.name,
                'materialType', m.material_type,
                'percentage', pm.percentage,
                'unit', pm.unit,
                'originCountryCode', m.origin_country_code
              ) ORDER BY pm.material_role
            ) FILTER (WHERE pm.material_id IS NOT NULL),
            '[]'::jsonb
          ) AS composition_json
        FROM tracefab_products p
        LEFT JOIN product_materials pm
          ON pm.product_id = p.id AND pm.product_version = p.version
        LEFT JOIN materials m ON m.id = pm.material_id
        WHERE p.brand_organization_id = ANY(${scopedOrganizations}::uuid[])
        GROUP BY p.id
        ORDER BY p.created_at DESC
      `;
    }, requestedTenantId(req));

    const content = [CATALOG_EXPORT_HEADERS.join(','), ...rows.map(csvRow)].join('\r\n');
    const filename = `tracefab-product-catalog-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(`\uFEFF${content}\r\n`);
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (isTenantError(error)) return json(res, error.status, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('GET /api/catalog/products/export failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
