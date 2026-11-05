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
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRODUCTION_APPLIED, ROLLED_BACK_ATTEMPTS, ECARTS, CATALOGUE, HORS_BANDE, CHECKSUM_EXCEPTIONS,
  BORNE_RELEVE, SNAPSHOT_DATE,
} from './lib/ecarts_migrations.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'prisma', 'migrations');
const markdown = process.argv.includes('--markdown');
const autotest = process.argv.includes('--autotest');
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

const lignesForward = (name) => {
  const base = {
    name,
    history: 'NOUVELLE (postérieure au snapshot)',
    risk: 'correction forward-only ; ne modifie aucune entrée _prisma_migrations déjà terminée',
    action: 'APPLIQUER EN PRÉPRODUCTION, puis Production après validation complète',
  };
  if (name === '20261104090000_plm_integrations_and_gs1_constraints') {
    return {
      ...base,
      effect: 'ajouter les quatre CHECK PLM manquants et autoriser GS1 GPC',
      evidence: 'catalogue Neon relu le 04/11 : quatre CHECK absents, contrainte GS1 sans gpc, zéro ligne invalide',
      risk: 'contrainte VALIDATE après précondition ; échec fermé si données invalides ou définition inattendue',
      prerequisite: 'rejouer les comptages de lignes invalides et relire les contraintes juste avant application',
      action: 'APPLIQUER APRÈS LES 13 MIGRATIONS HISTORIQUES, EN PRÉPRODUCTION PUIS PRODUCTION',
    };
  }
  if (name === '20261104100000_supply_chain_status_enum_casts') {
    return {
      ...base,
      effect: 'corriger les CASE texte en casts explicites data_value_status dans create/update supply-chain node',
      evidence: 'pg_get_functiondef identique en Production/Préproduction ; P10.5 a reproduit SQLSTATE 42804 pendant l’ingestion PLM/ERP',
      risk: 'remplacement de deux fonctions SECURITY DEFINER ; CREATE OR REPLACE doit conserver OID, propriétaire et ACL',
      prerequisite: '20261104090000 terminée ; current_user doit être neondb_owner, propriétaire actuel des deux fonctions (tracefab_migrator absent sur les deux bases) ; exécuter test:p105:ingestion et vérifier propriétaire/ACL après application',
      action: 'APPLIQUER APRÈS LA CORRECTION PLM/GS1, EN PRÉPRODUCTION PUIS PRODUCTION',
    };
  }
  if (name === '20261105160000_active_tenant_product_materials_rls') {
    return {
      ...base,
      effect: 'borner les relations produit-matière au tenant actif tout en conservant les partages fournisseur pour les produits du tenant actif',
      evidence: 'test direct sous tracefab_app : membre A+B, A actif, une relation product_materials de B était visible via la branche partagée de la politique SELECT ; helper material_visible_via_product ignorait aussi le tenant actif',
      risk: 'préserver les matières partagées sans exposer la composition d’un produit d’un autre tenant ; CREATE OR REPLACE conserve OID/propriétaire/ACL',
      prerequisite: '20261105150000 terminée ; vérifier les fonctions SECURITY DEFINER d’ajout/mise à jour de matières et la visibilité partagée',
      action: 'APPLIQUER APRÈS LE BORNAGE DES CLAIMS/IDENTITÉS DPP, EN PRÉPRODUCTION PUIS PRODUCTION APRÈS VALIDATION COMPLÈTE',
    };
  }
  if (name === '20261105150000_active_tenant_dpp_claims_identity_rls') {
    return {
      ...base,
      effect: 'borner les lectures privées des claims, événements et identités DPP au tenant du produit ; refuser les fonctions SECURITY DEFINER hors tenant actif',
      evidence: 'test direct sous tracefab_app : membre A+B, A actif, lecture de 1 claim et 1 identité privée de B ; pg_get_functiondef confirme plusieurs fonctions DPP/identité sans garde tenant',
      risk: 'CREATE OR REPLACE doit préserver OID, propriétaire et ACL ; conserver les politiques publiques et les accès partagés fournisseur sur les produits du tenant actif',
      prerequisite: '20261105140000 terminée ; vérifier les fonctions SECURITY DEFINER, leurs ACL et les politiques publiques DPP avant/après',
      action: 'APPLIQUER APRÈS LE BORNAGE DES ALLÉGATIONS VERTES, EN PRÉPRODUCTION PUIS PRODUCTION APRÈS VALIDATION COMPLÈTE',
    };
  }
  if (name === '20261105140000_active_tenant_green_claims_rls') {
    return {
      ...base,
      effect: 'borner les lectures et mutations des allégations vertes de marque au tenant actif',
      evidence: 'test direct sous tracefab_app sur Neon isolé : un membre de A et B, A actif, lisait 1 allégation privée appartenant à B',
      risk: 'politique privée ; ne pas introduire de lecture publique et vérifier le contexte actif des routes green claims',
      prerequisite: '20261105130000 terminée ; vérifier les routes de claims et la politique RLS sous tracefab_app',
      action: 'APPLIQUER APRÈS LE BORNAGE RLS PRODUITS/DPP/PEF, EN PRÉPRODUCTION PUIS PRODUCTION APRÈS VALIDATION COMPLÈTE',
    };
  }
  if (name === '20261105130000_active_tenant_product_dpp_pef_rls') {
    return {
      ...base,
      effect: 'borner les lectures privées produits, DPP et PEF au tenant actif, sans toucher aux politiques publiques',
      evidence: 'test direct sous tracefab_app sur Neon isolé : A actif ne voit aucune ligne produit/DPP/PEF de B ; B actif voit les trois',
      risk: 'les routes catalogue/DPP/PEF doivent armer le tenant actif ; préserver les partages fournisseur et les lectures publiques',
      prerequisite: '20261105120000 terminée ; vérifier les contextes actifs des routes produit/DPP/PEF et les politiques publiques avant/après',
      action: 'APPLIQUER APRÈS LE BORNAGE DE L’INGESTION PLM/ERP, EN PRÉPRODUCTION PUIS PRODUCTION APRÈS VALIDATION COMPLÈTE',
    };
  }
  if (name === '20261105120000_active_tenant_plm_ingest_enforcement') {
    return {
      ...base,
      effect: 'refuser les imports SECURITY DEFINER hors tenant actif, borner la RLS des intégrations/jobs PLM et accepter tous les types de source API',
      evidence: 'test multi-tenant direct sous tracefab_app : tenant A autorisé, B refusé en fonction et RLS ; CI test:p105:ingestion à obtenir',
      risk: 'CREATE OR REPLACE SECURITY DEFINER conserve OID, propriétaire et ACL ; prérequis tracefab_app et tracefab_in_active_tenant présents',
      prerequisite: '20261104100000 terminée ; vérifier le propriétaire neondb_owner, les ACL, la RLS, les rôles tracefab_app et les types source_system avant puis après',
      action: 'APPLIQUER APRÈS LA CORRECTION SUPPLY-CHAIN, EN PRÉPRODUCTION PUIS PRODUCTION APRÈS VALIDATION COMPLÈTE',
    };
  }
  return base;
};
const lines = [
  ...pending.map(planFor),
  ...newNames.map(lignesForward),
];
const errors = [];
const warnings = [];
const phases = [
  { label: 'PREPRODUCTION', command: 'npx prisma migrate deploy', gate: '13 migrations historiques pending + 7 corrections forward ordonnées (PLM/GS1, graphe, tenant actif PLM/ERP, RLS produits/DPP/PEF, allégations vertes, claims/identités DPP, puis compositions produit-matière) ; 1 variance checksum documentée et éprouvée par test Prisma ; aucun resolve' },
  { label: 'PRODUCTION', command: 'npx prisma migrate deploy', gate: 'Préproduction validée et catalogue vérifié' },
];
function violationsFor(planLines, phaseList = phases) {
  const violations = [];
  const text = planLines.map((line) => [line.action, line.risk, line.prerequisite].join(' ')).join('\n');
  if (/migrate\s+resolve\s+--(?:applied|rolled-back)/i.test(text)) violations.push('resolve interdit');
  if (/(?:UPDATE|DELETE\s+FROM)\s+_prisma_migrations/i.test(text)) violations.push('écriture directe dans _prisma_migrations interdite');
  const pre = phaseList.findIndex((phase) => phase.label === 'PREPRODUCTION');
  const prod = phaseList.findIndex((phase) => phase.label === 'PRODUCTION');
  if (pre < 0 || prod < 0 || pre > prod) violations.push('Production doit venir après Préproduction');
  if (phaseList.some((phase) => phase.label === 'PRODUCTION' && !/Préproduction validée/.test(phase.gate))) {
    violations.push('la phase Production exige une preuve de Préproduction');
  }
  return violations;
}
const known = new Set([...applied, ...pending, ...newNames]);
for (const name of migrations) if (!known.has(name)) errors.push(`${name}: aucune categorie dans le snapshot`);
for (const name of known) if (!migrations.includes(name)) errors.push(`${name}: reference absente du depot`);
if (applied.length !== 56) errors.push(`snapshot applique attendu 56, obtenu ${applied.length}`);
if (appliedViaPrisma !== 51) errors.push(`migrations via Prisma attendues 51, obtenu ${appliedViaPrisma}`);
if (outOfBand.length !== 5) errors.push(`migrations hors bande attendues 5, obtenu ${outOfBand.length}`);
if (pending.length !== 13) errors.push(`migrations historiques en attente attendues 13, obtenu ${pending.length}`);
if (JSON.stringify(newNames) !== JSON.stringify([
  '20261104090000_plm_integrations_and_gs1_constraints',
  '20261104100000_supply_chain_status_enum_casts',
  '20261105120000_active_tenant_plm_ingest_enforcement',
  '20261105130000_active_tenant_product_dpp_pef_rls',
  '20261105140000_active_tenant_green_claims_rls',
  '20261105150000_active_tenant_dpp_claims_identity_rls',
  '20261105160000_active_tenant_product_materials_rls',
])) {
  errors.push(`les sept corrections forward PLM/GS1, graphe, tenant actif, RLS produits/DPP/PEF, allégations vertes, claims/identités DPP puis compositions produit-matière sont attendues, obtenu ${JSON.stringify(newNames)}`);
}
if (ROLLED_BACK_ATTEMPTS.length !== 2) errors.push('le snapshot doit conserver deux tentatives annulees');
for (const name of outOfBand) {
  if (!PRODUCTION_APPLIED[name]) errors.push(`hors bande sans ligne terminee : ${name}`);
}
for (const attempt of ROLLED_BACK_ATTEMPTS) {
  if (!PRODUCTION_APPLIED[attempt.name]) errors.push(`tentative annulee sans ligne reussie du meme nom : ${attempt.name}`);
}
errors.push(...violationsFor(lines));
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
  const sha = sha256(readFileSync(file));
  const recorded = PRODUCTION_APPLIED[name];
  if (sha !== recorded) {
    const exception = CHECKSUM_EXCEPTIONS[name];
    const evidenceExists = exception?.evidence && existsSync(join(root, exception.evidence));
    if (exception && exception.appliedChecksum === recorded && exception.repositoryChecksum === sha
        && exception.exactHistoricalSqlRecovered === false
        && exception.status === 'DOCUMENTED_NON_BLOCKING_FOR_PRISMA_MIGRATE_DEPLOY'
        && exception.test === 'test:prisma:checksum-deploy' && evidenceExists) {
      warnings.push(`${name}: écart historique documenté (${recorded.slice(0,12)} ≠ ${sha.slice(0,12)}), exact SQL non retrouvé`);
    } else {
      errors.push(`${name}: checksum depot différent de l'historique Neon sans exception exacte`);
    }
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

if (autotest) {
  const mutants = [
    { label: 'resolve --applied', lines: [{ action: 'prisma migrate resolve --applied' }] },
    { label: 'écriture historique', lines: [{ action: 'UPDATE _prisma_migrations SET checksum = ...' }] },
  ];
  let passed = 0;
  const guardErrors = [];
  for (const mutant of mutants) {
    if (violationsFor(mutant.lines).length > 0) passed += 1;
    else guardErrors.push(`autotest non détecté : ${mutant.label}`);
  }
  const reversed = [...phases].reverse();
  if (violationsFor(lines, reversed).length > 0) passed += 1;
  else guardErrors.push('autotest non détecté : Production avant Préproduction');
  if (guardErrors.length) {
    console.error('\nAUTOTEST ECHEC');
    for (const error of guardErrors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(`Autotest OK : ${passed}/3 garde-fous détectent les mutations interdites.`);
  process.exit(0);
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
  console.log('\n## Séquence d’exécution');
  console.log('1. PRÉPRODUCTION : npx prisma migrate status — 13 migrations historiques pending + 7 corrections forward PLM/GS1, graphe, tenant actif, RLS produits/DPP/PEF, allégations vertes, claims/identités DPP puis compositions produit-matière ; 1 écart historique documenté, aucun resolve.');
  console.log('2. PRÉPRODUCTION : npx prisma migrate deploy, puis contrôles catalogue et tests.');
  console.log('3. PRODUCTION : même commande uniquement après validation complète de Préproduction.');
  console.log(`\nHistorique : ${appliedViaPrisma} via Prisma + ${outOfBand.length} hors bande, ${pending.length} migrations historiques absentes + ${newNames.length} correction(s) forward, ${ROLLED_BACK_ATTEMPTS.length} tentatives annulées déjà suivies d'une réussite.`);
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
  console.log('  Séquence : Préproduction → deploy → vérifications → Production.');
  for (const line of lines) {
    console.log(`  ${line.name}`);
    console.log(`    ${line.action}`);
    console.log(`    preuve: ${line.evidence}`);
    console.log(`    prérequis: ${line.prerequisite}`);
    console.log(`    risque: ${line.risk}`);
  }
}
if (warnings.length) {
  console.warn('\nAVERTISSEMENTS HISTORIQUES :');
  for (const warning of warnings) console.warn(`  - ${warning}`);
}
if (errors.length) {
  console.error('\nVIOLATIONS :');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log('\nPlan cohérent : 51 via Prisma + 5 hors bande, 13 migrations historiques en attente + 7 corrections forward PLM/GS1, graphe, tenant actif, RLS produits/DPP/PEF, allégations vertes, claims/identités DPP puis compositions produit-matière, 1 écart historique documenté, aucun resolve ni changement de checksum.');
