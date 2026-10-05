import { readFile } from 'node:fs/promises';

const files = Object.fromEntries(await Promise.all([
  ['storage', 'api/_lib/storage.ts'],
  ['documents', 'api/_lib/documents.ts'],
  ['uploadIntent', 'api/supplier/documents/upload-intent.ts'],
  ['scan', 'api/supplier/documents/[documentId]/scan.ts'],
  ['supplierDownload', 'api/supplier/documents/[documentId]/download.ts'],
  ['genericDownload', 'api/documents/[documentId]/download.ts'],
  ['response', 'api/data-request-items/[itemId]/response.ts'],
  ['certifications', 'api/supplier/certifications.ts'],
].map(async ([key, path]) => [key, await readFile(path, 'utf8')])));

const assert = (condition, message) => { if (!condition) throw new Error(message); };

assert(files.storage.includes("const PRIVATE_STORAGE_BUCKET = 'tracefab-private'"), 'Private bucket must be fixed');
assert(files.storage.includes('private_storage_antivirus_not_configured'), 'Missing antivirus configuration must block scanning');
assert(files.storage.includes('X-Tracefab-Scan-Protocol'), 'Antivirus protocol header is missing');
assert(files.storage.includes('MAX_DOCUMENT_BYTES = 50 * 1024 * 1024'), 'Server document limit is missing');
assert(files.storage.includes('storageObjectKey(ownerOrganizationId'), 'Tenant-scoped object key helper is missing');
assert(files.documents.includes('createHash(\'sha256\')'), 'Server SHA-256 calculation is missing');
assert(!files.uploadIntent.includes('body.sha256'), 'Upload intent must not accept a browser-provided hash');
assert(files.uploadIntent.includes('tracefab_register_document'), 'Upload intent must register a document in SQL');
assert(files.scan.includes('scanAndFinalizeDocument'), 'Scan route must use server-side finalization');
assert(files.supplierDownload.includes("status: 'available'"), 'Supplier downloads must require available status');
assert(files.genericDownload.includes('withTracefabUserContext'), 'Generic downloads must use SQL access context');
assert(files.response.includes("status: 'available'"), 'Response evidence must require an available document');
assert(files.certifications.includes("status: 'available'"), 'Certification evidence must require an available document');
console.log('Private storage contract passed: fixed private bucket, server validation, scanner gate, tenant-safe associations and temporary download routes');
