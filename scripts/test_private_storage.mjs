import { readFile } from 'node:fs/promises';

const files = Object.fromEntries(await Promise.all([
  ['storage', 'api/_lib/storage.ts'],
  ['documents', 'api/_lib/documents.ts'],
  ['scanner', 'api/_lib/cloud-storage/antivirus-scanner.ts'],
  ['readiness', 'api/_lib/readiness-probes.ts'],
  ['quota', 'api/_lib/cloud-storage/quota-manager.ts'],
  ['securityReport', 'api/_routes/documents/[documentId]/security-report.ts'],
  ['finalizerMigration', 'prisma/migrations/20261016120000_harden_document_finalization/migration.sql'],
  ['runtimeTest', 'scripts/test_private_storage_runtime.ts'],
  ['uploadIntent', 'api/_routes/supplier/documents/upload-intent.ts'],
  ['genericScan', 'api/_routes/documents/[documentId]/scan.ts'],
  ['scan', 'api/_routes/supplier/documents/[documentId]/scan.ts'],
  ['router', 'api/index.ts'],
  ['supplierDownload', 'api/_routes/supplier/documents/[documentId]/download.ts'],
  ['genericDownload', 'api/_routes/documents/[documentId]/download.ts'],
  ['response', 'api/_routes/data-request-items/[itemId]/response.ts'],
  ['certifications', 'api/_routes/supplier/certifications.ts'],
].map(async ([key, path]) => [key, await readFile(path, 'utf8')])));

const assert = (condition, message) => { if (!condition) throw new Error(message); };

