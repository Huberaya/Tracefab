import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { isUnauthorized } from '../../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { buildCompanyFilters } from '../../../_lib/crm-filters.js';
import { formatCsv } from '../../../_lib/bulk-operations/csv-parser.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';

const MAX_EXPORT_ROWS = 5000;

const HEADERS = [
  { key: 'name', label: 'Name' },
  { key: 'website', label: 'Website' },
  { key: 'country_code', label: 'Country' },
  { key: 'city', label: 'City' },
  { key: 'industry', label: 'Sector' },
  { key: 'company_type', label: 'Company type' },
  { key: 'employee_band', label: 'Size' },
  { key: 'product_count', label: 'Products' },
  { key: 'supplier_count', label: 'Suppliers' },
  { key: 'maturity', label: 'Digital maturity' },
  { key: 'dpp_interest', label: 'DPP interest' },
  { key: 'traceability_interest', label: 'Traceability interest' },
  { key: 'priority', label: 'Priority' },
  { key: 'stage', label: 'Stage' },
  { key: 'source', label: 'Source' },
  { key: 'source_detail', label: 'Source detail' },
  { key: 'collected_at', label: 'Collected at' },
  { key: 'owner_name', label: 'Owner' },
  { key: 'next_contact_at', label: 'Next contact' },
];

/**
 * GET /api/admin/companies/export — CSV du résultat filtré (§7 : exportable).
 *
 * Les filtres passent par `buildCompanyFilters`, le même module que la liste :
 * l'export contient exactement ce qui est à l'écran.
 *
 * `source`, `source_detail` et `collected_at` sont dans les colonnes exportées.
 * Un export qui perdrait la provenance transformerait un portefeuille tracé en
 * portefeuille anonyme dès son premier aller-retour (§9).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  try {
    const admin = await requirePlatformAdmin(req);

    const filters = buildCompanyFilters(
      req.query as Record<string, string | string[] | undefined>,
      admin.platformOrganizationId,
    );
    if (filters.error) return json(res, 400, { error: filters.error });

    const rows = (await withTracefabUserContext(admin.userId, admin.userEmail, (tx) =>
      tx.crm_companies.findMany({
        where: filters.where,
        orderBy: [{ priority: 'asc' }, { updated_at: 'desc' }],
        take: MAX_EXPORT_ROWS,
      }),
    )) as unknown as Array<Record<string, unknown>>;

    const csv = formatCsv(HEADERS, rows.map((row) => ({
      ...row,
      collected_at: row.collected_at ? new Date(row.collected_at as string).toISOString() : '',
      next_contact_at: row.next_contact_at ? new Date(row.next_contact_at as string).toISOString() : '',
    })));

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tracefab-prospects-${stamp}.csv"`);
    /* BOM : sans lui, Excel interprète les accents en Windows-1252. */
    res.status(200).send(`\uFEFF${csv}`);
    return undefined;
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isAdminAccessDenied(error)) return json(res, 403, { error: 'admin_access_denied' });
    const business = sqlBusinessError(error);
    if (business) return json(res, business.status, business);
    console.error('GET /api/admin/companies/export failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
