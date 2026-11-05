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
check('jobs : filtre les lignes sur le tenant résolu', /where: \\{ brand_organization_id: activeOrgId \\}/.test(jobs));
const suppliers = read('api/_routes/suppliers.ts');
check('fournisseurs : joint la relation sur un seul tenant', /r\.brand_organization_id = \$\\{tenant\.organizationId\\}::uuid/.test(suppliers));
const upload = read('api/_routes/supplier/documents/upload-intent.ts');
check('upload : document et clé de stockage utilisent le fournisseur du tenant', /currentSupplier\(tx, user\.id, tenant\.organizationId\)/.test(upload));
const usage = read('api/_routes/supplier/storage/usage.ts');
check('storage : quota lu pour le fournisseur du tenant', /getOrganizationStorageUsage\(tx, supplier\.organization_id\)/.test(usage));

const failures = checks.filter((c) => !c.condition);
for (const c of checks) console.log(`${c.condition ? 'OK' : 'ECHEC'} ${c.name}`);
console.log(`\\n${checks.length - failures.length}/${checks.length} contrôles réussis`);
if (failures.length) process.exit(1);
