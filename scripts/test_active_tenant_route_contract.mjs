#!/usr/bin/env node
/**
 * Contrat statique des routes sensibles au tenant actif.
 *
 * Ce test complète test_cross_tenant : il vérifie non seulement la présence
 * du helper, mais aussi la transmission du tenant au contexte transactionnel
 * et l'absence de repli sur la première organisation du compte.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const checks = [];
const check = (name, condition) => checks.push({ name, condition });

const routes = [
  ['api/_routes/integrations.ts', 'brand', ['owner', 'admin', 'manager']],
  ['api/_routes/integrations/ingest.ts', 'brand', ['owner', 'admin', 'manager']],
  ['api/_routes/integrations/jobs.ts', 'brand', null],
  ['api/_routes/suppliers.ts', 'brand', null],
  ['api/_routes/supplier/documents/upload-intent.ts', 'supplier', ['owner', 'admin', 'manager', 'contributor']],
  ['api/_routes/supplier/storage/usage.ts', 'supplier', null],
];

for (const [path, type, roles] of routes) {
  const src = read(path);
  check(`${path}: résout le tenant explicite`, /resolveActiveTenant\(tx, user\.id, requestedOrgId/.test(src));
  check(`${path}: transmet requestedOrgId au contexte transactionnel`, /\}, requestedOrgId\);/.test(src));
  check(`${path}: traduit les erreurs tenant en réponse HTTP`, /isTenantError\(error\)/.test(src));
  check(`${path}: n'utilise pas de repli première organisation`, !/brandOrgIds\[0\]|brandIds\[0\]|organizationIds\[0\]/.test(src));
  check(`${path}: borne le type d'organisation ${type}`, new RegExp(`types: \\[\\s*'${type}'\\s*\\]`).test(src));
  if (roles) {
    const expected = roles.map((r) => `'${r}'`).join(',\\s*');
    check(`${path}: borne les rôles métier`, new RegExp(`roles: \\[\\s*${expected}\\s*\\]`).test(src));
  }
}

const ingest = read('api/_routes/integrations/ingest.ts');
check('ingest : cible exclusivement le tenant résolu', /ingestPlmErpData\(tx, targetOrgId/.test(ingest));
const jobs = read('api/_routes/integrations/jobs.ts');
check('jobs : filtre les lignes sur le tenant résolu', jobs.includes('where: { brand_organization_id: activeOrgId }'));
const suppliers = read('api/_routes/suppliers.ts');
check('fournisseurs : joint la relation sur un seul tenant', suppliers.includes('r.brand_organization_id = ${tenant.organizationId}::uuid'));
const upload = read('api/_routes/supplier/documents/upload-intent.ts');
check('upload : document et clé de stockage utilisent le fournisseur du tenant', /currentSupplier\(tx, user\.id, tenant\.organizationId\)/.test(upload));
const usage = read('api/_routes/supplier/storage/usage.ts');
check('storage : quota lu pour le fournisseur du tenant', /getOrganizationStorageUsage\(tx, supplier\.organization_id\)/.test(usage));


const schemaBindings = read('api/_routes/schema-bindings.ts');
check('schema-bindings : GET résout un tenant explicite', schemaBindings.includes('requireActiveTenant(tx, req, user.id'));
check('schema-bindings : POST résout le tenant fourni au contexte', schemaBindings.includes('resolveActiveTenant(tx, user.id, activeOrganizationId'));
check('schema-bindings : le tenant est armé dans la transaction', schemaBindings.includes('}, activeOrganizationId)') && schemaBindings.includes('}, requestedTenantId(req))'));
check('schema-bindings : le sujet est borné au tenant avant lecture/écriture', schemaBindings.includes('subjectBelongsToTenant'));
check('schema-bindings : les erreurs tenant sont traitées', schemaBindings.includes('isTenantError(error)'));


const catalogImport = read('api/_routes/catalog/products/import.ts');
check('catalog import : refuse le repli sur l’union des marques', !catalogImport.includes('activeBrandOrganizationIds'));
check('catalog import : résout explicitement le tenant brand du CSV', catalogImport.includes("resolveActiveTenant(tx, user.id, requestedOrganizationId, { types: ['brand'] })"));
check('catalog import : arme le tenant dans le contexte SQL', catalogImport.includes('}, requestedOrganizationId)'));
check('catalog import : traite les erreurs tenant', catalogImport.includes('isTenantError(error)'));

const massBalance = read('api/_routes/products/[productId]/mass-balance.ts');
check('mass-balance : exige un tenant brand actif', (massBalance.match(/resolveActiveTenant\(tx, user\.id, activeOrganizationId, \{ types: \['brand'\] \}\)/g) || []).length === 2);
check('mass-balance : borne le produit au tenant avant lecture et écriture', (massBalance.match(/brand_organization_id: tenant\.organizationId/g) || []).length === 2);
check('mass-balance : arme le tenant dans les deux transactions', (massBalance.match(/\}, activeOrganizationId\)/g) || []).length === 2);
check('mass-balance : traite les erreurs tenant', massBalance.includes('isTenantError(err)'));


const massBalanceAllocate = read('api/_routes/products/[productId]/mass-balance/allocate.ts');
check('allocation TC : résout un tenant brand ou supplier explicite', massBalanceAllocate.includes("types: ['brand', 'supplier']"));
check('allocation TC : arme le tenant dans le contexte SQL', massBalanceAllocate.includes('}, activeOrganizationId)'));
check('allocation TC : exige un lien actif au produit ou au TC vendeur', massBalanceAllocate.includes('if (!product && !certificate) return null'));
check('allocation TC : traite les erreurs tenant', massBalanceAllocate.includes('isTenantError(err)'));

const definerMigration = read('prisma/migrations/20261105170000_active_tenant_security_definer_guards/migration.sql');
const definerGuards = [
  ['tracefab_add_supply_chain_link', 'tracefab_require_active_tenant_for_product'],
  ['tracefab_create_supply_chain_node', 'tracefab_require_active_tenant_for_product'],
  ['tracefab_update_supply_chain_node', 'tracefab_require_active_tenant_for_product'],
  ['tracefab_delete_supply_chain_node', 'tracefab_require_active_tenant_for_product'],
  ['tracefab_update_supply_chain_link', 'tracefab_require_active_tenant_for_supply_chain_link'],
  ['tracefab_delete_supply_chain_link', 'tracefab_require_active_tenant_for_product'],
  ['tracefab_allocate_tc_quantity', 'tracefab_require_active_tenant_for_tc_allocation'],
  ['tracefab_calculate_product_pef', 'tracefab_require_active_tenant_for_product'],
  ['tracefab_compute_dpp_readiness', 'tracefab_require_active_tenant_for_product'],
  ['tracefab_compute_product_quality', 'tracefab_require_active_tenant_for_product'],
  ['tracefab_create_data_request', 'tracefab_require_active_tenant_for_organization'],
  ['tracefab_create_product', 'tracefab_require_active_tenant_for_organization'],
  ['tracefab_reconcile_mass_balance', 'tracefab_require_active_tenant_for_product'],
  ['tracefab_set_dpp_publication', 'tracefab_require_active_tenant_for_product'],
  ['tracefab_start_product_revision', 'tracefab_require_active_tenant_for_product'],
  ['tracefab_update_product_data', 'tracefab_require_active_tenant_for_product'],
  ['tracefab_bind_schema', 'tracefab_require_active_tenant_for_schema_subject'],
  ['tracefab_get_product_traceability', 'tracefab_require_active_tenant_for_product'],
  ['tracefab_mark_dpp_ready_to_publish', 'tracefab_require_active_tenant_for_dpp_record'],
];
for (const [fn, helper] of definerGuards) {
  check(`migration SQL : ${fn} reçoit une garde ${helper}`,
    definerMigration.includes(`('${fn}'`) && definerMigration.includes(helper));
}
check('migration SQL : le remplacement préserve OID, propriétaire et ACL',
  definerMigration.includes('active_tenant_guard_changed_oid_owner_or_acl'));
check('migration SQL : le helper ne reçoit pas EXECUTE de PUBLIC',
  (definerMigration.match(/REVOKE ALL ON FUNCTION/g) || []).length === 6);

const failures = checks.filter((c) => !c.condition);
for (const c of checks) console.log(`${c.condition ? 'OK' : 'ECHEC'} ${c.name}`);
console.log(`\n${checks.length - failures.length}/${checks.length} contrôles réussis`);
if (failures.length) process.exit(1);
