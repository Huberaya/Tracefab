#!/usr/bin/env node
/**
 * Non-regression de reconciliation des trois migrations historiques.
 *
 * Les empreintes ci-dessous ont ete lues dans _prisma_migrations de Production
 * et de Preproduction le 04/11/2026. Les fichiers du depot doivent rester
 * byte-for-byte identiques aux versions effectivement appliquees.
 *
 * Les evolutions ulterieures restent dans des migrations forward distinctes :
 * - supplier invitation : 20261005100000_supplier_invitation_compatibility ;
 * - politiques PLM : 20261028150000 et 20261029180000 ;
 * - bootstrap du role app avant les migrations : db:deploy.
 *
 * Ce test ne se connecte a aucune base et ne modifie aucun historique.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lire = (d) => fs.readFileSync(path.join(root, 'prisma', 'migrations', d, 'migration.sql'));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
let echecs = 0;
let verifies = 0;

function ok(label, condition, detail = '') {
  verifies += 1;
  if (condition) console.log(`  ok    ${label}`);
  else {
    echecs += 1;
    console.error(`  ECHEC ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\n  1. Empreintes historiques Production / Preproduction');
const attendues = {
  '20261005090000_supplier_portal_advanced_hardening':
    '560356c203df6d460f8488f44bdf1ce582d3f609eae1b4acd329ad3cd686bbb7',
  '20261006210000_plm_erp_gs1_interoperability':
    'c944ce0c21f128b8ee8c919de58179d4f25fdf3d2f7f087dacbca615b89c3861',
  '20261009180000_public_read_context':
    'c12ee33303084b6710284139786058b8d088b2619d92372ea57f282e86480d04',
};
const fichiers = {};
for (const [migration, attendu] of Object.entries(attendues)) {
  const sql = lire(migration);
  fichiers[migration] = sql.toString('utf8');
  const calcule = sha256(sql);
  ok(`${migration} conserve l'empreinte appliquee`, calcule === attendu, calcule);
}

console.log('\n  2. Les corrections fonctionnelles restent dans des migrations forward');
const supplierCompat = lire('20261005100000_supplier_invitation_compatibility').toString('utf8');
ok('la migration de compatibilite fournisseur reste presente',
  supplierCompat.includes('tracefab_validate_member_invitation_role'));
ok('elle refuse un owner sans relationship_id',
  /target_role\s*=\s*'owner'[\s\S]{0,180}relationship_id\s+IS\s+NULL/i.test(supplierCompat));

const plmInitial = fichiers['20261006210000_plm_erp_gs1_interoperability'];
ok('la migration PLM historique cree la politique canonique SELECT',
  plmInitial.includes('CREATE POLICY plm_sync_jobs_select_org'));
ok('la migration PLM historique cree la politique canonique INSERT',
  plmInitial.includes('CREATE POLICY plm_sync_jobs_insert_brand'));
ok('la migration PLM historique n' + "'" + 'a pas absorbe les suppressions ulterieures',
  !plmInitial.includes('DROP POLICY IF EXISTS plm_erp_sync_jobs_insert_brand'));

for (const migration of [
  '20261028150000_reconcile_plm_erp_sync_job_policies',
  '20261029180000_plm_erp_sync_jobs_policy_dedup',
]) {
  const sql = lire(migration).toString('utf8');
  ok(`${migration} supprime les anciennes politiques INSERT/SELECT`,
    sql.includes('DROP POLICY IF EXISTS plm_erp_sync_jobs_insert_brand')
    && sql.includes('DROP POLICY IF EXISTS plm_erp_sync_jobs_select_brand'));
  ok(`${migration} reconstruit les politiques canoniques`,
    sql.includes('CREATE POLICY plm_sync_jobs_insert_brand')
    && sql.includes('CREATE POLICY plm_sync_jobs_select_org'));
}

const publicRead = fichiers['20261009180000_public_read_context'];
ok('la migration historique public-read accorde les fonctions a tracefab_app',
  /GRANT EXECUTE ON FUNCTION[\s\S]*?TO tracefab_app/i.test(publicRead));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const deploy = String(pkg.scripts?.['db:deploy'] || '');
ok('db:deploy provisionne le role app AVANT prisma migrate deploy',
  deploy.indexOf('bootstrap_app_role.mjs') >= 0
  && deploy.indexOf('bootstrap_app_role.mjs') < deploy.indexOf('prisma migrate deploy'),
  deploy);

console.log('\n  3. La migration worker pending ne requiert pas SUPERUSER');
const worker = lire('20261028120100_worker_identity_not_forgeable').toString('utf8');
ok('aucun ALTER ROLE ne tente de modifier SUPERUSER',
  !/ALTER\s+ROLE\s+tracefab_worker/i.test(worker));
ok('le role worker est cree directement NOLOGIN et sans privileges eleves',
  /CREATE ROLE tracefab_worker[\s\S]{0,180}NOLOGIN[\s\S]{0,180}NOSUPERUSER[\s\S]{0,180}NOBYPASSRLS/i.test(worker));
ok('le role de migration obtient INHERIT et SET sans ADMIN OPTION',
  /GRANT tracefab_worker TO %I WITH INHERIT TRUE, SET TRUE/.test(worker));
ok('CREATE est retire au worker apres le transfert des fonctions',
  worker.indexOf('ALTER FUNCTION public.tracefab_notification_outbox_health() OWNER TO tracefab_worker')
    < worker.indexOf('REVOKE CREATE ON SCHEMA public FROM tracefab_worker'));
ok("l'appartenance worker du role de migration est conservee",
  !/REVOKE\s+tracefab_worker\s+FROM\s+current_user/i.test(worker));
ok('le worker est refuse si tracefab_app en est membre',
  worker.includes('tracefab_app_must_not_be_worker_member'));

console.log('\n  --------------------------------------------');
if (echecs > 0) {
  console.error(`  ${echecs} echec(s) sur ${verifies}.`);
  process.exit(1);
}
console.log(`  ${verifies} verifications passees — checksums historiques preserves, evolutions versionnees en forward.`);
