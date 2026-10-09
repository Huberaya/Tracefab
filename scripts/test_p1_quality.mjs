import { readFile } from 'node:fs/promises';
import { pageSource } from './lib/page_source.mjs';

const overview = await readFile(new URL('../api/_routes/quality/overview.ts', import.meta.url), 'utf8');
const webhook = await readFile(new URL('../api/_routes/webhooks/clerk.ts', import.meta.url), 'utf8');
const qualityCenter = pageSource('quality-center/index.html');
const operations = pageSource('operations/index.html');
const index = await readFile(new URL('../api/index.ts', import.meta.url), 'utf8');
const migration = await readFile(new URL('../prisma/migrations/20261006110000_quality_center_shared_access/migration.sql', import.meta.url), 'utf8');

// quality-center/ ne contient plus de litteraux : sa copie vit dans le
// catalogue i18n partage (assets/i18n). Les deux assertions qui suivaient
// cherchaient des chaines francaises dans le HTML ; elles verifient la meme
// intention, mais au bon endroit — la page reference bien les cles, et le
// catalogue porte bien le sens attendu.
const i18nEnv = {};
new Function('window', await readFile(new URL('../assets/i18n/en.js', import.meta.url), 'utf8'))(i18nEnv);
const qEn = i18nEnv.TF_I18N_BUNDLES.en.quality;
const qFr = JSON.parse(await readFile(new URL('../assets/i18n/fr.json', import.meta.url), 'utf8')).quality;
const directoryMigration = await readFile(new URL('../prisma/migrations/20261006113000_clerk_directory_membership_sync/migration.sql', import.meta.url), 'utf8');
const schemaBindingMigration = await readFile(new URL('../prisma/migrations/20261006120000_external_schema_bindings/migration.sql', import.meta.url), 'utf8');
const clerkSyncFunctions = await readFile(new URL('../prisma/migrations/20261006123000_clerk_sync_security_functions/migration.sql', import.meta.url), 'utf8');
const schemaCatalog = await readFile(new URL('../api/_lib/schema-catalog.ts', import.meta.url), 'utf8');
const catalog = JSON.parse(await readFile(new URL('../catalog/questionnaires/product-data-core/1.0.json', import.meta.url), 'utf8'));

assert(index.includes("/^quality\\/overview$/"), 'quality overview route is not registered');
assert(index.includes("/^operations\\/overview$/"), 'operations overview route is not registered');
assert(index.includes("/^webhooks\\/clerk$/"), 'Clerk webhook route is not registered');
assert(overview.includes('withTracefabUserContext'), 'quality overview does not establish RLS context');
assert(overview.includes('tracefab_can_access_org') && overview.includes('tracefab_can_access_shared_subject'), 'quality overview access guards are incomplete');
assert(overview.includes('invalid_quality_severity') && overview.includes('invalid_quality_status') && overview.includes('invalid_quality_limit'), 'quality filters are not strictly validated');
assert(
  qualityCenter.includes("q('actionAck')") && qualityCenter.includes("q('actionWaive')")
    && /acknowledge/i.test(qEn.actionAck) && /waive/i.test(qEn.actionWaive)
    && qFr.actionAck === 'Acquitter' && qFr.actionWaive === 'Waiver',
  'Quality Center mutations are not exposed',
);
assert(
  qualityCenter.includes("q('heroLede')") && qualityCenter.includes("q('signInLede')")
    && qEn.heroLede.includes('certification') && qFr.heroLede.includes('certification')
    && qFr.signInLede.includes('explicables') && /explainable/i.test(qEn.signInLede),
  'Quality Center does not explain readiness vs certification',
);
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
