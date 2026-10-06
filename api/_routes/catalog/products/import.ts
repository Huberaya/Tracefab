import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { activeBrandOrganizationIds, isUuid } from '../../../_lib/products.js';
import { json, methodNotAllowed, readJsonBody } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import {
  CATALOG_IMPORT_MAX_BYTES,
  CATALOG_IMPORT_MAX_ROWS,
  validateCatalogProductCsv,
  type CatalogImportIssue,
  type CatalogProductImportRow,
} from '../../../_lib/catalog-importer.js';

type CatalogImportBody = {
  brandOrganizationId?: string;
  csvContent?: string;
  filename?: string;
  idempotencyKey?: string | null;
  dryRun?: boolean;
};

type ImportJob = {
  id: string;
  organization_id: string;
  actor_user_id: string;
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

function cleanFilename(value: unknown) {
  if (value === undefined || value === null || value === '') return 'catalog.csv';
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 240) throw new Error('invalid_import_filename');
  return value.trim().replace(/[\\/\r\n]/g, '_');
}

function cleanIdempotencyKey(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 200) throw new Error('invalid_idempotency_key');
  return value.trim();
}

function serializeIssue(issue: CatalogImportIssue) {
  return { line: issue.line, field: issue.field ?? null, code: issue.code, message: issue.message };
}

function jobPayload(job: ImportJob, replay = false) {
  return {
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
    replay,
  };
}

async function loadExistingReferences(tx: Prisma.TransactionClient, organizationId: string, rows: CatalogProductImportRow[]) {
  if (rows.length === 0) return new Set<string>();
  const existing = await tx.tracefab_products.findMany({
    where: { brand_organization_id: organizationId, reference: { in: rows.map((row) => row.reference) } },
    select: { reference: true },
  });
  return new Set(existing.map((row) => row.reference.toLocaleLowerCase()));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  try {
    const { user } = await requireClerkUser(req);
    const body = await readJsonBody<CatalogImportBody>(req);
    if (!isUuid(body.brandOrganizationId)) return json(res, 400, { error: 'invalid_brand_organization_id' });
    if (typeof body.csvContent !== 'string' || body.csvContent.length === 0) return json(res, 400, { error: 'csv_content_required' });
    if (Buffer.byteLength(body.csvContent, 'utf8') > CATALOG_IMPORT_MAX_BYTES) return json(res, 413, { error: 'catalog_import_file_too_large', maxBytes: CATALOG_IMPORT_MAX_BYTES });

    const filename = cleanFilename(body.filename);
    const idempotencyKey = cleanIdempotencyKey(body.idempotencyKey);
    const sourceSha256 = createHash('sha256').update(body.csvContent, 'utf8').digest('hex');
    const validation = validateCatalogProductCsv(body.csvContent);

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const organizationIds = await activeBrandOrganizationIds(tx, user.id);
      if (!organizationIds.includes(body.brandOrganizationId!)) return null;

      const existingReferences = await loadExistingReferences(tx, body.brandOrganizationId!, validation.rows);
      const duplicateIssues: CatalogImportIssue[] = [];
      const importableRows = validation.rows.filter((row) => {
        if (!existingReferences.has(row.reference.toLocaleLowerCase())) return true;
        duplicateIssues.push({ line: row.lineNumber, field: 'reference', code: 'reference_already_exists', message: `A product with reference ${row.reference} already exists in this catalogue.` });
        return false;
      });
      const allIssues = [...validation.issues, ...duplicateIssues].map(serializeIssue);
      const totalRows = validation.totalRows;
      const acceptedRows = importableRows.length;
      const rejectedRows = Math.max(0, totalRows - acceptedRows);
      const preview = {
        valid: allIssues.length === 0 && acceptedRows > 0,
        headers: validation.headers,
        totalRows,
        acceptedRows,
        rejectedRows,
        errors: allIssues,
        warnings: validation.warnings.map(serializeIssue),
      };

      if (body.dryRun) return { preview };
      if (idempotencyKey) {
        const replay = await tx.$queryRaw<ImportJob[]>`
          SELECT * FROM tracefab_catalog_import_jobs
          WHERE organization_id = ${body.brandOrganizationId!}::uuid
            AND idempotency_key = ${idempotencyKey}
          LIMIT 1
        `;
        if (replay[0]) return { job: jobPayload(replay[0], true) };
      }

      const inserted = await tx.$queryRaw<ImportJob[]>`
        INSERT INTO tracefab_catalog_import_jobs (
          organization_id, actor_user_id, import_kind, source_filename, source_sha256,
          idempotency_key, status, total_rows, accepted_rows, rejected_rows, error_rows
        ) VALUES (
          ${body.brandOrganizationId!}::uuid, ${user.id}::uuid, 'products', ${filename}, ${sourceSha256},
          ${idempotencyKey}, 'processing', ${totalRows}, 0, ${rejectedRows}, ${JSON.stringify(allIssues)}::jsonb
        )
        ON CONFLICT (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
        RETURNING *
      `;
      let job = inserted[0];
      if (!job && idempotencyKey) {
        const replay = await tx.$queryRaw<ImportJob[]>`
          SELECT * FROM tracefab_catalog_import_jobs
          WHERE organization_id = ${body.brandOrganizationId!}::uuid
            AND idempotency_key = ${idempotencyKey}
          LIMIT 1
        `;
        if (replay[0]) return { job: jobPayload(replay[0], true) };
      }
      if (!job) throw new Error('catalog_import_job_creation_failed');

      for (const row of importableRows) {
        const created = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM tracefab_create_product(
            ${body.brandOrganizationId!}::uuid,
            ${row.reference}, ${row.name}, ${row.category}, ${row.sku}
          )
        `;
        const productId = created[0]?.id;
        if (!productId) throw new Error('catalog_import_product_creation_failed');
        await tx.$queryRaw`
          SELECT id FROM tracefab_update_product_data(
            ${productId}::uuid,
            ${row.reference}, ${row.sku}, ${row.name}, ${row.category}, ${row.description},
            ${row.productFamily}, ${row.colorName}, ${row.sizeRange}::text[],
            ${row.countryOfDesign}, ${row.countryOfManufacture}, ${row.weightGrams},
            ${JSON.stringify(row.careInstructions)}::jsonb
          )
        `;
      }

      const status = acceptedRows === 0 ? 'rejected' : rejectedRows > 0 ? 'completed_with_errors' : 'completed';
      const updated = await tx.$queryRaw<ImportJob[]>`
        UPDATE tracefab_catalog_import_jobs
        SET status = ${status}, accepted_rows = ${acceptedRows}, rejected_rows = ${rejectedRows},
            error_rows = ${JSON.stringify(allIssues)}::jsonb, completed_at = now()
        WHERE id = ${job.id}::uuid
        RETURNING *
      `;
      await tx.$executeRaw`
        INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
        VALUES (
          ${body.brandOrganizationId!}::uuid, ${user.id}::uuid, 'catalog_import_completed',
          'catalog_import_job', ${job.id}::uuid,
          ${JSON.stringify({ sourceSha256, filename, totalRows, acceptedRows, rejectedRows })}::jsonb
        )
      `;
      return { job: jobPayload(updated[0] ?? job) };
    });

    if (!result) return json(res, 403, { error: 'brand_organization_access_denied' });
    if ('preview' in result) return json(res, 200, result.preview);
    return json(res, 202, { job: result.job });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Error && /^(invalid_|catalog_import_)/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('POST /api/catalog/products/import failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
