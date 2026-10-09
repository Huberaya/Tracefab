import { readFile } from 'node:fs/promises';

const overview = await readFile(new URL('../api/_routes/quality/overview.ts', import.meta.url), 'utf8');
const webhook = await readFile(new URL('../api/_routes/webhooks/clerk.ts', import.meta.url), 'utf8');
const qualityCenter = await readFile(new URL('../quality-center/index.html', import.meta.url), 'utf8');
const operations = await readFile(new URL('../operations/index.html', import.meta.url), 'utf8');
const index = await readFile(new URL('../api/index.ts', import.meta.url), 'utf8');
const migration = await readFile(new URL('../prisma/migrations/20261006110000_quality_center_shared_access/migration.sql', import.meta.url), 'utf8');
const directoryMigration = await readFile(new URL('../prisma/migrations/20261006113000_clerk_directory_membership_sync/migration.sql', import.meta.url), 'utf8');
const schemaBindingMigration = await readFile(new URL('../prisma/migrations/20261006120000_external_schema_bindings/migration.sql', import.meta.url), 'utf8');
const clerkSyncFunctions = await readFile(new URL('../prisma/migrations/20261006123000_clerk_sync_security_functions/migration.sql', import.meta.url), 'utf8');
const schemaCatalog = await readFile(new URL('../api/_lib/schema-catalog.ts', import.meta.url), 'utf8');
const catalog = JSON.parse(await readFile(new URL('../catalog/questionnaires/product-data-core/1.0.json', import.meta.url), 'utf8'));
const qualityFr = JSON.parse(await readFile(new URL('../locales/fr/quality.json', import.meta.url), 'utf8')).quality;

assert(index.includes("/^quality\\/overview$/"), 'quality overview route is not registered');
assert(index.includes("/^operations\\/overview$/"), 'operations overview route is not registered');
assert(index.includes("/^webhooks\\/clerk$/"), 'Clerk webhook route is not registered');
assert(overview.includes('withTracefabUserContext'), 'quality overview does not establish RLS context');
assert(overview.includes('tracefab_can_access_org') && overview.includes('tracefab_can_access_shared_subject'), 'quality overview access guards are incomplete');
assert(overview.includes('invalid_quality_severity') && overview.includes('invalid_quality_status') && overview.includes('invalid_quality_limit'), 'quality filters are not strictly validated');
/*
 * La page est passée sur le runtime i18n partagé : le contenu métier vit dans
 * locales/{lang}/quality.json, plus dans le HTML. Ces deux assertions cherchaient
 * les libellés français dans le source et échouaient donc sur une migration
 * RÉUSSIE.
 *
 * La garantie visée — « la page expose les mutations » et « la page distingue
 * préparation et certification » — est vérifiée là où le contenu vit désormais :
 * la page référence les clés, le dictionnaire français contient le texte. Le
 * rendu effectif, dans les sept langues, est couvert par test:i18n:quality et
 * test:quality-center.
 */
assert(qualityCenter.includes("tr('quality.actions.ack')") && qualityCenter.includes("tr('quality.actions.waive')"),
  'Quality Center mutations are not exposed');
assert(qualityFr.actions.ack && qualityFr.actions.waive, 'Quality Center mutation labels are missing from the dictionary');
assert(qualityCenter.includes("tr('quality.disclaimer')"), 'Quality Center does not render the readiness disclaimer');
assert(/préparation/i.test(qualityFr.disclaimer) && /jamais/i.test(qualityFr.disclaimer) && /certification/i.test(qualityFr.disclaimer),
  'Quality Center does not explain readiness vs certification');
assert(operations.includes('notifications') && operations.includes('schedulerConfigured'), 'operations view is incomplete');
assert(webhook.includes('verifyWebhook') && webhook.includes('user.updated'), 'signed Clerk user webhook sync is incomplete');
assert(webhook.includes('organizationMembership.created') && webhook.includes('clerkMembershipId'), 'Clerk membership sync is incomplete');
assert(migration.includes('quality_issues_select_authorized') && migration.includes('tracefab_can_access_shared_subject'), 'shared quality issue RLS migration is incomplete');
assert(directoryMigration.includes('clerk_organization_id') && directoryMigration.includes('clerk_membership_id'), 'Clerk directory migration is incomplete');
assert(schemaBindingMigration.includes('tracefab_schema_catalog') && schemaBindingMigration.includes('tracefab_bind_schema') && schemaBindingMigration.includes('schema_bindings_select_authorized'), 'schema binding migration is incomplete');
assert(clerkSyncFunctions.includes('tracefab_sync_clerk_organization') && clerkSyncFunctions.includes('tracefab_sync_clerk_membership') && clerkSyncFunctions.includes('SECURITY DEFINER'), 'Clerk sync security functions are incomplete');
assert(schemaCatalog.includes('versioned_external_catalog') && schemaCatalog.includes('catalog/schemas'), 'schema catalog loader is incomplete');
assert(catalog.version === '1.0' && catalog.items.length >= 4, 'external questionnaire catalog is incomplete');

console.log('P1 Quality contract passed: tenant-scoped overview, explainable UI, signed Clerk sync, shared RLS and versioned catalog');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
