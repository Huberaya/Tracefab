import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pageSource } from './lib/page_source.mjs';

console.log('--- Chantier 5 : Test Suite - Corrective Action Plans (CAP) & Remediation Workflow ---');

// 1. Verify schema migration SQL
const migrationSqlPath = path.resolve('prisma/migrations/20261006240000_quality_corrective_action_plans_cap/migration.sql');
assert(fs.existsSync(migrationSqlPath), 'Migration SQL for CAP must exist');
const migrationSql = fs.readFileSync(migrationSqlPath, 'utf8');

assert(migrationSql.includes('quality_corrective_action_plans'), 'Migration must create quality_corrective_action_plans table');
assert(migrationSql.includes('quality_cap_messages'), 'Migration must create quality_cap_messages table');
assert(migrationSql.includes('CHECK (status IN'), 'Migration must enforce status check constraint');
assert(migrationSql.includes('CHECK (priority IN'), 'Migration must enforce priority check constraint');
assert(migrationSql.includes('FORCE ROW LEVEL SECURITY'), 'Migration must enforce FORCE RLS on CAP tables');
assert(migrationSql.includes('tracefab_create_quality_cap'), 'Migration must create tracefab_create_quality_cap function');
assert(migrationSql.includes('tracefab_submit_quality_remediation'), 'Migration must create tracefab_submit_quality_remediation function');
assert(migrationSql.includes('tracefab_review_quality_remediation'), 'Migration must create tracefab_review_quality_remediation function');
console.log('✓ Migration SQL schema & procedures verified');

// 2. Verify TypeScript library files
const capTypesPath = path.resolve('api/_lib/quality-cap/types.ts');
const capManagerPath = path.resolve('api/_lib/quality-cap/cap-manager.ts');
assert(fs.existsSync(capTypesPath), 'CAP types file must exist');
assert(fs.existsSync(capManagerPath), 'CAP manager file must exist');

const capTypes = fs.readFileSync(capTypesPath, 'utf8');
assert(capTypes.includes('QualityCapStatus'), 'QualityCapStatus must be defined');
assert(capTypes.includes('QualityCapPriority'), 'QualityCapPriority must be defined');
assert(capTypes.includes('CreateQualityCapInput'), 'CreateQualityCapInput must be defined');

const capManager = fs.readFileSync(capManagerPath, 'utf8');
assert(capManager.includes('createQualityCap'), 'createQualityCap must be exported');
assert(capManager.includes('submitQualityRemediation'), 'submitQualityRemediation must be exported');
assert(capManager.includes('reviewQualityRemediation'), 'reviewQualityRemediation must be exported');
console.log('✓ TypeScript CAP library contract verified');

// 3. Verify API Route Handlers
const routes = [
  'api/_routes/quality/caps.ts',
  'api/_routes/quality/issues/[issueId]/cap.ts',
  'api/_routes/quality/caps/[capId]/messages.ts',
  'api/_routes/quality/caps/[capId]/submit-remediation.ts',
  'api/_routes/quality/caps/[capId]/review.ts',
];
for (const r of routes) {
  assert(fs.existsSync(path.resolve(r)), `Route file ${r} must exist`);
  const content = fs.readFileSync(path.resolve(r), 'utf8');
  assert(content.includes('export default async function handler'), `Route ${r} must export a handler`);
}
console.log('✓ API route handlers exist and export handler function');

// 4. Verify API Router Dispatch in api/index.ts
const apiIndexPath = path.resolve('api/index.ts');
const apiIndex = fs.readFileSync(apiIndexPath, 'utf8');
assert(apiIndex.includes('quality/issues/'), 'Router must route to issue CAP creation');
assert(apiIndex.includes('quality/caps/'), 'Router must route to CAP sub-routes');
assert(apiIndex.includes('./_routes/quality/caps.js'), 'Router must route to quality/caps');
console.log('✓ API index routing table verified');

// 5. Verify Brand Console UX
const brandConsolePath = path.resolve('brand-console/index.html');
const brandConsole = pageSource('brand-console/index.html');
assert(brandConsole.includes('data-action="open-cap-modal"'), 'Brand console must provide button to open CAP modal');
assert(brandConsole.includes('id="create-cap-form"'), 'Brand console must provide CAP creation form');
assert(brandConsole.includes('data-action="open-review-cap-modal"'), 'Brand console must provide review CAP button');
assert(brandConsole.includes('id="review-cap-form"'), 'Brand console must provide review CAP form');
assert(brandConsole.includes('id="cap-message-form"'), 'Brand console must provide CAP message thread form');
console.log('✓ Brand Console UI/UX integration verified');

// 6. Verify Supplier Portal UX
const supplierPortalPath = path.resolve('supplier-portal/index.html');
const supplierPortal = pageSource('supplier-portal/index.html');
// La copie n'est plus en dur : le balisage appelle la cle, et le catalogue
// francais conserve le libelle d'origine.
assert(supplierPortal.includes("t('spCapTitle')"), 'Supplier portal must display received CAPs');
assert(
  JSON.parse(fs.readFileSync(path.resolve('assets/i18n/fr.json'), 'utf8'))
    .portal?.spCapTitle === 'Plans d’Actions Correctives Reçus (CAP / 8D)',
  'fr.json portal.spCapTitle must keep the original French wording'
);
assert(supplierPortal.includes('cap-submit-form'), 'Supplier portal must provide remediation submission form');
assert(supplierPortal.includes('submitCapRemediation'), 'Supplier portal must implement submitCapRemediation function');
console.log('✓ Supplier Portal UI/UX integration verified');

console.log('--- Chantier 5 Static & Contract Tests PASSED ---');
