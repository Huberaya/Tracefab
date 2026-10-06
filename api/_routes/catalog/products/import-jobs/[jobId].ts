import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireClerkUser, isUnauthorized } from '../../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../../_lib/context.js';
import { activeBrandOrganizationIds, isUuid } from '../../../../_lib/products.js';
import { json, methodNotAllowed } from '../../../../_lib/http.js';

type ImportJob = {
  id: string;
  organization_id: string;
  import_kind: string;
  source_filename: string;
  source_sha256: string;
  idempotency_key: string | null;
  status: string;
  total_rows: number;
  accepted_rows: number;
  rejected_rows: number;
  error_rows: unknown;
  created_at: Date;
  completed_at: Date | null;
};

function routeJobId(req: VercelRequest) {
  const value = req.query.jobId;
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const jobId = routeJobId(req);
    if (!isUuid(jobId)) return json(res, 400, { error: 'invalid_import_job_id' });
    const { user } = await requireClerkUser(req);
    const job = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const organizationIds = await activeBrandOrganizationIds(tx, user.id);
      const rows = await tx.$queryRaw<ImportJob[]>`
        SELECT id, organization_id, import_kind, source_filename, source_sha256, idempotency_key,
               status, total_rows, accepted_rows, rejected_rows, error_rows, created_at, completed_at
        FROM tracefab_catalog_import_jobs
        WHERE id = ${jobId}::uuid
          AND organization_id = ANY(${organizationIds}::uuid[])
        LIMIT 1
      `;
      return rows[0] ?? null;
    });
    if (!job) return json(res, 404, { error: 'catalog_import_job_not_found' });
    return json(res, 200, {
      job: {
        id: job.id,
        organizationId: job.organization_id,
        importKind: job.import_kind,
        sourceFilename: job.source_filename,
        sourceSha256: job.source_sha256,
        idempotencyKey: job.idempotency_key,
        status: job.status,
        totalRows: job.total_rows,
        acceptedRows: job.accepted_rows,
        rejectedRows: job.rejected_rows,
        errors: Array.isArray(job.error_rows) ? job.error_rows : [],
        createdAt: job.created_at,
        completedAt: job.completed_at,
      },
    });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('GET /api/catalog/products/import-jobs/:jobId failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
