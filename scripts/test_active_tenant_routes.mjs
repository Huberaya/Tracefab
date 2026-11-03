#!/usr/bin/env node
/**
 * TraceFab — contrat de sélection du tenant sur les routes privées sensibles.
 *
 * Le contexte utilisateur seul ne suffit pas : un même compte peut être membre
 * de plusieurs marques ou fournisseurs. Chaque route métier doit valider un
 * tenant actif explicite et armer ce même tenant dans la transaction.
 *
 * Ce contrôle complète test_cross_tenant.mjs : il vérifie les routes connues
 * pour leurs repli multi-organisations et le helper fournisseur historique.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => {
  const absolute = join(ROOT, path);
  if (!existsSync(absolute)) throw new Error(`fichier absent: ${path}`);
  return readFileSync(absolute, 'utf8');
};

const BRAND_ROUTES = [
  'api/_routes/catalog/audit-export.ts',
  'api/_routes/catalog/products/export.ts',
  'api/_routes/catalog/products/import-jobs/[jobId].ts',
  'api/_routes/catalog/export/audit-dossier.ts',
  'api/_routes/catalog/export/products.ts',
  'api/_routes/catalog/export/suppliers.ts',
  'api/_routes/catalog/import/products.ts',
  'api/_routes/catalog/import/suppliers.ts',
  'api/_routes/catalog/products/import.ts',
  'api/_routes/catalog/suppliers/import.ts',
  'api/_routes/documents/[documentId]/download.ts',
  'api/_routes/documents/[documentId]/scan.ts',
  'api/_routes/documents/upload-intent.ts',
  'api/_routes/organization/storage/usage.ts',
  'api/_routes/integrations.ts',
  'api/_routes/integrations/ingest.ts',
  'api/_routes/integrations/jobs.ts',
  'api/_routes/integrations/plm.ts',
  'api/_routes/suppliers.ts',
];

const SUPPLIER_ROUTES = [
  'api/_routes/supplier/certifications/ocr-extract.ts',
  'api/_routes/supplier/certifications/[certificationId]/auto-verify.ts',
  'api/_routes/supplier/certifications/[certificationId].ts',
  'api/_routes/supplier/certifications.ts',
  'api/_routes/supplier/data-points/[dataPointId].ts',
  'api/_routes/supplier/data-points.ts',
  'api/_routes/supplier/documents/[documentId]/download.ts',
  'api/_routes/supplier/documents/[documentId]/scan.ts',
  'api/_routes/supplier/documents.ts',
  'api/_routes/supplier/documents/upload-intent.ts',
  'api/_routes/supplier/storage/usage.ts',
  'api/_routes/supplier/shares.ts',
  'api/_routes/supplier/members.ts',
  'api/_routes/supplier/member-invitations/[invitationId].ts',
  'api/_routes/supplier/profile/submit.ts',
  'api/_routes/supplier/profile.ts',
  'api/_routes/supplier/quality.ts',
  'api/_routes/supplier/sites/[siteId].ts',
  'api/_routes/supplier/sites.ts',
  'api/_routes/supplier/passport.ts',
  'api/_routes/supplier/passport/access-requests.ts',
  'api/_routes/suppliers/[supplierId]/profile/submit.ts',
];

const MULTI_TENANT_ROUTES = [
  'api/_routes/quality/suppliers/[supplierId].ts',
  'api/_routes/suppliers/[supplierId]/profile.ts',
];

const failures = [];
let checks = 0;
const ok = (message) => { checks += 1; console.log(`  ok    ${message}`); };
const fail = (message) => { failures.push(message); console.error(`  ECHEC ${message}`); };

const context = read('api/_lib/context.ts');
if (
  /export async function withTracefabTenantContext/.test(context)
  && /const activeOrganizationId = requestedTenantId\(req\)/.test(context)
  && /requireActiveTenant\(tx, req, user\.id, scope\)/.test(context)
  && /\}, activeOrganizationId\)/.test(context)
) ok('withTracefabTenantContext arme le tenant avant les requêtes métier et le valide dans la même transaction');
else fail('withTracefabTenantContext ne lie pas validation, GUC et tenant actif dans une seule transaction');

for (const path of BRAND_ROUTES) {
  let source;
  try { source = read(path); } catch (error) { fail(String(error)); continue; }
  const guarded = /withTracefabTenantContext\s*\(|requireActiveTenant\s*\(/.test(source);
  if (!guarded) fail(`${path}: aucun contrôle du tenant actif`);
  else ok(`${path}: tenant brand explicitement validé`);
  if (/activeBrandOrganizationIds\s*\(|activeOrganizationIds\s*\(|\b(?:brandIds|brandOrgIds|organizationIds)\s*\[0\]/.test(source)) {
    fail(`${path}: repli ou union des organisations encore présent`);
  }
}

for (const path of SUPPLIER_ROUTES) {
  let source;
  try { source = read(path); } catch (error) { fail(String(error)); continue; }
  if (!/withTracefabTenantContext\s*\(/.test(source)) {
    fail(`${path}: route fournisseur sans tenant actif explicite`);
    continue;
  }
  if (!/types:\s*\['supplier'\]/.test(source) || !/tenant\.organizationId/.test(source)) {
    fail(`${path}: le tenant fournisseur validé n'est pas celui utilisé par la route`);
    continue;
  }
  ok(`${path}: tenant fournisseur explicite`);
}

const bom = read('api/_routes/supplier/materials/import-bom.ts');
if (
  /withTracefabUserContext\(auth\.user\.id, auth\.user\.email, async \(tx\) => \{[\s\S]*?\}, requestedOrganizationId\(req\)\)/.test(bom)
  && /currentSupplier\(tx, auth\.user\.id, requestedOrganizationId\(req\)\)/.test(bom)
) ok('supplier/materials/import-bom: tenant demandé transmis au contexte et à la sélection');
else fail('supplier/materials/import-bom: le tenant demandé ne borne pas le contexte et le profil');

for (const path of MULTI_TENANT_ROUTES) {
  let source;
  try { source = read(path); } catch (error) { fail(String(error)); continue; }
  if (!/withTracefabTenantContext\s*\(/.test(source) || !/supplierAccessibleFromTenant|accessibleSupplier\(tx,[^;]*tenant/.test(source)) {
    fail(`${path}: accès fournisseur multi-tenant non borné au tenant actif`);
  } else {
    ok(`${path}: accès fournisseur borné au tenant actif (relation ou partage)`);
  }
}

const documentsHelper = read('api/_lib/documents.ts');
if (
  /documentAccessibleFromTenant/.test(documentsHelper)
  && /tenant\.organizationId/.test(documentsHelper)
  && /req\.brand_organization_id = \$\{tenant\.organizationId\}::uuid/.test(documentsHelper)
  && /req\.supplier_organization_id = \$\{tenant\.organizationId\}::uuid/.test(documentsHelper)
) ok('documentAccessibleFromTenant borne les partages et réponses au tenant actif');
else fail('documentAccessibleFromTenant ne borne pas tous les chemins d’accès au tenant actif');

const scanFlow = read('api/_lib/document-scan-flow.ts');
if ((scanFlow.match(/ownerOrganizationId/g) || []).length >= 6) {
  ok('document-scan-flow conserve le tenant propriétaire dans les trois transactions');
} else fail('document-scan-flow perd le tenant propriétaire entre les phases de scan');

const supplierProfile = read('api/_lib/supplier-profile.ts');
const currentSupplierStart = supplierProfile.indexOf('export async function currentSupplier(');
const currentSupplierEnd = supplierProfile.indexOf('\nexport ', currentSupplierStart + 1);
const currentSupplierSource = supplierProfile.slice(currentSupplierStart, currentSupplierEnd < 0 ? undefined : currentSupplierEnd);
if (/if \(!organizationId\) return null;/.test(currentSupplierSource) && !/orderBy:\s*\{\s*created_at:\s*'asc'\s*\}/.test(currentSupplierSource)) {
  ok('currentSupplier refuse l’absence de tenant au lieu de choisir la première adhésion');
} else {
  fail('currentSupplier conserve un repli ambigu vers la première adhésion fournisseur');
}

// Ces deux routes sont explicitement hors tenant : l'une enregistre une nouvelle
// organisation (aucun tenant fournisseur n'existe encore), l'autre sert le
// sélecteur et retourne uniquement les adhésions du compte authentifié.
const onboarding = read('api/_routes/supplier/onboarding.ts');
if (/tracefab_register_supplier_organization/.test(onboarding) && /withTracefabUserContext/.test(onboarding)) {
  ok('supplier/onboarding: exception account-level justifiée par la création initiale');
} else fail('supplier/onboarding: contrat de création initiale modifié sans requalification');
const organizations = read('api/_routes/supplier/organizations.ts');
if (/organization_memberships\.findMany/.test(organizations) && /organizations:\s*\{\s*type:\s*'supplier'/.test(organizations)) {
  ok('supplier/organizations: exception account-level limitée au sélecteur des adhésions fournisseur');
} else fail('supplier/organizations: contrat du sélecteur de tenant modifié sans requalification');

console.log(`\nRoutes tenant actif : ${checks} contrôles, ${failures.length} échec(s).`);
process.exit(failures.length === 0 ? 0 : 1);
