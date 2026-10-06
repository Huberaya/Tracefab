import { createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { VercelRequest, VercelResponse } from '../../../_lib/vercel-types.js';
import { requireClerkUser, isUnauthorized } from '../../../_lib/auth.js';
import { withTracefabUserContext } from '../../../_lib/context.js';
import { isUuid } from '../../../_lib/products.js';
import { json, methodNotAllowed, readJsonBody } from '../../../_lib/http.js';
import { sqlBusinessError } from '../../../_lib/sql-errors.js';
import { manualInvitationFallbackAllowed, sendSupplierInvitationEmail } from '../../../_lib/email.js';
import { CATALOG_IMPORT_MAX_BYTES } from '../../../_lib/catalog-importer.js';
import { SUPPLIER_IMPORT_MAX_ROWS, validateSupplierCsv, type SupplierImportIssue, type SupplierImportRow } from '../../../_lib/supplier-importer.js';

type SupplierImportBody = {
  brandOrganizationId?: string;
  csvContent?: string;
  filename?: string;
  idempotencyKey?: string | null;
  dryRun?: boolean;
};

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

type PendingInvitation = {
  email: string;
  supplierName: string;
  token: string;
  expiresAt: Date;
};

function filename(value: unknown) {
  if (value === undefined || value === null || value === '') return 'suppliers.csv';
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 240) throw new Error('invalid_import_filename');
  return value.trim().replace(/[\\/\r\n]/g, '_');
}

function idempotencyKey(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) throw new Error('invalid_idempotency_key');
  return value.trim();
}

