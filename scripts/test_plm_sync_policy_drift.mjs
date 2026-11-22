#!/usr/bin/env node
/**
 * Garde-fou statique sur l'unique migration corrective PLM/ERP retenue.
 * La preuve d'effet est couverte par test:plm-convergence sur PGlite.
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';

const url = new URL('../prisma/migrations/20261028150000_reconcile_plm_erp_sync_job_policies/migration.sql', import.meta.url);
const sql = fs.readFileSync(url, 'utf8');
const code = sql.replace(/--[^\n]*/g, '');
const checks = [
  ['transaction', /BEGIN\s*;/i.test(code) && /COMMIT\s*;/i.test(code)],
  ['precondition table cible', /plm_erp_sync_jobs_absente/i.test(code)],
  ['accepte uniquement etats connus de 2 ou 4 politiques', /v_policy_count NOT IN \(2, 4\)/i.test(code)],
  ['refuse politiques inconnues', /v_unexpected_count <> 0/i.test(code)],
  ['retire INSERT surnumeraire', /DROP POLICY IF EXISTS plm_erp_sync_jobs_insert_brand ON public\.plm_erp_sync_jobs;/i.test(code)],
  ['retire SELECT surnumeraire', /DROP POLICY IF EXISTS plm_erp_sync_jobs_select_brand ON public\.plm_erp_sync_jobs;/i.test(code)],
  ['preserve INSERT canonique', !/DROP POLICY[^;]*plm_sync_jobs_insert_brand/i.test(code)],
  ['preserve SELECT canonique', !/DROP POLICY[^;]*plm_sync_jobs_select_org/i.test(code)],
  ['aucun GRANT/REVOKE', !/\b(?:GRANT|REVOKE)\b/i.test(code)],
  ['aucune mutation de donnees', !/\b(?:INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|TRUNCATE)\b/i.test(code)],
  ['les commentaires sont exclus des contrôles d absence', /\bGRANT\b/i.test(sql) && !/\bGRANT\b/i.test(code)],
];
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
  assert.ok(pass, name);
}
console.log(`${checks.length}/${checks.length} PASS`);
