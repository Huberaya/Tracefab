import type { Prisma } from '@prisma/client';
import { downloadObject, headObject, MAX_DOCUMENT_BYTES, scanWithAntivirus } from './storage.js';

export const DOCUMENT_SELECT = {
  id: true,
  owner_organization_id: true,
  storage_bucket: true,
  storage_path: true,
  original_filename: true,
  content_type: true,
  byte_size: true,
  sha256: true,
  kind: true,
  status: true,
  visibility: true,
  expires_at: true,
  uploaded_by: true,
  created_at: true,
  metadata: true,
  available_at: true,
  deleted_at: true,
  updated_at: true,
} satisfies Prisma.documentsSelect;

export type DocumentRecord = Prisma.documentsGetPayload<{ select: typeof DOCUMENT_SELECT }>;

export function serializeDocument(document: DocumentRecord) {
  return {
    id: document.id,
    ownerOrganizationId: document.owner_organization_id,
    storageBucket: document.storage_bucket,
    originalFilename: document.original_filename,
    contentType: document.content_type,
    byteSize: Number(document.byte_size),
    sha256: document.sha256,
    kind: document.kind,
    status: document.status,
    visibility: document.visibility,
    expiresAt: document.expires_at,
    uploadedBy: document.uploaded_by,
    createdAt: document.created_at,
    metadata: document.metadata,
    availableAt: document.available_at,
    deletedAt: document.deleted_at,
    updatedAt: document.updated_at,
  };
}

export const ALLOWED_DOCUMENT_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'text/plain']);
export const DOCUMENT_KINDS = new Set(['certificate', 'technical_spec', 'origin_proof', 'audit_report', 'invoice', 'other']);

export function documentMetadata(body: Record<string, unknown>) {
  const allowedKeys = new Set(['originalFilename', 'contentType', 'byteSize', 'kind', 'expiresAt', 'metadata']);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) throw new Error('invalid_document_fields');
  if (typeof body.originalFilename !== 'string' || body.originalFilename.trim().length === 0 || body.originalFilename.length > 240) throw new Error('invalid_document_filename');
  if (typeof body.contentType !== 'string' || !ALLOWED_DOCUMENT_TYPES.has(body.contentType.trim().toLowerCase())) throw new Error('document_content_type_not_allowed');
  const byteSize = typeof body.byteSize === 'number' ? body.byteSize : Number(body.byteSize);
  if (!Number.isInteger(byteSize) || byteSize <= 0 || byteSize > MAX_DOCUMENT_BYTES) throw new Error('document_size_limit_exceeded');
  const kind = typeof body.kind === 'string' && DOCUMENT_KINDS.has(body.kind) ? body.kind : null;
  if (!kind) throw new Error('invalid_document_kind');
  let expiresAt: string | null = null;
  if (body.expiresAt !== undefined && body.expiresAt !== null && body.expiresAt !== '') {
    if (typeof body.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.expiresAt) || Number.isNaN(Date.parse(`${body.expiresAt}T00:00:00Z`))) throw new Error('invalid_document_expiry');
    expiresAt = body.expiresAt;
  }
  const metadata = body.metadata === undefined || body.metadata === null ? {} : body.metadata;
  if (typeof metadata !== 'object' || Array.isArray(metadata) || JSON.stringify(metadata).length > 10000) throw new Error('invalid_document_metadata');
  return { originalFilename: body.originalFilename.trim(), contentType: body.contentType.trim().toLowerCase(), byteSize, kind, expiresAt, metadata };
}

export async function scanAndFinalizeDocument(
  tx: Prisma.TransactionClient,
  document: DocumentRecord,
) {
  if (document.status === 'deleted') throw new Error('document_deleted');
  await tx.$executeRaw`SELECT set_config('tracefab.internal_document_update', 'true', true)`;
  await tx.$executeRaw`UPDATE documents SET status = 'scanning'::document_status WHERE id = ${document.id}::uuid`;
  await tx.$executeRaw`SELECT set_config('tracefab.internal_document_update', 'false', true)`;
  const object = await headObject(document.storage_path);
  if (!object.byteSize || object.byteSize > MAX_DOCUMENT_BYTES) throw new Error('document_size_limit_exceeded');
  if (object.byteSize !== Number(document.byte_size)) throw new Error('document_size_mismatch');
  if (object.contentType && object.contentType !== document.content_type) throw new Error('document_content_type_mismatch');
  const bytes = await downloadObject(document.storage_path);
  if (bytes.byteLength !== object.byteSize) throw new Error('document_size_mismatch');
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update(Buffer.from(bytes) as unknown as Uint8Array<ArrayBuffer>).digest('hex');
  const scan = await scanWithAntivirus(bytes, document.original_filename, document.content_type);
  if (scan.mimeType && scan.mimeType !== document.content_type) throw new Error('document_content_type_mismatch');
  const rows = await tx.$queryRaw<DocumentRecord[]>`
    SELECT * FROM tracefab_finalize_document_upload(
      ${document.id}::uuid,
      ${sha256},
      ${scan.clean},
      ${object.byteSize}
    )
  `;
  if (!rows[0]) throw new Error('document_finalization_failed');
  return rows[0];
}
