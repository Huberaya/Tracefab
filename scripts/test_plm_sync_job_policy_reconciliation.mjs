#!/usr/bin/env node
/**
 * Regression test for the production-observed duplicate PLM sync-job policies.
 * This is a static guard: database behavior must still be proven by the disposable
 * PostgreSQL migration workflow, never by running this against production.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationPath = path.join(root, 'prisma/migrations/20261028150000_reconcile_plm_erp_sync_job_policies/migration.sql');
const baselinePath = path.join(root, 'prisma/migrations/20261006210000_plm_erp_gs1_interoperability/migration.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');
const baseline = fs.readFileSync(baselinePath, 'utf8');
const checks = [];
const check = (name, condition) => checks.push({ name, condition });

check('drops the observed over-permissive INSERT policy',
  /DROP POLICY IF EXISTS plm_erp_sync_jobs_insert_brand ON public\.plm_erp_sync_jobs;/i.test(migration));
check('drops the duplicate SELECT policy',
  /DROP POLICY IF EXISTS plm_erp_sync_jobs_select_brand ON public\.plm_erp_sync_jobs;/i.test(migration));
check('preserves canonical INSERT policy limited to owner/admin/manager',
  /CREATE POLICY plm_sync_jobs_insert_brand[\s\S]*?ARRAY\['owner', 'admin', 'manager'\]::membership_role\[\]/i.test(baseline));
check('preserves canonical tenant-scoped SELECT policy',
  /CREATE POLICY plm_sync_jobs_select_org[\s\S]*?tracefab_is_org_member\(brand_organization_id\)/i.test(baseline));
check('does not alter grants or revoke privileges',
  !/\b(?:GRANT|REVOKE)\b/i.test(migration));
check('does not modify data or table definitions',
  !/\b(?:INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+TABLE)\b/i.test(migration));

for (const { name, condition } of checks) {
  console.log(`  ${condition ? 'ok' : 'FAIL'}  ${name}`);
}
console.log(`\n${checks.filter(x => x.condition).length}/${checks.length} checks passed`);
if (checks.some(x => !x.condition)) process.exit(1);
