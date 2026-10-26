import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const consoleJs = read('assets/js/brand-console.1.js');
const dppJs = read('assets/js/dpp.2.js');
const dppHtml = read('dpp/index.html');
const dppLib = read('api/_lib/dpp.ts');
const publish = read('api/_routes/products/[productId]/dpp/publish-review.ts');
const portfolio = read('api/_routes/dpp/portfolio.ts');
const settingsRoute = read('api/_routes/organization-settings.ts');
const productRoute = read('api/_routes/products/[productId].ts');
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
assert.ok(dppLib.includes('derivedMissing') && dppLib.includes("completionScore < 100"), 'summary must derive gaps and current status from the strict active profile');
assert.ok(portfolio.includes('DPP_STANDARD_REQUIREMENT_KEYS') && portfolio.includes('snapshot.requirement_results'), 'portfolio must aggregate strict requirement results, not stale missing_fields');
assert.ok(portfolio.includes('statusCounts.in_progress'), 'portfolio must downgrade incomplete historical statuses');
assert.ok(!dppLib.includes("'product.data_ready',\n    'composition.complete'"), 'self-referential readiness must not be scored');

// A product preview must resolve a real identifier; bare /dpp/ cannot silently
// substitute the polished sample passport.
assert.ok(consoleJs.includes('journeyResolvableIdRequired'));
assert.ok(consoleJs.includes('/dpp/?gtin=${encodeURIComponent(dppIdentifier)}'));
assert.ok(dppJs.includes("if (!id) {"));
assert.ok(dppJs.includes("data-dpp-source', 'unavailable"));
assert.ok(dppHtml.includes('data-dpp-source="unavailable"'));
assert.ok(dppHtml.includes('html[data-dpp-source="unavailable"] [data-tf-demo]'));
for (const forbidden of ['Organic Cotton Essential', '3760123456789', 'GRS Certified', 'Quinta de São Martinho', 'e3b0c44298fc']) {
  assert.ok(!dppHtml.includes(forbidden), `public HTML must not contain synthetic claim: ${forbidden}`);
}
assert.ok(dppHtml.includes('id="dpp-wallet-actions" hidden'));
assert.ok(dppJs.includes('walletActions.hidden = walletLinkCount === 0'));

// Production actions may not route through the generic demo-action warning.
assert.ok(consoleJs.includes('data-action="inspect-material"'));
assert.ok(consoleJs.includes("api('/api/materials/'"));
assert.ok(!consoleJs.includes('<button class="btn btn-secondary" data-demo-action="1">${bt(\'exportCsv\')}</button>'));

// Request entry points share the supplier prerequisite.
assert.ok(consoleJs.includes("data-action=\"new-request\" ${suppliers().length ? ''"));
assert.ok(consoleJs.includes("if (!suppliers().length) { notify(bt('journeySupplierRequired')"));

// Governance settings must be role-aware and validated in both UI and API.
assert.ok(consoleJs.includes("const canEdit = ['owner', 'admin'].includes"));
assert.ok(consoleJs.includes("${canEdit ? '' : 'disabled'}"));
assert.ok(settingsRoute.includes('invalid_dpp_identifier_format'));

assert.match(productRoute, /roles:\s*lifecycleRequested\s*\?\s*\['owner',\s*'admin'\]/, 'Product archival and restoration must require an owner or admin role');
assert.match(productRoute, /action:\s*'product\.restored'/, 'Product restoration must leave an organization-scoped audit record');
assert.match(productRoute, /current\.status\s*!==\s*'draft'/, 'Only draft products may be archived');
assert.match(productRoute, /action:\s*'product\.archived'/, 'Product archival must leave an organization-scoped audit record');
assert.match(productRoute, /const actorUserId = user\.id/, 'Product archival must use the provisioned Tracefab user UUID');
assert.match(productRoute, /actor_user_id:\s*actorUserId/, 'Product archival audit must identify the database actor required by RLS');
assert.match(consoleJs, /data-action="archive-product"/, 'Draft product detail must expose an archive action');
assert.match(consoleJs, /p\.status\s*===\s*'archived'/, 'Archived products must leave the default active catalogue');

console.log('Customer-journey release blockers contract passed');
