#!/usr/bin/env node
/**
 * Régression statique du durcissement RLS PLM/ERP.
 * Le test vérifie les objets et les rôles exacts dans la migration corrective.
 * La validation d'effet en base reste assurée par les suites PostgreSQL jetables.
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';

const migration = fs.readFileSync(
  new URL('../prisma/migrations/20261029180000_plm_erp_sync_jobs_policy_dedup/migration.sql', import.meta.url),
  'utf8',
);

for (const policy of [
  'plm_erp_sync_jobs_insert_brand',
  'plm_erp_sync_jobs_select_brand',
]) {
  assert.match(migration, new RegExp('DROP POLICY IF EXISTS ' + policy + '\\s+ON'));
}
assert.match(migration, /CREATE POLICY plm_sync_jobs_insert_brand[\s\S]*?FOR INSERT TO PUBLIC[\s\S]*?ARRAY\['owner', 'admin', 'manager'\]::membership_role\[\]/);
assert.doesNotMatch(migration, /ARRAY\[[^\]]*'contributor'[^\]]*\]::membership_role\[\]/);
assert.match(migration, /CREATE POLICY plm_sync_jobs_select_org[\s\S]*?FOR SELECT TO PUBLIC[\s\S]*?tracefab_is_org_member\(brand_organization_id\)/);
assert.match(migration, /to_regclass\('public\.plm_erp_sync_jobs'\)[\s\S]*?RAISE EXCEPTION/);
assert.doesNotMatch(migration, /\b(GRANT|REVOKE)\b/i);
console.log('PLM/ERP RLS policy dedup: 7/7 checks passed');
