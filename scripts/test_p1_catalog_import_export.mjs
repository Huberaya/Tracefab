import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const files = Object.fromEntries(await Promise.all([
  ['portal', 'brand-console/index.html'],
  ['helper', 'api/_lib/catalog-importer.ts'],
  ['importRoute', 'api/_routes/catalog/products/import.ts'],
  ['supplierHelper', 'api/_lib/supplier-importer.ts'],
  ['supplierImportRoute', 'api/_routes/catalog/suppliers/import.ts'],
  ['exportRoute', 'api/_routes/catalog/products/export.ts'],
  ['auditExport', 'api/_routes/catalog/audit-export.ts'],
  ['jobRoute', 'api/_routes/catalog/products/import-jobs/[jobId].ts'],
  ['router', 'api/index.ts'],
  ['migration', 'prisma/migrations/20261006190000_catalog_import_export/migration.sql'],
  ['docs', 'docs/architecture/28-p1-catalog-import-export.md'],
].map(async ([key, path]) => [key, await readFile(path, 'utf8')])));

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const script = files.portal.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert(script, 'Brand Console inline application script is missing');
const temporaryScript = '/tmp/tracefab-catalog-import-export-check.mjs';
await writeFile(temporaryScript, script);
const syntax = spawnSync(process.execPath, ['--check', temporaryScript], { encoding: 'utf8' });
await unlink(temporaryScript).catch(() => {});
assert(syntax.status === 0, syntax.stderr || 'Brand Console script syntax is invalid');

for (const contract of [
  'data-action="catalog-import"',
  'data-action="supplier-import"',
  'data-action="catalog-export"',
  'data-action="audit-export"',
  'previewCatalogImport',
  'commitCatalogImport',
  '/api/catalog/products/import',
  '/api/catalog/products/export',
  'catalogImportPreview',
]) assert(files.portal.includes(contract), `Brand Console catalogue contract missing: ${contract}`);

for (const contract of ['CATALOG_IMPORT_MAX_BYTES', 'CATALOG_IMPORT_MAX_ROWS', 'parseCsvRecords', 'duplicate_reference_in_file', 'invalid_country_code', 'csvCell', 'CATALOG_EXPORT_HEADERS']) {
  assert(files.helper.includes(contract), `Catalogue importer helper contract missing: ${contract}`);
}
assert(files.importRoute.includes('dryRun') && files.importRoute.includes('tracefab_catalog_import_jobs') && files.importRoute.includes('tracefab_create_product') && files.importRoute.includes('audit_logs'), 'Catalogue import route must validate, persist jobs, create products and audit');
assert(files.supplierHelper.includes('SUPPLIER_IMPORT_MAX_ROWS') && files.supplierHelper.includes('duplicate_email_in_file') && files.supplierHelper.includes('invalid_supplier_email'), 'Supplier importer validation contract is missing');
assert(files.supplierImportRoute.includes('tracefab_invite_supplier') && files.supplierImportRoute.includes('sendSupplierInvitationEmail') && files.supplierImportRoute.includes('import_kind'), 'Supplier bulk import must create hashed invitations, deliver through the email adapter and persist a typed job');
assert(files.exportRoute.includes('text/csv') && files.exportRoute.includes('product_materials') && files.exportRoute.includes('activeBrandOrganizationIds'), 'Catalogue export route must be CSV, composition-aware and tenant-scoped');
assert(files.auditExport.includes('audit_logs') && files.auditExport.includes('data_points') && files.auditExport.includes('no-store'), 'Audit export must include data points, audit events and no-store headers');
assert(files.jobRoute.includes('tracefab_catalog_import_jobs') && files.jobRoute.includes('activeBrandOrganizationIds'), 'Import job status route must be tenant-scoped');
assert(files.router.includes('catalog/products/import') && files.router.includes('catalog/products/export') && files.router.includes('catalog/suppliers/import') && files.router.includes('import-jobs'), 'Catalogue routes missing from API router');
assert(files.migration.includes('FORCE ROW LEVEL SECURITY') && files.migration.includes('idx_catalog_import_jobs_idempotency') && files.migration.includes('source_sha256') && files.migration.includes('audit_logs'), 'Catalogue import migration is missing RLS, idempotency, hash or audit protections');
assert(files.docs.includes('Chantier P1') && files.docs.includes('idempotency') && files.docs.includes('DATA READY'), 'Catalogue import/export documentation is incomplete');
assert(!files.portal.includes('localhost') && !/sk_live_|secret_key|ghp_[A-Za-z0-9]/i.test(files.portal), 'Brand Console contains an unsafe browser credential or URL');

function parseCsv(content) {
  const rows = [];
  let current = '';
  let row = [];
  let quoted = false;
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (char === '"' && content[i + 1] === '"' && quoted) { current += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { row.push(current); current = ''; }
    else if (char === '\n' && !quoted) { row.push(current); rows.push(row); row = []; current = ''; }
    else current += char;
  }
  if (current || row.length) { row.push(current); rows.push(row); }
  return rows;
}
const parsed = parseCsv('reference,name,description\nAT-001,"Chemise, lin", "Ligne\nété"');
assert(parsed.length === 2 && parsed[1][1] === 'Chemise, lin' && parsed[1][2].includes('été'), 'Quoted CSV fields must preserve commas and newlines');

console.log('P1 catalogue import/export contract passed: tenant-safe CSV preview/import, idempotent jobs, composition-aware export and audit metadata');
