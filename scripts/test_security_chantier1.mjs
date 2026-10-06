import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const assert = (condition, message) => { if (!condition) throw new Error(message); };

// 1. Verify migration SQL content
const migrationSql = await readFile(
  new URL('../prisma/migrations/20261006100000_security_force_rls_and_document_access/migration.sql', import.meta.url),
  'utf8',
);

const expectedForcedTables = [
  'users',
  'organizations',
  'organization_memberships',
  'organization_invitations',
  'brand_supplier_relationships',
  'suppliers',
  'supplier_sites',
  'tracefab_products',
  'materials',
  'product_materials',
  'product_identifiers',
  'supply_chain_nodes',
  'supply_chain_links',
  'data_requests',
  'data_request_items',
  'documents',
  'data_responses',
  'data_points',
  'data_shares',
  'certifications',
  'verification_records',
  'data_quality_scores',
  'data_quality_issues',
  'dpp_requirement_profiles',
  'dpp_records',
  'orders',
  'audit_logs',
  'tracefab_notification_outbox',
];

for (const table of expectedForcedTables) {
  assert(
    migrationSql.includes(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`),
    `Table ${table} must have FORCE ROW LEVEL SECURITY in migration`,
  );
}

assert(
  migrationSql.includes('CREATE OR REPLACE FUNCTION tracefab_can_access_document(p_document_id UUID)'),
  'Function tracefab_can_access_document must be declared',
);
assert(
  migrationSql.includes('GRANT EXECUTE ON FUNCTION tracefab_can_access_document(UUID) TO PUBLIC;'),
  'Function tracefab_can_access_document must be granted to PUBLIC',
);
assert(
  migrationSql.includes('CREATE POLICY documents_select_authorized ON documents'),
  'Policy documents_select_authorized must be updated with unified access guard',
);
assert(
  migrationSql.includes('CREATE POLICY data_points_select_authorized ON data_points'),
  'Policy data_points_select_authorized must be updated for product data points',
);
assert(
  migrationSql.includes('CREATE POLICY organizations_select_member ON organizations'),
  'Policy organizations_select_member must allow partner brands/suppliers and invited emails',
);
assert(
  migrationSql.includes('CREATE POLICY suppliers_select_authorized ON suppliers'),
  'Policy suppliers_select_authorized must allow partner brands with active relationships',
);
assert(
  migrationSql.includes('CREATE POLICY supplier_sites_select_authorized ON supplier_sites'),
  'Policy supplier_sites_select_authorized must allow partner brands with active relationships',
);
assert(
  migrationSql.includes('CREATE POLICY materials_select_authorized ON materials'),
  'Policy materials_select_authorized must allow partner brands with product materials or active relationships',
);
assert(
  migrationSql.includes('CREATE POLICY certifications_select_authorized ON certifications'),
  'Policy certifications_select_authorized must allow partner brands linked to supplier or product materials',
);

// 2. Verify router integration
const routerTs = await readFile(new URL('../api/index.ts', import.meta.url), 'utf8');
assert(
  routerTs.includes("import('./_routes/products/[productId]/data-points.js')"),
  'Route /api/products/:productId/data-points must be registered in router',
);

// 3. Verify document download hardening
const downloadTs = await readFile(
  new URL('../api/_routes/documents/[documentId]/download.ts', import.meta.url),
  'utf8',
);
assert(
  downloadTs.includes('tracefab_can_access_document'),
  'Brand document download route must check tracefab_can_access_document',
);
assert(
  downloadTs.includes('if (!accessRows[0]?.can_access) return null;'),
  'Brand document download route must return null if not authorized',
);

// 4. Verify product data points endpoint
const productPointsTs = await readFile(
  new URL('../api/_routes/products/[productId]/data-points.ts', import.meta.url),
  'utf8',
);
assert(productPointsTs.includes("req.method !== 'GET' && req.method !== 'POST'"), 'Route must support GET and POST');
assert(productPointsTs.includes('activeBrandOrganizationIds'), 'Route must check brand organization access');
assert(productPointsTs.includes('brand_product_role_required'), 'Route must require brand mutation role');
assert(productPointsTs.includes('productDataPointMutation'), 'Route must use productDataPointMutation');
assert(productPointsTs.includes('tracefab_can_access_document'), 'Route must verify source document access');
assert(productPointsTs.includes('supersedes_id'), 'Route must maintain supersedes_id chain');
assert(productPointsTs.includes('version: current ? current.version + 1 : 1'), 'Route must increment version');

// 5. Transpile and unit test productDataPointMutation
const dataPointsSource = await readFile(new URL('../api/_lib/data-points.ts', import.meta.url), 'utf8');
const compiledDataPoints = ts.transpileModule(dataPointsSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
}).outputText;
const dataPointsModule = await import(`data:text/javascript;base64,${Buffer.from(compiledDataPoints).toString('base64')}`);

const { productDataPointMutation, DATA_POINT_DEFINITIONS } = dataPointsModule;

const validPoint = productDataPointMutation({
  dataKey: 'recycled_content_percentage',
  dataType: 'percentage',
  value: 45.5,
  validFrom: '2026-01-01',
  validUntil: '2026-12-31',
});
assert(validPoint.dataKey === 'recycled_content_percentage', 'Valid data key mismatch');
assert(validPoint.dataType === 'percentage', 'Valid data type mismatch');
assert(validPoint.value === 45.5, 'Valid value mismatch');
assert(validPoint.validFrom instanceof Date, 'ValidFrom must be Date');
assert(validPoint.validUntil instanceof Date, 'ValidUntil must be Date');

// Test definitions presence
assert(DATA_POINT_DEFINITIONS.recycled_content_percentage?.dataType === 'percentage', 'recycled_content_percentage missing');
assert(DATA_POINT_DEFINITIONS.carbon_footprint_kg?.dataType === 'number', 'carbon_footprint_kg missing');
assert(DATA_POINT_DEFINITIONS.water_usage_liters?.dataType === 'number', 'water_usage_liters missing');
assert(DATA_POINT_DEFINITIONS.care_wash_temp?.dataType === 'number', 'care_wash_temp missing');

// Test validation errors
let threw = false;
try {
  productDataPointMutation({
    dataKey: 'invalid key with spaces!',
    dataType: 'text',
    value: 'test',
  });
} catch (e) {
  threw = true;
  assert(e.message === 'invalid_data_key', 'Expected invalid_data_key error');
}
assert(threw, 'Should have thrown on invalid dataKey');

threw = false;
try {
  productDataPointMutation({
    dataKey: 'carbon_footprint_kg',
    dataType: 'number',
    value: 12.4,
    validFrom: '2026-12-31',
    validUntil: '2026-01-01', // End before start
  });
} catch (e) {
  threw = true;
  assert(e.message === 'invalid_data_point_date_range', 'Expected invalid_data_point_date_range error');
}
assert(threw, 'Should have thrown on inverted date range');

threw = false;
try {
  productDataPointMutation({
    dataKey: 'unknown_key',
    dataType: 'invalid_type',
    value: 'hello',
  });
} catch (e) {
  threw = true;
  assert(e.message === 'invalid_data_type', 'Expected invalid_data_type error');
}
assert(threw, 'Should have thrown on invalid dataType');

console.log('Chantier 1 security tests passed: FORCE RLS migration, document authorization, product data-points API and mutation validation.');
