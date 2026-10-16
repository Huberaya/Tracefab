import type { Prisma } from '@prisma/client';
import { downloadObject, headObject, MAX_DOCUMENT_BYTES, presignedDownload, scanWithAntivirus } from './storage.js';

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

const SERVER_OWNED_METADATA_KEYS = new Set([
  'security_scan',
  'scan_passed',
  'sha256',
  'antivirus',
  'isencryptedatrest',
]);

function clientVisibleMetadata(value: Prisma.JsonValue) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SERVER_OWNED_METADATA_KEYS.has(key.toLowerCase())));
}

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
    metadata: clientVisibleMetadata(document.metadata),
    availableAt: document.available_at,
    deletedAt: document.deleted_at,
    updatedAt: document.updated_at,
  };
}

export const ALLOWED_DOCUMENT_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'text/plain']);
export const DOCUMENT_KINDS = new Set(['certificate', 'technical_spec', 'origin_proof', 'audit_report', 'invoice', 'other']);

export function documentAntivirusSummary(document: Pick<DocumentRecord, 'status' | 'available_at'>) {
  return {
    clean: document.status === 'available',
    status: document.status === 'available' ? 'clean' : document.status === 'rejected' ? 'quarantined' : 'pending',
    protocol: 'tracefab-v1',
    engine: null,
    verifiedAt: document.status === 'available' ? document.available_at : null,
  };
}

export async function presignedDownloadForDocument(document: DocumentRecord) {
  if (document.status !== 'available') throw new Error('document_not_available');
  const object = await headObject(document.storage_path);
  if (object.byteSize !== Number(document.byte_size) || object.contentType !== document.content_type) {
    throw new Error('document_storage_integrity_mismatch');
  }
  return presignedDownload(document.storage_path);
}

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
  if (Object.keys(metadata).some((key) => SERVER_OWNED_METADATA_KEYS.has(key.toLowerCase()))) {
    throw new Error('invalid_document_metadata_reserved_key');
  }
  return { originalFilename: body.originalFilename.trim(), contentType: body.contentType.trim().toLowerCase(), byteSize, kind, expiresAt, metadata };
}

export type DocumentScanOutcome = {
  sha256: string | null;
  scanPassed: boolean;
  actualByteSize: number;
};

/**
 * Commit the scanning state before making network calls. The caller must first
 * check the tenant and scan role in this same short transaction. The storage
 * provider and antivirus service are never contacted while a DB transaction
 * (or row lock) is held.
 */
export async function markDocumentScanning(tx: Prisma.TransactionClient, documentId: string) {
  await tx.$executeRaw`SELECT set_config('tracefab.internal_document_update', 'true', true)`;
  try {
    const updated = await tx.$executeRaw`
      UPDATE documents
      SET status = 'scanning'::document_status
      WHERE id = ${documentId}::uuid
        AND status IN ('uploaded'::document_status, 'scanning'::document_status)
    `;
    return updated === 1;
  } finally {
    try {
      await tx.$executeRaw`SELECT set_config('tracefab.internal_document_update', 'false', true)`;
    } catch {
      // An aborted transaction is rolled back by the caller; preserve its error.
    }
  }
}

/** Perform only storage/scanner I/O; this function deliberately accepts no DB transaction. */
export async function scanDocumentStorage(
  document: Pick<DocumentRecord, 'status' | 'storage_path' | 'byte_size' | 'content_type' | 'original_filename'>,
): Promise<DocumentScanOutcome> {
  if (document.status === 'deleted') throw new Error('document_deleted');

  const object = await headObject(document.storage_path);
  if (object.byteSize > MAX_DOCUMENT_BYTES || object.byteSize !== Number(document.byte_size)) {
    // Record the actual S3 size and reject the object. This both prevents
    // approval and makes quota accounting reflect bytes already stored.
    return { sha256: null, scanPassed: false, actualByteSize: object.byteSize };
  }
  if (object.contentType !== document.content_type) {
    return { sha256: null, scanPassed: false, actualByteSize: object.byteSize };
  }
  const bytes = await downloadObject(document.storage_path);
  if (bytes.byteLength !== object.byteSize) {
    return { sha256: null, scanPassed: false, actualByteSize: bytes.byteLength };
  }
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update(Buffer.from(bytes) as unknown as Uint8Array<ArrayBuffer>).digest('hex');
  const scan = await scanWithAntivirus(bytes, document.original_filename, document.content_type);
  if (scan.clean && scan.mimeType !== document.content_type) {
    return { sha256, scanPassed: false, actualByteSize: object.byteSize };
  }
  return { sha256, scanPassed: scan.clean, actualByteSize: object.byteSize };
}

/** Finalize in a short tenant-scoped transaction only after a definitive scanner result. */
export async function finalizeDocumentUpload(
  tx: Prisma.TransactionClient,
  documentId: string,
  outcome: DocumentScanOutcome,
) {
  const rows = await tx.$queryRaw<DocumentRecord[]>`
    SELECT * FROM tracefab_finalize_document_upload(
      ${documentId}::uuid,
      ${outcome.sha256},
      ${outcome.scanPassed},
      ${outcome.actualByteSize}
    )
  `;
  if (!rows[0]) throw new Error('document_finalization_failed');
  return rows[0];
}
