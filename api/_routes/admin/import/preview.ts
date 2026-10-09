import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { isUnauthorized } from '../../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { readImportPayload, importPayloadStatus } from '../../../_lib/import-payload.js';
import { buildImportPreview } from '../../../_lib/crm-import.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';

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

    /*
     * §8 — CSV ou Excel. La même fonction sert ici et à /commit : accepter un
     * classeur à l'aperçu puis le refuser à l'import serait le pire des
     * comportements. La détection se fait sur le contenu, pas sur le nom.
     */
    const payload = readImportPayload(body);
    if (payload.status === 'error') {
      return json(res, importPayloadStatus(payload.error), {
        error: payload.error,
        ...(payload.detail ? { detail: payload.detail } : {}),
        ...(payload.error === 'import_file_has_no_data_rows'
          ? { details: ['headers_and_at_least_one_row_required'] } : {}),
      });
    }

    const source = typeof body.source === 'string' ? body.source.trim() : '';
    if (!source) return json(res, 422, { error: 'crm_import_source_required' });

    const records = payload.records as Array<Record<string, unknown>>;

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

    return json(res, 200, { preview, writes: 'none', format: payload.format });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isAdminAccessDenied(error)) return json(res, 403, { error: 'admin_access_denied' });
    const business = sqlBusinessError(error);
    if (business) return json(res, business.status, business);
    console.error('POST /api/admin/import/preview failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
