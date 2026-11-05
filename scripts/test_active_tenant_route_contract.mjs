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

const tcRegistrationRoute = read('api/_routes/mass-balance/certificates.ts');
check('certificats TC : la route exige que le tenant actif soit vendeur ou acheteur',
  tcRegistrationRoute.includes("sellerOrganizationId !== tenant.organizationId && buyerOrganizationId !== tenant.organizationId"));
const tcRegistrationMigration = read('prisma/migrations/20261105180000_active_tenant_tc_registration_guard/migration.sql');
check('certificats TC : la fonction SECURITY DEFINER vérifie elle-même le tenant actif',
  tcRegistrationMigration.includes('tracefab_register_transaction_certificate')
    && tcRegistrationMigration.includes('tracefab_in_active_tenant(p_seller_organization_id)')
    && tcRegistrationMigration.includes('tracefab_in_active_tenant(p_buyer_organization_id)'));
check('certificats TC : la migration préserve OID, propriétaire et ACL',
  tcRegistrationMigration.includes('active_tenant_tc_registration_changed_oid_owner_or_acl'));
const activeTenantDbTest = read('scripts/test_neon_active_tenant.mjs');
check('certificats TC : test PostgreSQL positif et refus direct inter-tenant',
  activeTenantDbTest.includes('tracefab_register_transaction_certificate accepte un appel direct')
    && activeTenantDbTest.includes("await assertTenantGuard('tracefab_register_transaction_certificate'"));

const qualityCollectionMigration = read('prisma/migrations/20261105190000_active_tenant_quality_collection_guards/migration.sql');
const qualityCollectionFunctions = [
  ['tracefab_acknowledge_quality_issue', 'v_issue.owner_organization_id'],
  ['tracefab_waive_quality_issue', 'v_issue.owner_organization_id'],
  ['tracefab_add_data_request_item', 'v_request.brand_organization_id'],
  ['tracefab_send_data_request', 'v_request.brand_organization_id'],
  ['tracefab_submit_data_request', 'v_request.supplier_organization_id'],
  ['tracefab_submit_data_response', 'v_request.supplier_organization_id'],
  ['tracefab_review_data_response', 'v_request.brand_organization_id'],
];
for (const [fn, tenantExpression] of qualityCollectionFunctions) {
  check(`migration SQL : ${fn} exige le tenant actif de ${tenantExpression}`,
    qualityCollectionMigration.includes(fn)
      && qualityCollectionMigration.includes(`tracefab_require_active_tenant_for_organization(${tenantExpression})`));
}
check('migration qualité/collecte : helpers accordés aux propriétaires, jamais au runtime',
  qualityCollectionMigration.includes('GRANT EXECUTE ON FUNCTION public.tracefab_require_active_tenant_for_organization(uuid)')
    && qualityCollectionMigration.includes('active_tenant_quality_collection_runtime_owns_definer_function')
    && qualityCollectionMigration.includes('active_tenant_quality_collection_helper_executable_by_runtime'));
const tenantBoundRoutes = [
  'api/_routes/quality-issues/[issueId]/acknowledge.ts',
  'api/_routes/quality-issues/[issueId]/waive.ts',
  'api/_routes/data-requests/[requestId]/items.ts',
  'api/_routes/data-requests/[requestId]/send.ts',
  'api/_routes/data-requests/[requestId]/submit.ts',
  'api/_routes/data-request-items/[itemId]/response.ts',
];
for (const path of tenantBoundRoutes) {
  const src = read(path);
  check(`${path}: arme et valide le tenant actif`,
    src.includes('requireActiveTenant(tx, req, user.id')
      && src.includes('requestedTenantId(req)')
      && src.includes('isTenantError(error)'));
}
const materialCertificationMigration = read('prisma/migrations/20261105200000_active_tenant_material_certification_guards/migration.sql');
for (const [fn, guard] of [
  ['tracefab_create_material', 'p_owner_organization_id'],
  ['tracefab_update_material', 'v_material.owner_organization_id'],
  ['tracefab_register_certification', 'p_owner_organization_id'],
  ['tracefab_update_certification', 'v_certification.owner_organization_id'],
]) {
  check(`migration SQL : ${fn} exige le tenant actif`,
    materialCertificationMigration.includes(fn)
      && materialCertificationMigration.includes(`tracefab_require_active_tenant_for_organization(${guard})`));
}
for (const path of ['api/_routes/materials.ts', 'api/_routes/materials/[materialId].ts']) {
  const src = read(path);
  check(`${path}: résout et arme le tenant actif`,
    src.includes('requireActiveTenant(tx, req, user.id') && src.includes('requestedTenantId(req)'));
}
for (const path of ['api/_routes/supplier/certifications.ts', 'api/_routes/supplier/certifications/[certificationId].ts']) {
  const src = read(path);
  check(`${path}: exige un tenant supplier explicite`,
    src.includes("resolveActiveTenant(tx, user.id, activeOrganizationId, { types: ['supplier'] })")
      && src.includes('}, activeOrganizationId)')
      && src.includes('isTenantError(error)'));
}
const materialCertificationDbTest = read('scripts/test_neon_active_tenant.mjs');
for (const fn of ['tracefab_create_material','tracefab_update_material','tracefab_register_certification','tracefab_update_certification']) {
  check(`PostgreSQL : test négatif direct pour ${fn}`,
    materialCertificationDbTest.includes(`await assertTenantGuard('${fn}'`));
}

