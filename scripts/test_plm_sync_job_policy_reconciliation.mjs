#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationPath = path.join(root, 'prisma/migrations/20261028150000_reconcile_plm_erp_sync_job_policies/migration.sql');
const baselinePath = path.join(root, 'prisma/migrations/20261006210000_plm_erp_gs1_interoperability/migration.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');
const baseline = fs.readFileSync(baselinePath, 'utf8');

/**
 * Les contrôles doivent porter sur le CODE, pas sur les commentaires.
 *
 * Deux échecs venaient de là : `/^BEGIN;/` ne trouvait rien parce que le
 * fichier commence par un en-tête de commentaires, et le contrôle des
 * GRANT/REVOKE matchait la phrase « Aucun GRANT/REVOKE » de la documentation.
 * Un test qui échoue sur son propre commentaire n'est pas un test : il apprend
 * à réécrire les commentaires au lieu de vérifier le code.
 *
 * On retire donc les commentaires de ligne avant d'analyser — et on vérifie en
 * plus que les motifs interdits n'apparaissent pas dans le code restant.
 */
const codeSeul = (sql) => sql
  .split('\n')
  .map((l) => {
    // Un `--` dans une chaîne littérale n'est pas un commentaire : on protège
    // le contenu des quotes simple avant de couper.
    let dansQuote = false;
    for (let i = 0; i < l.length; i += 1) {
      if (l[i] === "'") dansQuote = !dansQuote;
      else if (!dansQuote && l[i] === '-' && l[i + 1] === '-') return l.slice(0, i);
    }
    return l;
  })
  .join('\n');
const migrationCode = codeSeul(migration);
const checks = [];
const check = (name, condition) => checks.push({ name, condition });

check('wraps the correction in a transaction',
  /^\s*BEGIN;[\s\S]*COMMIT;\s*$/i.test(migrationCode.trim()));
check('fails closed if the target table is missing', /plm_erp_sync_jobs_absente/i.test(migration));
check('fails closed if canonical INSERT policy is missing', /politique_canonique_insert_absente/i.test(migration));
check('fails closed if canonical SELECT policy is missing', /politique_canonique_select_absente/i.test(migration));
check('fails closed if canonical INSERT policy is unexpectedly permissive', /politique_canonique_insert_inattendue/i.test(migration));
check('drops the observed over-permissive INSERT policy', /DROP POLICY IF EXISTS plm_erp_sync_jobs_insert_brand ON public\.plm_erp_sync_jobs;/i.test(migration));
check('drops the duplicate SELECT policy', /DROP POLICY IF EXISTS plm_erp_sync_jobs_select_brand ON public\.plm_erp_sync_jobs;/i.test(migration));
check('preserves canonical INSERT policy limited to owner/admin/manager', /CREATE POLICY plm_sync_jobs_insert_brand[\s\S]*?ARRAY\['owner', 'admin', 'manager'\]::membership_role\[\]/i.test(baseline));
check('preserves canonical tenant-scoped SELECT policy', /CREATE POLICY plm_sync_jobs_select_org[\s\S]*?tracefab_is_org_member\(brand_organization_id\)/i.test(baseline));
check('does not alter grants or revoke privileges', !/\b(?:GRANT|REVOKE)\b/i.test(migrationCode));
check('the check above is not fooled by a comment mentioning GRANT/REVOKE',
  /\bGRANT\b/i.test(migration) && !/\bGRANT\b/i.test(migrationCode));
check('does not modify data or table definitions',
  !/\b(?:INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+TABLE)\b/i.test(migrationCode));

for (const { name, condition } of checks) console.log(`  ${condition ? 'ok' : 'FAIL'}  ${name}`);
console.log(`\n${checks.filter(x => x.condition).length}/${checks.length} checks passed`);
if (checks.some(x => !x.condition)) process.exit(1);
