#!/usr/bin/env node
/**
 * Garde-fou : une seule migration corrective PLM/ERP doit rester versionnee.
 * Elle est la reference parce qu'elle valide l'etat de depart AVANT les DROP,
 * puis retire seulement les deux politiques surnumeraires dans une transaction.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrations = path.join(root, 'prisma/migrations');
const canonical = '20261028150000_reconcile_plm_erp_sync_job_policies';
const duplicates = [
  '20261029150000_plm_erp_sync_jobs_policy_deduplication',
  '20261029150000_plm_sync_jobs_policy_alignment',
  '20261029160000_plm_erp_sync_jobs_policy_drift',
];
const dirs = fs.readdirSync(migrations).filter((d) => /^\d{14}_/.test(d));
const names = dirs.filter((d) => /(?:plm_erp_sync_jobs_policy|plm_sync_jobs_policy|reconcile_plm_erp_sync_job_policies)/.test(d));
assert.deepEqual(names.sort(), [canonical], `Une seule migration corrective PLM/ERP attendue, trouvees: ${names.join(', ')}`);
const sql = fs.readFileSync(path.join(migrations, canonical, 'migration.sql'), 'utf8');
const code = sql.replace(/--[^\n]*/g, '');
const checks = [
  ['migration corrective canonique presente', fs.existsSync(path.join(migrations, canonical, 'migration.sql'))],
  ['transaction BEGIN/COMMIT', /^\s*BEGIN;[\s\S]*COMMIT;\s*$/i.test(code.trim())],
  ['preconditions fail-closed sur table et nombre de politiques', /plm_erp_sync_jobs_absente/.test(code) && /v_policy_count NOT IN \(2, 4\)/.test(code)],
  ['refuse les noms de politique inconnus', /v_unexpected_count <> 0/.test(code)],
  ['retire la politique INSERT surnumeraire', /DROP POLICY IF EXISTS plm_erp_sync_jobs_insert_brand ON public\.plm_erp_sync_jobs;/i.test(code)],
  ['retire la politique SELECT surnumeraire', /DROP POLICY IF EXISTS plm_erp_sync_jobs_select_brand ON public\.plm_erp_sync_jobs;/i.test(code)],
  ['ne supprime pas les politiques canoniques', !/DROP POLICY[^;]*plm_sync_jobs_insert_brand/i.test(code) && !/DROP POLICY[^;]*plm_sync_jobs_select_org/i.test(code)],
  ['aucun GRANT/REVOKE ni modification de donnees', !/\b(?:GRANT|REVOKE|INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|TRUNCATE)\b/i.test(code)],
  ['idempotence documentee', /idempotente/i.test(sql)],
  ['anciennes migrations jumelles absentes', duplicates.every((d) => !dirs.includes(d))],
];
for (const [name, pass] of checks) console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
console.log(`${checks.filter(([, pass]) => pass).length}/${checks.length} checks`);
if (checks.some(([, pass]) => !pass)) process.exit(1);
