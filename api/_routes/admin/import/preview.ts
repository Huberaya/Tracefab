import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { isUnauthorized } from '../../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { parseCsvRows } from '../../../_lib/bulk-operations/csv-parser.js';
import { buildImportPreview } from '../../../_lib/crm-import.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';

/** Fichiers au-delà de 2 Mo : un CSV de prospection raisonnable tient en dessous. */
const MAX_CSV_BYTES = 2 * 1024 * 1024;

/**
 * POST /api/admin/import/preview
 *
 * §8 : « Preview then Import ». Cet endpoint n'ÉCRIT RIEN. Il renvoie le mapping
 * suggéré, les doublons détectés avec leur raison, et les lignes invalides avec
 * leurs erreurs — pour que la décision soit prise avant l'écriture.
 *
 * `source` est obligatoire : un import sans provenance produirait un portefeuille
 * dont on ne sait plus d'où vient chaque ligne (§9).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const admin = await requirePlatformAdmin(req);
    const body = { ...((req.body || {}) as Record<string, unknown>) };

    const csv = typeof body.csv === 'string' ? body.csv : '';
    if (!csv.trim()) return json(res, 422, { error: 'csv_required' });
    if (Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) {
      return json(res, 413, { error: 'crm_import_file_too_large' });
    }

    const source = typeof body.source === 'string' ? body.source.trim() : '';
    if (!source) return json(res, 422, { error: 'crm_import_source_required' });

    const records = parseCsvRows(csv) as Array<Record<string, unknown>>;
    if (!records.length) {
      return json(res, 422, { error: 'csv_has_no_data_rows', details: ['headers_and_at_least_one_row_required'] });
    }

    const mapping = body.mapping && typeof body.mapping === 'object'
      ? (body.mapping as Record<string, string | null>)
      : {};

    const existing = (await withTracefabUserContext(admin.userId, admin.userEmail, (tx) =>
      tx.crm_companies.findMany({
        where: { platform_organization_id: admin.platformOrganizationId },
        select: { id: true, name: true, country_code: true, website: true },
      }),
    )) as never;

    const preview = buildImportPreview(records, {
      source,
      sourceDetail: typeof body.source_detail === 'string' ? body.source_detail.trim() || null : null,
      collectedAt: typeof body.collected_at === 'string' ? body.collected_at : null,
      mapping,
      existing,
      skipDuplicates: body.skip_duplicates === true,
    });

    return json(res, 200, { preview, writes: 'none' });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isAdminAccessDenied(error)) return json(res, 403, { error: 'admin_access_denied' });
    const business = sqlBusinessError(error);
    if (business) return json(res, business.status, business);
    console.error('POST /api/admin/import/preview failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
