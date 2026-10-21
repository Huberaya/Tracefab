import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const consoleJs = read('assets/js/brand-console.1.js');
const dppJs = read('assets/js/dpp.2.js');
const dppHtml = read('dpp/index.html');
const dppLib = read('api/_lib/dpp.ts');
const publish = read('api/_routes/products/[productId]/dpp/publish-review.ts');
const migration = read('prisma/migrations/20261021170000_dpp_readiness_truthful_gates/migration.sql');

// Publication must fail closed on current source data, independently from an
// older persisted readiness record.
for (const token of [
  'product.required_attributes', 'materials.origin_documented',
  'traceability.documented', 'quality.no_open_issues',
  'evidence.product_data', 'product.not_draft',
]) {
  assert.ok(migration.includes(token), `strict DPP profile must include ${token}`);
  assert.ok(dppLib.includes(token), `DPP summary must expose ${token}`);
}
assert.ok(migration.includes('CREATE OR REPLACE FUNCTION tracefab_mark_dpp_ready_to_publish'));
assert.ok(migration.includes("RAISE EXCEPTION 'dpp_publication_requirements_not_met'"));
assert.ok(migration.includes('REVOKE EXECUTE ON FUNCTION tracefab_dpp_requirement_met(TEXT, UUID) FROM tracefab_app'));
assert.ok(publish.includes('tracefab_mark_dpp_ready_to_publish'));
assert.ok(publish.includes('dpp_publication_requirements_not_met'));
assert.ok(dppLib.includes('snapshotMet === true'), 'requirements absent from an old snapshot must fail closed');
assert.ok(!dppLib.includes("'product.data_ready',\n    'composition.complete'"), 'self-referential readiness must not be scored');

// A product preview must resolve a real identifier; bare /dpp/ cannot silently
// substitute the polished sample passport.
assert.ok(consoleJs.includes('journeyResolvableIdRequired'));
assert.ok(consoleJs.includes('/dpp/?gtin=${encodeURIComponent(dppIdentifier)}'));
assert.ok(dppJs.includes("if (!id) {"));
assert.ok(dppJs.includes("data-dpp-source', 'unavailable"));
assert.ok(dppHtml.includes('data-dpp-source="unavailable"'));
assert.ok(dppHtml.includes('html[data-dpp-source="unavailable"] [data-tf-demo]'));

// Production actions may not route through the generic demo-action warning.
assert.ok(consoleJs.includes('data-action="inspect-material"'));
assert.ok(consoleJs.includes("api('/api/materials/'"));
assert.ok(!consoleJs.includes('<button class="btn btn-secondary" data-demo-action="1">${bt(\'exportCsv\')}</button>'));

// Request entry points share the supplier prerequisite.
assert.ok(consoleJs.includes("data-action=\"new-request\" ${suppliers().length ? ''"));
assert.ok(consoleJs.includes("if (!suppliers().length) { notify(bt('journeySupplierRequired')"));

console.log('Customer-journey release blockers contract passed');
