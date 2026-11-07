import { readFile } from 'node:fs/promises';

const files = Object.fromEntries(await Promise.all([
  ['storage', 'api/_lib/storage.ts'],
  ['context', 'api/_lib/context.ts'],
  ['documents', 'api/_lib/documents.ts'],
  ['scanFlow', 'api/_lib/document-scan-flow.ts'],
  ['quota', 'api/_lib/cloud-storage/quota-manager.ts'],
  ['uploadIntent', 'api/_routes/supplier/documents/upload-intent.ts'],
  ['brandUploadIntent', 'api/_routes/documents/upload-intent.ts'],
  ['scan', 'api/_routes/supplier/documents/[documentId]/scan.ts'],
  ['brandScan', 'api/_routes/documents/[documentId]/scan.ts'],
  ['supplierDownload', 'api/_routes/supplier/documents/[documentId]/download.ts'],
  ['genericDownload', 'api/_routes/documents/[documentId]/download.ts'],
  ['response', 'api/_routes/data-request-items/[itemId]/response.ts'],
  ['certifications', 'api/_routes/supplier/certifications.ts'],
].map(async ([key, path]) => [key, await readFile(path, 'utf8')])));

const assert = (condition, message) => { if (!condition) throw new Error(message); };

assert(files.storage.includes("const PRIVATE_STORAGE_BUCKET = 'tracefab-private'"), 'Private bucket must be fixed');
assert(files.storage.includes('private_storage_antivirus_not_configured'), 'Missing antivirus configuration must block scanning');
assert(files.storage.includes('X-Tracefab-Scan-Protocol'), 'Antivirus protocol header is missing');
assert(files.storage.includes('MAX_DOCUMENT_BYTES = 50 * 1024 * 1024'), 'Server document limit is missing');
assert(files.storage.includes('storageObjectKey(ownerOrganizationId'), 'Tenant-scoped object key helper is missing');
assert(files.documents.includes("createHash('sha256')"), 'Server SHA-256 calculation is missing');
assert(!files.uploadIntent.includes('body.sha256'), 'Upload intent must not accept a browser-provided hash');
assert(files.uploadIntent.includes('tracefab_register_document'), 'Upload intent must register a document in SQL');

// TF-02 — cycle de scan : trois phases, reseau hors transaction, fail-closed.
assert(files.documents.includes('beginDocumentScan') && files.documents.includes('performDocumentScanChecks') && files.documents.includes('completeDocumentScan'),
  'Scan must be split into short transactions and network-only phases');
assert(files.documents.includes('isDefinitiveScanError'), 'Definitive integrity errors must be classified');
assert(files.scanFlow.includes('retryable'), 'Transient scanner/storage failures must leave the document retriable (never clean)');
assert(files.scanFlow.includes('rejectDocumentScan'), 'Definitive failures must reject the document through finalization');
// Le reseau ne doit jamais etre execute depuis la transaction : aucune
// combinaison transaction + appels S3/antivirus dans le meme bloc.
const flowBody = files.scanFlow.split('export async function runDocumentScanFlow')[1] || '';
const txBlocksWithNetwork = flowBody.split('withTracefabUserContext').slice(1)
  .filter((block) => block.slice(0, 400).includes('performDocumentScanChecks'));
assert(txBlocksWithNetwork.length === 0, 'Network checks must not run inside the SQL transaction');

// TF-02 — parcours scan proprietaire (marque) : route dediee et next.scan coherent.
assert(files.brandScan.includes('runDocumentScanFlow')
  && files.brandScan.includes('withTracefabTenantContext')
  && files.brandScan.includes("roles: ['owner', 'admin', 'manager', 'contributor']")
  && files.brandScan.includes('owner_organization_id: tenant.organizationId'),
  'Owner scan route must validate the active brand tenant, enforce writer roles and scope the document owner');
assert(files.brandUploadIntent.includes('/api/documents/${result.document.id}/scan'),
  'Brand upload intent must point to the owner scan route, not the supplier one');
assert(files.scan.includes('runDocumentScanFlow'), 'Supplier scan route must use the shared fail-closed flow');

// TF-02 — quotas : verrou anti-concurrence present.
assert(files.quota.includes('pg_advisory_xact_lock'), 'Quota check must take a transactional advisory lock');

assert(files.supplierDownload.includes("status: 'available'"), 'Supplier downloads must require available status');
// Le telechargement fournisseur ne doit pas se limiter a la propriete : les
// pieces explicitement partagees par une marque (certificat emis au nom du
// fournisseur, reponse de collecte) sont legitimes. Le garde lie au tenant
// actif est la SEULE decision ; un filtre proprietaire seul les rendait
// introuvables et un filtre sur l'union des adhesions aurait ouvert une fuite.
assert(files.supplierDownload.includes('documentAccessibleFromTenant')
  && files.supplierDownload.includes('withTracefabTenantContext'),
'Supplier downloads must authorize through the active-tenant document guard');
assert(!files.supplierDownload.includes('tracefab_can_access_document('),
  'Supplier downloads must not use the membership-union guard');
// Le téléchargement générique ne doit plus seulement ouvrir un contexte SQL :
// il doit valider le tenant actif ET borner l'autorisation documentaire à ce
// tenant (une union d'adhésions laisserait passer le document d'une autre
// marque du même compte). Le contrat est renforcé, pas assoupli.
assert(files.genericDownload.includes('withTracefabTenantContext'), 'Generic downloads must validate the active tenant');
assert(files.context.includes('withTracefabUserContext('), 'Tenant context must still open the SQL user context');
assert(files.genericDownload.includes('tracefab_document_accessible_in_active_tenant')
  || files.genericDownload.includes('documentAccessibleFromTenant'),
'Generic downloads must bound document access to the active tenant');
assert(files.genericDownload.includes("status: 'available'"), 'Generic downloads must require available status');
// Toutes les routes qui autorisent un document par son identifiant doivent
// passer par le garde lié au tenant actif, jamais par la seule union des
// adhésions de `tracefab_can_access_document`.
const EVIDENCE_ROUTES = [
  'api/_routes/products/[productId]/data-points.ts',
  'api/_routes/products/[productId]/supply-chain/nodes.ts',
  'api/_routes/products/[productId]/supply-chain/links.ts',
  'api/_routes/products/[productId]/supply-chain/nodes/[nodeId].ts',
  'api/_routes/products/[productId]/supply-chain/links/[linkId].ts',
];
for (const path of EVIDENCE_ROUTES) {
  const source = await readFile(path, 'utf8');
  assert(!source.includes('tracefab_can_access_document('),
    `${path}: evidence must not be authorized by the membership union`);
  assert(source.includes('tracefab_document_accessible_in_active_tenant('),
    `${path}: evidence must be authorized in the active tenant`);
}
assert(files.response.includes("status: 'available'"), 'Response evidence must require an available document');
assert(files.certifications.includes("status: 'available'"), 'Certification evidence must require an available document');
console.log('Private storage contract passed: fixed private bucket, server validation, scanner gate, fail-closed scan phases, owner scan route, quota lock, tenant-safe associations and temporary download routes');
