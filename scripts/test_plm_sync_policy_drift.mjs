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
/**
 * Les contrôles d'ABSENCE doivent porter sur le SQL, pas sur la prose : le
 * commentaire de cette migration dit « Aucun GRANT/REVOKE ... » et faisait
 * échouer le contrôle sur sa propre documentation. Un détecteur qui lit les
 * commentaires produit un faux positif — c'est un piège déjà rencontré dans ce
 * dépôt, on le neutralise ici de façon explicite.
 * Les contrôles de PRESENCE (BEGIN/COMMIT, DROP attendus) gardent le texte
 * complet : eux ne peuvent pas être trompés par un commentaire.
 */
const code = sql.replace(/--[^\n]*/g, '');
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
check(!/\b(GRANT|REVOKE)\b/i.test(code), 'ne modifie aucun privilège SQL');
check(!/\b(DELETE FROM|UPDATE\s+public\.|TRUNCATE)\b/i.test(code), 'ne modifie aucune donnée');

// Le détecteur doit encore VOIR une vraie écriture : un contrôle qui ne peut
// plus échouer ne prouve rien. Deux témoins, sur des textes synthétiques.
check(/\b(GRANT|REVOKE)\b/i.test('GRANT INSERT ON t TO r;'), 'témoin : un GRANT réel est détecté');
check(!/\b(GRANT|REVOKE)\b/i.test('-- aucun GRANT ici'.replace(/--[^\n]*/g, '')),
  'témoin : une mention en commentaire ne l est pas');
check(/Idempotent/i.test(sql), 'documente le caractère idempotent');

console.log(`test_plm_sync_policy_drift: ${checks}/${checks} PASS (contrôle statique uniquement)`);
