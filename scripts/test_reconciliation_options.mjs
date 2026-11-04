#!/usr/bin/env node
/**
 * La réconciliation du 04/11/2026 n'autorise aucun resolve.
 *
 * Les exports réels de Production et Préproduction montrent 56 migrations
 * terminées (51 via Prisma, 5 hors bande), 13 absentes et deux tentatives
 * annulées suivies d'une réussite. Les 13 absentes doivent être exécutées par
 * Prisma après validation ; les 5 hors bande ne doivent pas être rejouées.
 *
 * Ce test remplace l'ancien scénario à 11 écarts / 54 migrations, devenu faux
 * après le relevé Neon du 04/11. Il ne se connecte à aucune base.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  PRODUCTION_APPLIED, ROLLED_BACK_ATTEMPTS, ECARTS, CATALOGUE, HORS_BANDE, CHECKSUM_EXCEPTIONS,
} from './lib/ecarts_migrations.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshot = JSON.parse(fs.readFileSync(
  path.join(root, 'docs/security/2026-11-04-neon-migration-history-snapshot.json'), 'utf8',
));
const worker = fs.readFileSync(path.join(root,
  'prisma/migrations/20261028120100_worker_identity_not_forgeable/migration.sql'), 'utf8');
const planPath = path.join(root, 'scripts/plan_reconciliation_migrations.mjs');
const planResult = spawnSync('node', [planPath, '--markdown'], { encoding: 'utf8' });
const planAuto = spawnSync('node', [planPath, '--autotest'], { encoding: 'utf8' });
const plan = `${planResult.stdout || ''}${planResult.stderr || ''}`;
const planAutoOutput = `${planAuto.stdout || ''}${planAuto.stderr || ''}`;
const assisted = fs.readFileSync(path.join(root, 'scripts/lib/migrations_assistees.mjs'), 'utf8');
const migrationsDir = path.join(root, 'prisma/migrations');

let verifies = 0;
const ok = (label, condition, detail = '') => {
  assert.ok(condition, `${label}${detail ? ` — ${detail}` : ''}`);
  verifies += 1;
};

const appliedNames = Object.keys(PRODUCTION_APPLIED);
const pendingNames = Object.keys(ECARTS);
const outOfBandNames = Object.keys(HORS_BANDE);

console.log('\n  1. L’historique mesuré, sans confusion entre états');
ok('les deux environnements ont le même snapshot', snapshot.environments.includes('Production') && snapshot.environments.includes('Preproduction'));
ok('56 migrations ont une ligne terminée', appliedNames.length === 56 && snapshot.applied.length === 56);
ok('13 migrations sont absentes de l’historique', pendingNames.length === 13 && snapshot.missing.length === 13);
ok('51 migrations ont été exécutées via Prisma', snapshot.applied.filter((m) => m.applied_steps_count > 0).length === 51);
ok('5 migrations hors bande ont applied_steps_count=0', outOfBandNames.length === 5 && snapshot.out_of_band.length === 5);
ok('deux tentatives annulées sont suivies d’une réussite', ROLLED_BACK_ATTEMPTS.length === 2
  && ROLLED_BACK_ATTEMPTS.every((m) => Boolean(PRODUCTION_APPLIED[m.name])));
ok('aucune migration inachevée ne subsiste', snapshot.unfinished.length === 0);
ok('les tentatives annulées ne sont pas classées en attente',
  ROLLED_BACK_ATTEMPTS.every((m) => !ECARTS[m.name]));

console.log('\n  2. Les cinq migrations hors bande sont prouvées et ne sont pas rejouées');
for (const name of outOfBandNames) {
  const entry = snapshot.applied.find((m) => m.name === name);
  ok(`${name} possède une ligne terminée avec 0 étape`, Boolean(entry && entry.applied_steps_count === 0));
  ok(`${name} est classée hors bande, pas absente`, Boolean(PRODUCTION_APPLIED[name] && !ECARTS[name]));
}
ok('les 12 objets des migrations hors bande sont présents sur les deux environnements',
  snapshot.out_of_band_objects.length === 12
  && snapshot.out_of_band_objects.every((o) => o.production_present && o.preproduction_present));

console.log('\n  3. Les 13 migrations absentes sont toutes classées');
for (const name of pendingNames) {
  ok(`${name} existe dans le depot`, fs.existsSync(path.join(migrationsDir, name, 'migration.sql')));
  ok(`${name} est explicitement ABSENTE`, ECARTS[name].historique === 'ABSENTE');
  ok(`${name} possède une observation catalogue`, Boolean(CATALOGUE[name]?.catalogue && CATALOGUE[name]?.statut));
  ok(`${name} n’est pas déjà dans l’historique réussi`, !PRODUCTION_APPLIED[name]);
}
const plmRepairName = '20261104090000_plm_integrations_and_gs1_constraints';
ok('la correction forward PLM/GS1 est postérieure au snapshot et non appliquée',
  fs.existsSync(path.join(migrationsDir, plmRepairName, 'migration.sql'))
  && !PRODUCTION_APPLIED[plmRepairName] && !ECARTS[plmRepairName]
  && plan.includes(plmRepairName));
ok('les migrations PLM canoniques restent à appliquer, sans resolve',
  Boolean(ECARTS['20261028150000_reconcile_plm_erp_sync_job_policies'])
  && Boolean(ECARTS['20261029180000_plm_erp_sync_jobs_policy_dedup']));

console.log('\n  4. Écart de checksum PLM borné, aucun resolve ni réécriture d’historique');
const plmName = '20261006210000_plm_erp_gs1_interoperability';
const plmException = CHECKSUM_EXCEPTIONS[plmName];
ok('une seule exception est épinglée aux checksums Production et dépôt',
  plmException?.appliedChecksum === snapshot.applied.find((m) => m.name === plmName)?.checksum
  && plmException?.repositoryChecksum === '6a8d03eb507b824e2a308d7e29113478d60d726255fcc1883cef56c506783044'
  && plmException?.exactHistoricalSqlRecovered === false
  && fs.existsSync(path.join(root, plmException.evidence)));
ok('le plan est exécutable et conserve l’avertissement historique PLM',
  planResult.status === 0 && plan.includes(plmName) && /écart historique documenté/i.test(plan)
  && /Préproduction/i.test(plan) && /Production/i.test(plan), plan.slice(-900));
ok('les autotests des garde-fous passent', planAuto.status === 0 && /Autotest OK : 3\/3/.test(planAutoOutput), planAutoOutput.slice(-500));
ok('le plan ne propose aucun resolve', !/migrate\s+resolve\s+--(?:applied|rolled-back)/i.test(plan));
ok('le plan ne modifie pas _prisma_migrations', !/(UPDATE|DELETE\s+FROM)\s+_prisma_migrations/i.test(plan));

console.log('\n  5. La migration worker est compatible avec un rôle non-superutilisateur');
ok('aucun ALTER ROLE tracefab_worker', !/ALTER\s+ROLE\s+tracefab_worker/i.test(worker));
ok('le worker est créé NOLOGIN et sans privilèges élevés',
  /CREATE ROLE tracefab_worker[\s\S]{0,180}NOLOGIN[\s\S]{0,180}NOSUPERUSER[\s\S]{0,180}NOBYPASSRLS/i.test(worker));
ok('le migrateur obtient INHERIT et SET sans ADMIN OPTION',
  /GRANT tracefab_worker TO %I WITH INHERIT TRUE, SET TRUE/.test(worker));
const workerVerification = worker.slice(worker.indexOf('DO $worker_verify
  worker.indexOf('ALTER FUNCTION public.tracefab_notification_outbox_health() OWNER TO tracefab_worker')
    < worker.indexOf('REVOKE CREATE ON SCHEMA public FROM tracefab_worker'));
ok('l’appartenance SET du migrateur est conservée',
  !/REVOKE\s+tracefab_worker\s+FROM\s+current_user/i.test(worker));
ok('aucune migration assistée ne demande encore SUPERUSER',
  /MIGRATIONS_ASSISTEES\s*=\s*Object\.freeze\(\{\}\)/.test(assisted));

console.log('\n  --------------------------------------------');
console.log(`  ${verifies} vérifications passées — snapshot Neon 04/11, aucune réécriture d’historique.`);
));
ok('le contrôle distingue le GRANT explicite du bootstrap ADMIN Neon',
  /m\.grantor = v_member_oid/.test(workerVerification)
  && /v_bootstrap_rows/.test(workerVerification)
  && /grantor\.rolsuper OR grantor\.rolcreaterole OR grantor\.rolbypassrls/.test(workerVerification));
ok('le contrôle ne lit plus arbitrairement une seule ligne pg_auth_members',
  !/SELECT m\.inherit_option, m\.set_option, m\.admin_option\s+INTO v_membership/i.test(workerVerification));
ok('CREATE est retiré après le transfert de propriété',
  worker.indexOf('ALTER FUNCTION public.tracefab_notification_outbox_health() OWNER TO tracefab_worker')
    < worker.indexOf('REVOKE CREATE ON SCHEMA public FROM tracefab_worker'));
ok('l’appartenance SET du migrateur est conservée',
  !/REVOKE\s+tracefab_worker\s+FROM\s+current_user/i.test(worker));
ok('aucune migration assistée ne demande encore SUPERUSER',
  /MIGRATIONS_ASSISTEES\s*=\s*Object\.freeze\(\{\}\)/.test(assisted));

console.log('\n  --------------------------------------------');
console.log(`  ${verifies} vérifications passées — snapshot Neon 04/11, aucune réécriture d’historique.`);
