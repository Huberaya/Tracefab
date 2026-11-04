#!/usr/bin/env node
/**
 * Plan de reconciliation genere depuis le snapshot Neon du 04/11/2026.
 *
 * Ce script est en lecture seule : il ne se connecte a aucune base et
 * n'applique rien. Il verifie que les 56 migrations reussies gardent leurs
 * checksums, identifie les 13 migrations absentes et ordonne leur deploiement.
 *
 * Regle d'execution : Préproduction d'abord ; Production uniquement apres
 * verification complete de Préproduction. Aucun resolve n'est requis ni admis.
 *
 *   node scripts/plan_reconciliation_migrations.mjs [--markdown] [--autotest]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRODUCTION_APPLIED, ROLLED_BACK_ATTEMPTS, ECARTS, CATALOGUE, HORS_BANDE,
  BORNE_RELEVE, SNAPSHOT_DATE,
} from './lib/ecarts_migrations.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'prisma', 'migrations');
const markdown = process.argv.includes('--markdown');
const migrations = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

const pending = Object.keys(ECARTS).sort();
const applied = Object.keys(PRODUCTION_APPLIED).sort();
const outOfBand = Object.keys(HORS_BANDE).sort();
const appliedViaPrisma = applied.length - outOfBand.length;
const newNames = migrations.filter((name) =>
  !PRODUCTION_APPLIED[name] && !ECARTS[name] && name > BORNE_RELEVE);

function planFor(name) {
  const gap = ECARTS[name];
  const catalogue = CATALOGUE[name];
  const base = {
    name,
    history: 'ABSENTE',
    effect: gap.effets[0],
    evidence: catalogue.catalogue,
    risk: 'migration non encore attestee ; appliquer une seule fois par Prisma apres preflight',
    prerequisite: gap.suite,
    action: 'APPLIQUER EN PRÉPRODUCTION, puis Production après validation complète',
  };
  if (name === '20261028120000_runtime_function_registry') {
    return { ...base,
      action: 'APPLIQUER EN PREMIER EN PRÉPRODUCTION, puis Production après validation',
      risk: 'CREATE TABLE sans IF NOT EXISTS ; table vérifiée absente le 04/11, re-vérifier juste avant deploy',
      prerequisite: 'confirmer tracefab_runtime_function_registry absente et exécuteur propriétaire des fonctions',
    };
  }
  if (name === '20261028120100_worker_identity_not_forgeable') {
    return { ...base,
      action: 'APPLIQUER APRÈS 20261028120000',
      risk: 'migration corrigée dans cette branche ; CI P10.5 doit prouver l’exécution sans SUPERUSER',
      prerequisite: 'rôle de migration avec CREATEROLE et propriété des fonctions ; vérifier worker NOLOGIN et app non membre',
    };
  }
  if (name === '20261028150000_reconcile_plm_erp_sync_job_policies'
      || name === '20261029180000_plm_erp_sync_jobs_policy_dedup') {
    return { ...base,
      action: 'APPLIQUER EN PRÉPRODUCTION, puis Production',
      risk: 'les politiques canoniques sont déjà présentes ; migration de normalisation à rejouer une seule fois via Prisma',
      prerequisite: 'confirmer que la table conserve exactement les deux politiques canoniques avant et après',
    };
  }
  if (name === '20261031120000_identite_hmac_liee_au_contexte') {
    return { ...base,
      risk: 'mode strict désactivé ; TRACEFAB_IDENTITY_KEY absent ; ne pas activer strict pendant le deploy',
      prerequisite: 'appliquer les tables et fonctions HMAC ; provisionner la clé séparément après déploiement',
    };
  }
  if (name === '20261102120000_identite_stricte_email_et_rotation') {
    return { ...base,
      risk: 'dépend des tables HMAC ; ne pas activer le mode strict sans clé et couverture complète des routes',
      prerequisite: '20261031120000 terminée ; strict reste désactivé jusqu’à validation dédiée',
    };
  }
  return base;
}

const lines = pending.map(planFor);
const errors = [];
const known = new Set([...applied, ...pending, ...newNames]);
for (const name of migrations) if (!known.has(name)) errors.push(`${name}: aucune categorie dans le snapshot`);
for (const name of known) if (!migrations.includes(name)) errors.push(`${name}: reference absente du depot`);
if (applied.length !== 56) errors.push(`snapshot applique attendu 56, obtenu ${applied.length}`);
if (appliedViaPrisma !== 51) errors.push(`migrations via Prisma attendues 51, obtenu ${appliedViaPrisma}`);
if (outOfBand.length !== 5) errors.push(`migrations hors bande attendues 5, obtenu ${outOfBand.length}`);
if (pending.length !== 13) errors.push(`migrations en attente attendues 13, obtenu ${pending.length}`);
if (ROLLED_BACK_ATTEMPTS.length !== 2) errors.push('le snapshot doit conserver deux tentatives annulees');
for (const name of outOfBand) {
  if (!PRODUCTION_APPLIED[name]) errors.push(`hors bande sans ligne terminee : ${name}`);
}
for (const attempt of ROLLED_BACK_ATTEMPTS) {
  if (!PRODUCTION_APPLIED[attempt.name]) errors.push(`tentative annulee sans ligne reussie du meme nom : ${attempt.name}`);
}
if (lines.some((line) => /RESOLVE --APPLIED|RESOLVE --ROLLED-BACK/i.test(line.action))) {
  errors.push('un resolve est interdit : les 13 migrations sont a appliquer via Prisma');
}
const index = (name) => pending.indexOf(name);
const ordered = [
  ['20261021170000_dpp_readiness_truthful_gates','20261027100000_dpp_quality_gate_requires_assessment'],
  ['20261027100000_dpp_quality_gate_requires_assessment','20261027130000_dpp_review_preservation_and_publication_coherence'],
  ['20261028120000_runtime_function_registry','20261028120100_worker_identity_not_forgeable'],
  ['20261028120100_worker_identity_not_forgeable','20261028120200_document_reserved_fields_internal_only'],
  ['20261031120000_identite_hmac_liee_au_contexte','20261102120000_identite_stricte_email_et_rotation'],
];
for (const [before,after] of ordered) {
  if (index(before) < 0 || index(after) < 0 || index(before) > index(after)) {
    errors.push(`ordre de dependance invalide : ${before} doit preceder ${after}`);
  }
}
for (const name of applied) {
  const file = join(migrationsDir,name,'migration.sql');
  const sha = (awaitImportCryptoHash(readFileSync(file)));
  if (sha !== PRODUCTION_APPLIED[name]) errors.push(`${name}: checksum depot différent de l'historique Neon`);
}

function awaitImportCryptoHash(bytes) {
  // Node crypto is imported statically below via createHash.
  return createHash('sha256').update(bytes).digest('hex');
}

if (markdown) {
  console.log(`# Plan de réconciliation Neon — ${SNAPSHOT_DATE}\n`);
  console.log('**Ce plan est généré, non exécuté. Préproduction doit réussir avant toute action Production.**\n');
  console.log('| Migration | Catalogue mesuré | Action | Prérequis | Risque |');
  console.log('|---|---|---|---|---|');
  for (const line of lines) {
    console.log(`| \`${line.name}\` | ${line.evidence} | **${line.action}** | ${line.prerequisite} | ${line.risk} |`);
  }
    console.log('\n## Déjà appliquées hors bande — ne pas rejouer');
  for (const name of outOfBand) console.log(`- ${name}: ${HORS_BANDE[name].join(', ')}`);
  console.log(`\nHistorique : ${appliedViaPrisma} via Prisma + ${outOfBand.length} hors bande, ${pending.length} absentes, ${ROLLED_BACK_ATTEMPTS.length} tentatives annulées déjà suivies d'une réussite.`);
} else {
  console.log(`Plan Neon — snapshot ${SNAPSHOT_DATE}`);
  console.log(`  migrations dépôt       : ${migrations.length}`);
  console.log(`  appliquées via Prisma  : ${appliedViaPrisma}`);
  console.log(`  appliquées hors bande  : ${outOfBand.length}`);
  console.log(`  appliquées au total    : ${applied.length}`);
  console.log(`  absentes               : ${pending.length}`);
  console.log(`  nouvelles post-snapshot: ${newNames.length}`);
  console.log(`  tentatives annulées    : ${ROLLED_BACK_ATTEMPTS.length} (non en attente)`);
  console.log('');
  for (const line of lines) {
    console.log(`  ${line.name}`);
    console.log(`    ${line.action}`);
    console.log(`    preuve: ${line.evidence}`);
    console.log(`    prérequis: ${line.prerequisite}`);
    console.log(`    risque: ${line.risk}`);
  }
}
if (errors.length) {
  console.error('\nVIOLATIONS :');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log('\nPlan cohérent : 56 appliquées, 13 en attente, aucun resolve ni changement de checksum.');