function serializeIssue(issue: SupplierImportIssue) {
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const { user } = await requireClerkUser(req);
    const body = await readJsonBody<SupplierImportBody>(req);
    if (!isUuid(body.brandOrganizationId)) return json(res, 400, { error: 'invalid_brand_organization_id' });
    if (typeof body.csvContent !== 'string' || !body.csvContent.length) return json(res, 400, { error: 'csv_content_required' });
    if (Buffer.byteLength(body.csvContent, 'utf8') > CATALOG_IMPORT_MAX_BYTES) return json(res, 413, { error: 'supplier_import_file_too_large', maxBytes: CATALOG_IMPORT_MAX_BYTES });
    const sourceFilename = filename(body.filename);
    const sourceIdempotencyKey = idempotencyKey(body.idempotencyKey);
    const sourceSha256 = createHash('sha256').update(body.csvContent, 'utf8').digest('hex');
    const validation = validateSupplierCsv(body.csvContent);

    const result = await withTracefabUserContext(user.id, user.email, async (tx) => {
      const memberships = await tx.organization_memberships.findMany({
        where: {
          user_id: user.id,
          status: 'active',
          role: { in: ['owner', 'admin', 'manager'] },
          organizations: { type: 'brand', status: 'active' },
        },
        select: { organization_id: true },
      });
      const organizationIds = memberships.map((membership) => membership.organization_id);
      if (!organizationIds.includes(body.brandOrganizationId!)) return null;
      const supplierEmails = validation.rows.map((row) => row.email);
      const existingInvitations = supplierEmails.length
        ? await tx.$queryRaw<Array<{ email: string }>>`
          SELECT lower(i.email) AS email
          FROM organization_invitations i
          JOIN brand_supplier_relationships r ON r.id = i.relationship_id
          WHERE r.brand_organization_id = ${body.brandOrganizationId!}::uuid
            AND lower(i.email) = ANY(${supplierEmails}::text[])
            AND i.accepted_at IS NULL
            AND i.expires_at > now()
        `
        : [];
      const existingEmails = new Set(existingInvitations.map((row) => row.email.toLowerCase()));
      const existingIssues: SupplierImportIssue[] = [];
      const importableRows = validation.rows.filter((row: SupplierImportRow) => {
        if (!existingEmails.has(row.email)) return true;
        existingIssues.push({ line: row.lineNumber, field: 'email', code: 'active_invitation_exists', message: `An active invitation already exists for ${row.email}.` });
        return false;
      });
      const errors = [...validation.issues, ...existingIssues].map(serializeIssue);
      const totalRows = validation.totalRows;
      const acceptedRows = importableRows.length;
      const rejectedRows = Math.max(0, totalRows - acceptedRows);
      const preview = { valid: errors.length === 0 && acceptedRows > 0, headers: validation.headers, totalRows, acceptedRows, rejectedRows, errors };
      if (body.dryRun) return { preview };

      if (sourceIdempotencyKey) {
        const replay = await tx.$queryRaw<ImportJob[]>`
          SELECT * FROM tracefab_catalog_import_jobs
          WHERE organization_id = ${body.brandOrganizationId!}::uuid AND idempotency_key = ${sourceIdempotencyKey}
          LIMIT 1
        `;
        if (replay[0]) return { job: jobPayload(replay[0], true), deliveries: [] as PendingInvitation[], brandName: '' };
      }

      const inserted = await tx.$queryRaw<ImportJob[]>`
        INSERT INTO tracefab_catalog_import_jobs (
          organization_id, actor_user_id, import_kind, source_filename, source_sha256,
          idempotency_key, status, total_rows, accepted_rows, rejected_rows, error_rows
        ) VALUES (
          ${body.brandOrganizationId!}::uuid, ${user.id}::uuid, 'suppliers', ${sourceFilename}, ${sourceSha256},
          ${sourceIdempotencyKey}, 'processing', ${totalRows}, 0, ${rejectedRows}, ${JSON.stringify(errors)}::jsonb
        )
        ON CONFLICT (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
        RETURNING *
      `;
      let job = inserted[0];
      if (!job && sourceIdempotencyKey) {
        const replay = await tx.$queryRaw<ImportJob[]>`
          SELECT * FROM tracefab_catalog_import_jobs
          WHERE organization_id = ${body.brandOrganizationId!}::uuid AND idempotency_key = ${sourceIdempotencyKey}
          LIMIT 1
        `;
        if (replay[0]) return { job: jobPayload(replay[0], true), deliveries: [] as PendingInvitation[], brandName: '' };
      }
      if (!job) throw new Error('supplier_import_job_creation_failed');

      const brand = await tx.organizations.findUnique({ where: { id: body.brandOrganizationId! }, select: { display_name: true, legal_name: true } });
      const brandName = brand?.display_name || brand?.legal_name || 'A Tracefab organization';
      const deliveries: PendingInvitation[] = [];
      for (const row of importableRows) {
        const token = randomBytes(32).toString('base64url');
        const tokenHash = createHash('sha256').update(token).digest('hex');
        const rows = await tx.$queryRaw<Array<{ expires_at: Date }>>`
          SELECT expires_at FROM tracefab_invite_supplier(
            ${body.brandOrganizationId!}::uuid, ${row.email}, ${row.legalName}, ${row.displayName}, ${row.countryCode}, ${tokenHash}
          )
        `;
        if (!rows[0]) throw new Error('supplier_invitation_creation_failed');
        deliveries.push({ email: row.email, supplierName: row.displayName || row.legalName, token, expiresAt: rows[0].expires_at });
      }

      const status = acceptedRows === 0 ? 'rejected' : rejectedRows > 0 ? 'completed_with_errors' : 'completed';
      const updated = await tx.$queryRaw<ImportJob[]>`
        UPDATE tracefab_catalog_import_jobs
        SET status = ${status}, accepted_rows = ${acceptedRows}, rejected_rows = ${rejectedRows}, error_rows = ${JSON.stringify(errors)}::jsonb, completed_at = now()
        WHERE id = ${job.id}::uuid
        RETURNING *
      `;
      await tx.$executeRaw`
        INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
        VALUES (${body.brandOrganizationId!}::uuid, ${user.id}::uuid, 'supplier_bulk_import_completed', 'catalog_import_job', ${job.id}::uuid,
          ${JSON.stringify({ sourceSha256, filename: sourceFilename, totalRows, acceptedRows, rejectedRows })}::jsonb)
      `;
      return { job: jobPayload(updated[0] ?? job), deliveries, brandName };
    });

    if (!result) return json(res, 403, { error: 'brand_organization_access_denied' });
    if ('preview' in result) return json(res, 200, result.preview);
    if (result.job.replay) return json(res, 202, { job: result.job, delivery: { status: 'replayed' } });

    let sent = 0; let pending = 0; let failed = 0;
    for (const invitation of result.deliveries) {
      const delivery = await sendSupplierInvitationEmail({ to: invitation.email, supplierName: invitation.supplierName, brandName: result.brandName, invitationToken: invitation.token, expiresAt: invitation.expiresAt });
      if (delivery.status === 'sent') sent += 1;
      else if (delivery.status === 'not_configured' && manualInvitationFallbackAllowed()) pending += 1;
      else failed += 1;
    }
    return json(res, 202, { job: result.job, delivery: { sent, pending, failed, total: result.deliveries.length } });
  } catch (error) {
    if (isUnauthorized(error)) return json(res, 401, { error: 'unauthorized' });
    const businessError = sqlBusinessError(error);
    if (businessError) return json(res, businessError.status, { error: businessError.error });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return json(res, 409, { error: 'active_supplier_invitation_exists' });
    if (error instanceof Error && /^(invalid_|supplier_)/.test(error.message)) return json(res, 400, { error: error.message });
    if (error instanceof Error && error.message === 'missing_clerk_secret_key') return json(res, 503, { error: 'clerk_not_configured' });
    console.error('POST /api/catalog/suppliers/import failed', error);
    return json(res, 500, { error: 'internal_server_error' });
  }
}
