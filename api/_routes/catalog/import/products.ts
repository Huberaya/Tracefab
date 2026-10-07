import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { parseCsvRows } from '../../../_lib/bulk-operations/csv-parser.js';
import { bulkImportProducts } from '../../../_lib/bulk-operations/bulk-importer.js';
import type { BulkProductImportRow } from '../../../_lib/bulk-operations/types.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  try {
    const { user } = await requireClerkUser(req);
    const contentType = req.headers['content-type'] || '';

    let brandOrganizationId = '';
    let rows: BulkProductImportRow[] = [];

    if (contentType.includes('text/csv') || contentType.includes('text/plain')) {
      let rawCsv = '';
      if (typeof req.body === 'string') {
        rawCsv = req.body;
      } else if (Buffer.isBuffer(req.body)) {
        rawCsv = req.body.toString('utf-8');
      } else {
        const chunks: any[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        rawCsv = Buffer.concat(chunks).toString('utf-8');
      }
      const parsedRecords = parseCsvRows(rawCsv);

      brandOrganizationId = (req.query.organizationId as string) || (req.headers['x-tracefab-organization-id'] as string) || '';
      rows = parsedRecords.map((r) => ({
        reference: r.reference || r.ref || r.code_produit || r.id_interne || '',
        name: r.name || r.nom || r.titre || r.designation || '',
        category: r.category || r.categorie || '',
        sku: r.sku || '',
        description: r.description || '',
        weightGrams: r.weight_grams || r.weightGrams || r.poids_grammes || r.poids ? Number(r.weight_grams || r.weightGrams || r.poids_grammes || r.poids) : undefined,
        countryOfManufacture: r.country_of_manufacture || r.countryOfManufacture || r.pays_confection || r.pays_fabrication || '',
        countryOfDesign: r.country_of_design || r.countryOfDesign || r.pays_conception || '',
        gtin: r.gtin || r.ean || r.code_barre || '',
        materialComposition: r.material_composition || r.materialComposition || r.materials_summary || r.materialsSummary || r.composition || r.matieres || '',
      }));
    } else {
      const body = await readJsonBody<Record<string, any>>(req);
      brandOrganizationId = body.organizationId || (req.query.organizationId as string) || (req.headers['x-tracefab-organization-id'] as string) || '';
      if (Array.isArray(body.rows)) {
        rows = body.rows;
      } else if (Array.isArray(body.products)) {
        rows = body.products;
      } else if (typeof body.csvText === 'string') {
        const parsed = parseCsvRows(body.csvText);
        rows = parsed.map((r) => ({
          reference: r.reference || r.ref || r.code_produit || r.id_interne || '',
          name: r.name || r.nom || r.titre || r.designation || '',
          category: r.category || r.categorie || '',
          sku: r.sku || '',
          description: r.description || '',
          weightGrams: r.weight_grams || r.weightGrams || r.poids_grammes || r.poids ? Number(r.weight_grams || r.weightGrams || r.poids_grammes || r.poids) : undefined,
          countryOfManufacture: r.country_of_manufacture || r.countryOfManufacture || r.pays_confection || r.pays_fabrication || '',
          countryOfDesign: r.country_of_design || r.countryOfDesign || r.pays_conception || '',
          gtin: r.gtin || r.ean || r.code_barre || '',
          materialComposition: r.material_composition || r.materialComposition || r.materials_summary || r.materialsSummary || r.composition || r.matieres || '',
        }));
      }
    }

    if (!brandOrganizationId || !/^[0-9a-f-]{36}$/i.test(brandOrganizationId)) {
      return json(res, 400, { error: 'invalid_brand_organization_id' });
    }
    if (!rows.length) {
      return json(res, 400, { error: 'no_product_rows_provided' });
    }

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      return await bulkImportProducts(tx, brandOrganizationId, rows, user.id);
    });

    return json(res, 200, {
      message: 'bulk_product_import_completed',
      summary: result,
    });
  } catch (err: unknown) {
    if (isUnauthorized(err)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    const sqlError = sqlBusinessError(err);
    if (sqlError) {
      return json(res, sqlError.status, { error: sqlError.error });
    }
    console.error('Bulk product import error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