assert(files.storage.includes("const PRIVATE_STORAGE_BUCKET = 'tracefab-private'"), 'Private bucket must be fixed');
assert(files.storage.includes('private_storage_not_configured'), 'Missing antivirus configuration must block scanning');
assert(files.storage.includes('X-Tracefab-Scan-Protocol'), 'Antivirus protocol header is missing');
assert(files.storage.includes("'If-None-Match': '*'"), 'PUT must be conditional to prevent object replacement');
assert(files.storage.includes('content-type;host;if-none-match'), 'Conditional PUT headers must be signed');
assert(files.storage.includes('MAX_DOCUMENT_BYTES = 50 * 1024 * 1024'), 'Server document limit is missing');
assert(files.storage.includes('storageObjectKey(ownerOrganizationId'), 'Tenant-scoped object key helper is missing');
assert(files.documents.includes("createHash('sha256')"), 'Server SHA-256 calculation is missing');
assert(files.documents.includes('presignedDownloadForDocument'), 'Downloads must verify the stored object before signing');
assert(files.documents.includes('invalid_document_metadata_reserved_key'), 'Client cannot supply server-owned scan metadata');
assert(files.documents.includes('markDocumentScanning'), 'Scan state must be committed before remote I/O for retryability');
assert(files.documents.includes('scanDocumentStorage'), 'Real S3 bytes and scanner verdict must be evaluated');
assert(files.documents.includes('finalizeDocumentUpload'), 'Scan verdict must pass through the SQL finalizer');
assert(!files.uploadIntent.includes('body.sha256'), 'Upload intent must not accept a browser-provided hash');
assert(files.uploadIntent.includes('tracefab_register_document'), 'Upload intent must register a document in SQL');
assert(files.scan.includes('scanDocumentStorage'), 'Supplier scan route must call storage/scanner outside a DB transaction');
assert(files.scan.includes('finalizeDocumentUpload'), 'Supplier scan route must use server-side SQL finalization');
assert(files.genericScan.includes('tracefab_has_org_role'), 'Generic brand document scan must verify the owner tenant role');
assert(files.genericScan.includes('scanDocumentStorage'), 'Generic scan route must call storage/scanner outside a DB transaction');
assert(files.genericScan.includes('finalizeDocumentUpload'), 'Generic scan route must use server-side SQL finalization');
for (const [label, source] of [['supplier', files.scan], ['generic', files.genericScan]]) {
  const claim = source.indexOf('const claim = await withTracefabUserContext');
  const markScanning = source.indexOf('markDocumentScanning(tx,', claim);
  const remoteIo = source.indexOf('const outcome = await scanDocumentStorage');
  const finalizer = source.indexOf('const document = await withTracefabUserContext', remoteIo);
  assert(claim >= 0 && markScanning > claim && remoteIo > markScanning, `${label} scan state must be committed before storage/scanner I/O`);
  assert(remoteIo >= 0 && finalizer > remoteIo, `${label} scanner I/O must finish before the finalization transaction starts`);
}
assert(files.router.includes("documents\\/([^\\/]+)\\/scan"), 'Generic scan route must be registered');
assert(files.genericScan.includes('logStorageFailure'), 'Generic scan errors must be logged without raw exception details');
assert(files.supplierDownload.includes("status: 'available'"), 'Supplier downloads must require available status');
assert(files.genericDownload.includes('withTracefabUserContext'), 'Generic downloads must use SQL access context');
for (const [label, source] of [['supplier', files.supplierDownload], ['generic', files.genericDownload]]) {
  const transaction = source.indexOf('await withTracefabUserContext(');
  const storageHead = source.indexOf('const download = await presignedDownloadForDocument(document)');
  assert(transaction >= 0 && storageHead > transaction && source.slice(transaction, storageHead).includes('S3 HEAD verification is deliberately outside'), `${label} download must perform external storage I/O after the authorization transaction closes`);
}
assert(files.readiness.includes("scanWithAntivirus(bytes, 'tracefab-readiness-probe.pdf'"), 'Readiness must exercise the scanner POST protocol');
assert(files.readiness.includes('Promise.race([operation, timeout])'), 'The configured readiness-wide deadline must bound all live probes');
assert(files.runtimeTest.includes('boundedReadiness'), 'Behavioral tests must exercise the readiness-wide scanner deadline');
const antivirusProbeSource = files.readiness.slice(files.readiness.indexOf('export function probeAntivirus'), files.readiness.indexOf('export function probeEmail'));
assert(!antivirusProbeSource.includes('reachableByHttp'), 'Readiness must not treat scanner HEAD as scan validation');
assert(files.quota.includes('pg_advisory_xact_lock'), 'Quota checks must serialize concurrent upload intents');
assert(files.quota.includes('tracefab_get_document_storage_usage'), 'Quota reads must use the tenant-checked aggregate function');
assert(files.finalizerMigration.includes('SET row_security = off'), 'Aggregate function must fail closed rather than silently undercount rows hidden by RLS');
assert(files.finalizerMigration.includes('REVOKE ALL ON FUNCTION tracefab_get_document_storage_usage(UUID) FROM PUBLIC'), 'Quota aggregate must not be executable by PUBLIC');
assert(!files.quota.includes("status NOT IN ('deleted', 'rejected')"), 'Quota must include stored rejected and soft-deleted objects');
assert(!files.securityReport.includes('meta.security_scan'), 'Security report must not trust uploader-provided scan claims');
assert(files.securityReport.includes('isEncryptedAtRest: null'), 'Security report must not claim unverified at-rest encryption');
assert(files.finalizerMigration.includes('tracefab_has_org_role'), 'SQL finalizer must enforce the document tenant role');
assert(files.finalizerMigration.includes('document_size_mismatch'), 'SQL finalizer must enforce declared versus actual size');
assert(files.scanner.includes('External scanner (tracefab-v1'), 'External scanner pipeline must be explicit');
assert(!files.scanner.includes('otherwise executes deep heuristic'), 'Heuristic analysis must not be a clean-scan fallback');
assert(files.runtimeTest.includes('local in-memory S3/scanner HTTP doubles'), 'Behavioral suite must label its local service doubles');
assert(files.response.includes("status: 'available'"), 'Response evidence must require an available document');
assert(files.certifications.includes("status: 'available'"), 'Certification evidence must require an available document');
console.log('Private storage static contract passed; behavioral local-double suite follows in test:private-storage.');
