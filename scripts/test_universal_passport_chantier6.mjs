import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

console.log('--- Chantier : Test Suite - Passeport Fournisseur Universel « 1-Clic » & Viralité Inversée ---');

// 1. Verify schema migration SQL
const migrationSqlPath = path.resolve('prisma/migrations/20261006250000_universal_supplier_passport/migration.sql');
assert(fs.existsSync(migrationSqlPath), 'Migration SQL for universal supplier passport must exist');
const migrationSql = fs.readFileSync(migrationSqlPath, 'utf8');

assert(migrationSql.includes('supplier_universal_passports'), 'Migration must create supplier_universal_passports table');
assert(migrationSql.includes('supplier_passport_access_requests'), 'Migration must create supplier_passport_access_requests table');
assert(migrationSql.includes('FORCE ROW LEVEL SECURITY'), 'Migration must enforce FORCE RLS on passport tables');
assert(migrationSql.includes('tracefab_get_or_create_supplier_passport'), 'Migration must create tracefab_get_or_create_supplier_passport');
assert(migrationSql.includes('tracefab_update_supplier_passport'), 'Migration must create tracefab_update_supplier_passport');
assert(migrationSql.includes('tracefab_get_public_supplier_passport'), 'Migration must create tracefab_get_public_supplier_passport');
assert(migrationSql.includes('tracefab_request_passport_access'), 'Migration must create tracefab_request_passport_access');
assert(migrationSql.includes('tracefab_review_passport_access'), 'Migration must create tracefab_review_passport_access');
console.log('✓ Migration SQL schema, RLS & procedures verified');

// 2. Verify TypeScript library
const typesPath = path.resolve('api/_lib/supplier-passport/types.ts');
const managerPath = path.resolve('api/_lib/supplier-passport/passport-manager.ts');
assert(fs.existsSync(typesPath), 'Types file must exist');
assert(fs.existsSync(managerPath), 'Manager file must exist');

const typesContent = fs.readFileSync(typesPath, 'utf8');
assert(typesContent.includes('TradeSecretMode'), 'TradeSecretMode type must be defined');
assert(typesContent.includes('PublicSupplierPassport'), 'PublicSupplierPassport must be defined');
assert(typesContent.includes('UniversalPassportRecord'), 'UniversalPassportRecord must be defined');

const managerContent = fs.readFileSync(managerPath, 'utf8');
assert(managerContent.includes('getOrCreateSupplierPassport'), 'getOrCreateSupplierPassport must be exported');
assert(managerContent.includes('updateSupplierPassport'), 'updateSupplierPassport must be exported');
assert(managerContent.includes('getPublicSupplierPassport'), 'getPublicSupplierPassport must be exported');
assert(managerContent.includes('requestPassportAccess'), 'requestPassportAccess must be exported');
assert(managerContent.includes('reviewPassportAccess'), 'reviewPassportAccess must be exported');
console.log('✓ TypeScript library and manager contracts verified');

// 3. Verify API routes
const routes = [
  'api/_routes/supplier/passport.ts',
  'api/_routes/supplier/passport/access-requests.ts',
  'api/_routes/passport/[tokenOrSlug].ts',
  'api/_routes/passport/[tokenOrSlug]/request-access.ts',
];
for (const r of routes) {
  assert(fs.existsSync(path.resolve(r)), `Route file ${r} must exist`);
  const content = fs.readFileSync(path.resolve(r), 'utf8');
  assert(content.includes('export default async function handler'), `Route ${r} must export default handler`);
}
console.log('✓ API route handlers exist and export handler function');

// 4. Verify API Router Dispatch in api/index.ts
const apiIndexPath = path.resolve('api/index.ts');
const apiIndex = fs.readFileSync(apiIndexPath, 'utf8');
assert(apiIndex.includes('./_routes/supplier/passport/access-requests.js'), 'Router must route to passport access requests');
assert(apiIndex.includes('./_routes/supplier/passport.js'), 'Router must route to supplier passport');
assert(apiIndex.includes('./_routes/passport/[tokenOrSlug]/request-access.js'), 'Router must route to passport public request access');
assert(apiIndex.includes('./_routes/passport/[tokenOrSlug].js'), 'Router must route to public passport view');
console.log('✓ API index routing table verified');

// 5. Verify Public Passport Frontend (passport/index.html)
const publicPassportPath = path.resolve('passport/index.html');
assert(fs.existsSync(publicPassportPath), 'passport/index.html must exist');
const publicPassport = fs.readFileSync(publicPassportPath, 'utf8');
assert(publicPassport.includes('Universal Supplier Passport'), 'Page must contain title');
// La copie n'est plus en dur : le balisage appelle la cle et le catalogue
// francais conserve le libelle d'origine.
const passportFr = JSON.parse(fs.readFileSync(path.resolve('assets/i18n/fr.json'), 'utf8')).passport;
assert(publicPassport.includes("pt_('ndaTitle')"), 'Page must state Trade Secret Protection Directive');
assert(
  passportFr?.ndaTitle === "Protection des Secrets d'Affaires Active (Directive UE 2016/943)",
  'fr.json passport.ndaTitle must keep the original French wording'
);
assert(publicPassport.includes("pt_('ctaFullAccessNda')"), 'Page must contain CTA for brands');
assert(
  passportFr?.ctaFullAccessNda === 'Demander accès complet (NDA)',
  'fr.json passport.ctaFullAccessNda must keep the original French wording'
);
assert(publicPassport.includes('/api/passport/'), 'Page must call passport API');
console.log('✓ Public Verifiable Passport Viewer (passport/index.html) verified');

// 6. Verify Supplier Portal Integration (supplier-portal/index.html)
const supplierPortalPath = path.resolve('supplier-portal/index.html');
const supplierPortal = fs.readFileSync(supplierPortalPath, 'utf8');
assert(supplierPortal.includes('passportView'), 'Supplier portal must implement passportView');
// La copie n'est plus en dur : le balisage appelle la cle, et le catalogue
// francais conserve le libelle d'origine.
assert(supplierPortal.includes("t('spPassportTitle')"), 'Supplier portal must display Universal Passport title');
assert(
  JSON.parse(fs.readFileSync(path.resolve('assets/i18n/fr.json'), 'utf8'))
    .portal?.spPassportTitle === 'Passeport Fournisseur Universel « 1-Clic »',
  'fr.json portal.spPassportTitle must keep the original French wording'
);
assert(supplierPortal.includes('passport-settings-form'), 'Supplier portal must have settings form');
assert(supplierPortal.includes('review-passport-request'), 'Supplier portal must have review request action');
console.log('✓ Supplier Portal UI/UX integration verified');

console.log('--- Chantier Universal Supplier Passport Static Tests PASSED ---');
