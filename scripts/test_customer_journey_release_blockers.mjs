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
const productsRoute = read('api/_routes/products.ts');
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

// Depuis la correction D1, le cycle de vie distingue trois actes : activation
// (owner/admin/manager), archivage et restauration (owner/admin). L'exigence
// d'origine — un role fort pour archiver et restaurer — reste verifiee, mais
// elle ne doit plus etre confondue avec l'activation.
assert.match(productRoute, /roles:\s*activateRequested\s*\?\s*\['owner',\s*'admin',\s*'manager'\]/, 'Product activation must be open to owner, admin and manager');
assert.match(productRoute, /:\s*lifecycleRequested\s*\?\s*\['owner',\s*'admin'\]/, 'Product archival and restoration must require an owner or admin role');
assert.match(productRoute, /action:\s*'product\.restored'/, 'Product restoration must leave an organization-scoped audit record');
assert.match(productsRoute, /status:\s*archived\s*\?\s*'archived'\s*:\s*\{\s*not:\s*'archived'\s*\}/, 'The active catalogue must exclude archived products at the API boundary');
assert.match(productsRoute, /source_archived_product_id:\s*reuseSource\.id/, 'Reused products must retain auditable provenance');
assert.match(productsRoute, /historical_relations_copied:\s*false/, 'Reuse must not claim historical relations were copied');
// L'archivage doit rester refuse depuis un produit deja archive ou publie : la
// garde couvre desormais draft et active, ce qui est plus large que l'ancien
// « brouillon seulement », sans ouvrir la voie a un archivage arbitraire.
assert.match(productRoute, /current\.status\s*!==\s*'draft'\s*&&\s*current\.status\s*!==\s*'active'/, 'Only draft or active products may be archived');
assert.match(productRoute, /action:\s*'product\.archived'/, 'Product archival must leave an organization-scoped audit record');
assert.match(productRoute, /const actorUserId = user\.id/, 'Product archival must use the provisioned Tracefab user UUID');
assert.match(productRoute, /actor_user_id:\s*actorUserId/, 'Product archival audit must identify the database actor required by RLS');
assert.match(consoleJs, /data-action="archive-product"/, 'Draft product detail must expose an archive action');
assert.match(consoleJs, /p\.status\s*===\s*'archived'/, 'Archived products must leave the default active catalogue');

console.log('Customer-journey release blockers contract passed');
