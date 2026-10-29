#!/usr/bin/env node
/**
 * Garde-fou statique pour la migration qui retire les politiques PLM hors référentiel.
 * La preuve d'effet réelle exige une base jetable PostgreSQL et la confrontation de
 * catalogue de production après application autorisée ; ce test ne prétend pas les remplacer.
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';

const path = new URL('../prisma/migrations/20261029160000_plm_erp_sync_jobs_policy_drift/migration.sql', import.meta.url);
const sql = fs.readFileSync(path, 'utf8');
let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks++;
};

check(/BEGIN\s*;/i.test(sql) && /COMMIT\s*;/i.test(sql), 'migration transactionnelle');
check(/DROP POLICY IF EXISTS plm_erp_sync_jobs_insert_brand ON public\.plm_erp_sync_jobs;/i.test(sql), 'retire la politique INSERT surnuméraire');
check(/DROP POLICY IF EXISTS plm_erp_sync_jobs_select_brand ON public\.plm_erp_sync_jobs;/i.test(sql), 'retire la politique SELECT surnuméraire');
check(!/DROP POLICY[^;]*plm_sync_jobs_insert_brand/i.test(sql), 'préserve la politique INSERT canonique');
check(!/DROP POLICY[^;]*plm_sync_jobs_select_org/i.test(sql), 'préserve la politique SELECT canonique');
check(!/\b(GRANT|REVOKE)\b/i.test(sql), 'ne modifie aucun privilège SQL');
check(!/\b(DELETE FROM|UPDATE\s+public\.|TRUNCATE)\b/i.test(sql), 'ne modifie aucune donnée');
check(/Idempotent/i.test(sql), 'documente le caractère idempotent');

console.log(`test_plm_sync_policy_drift: ${checks}/${checks} PASS (contrôle statique uniquement)`);
