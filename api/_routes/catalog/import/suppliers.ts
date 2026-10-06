import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { json, methodNotAllowed, readJsonBody } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { parseCsvRows } from '../../../_lib/bulk-operations/csv-parser.js';
import { bulkImportSuppliers } from '../../../_lib/bulk-operations/bulk-importer.js';
import type { BulkSupplierImportRow } from '../../../_lib/bulk-operations/types.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, ['POST']);
  }

  try {
    const { user } = await requireClerkUser(req);
    const contentType = req.headers['content-type'] || '';

    let brandOrganizationId = '';
    let rows: BulkSupplierImportRow[] = [];

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
        email: r.email || r.courriel || r.contact_email || '',
        legalName: r.legal_name || r.raison_sociale || r.nom_legal || r.entreprise || '',
        displayName: r.display_name || r.nom_commercial || r.nom || '',
        countryCode: r.country_code || r.pays || r.code_pays || '',
        tier: r.tier || r.rang || '',
        contactName: r.contact_name || r.nom_contact || '',
        contactPhone: r.contact_phone || r.telephone || '',
      }));
    } else {
      const body = await readJsonBody<Record<string, any>>(req);
      brandOrganizationId = body.organizationId || (req.query.organizationId as string) || (req.headers['x-tracefab-organization-id'] as string) || '';
      if (Array.isArray(body.rows)) {
        rows = body.rows;
      } else if (typeof body.csvText === 'string') {
        const parsed = parseCsvRows(body.csvText);
        rows = parsed.map((r) => ({
          email: r.email || r.courriel || r.contact_email || '',
          legalName: r.legal_name || r.raison_sociale || r.nom_legal || r.entreprise || '',
          displayName: r.display_name || r.nom_commercial || r.nom || '',
          countryCode: r.country_code || r.pays || r.code_pays || '',
          tier: r.tier || r.rang || '',
          contactName: r.contact_name || r.nom_contact || '',
          contactPhone: r.contact_phone || r.telephone || '',
        }));
      }
    }

    if (!brandOrganizationId || !/^[0-9a-f-]{36}$/i.test(brandOrganizationId)) {
      return json(res, 400, { error: 'invalid_brand_organization_id' });
    }
    if (!rows.length) {
      return json(res, 400, { error: 'no_supplier_rows_provided' });
    }

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      return await bulkImportSuppliers(tx, brandOrganizationId, rows, user.id);
    });

    return json(res, 200, {
      message: 'bulk_supplier_import_completed',
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
    console.error('Bulk supplier import error:', err);
    return json(res, 500, { error: 'internal_error' });
  }
}
