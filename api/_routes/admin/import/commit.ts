import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { json, methodNotAllowed } from '../../../_lib/http.js';
import { isUnauthorized } from '../../../_lib/auth.js';
import { isAdminAccessDenied, requirePlatformAdmin } from '../../../_lib/admin-access.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { parseCsvRows } from '../../../_lib/bulk-operations/csv-parser.js';
import { buildImportPreview } from '../../../_lib/crm-import.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { auditAdmin } from '../../../_lib/crm-audit-write.js';

const MAX_CSV_BYTES = 2 * 1024 * 1024;
const MAX_ROWS_PER_IMPORT = 2000;

/**
 * POST /api/admin/import/commit
 *
 * Écrit. Rejoue exactement le même calcul que /preview : l'aperçu et l'écriture
 * ne peuvent pas diverger, parce qu'ils appellent la même fonction.
 *
 * `duplicates` :
 *   - `skip`  (défaut) — les doublons ne sont pas créés, le reste l'est ;
 *   - `abort`          — aucun doublon toléré : rien n'est écrit, 409.
 *
 * Les lignes invalides ne sont jamais écrites et ne sont jamais « réparées » :
 * deviner la valeur d'un champ illisible serait inventer une donnée.
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

    const onDuplicate = body.duplicates === 'abort' ? 'abort' : 'skip';

    const records = parseCsvRows(csv) as Array<Record<string, unknown>>;
    if (!records.length) {
      return json(res, 422, { error: 'csv_has_no_data_rows', details: ['headers_and_at_least_one_row_required'] });
    }
    if (records.length > MAX_ROWS_PER_IMPORT) {
      return json(res, 413, { error: 'crm_import_file_too_large', limit: MAX_ROWS_PER_IMPORT });
    }

    const mapping = body.mapping && typeof body.mapping === 'object'
      ? (body.mapping as Record<string, string | null>)
      : {};

    const result = (await withTracefabUserContext(admin.userId, admin.userEmail, async (tx) => {
      const existing = (await tx.crm_companies.findMany({
        where: { platform_organization_id: admin.platformOrganizationId },
        select: { id: true, name: true, country_code: true, website: true },
      })) as never;

      const preview = buildImportPreview(records, {
        source,
        sourceDetail: typeof body.source_detail === 'string' ? body.source_detail.trim() || null : null,
        collectedAt: typeof body.collected_at === 'string' ? body.collected_at : null,
        mapping,
        existing,
        skipDuplicates: true,
      });

      if (onDuplicate === 'abort' && preview.counts.duplicate > 0) {
        return { aborted: true as const, preview };
      }

      const created: unknown[] = [];
      for (const row of preview.rows) {
        if (row.status !== 'new' || !row.data) continue;
        const inserted = await tx.crm_companies.create({
          data: {
            ...row.data,
            platform_organization_id: admin.platformOrganizationId,
            owner_name: (row.data.owner_name as string) || admin.fullName,
            owner_user_id: admin.userId,
          } as never,
        });
        created.push(inserted);
      }

      /* Chaque entreprise importée laisse une trace dans sa propre timeline :
         un portefeuille dont on ne sait pas quand il est entré n'est pas auditable. */
      for (const row of preview.rows) {
        if (row.status !== 'new' || !row.data) continue;
        const company = created.find(
          (c) => (c as { name?: string }).name === row.data?.name,
        ) as { id?: string } | undefined;
        if (!company?.id) continue;
        await tx.crm_activities.create({
          data: {
            company_id: company.id,
            platform_organization_id: admin.platformOrganizationId,
            type: 'created',
            summary: `Imported from ${source}`,
            detail: preview.counts.total > 1
              ? `Fichier de ${preview.counts.total} lignes — ${preview.counts.new} créées, ${preview.counts.duplicate} doublons, ${preview.counts.invalid} invalides`
              : null,
            actor_user_id: admin.userId,
            actor_name: admin.fullName,
            occurred_at: new Date(),
          } as never,
        });
      }

      await auditAdmin(tx as never, {
        admin,
        entity: 'crm_import',
        action: 'imported',
        entityId: null,
        /* L'import est journalisé comme UN acte, pas comme N créations : chaque
           entreprise créée porte déjà sa provenance dans `source` et sa propre
           activité `created`. Doubler l'écriture noierait la chaîne. */
        metadata: {
          source,
          total: preview.counts.total,
          created: created.length,
          duplicate: preview.counts.duplicate,
          invalid: preview.counts.invalid,
        },
      });

      return { aborted: false as const, preview, createdCount: created.length };
    })) as unknown as {
      aborted: boolean;
      preview: { counts: Record<string, number>; mapping: Record<string, string | null> };
      createdCount?: number;
    };

    if (result.aborted) {
      return json(res, 409, {
        error: 'crm_company_duplicate',
        details: ['duplicates_present_and_policy_is_abort'],
        counts: result.preview.counts,
      });
    }

    return json(res, 201, {
      counts: result.preview.counts,
      created: result.createdCount ?? 0,
      mapping: result.preview.mapping,
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (isAdminAccessDenied(error)) return json(res, 403, { error: 'admin_access_denied' });
    const business = sqlBusinessError(error);
    if (business) return json(res, business.status, business);
    console.error('POST /api/admin/import/commit failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
