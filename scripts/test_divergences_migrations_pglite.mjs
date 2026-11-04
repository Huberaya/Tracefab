#!/usr/bin/env node
/**
 * Non-regression de reconciliation des migrations historiques.
 *
 * Le snapshot Neon du 04/11/2026 confirme les checksums Production/Preproduction.
 * Deux fichiers historiques ont été restaurés exactement. Le checksum PLM
 * (c944ce0c...) ne correspond à aucune version retrouvée dans Git : le fichier
 * courant est conservé, et Prisma doit BLOQUER tant que le fichier exact n'est
 * pas récupéré. Aucun checksum n'est modifié en base.
 *
 * Ce test ne se connecte à aucune base et ne modifie aucun historique.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
const conformes = {
  '20261005090000_supplier_portal_advanced_hardening':
    '560356c203df6d460f8488f44bdf1ce582d3f609eae1b4acd329ad3cd686bbb7',
  '20261009180000_public_read_context':
    'c12ee33303084b6710284139786058b8d088b2619d92372ea57f282e86480d04',
};
const fichiers = {};
for (const [migration, attendu] of Object.entries(conformes)) {
  const sql = lire(migration);
  fichiers[migration] = sql.toString('utf8');
  const calcule = sha256(sql);
  ok(`${migration} conserve l'empreinte appliquee`, calcule === attendu, calcule);
}

const plmName = '20261006210000_plm_erp_gs1_interoperability';
const plmShaApplied = 'c944ce0c21f128b8ee8c919de58179d4f25fdf3d2f7f087dacbca615b89c3861';
const plmShaCurrentMain = '6a8d03eb507b824e2a308d7e29113478d60d726255fcc1883cef56c506783044';
const plmInitial = lire(plmName).toString('utf8');
const plmShaCurrent = sha256(Buffer.from(plmInitial));
ok('le checksum PLM appliqué est identifié', plmShaApplied.length === 64);
ok('le fichier PLM du dépôt est conservé, mais son checksum diffère de la base',
  plmShaCurrent === plmShaCurrentMain && plmShaCurrent !== plmShaApplied,
  `appliqué=${plmShaApplied}; dépôt=${plmShaCurrent}`);

const planResult = spawnSync('node', [path.join(root, 'scripts/plan_reconciliation_migrations.mjs'), '--markdown'], { encoding: 'utf8' });
const planOutput = `${planResult.stdout || ''}\n${planResult.stderr || ''}`;
ok('le plan Prisma est bloqué tant que le checksum PLM exact manque',
  planResult.status !== 0 && planOutput.includes(plmName) && /checksum/i.test(planOutput),
  planOutput.slice(-1200));

console.log('\n  2. Les corrections fonctionnelles restent dans des migrations forward');
const supplierCompat = lire('20261005100000_supplier_invitation_compatibility').toString('utf8');
ok('la migration de compatibilite fournisseur reste presente',
  supplierCompat.includes('tracefab_validate_member_invitation_role'));
ok('elle refuse un owner sans relationship_id',
  /target_role\s*=\s*'owner'[\s\S]{0,180}relationship_id\s+IS\s+NULL/i.test(supplierCompat));

ok('le fichier PLM courant conserve les deux instructions de nettoyage',
  plmInitial.includes('DROP POLICY IF EXISTS plm_erp_sync_jobs_insert_brand')
  && plmInitial.includes('DROP POLICY IF EXISTS plm_erp_sync_jobs_select_brand'));

for (const migration of [
  '20261028150000_reconcile_plm_erp_sync_job_policies',
  '20261029180000_plm_erp_sync_jobs_policy_dedup',
]) {
  const sql = lire(migration).toString('utf8');
  ok(`${migration} supprime les anciennes politiques INSERT/SELECT`,
    sql.includes('DROP POLICY IF EXISTS plm_erp_sync_jobs_insert_brand')
    && sql.includes('DROP POLICY IF EXISTS plm_erp_sync_jobs_select_brand'));
  if (migration === '20261029180000_plm_erp_sync_jobs_policy_dedup') {
    ok(`${migration} reconstruit les politiques canoniques`,
      sql.includes('CREATE POLICY plm_sync_jobs_insert_brand')
      && sql.includes('CREATE POLICY plm_sync_jobs_select_org'));
  } else {
    ok(`${migration} est une suppression ciblée avec préconditions`,
      sql.includes('BEGIN;') && sql.includes('COMMIT;')
      && sql.includes('nombre_ou_identite_politiques_inattendu'));
  }
}

const publicRead = fichiers['20261009180000_public_read_context'];
ok('la migration historique public-read accorde les fonctions a tracefab_app',
  /GRANT EXECUTE ON FUNCTION[\s\S]*?TO tracefab_app/i.test(publicRead));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const deploy = String(pkg.scripts?.['db:deploy'] || '');
const bootstrap = fs.readFileSync(path.join(root, 'scripts/bootstrap_app_role.mjs'), 'utf8');
ok('db:deploy appelle Prisma migrate deploy sans modifier l’historique',
  deploy.trim() === 'prisma migrate deploy', deploy);
ok('le bootstrap tracefab_app est documente comme pre-requis sur base vierge',
  bootstrap.includes('AVANT la chaine de migrations')
  && bootstrap.includes('base vierge')
  && bootstrap.includes('ensureAppRoleFromUrl'));

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
console.log(`  ${verifies} verifications passees — 2 checksums restaurés, PLM bloqué, aucune réécriture d'historique.`);