const supplierProfilePassportMigration = read('prisma/migrations/20261105210000_active_tenant_supplier_profile_passport_guards/migration.sql');
for (const [fn, guard] of [
  ['tracefab_update_supplier_profile', 'v_supplier.organization_id'],
  ['tracefab_submit_supplier_profile', 'v_supplier.organization_id'],
  ['tracefab_get_or_create_supplier_passport', 'p_supplier_organization_id'],
  ['tracefab_update_supplier_passport', 'p_supplier_organization_id'],
]) {
  check(`migration SQL : ${fn} exige le tenant fournisseur actif`,
    supplierProfilePassportMigration.includes(fn)
      && supplierProfilePassportMigration.includes(`tracefab_require_active_tenant_for_organization(${guard})`));
}
for (const path of [
  'api/_routes/supplier/profile.ts',
  'api/_routes/supplier/profile/submit.ts',
  'api/_routes/suppliers/[supplierId]/profile.ts',
  'api/_routes/suppliers/[supplierId]/profile/submit.ts',
]) {
  const src = read(path);
  check(`${path}: borne les mutations au tenant fournisseur`,
    src.includes("types: ['supplier']")
      && src.includes('requestedTenantId(req)')
      && src.includes('isTenantError(error)'));
}
const supplierPassportRoute = read('api/_routes/supplier/passport.ts');
check('supplier passport : résout un tenant supplier explicite', supplierPassportRoute.includes("resolveActiveTenant(tx, user.id, activeOrganizationId, { types: ['supplier'] })"));
check('supplier passport : arme le tenant dans le contexte SQL', supplierPassportRoute.includes('}, activeOrganizationId)'));
check('supplier passport : traite les erreurs tenant', supplierPassportRoute.includes('isTenantError(err)'));
const universalPassportTest = read('scripts/test_neon_universal_passport.mjs');
check('passeport universel : le parcours positif arme puis efface le tenant actif', (universalPassportTest.match(/set_config\\('tracefab\\.active_organization_id'/g) || []).length === 3);

const supplierProfileDbTest = read('scripts/test_neon_active_tenant.mjs');
for (const fn of [
  'tracefab_update_supplier_profile','tracefab_submit_supplier_profile',
  'tracefab_get_or_create_supplier_passport','tracefab_update_supplier_passport',
]) {
  check(`PostgreSQL : test négatif direct pour ${fn}`,
    supplierProfileDbTest.includes(`await assertTenantGuard('${fn}'`));
}

const qualityCapMigration = read('prisma/migrations/20261105220000_active_tenant_quality_cap_guards/migration.sql');
for (const [fn, guard] of [
  ['tracefab_create_quality_cap', 'v_issue.owner_organization_id'],
  ['tracefab_submit_quality_remediation', 'v_cap.supplier_organization_id'],
  ['tracefab_review_quality_remediation', 'v_cap.brand_organization_id'],
]) {
  check(`migration SQL : ${fn} exige le tenant actif de la partie concernée`,
    qualityCapMigration.includes(fn)
      && qualityCapMigration.includes(`tracefab_require_active_tenant_for_organization(${guard})`));
}
for (const [path, type] of [
  ['api/_routes/quality/issues/[issueId]/cap.ts', 'brand'],
  ['api/_routes/quality/caps/[capId]/submit-remediation.ts', 'supplier'],
  ['api/_routes/quality/caps/[capId]/review.ts', 'brand'],
]) {
  const src = read(path);
  check(`${path}: borne le CAP au tenant ${type}`,
    src.includes(`types: ['${type}']`)
      && src.includes('requestedTenantId(req)')
      && src.includes('isTenantError(err)'));
}
const qualityCapDbTest = read('scripts/test_neon_active_tenant.mjs');
for (const fn of ['tracefab_create_quality_cap','tracefab_submit_quality_remediation','tracefab_review_quality_remediation']) {
  check(`PostgreSQL : test positif/négatif CAP pour ${fn}`,
    qualityCapDbTest.includes(`await assertTenantGuard('${fn}'`));
}

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
check('migration SQL : les six helpers sont révoqués de PUBLIC',
  (definerMigration.match(/REVOKE ALL ON FUNCTION[^;]+ FROM PUBLIC;/g) || []).length === 6);
check('migration SQL : les six helpers sont révoqués de tracefab_app',
  (definerMigration.match(/REVOKE ALL ON FUNCTION[^;]+ FROM tracefab_app;/g) || []).length === 6);
check('migration SQL : refuse un propriétaire de fonction appelante égal au runtime',
  definerMigration.includes("active_tenant_guard_runtime_role_owns_definer_function"));
check('migration SQL : postcondition vérifie l’absence d’EXECUTE effectif du runtime',
  definerMigration.includes("active_tenant_guard_helpers_executable_by_runtime"));

const failures = checks.filter((c) => !c.condition);
for (const c of checks) console.log(`${c.condition ? 'OK' : 'ECHEC'} ${c.name}`);
console.log(`\n${checks.length - failures.length}/${checks.length} contrôles réussis`);
if (failures.length) process.exit(1);
