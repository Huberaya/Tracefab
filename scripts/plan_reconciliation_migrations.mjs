#!/usr/bin/env node
/**
 * Plan de reconciliation genere depuis le snapshot Neon du 04/11/2026.
 *
 * Ce script est en lecture seule : il ne se connecte a aucune base et
 * n'applique rien. Il verifie que les 56 migrations reussies gardent leurs
 * checksums, identifie les 13 migrations historiques absentes et ordonne leur deploiement avec les corrections forward.
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
  if (name === '20261105220000_active_tenant_quality_cap_guards') {
    return {
      ...base,
      effect: 'exiger le tenant actif de la marque pour créer/revoir un CAP et du fournisseur pour soumettre la remédiation',
      evidence: 'les trois fonctions SECURITY DEFINER contrôlaient le rôle ou l’adhésion sans vérifier le tenant actif ; les routes sont maintenant bornées à la partie concernée et testées en PostgreSQL',
      risk: 'CREATE OR REPLACE doit préserver OID, propriétaire et ACL ; le helper reste non exécutable par tracefab_app',
      prerequisite: '20261105210000 terminée ; vérifier la création sous marque active, puis les refus de soumission fournisseur et de revue marque hors tenant',
      action: 'APPLIQUER APRÈS LES GARDES PROFIL/PASSEPORT FOURNISSEUR, EN PRÉPRODUCTION PUIS PRODUCTION APRÈS VALIDATION COMPLÈTE',
    };
  }
  if (name === '20261105230000_active_tenant_invite_document_passport_guards') {
    return {
      ...base,
      effect: 'lier les invitations fournisseur, l’enregistrement des documents, le démarrage des scans et la revue des demandes de passeport au tenant actif',
      evidence: 'tests de routes et d’intégration : le tenant marque/fournisseur propriétaire est résolu explicitement et armé dans les transactions appelantes',
      risk: 'CREATE OR REPLACE doit préserver OID, propriétaire et ACL ; les chemins de scan doivent réarmer le tenant à chaque transaction',
      prerequisite: '20261105220000 terminée ; vérifier invitations, upload, scan et revue de passeport sur PostgreSQL 17',
      action: 'APPLIQUER APRÈS LES GARDES CAP QUALITÉ, EN PRÉPRODUCTION PUIS PRODUCTION APRÈS VALIDATION COMPLÈTE',
    };
  }
  if (name === '20261105250000_active_tenant_document_material_access') {
    return {
      ...base,
      effect: 'borner les documents, materiaux, fournisseurs, sites et certifications au locataire actif, et n’ouvrir le partage explicite qu’au beneficiaire actif',
      evidence: 'test PostgreSQL direct a trois tenants : document d’un autre locataire invisible, partage explicite toujours lisible, materiau du fournisseur visible par composition, refus en ecriture',
      risk: 'remplace six politiques et deux fonctions DEFINER ; les branches de partage metier doivent rester ouvertes, verifie par postcondition sur le catalogue',
      prerequisite: '20261105240000 terminee ; verifier test_neon_document_lifecycle et test_neon_document_material_tenant_scope sur PostgreSQL 17',
      action: 'APPLIQUER APRES LA GARDE QUALITE FOURNISSEUR, EN PRÉPRODUCTION PUIS PRODUCTION APRÈS VALIDATION COMPLÈTE',
    };
  }
  if (name === '20261105260000_runtime_user_email_definer_guard') {
    return {
      ...base,
      effect: 'rendre tracefab_current_user_email executable par le runtime sans lui accorder SELECT sur users (SECURITY DEFINER, search_path fige, ACL conservee)',
      evidence: 'mesure : select id from organizations sous tracefab_app rendait 42501 permission denied for table users ; rend zero ligne apres correction',
      risk: 'CREATE OR REPLACE doit preserver OID, proprietaire et ACL ; la fonction ne rend que l’email de l’identite courante',
      prerequisite: '20261105250000 terminee ; verifier test:neon:cross-tenant et test:neon:rls',
      action: 'APPLIQUER APRES LA GARDE DOCUMENTS/MATERIAUX, EN PRÉPRODUCTION PUIS PRODUCTION APRÈS VALIDATION COMPLÈTE',
    };
  }
  if (name === '20261105280000_active_tenant_document_indirect_paths') {
    return {
      ...base,
      effect: 'borner au locataire actif les branches indirectes de tracefab_can_access_document (reponses de collecte, certifications, points de donnee)',
      evidence: 'mesure sur PostgreSQL 17 : locataire A actif, la fonction rendait vrai pour une piece de B atteinte par un point de donnee, et la RLS laissait passer 1 piece sur 3',
      risk: 'CREATE OR REPLACE doit preserver OID, proprietaire et ACL ; les branches legitimes (propriete, partage explicite, relation active) sont conservees',
      prerequisite: '20261105270000 terminee ; verifier test:neon:document-material-scope et test:neon:document-lifecycle',
      action: 'APPLIQUER APRES LA LECTURE RUNTIME, EN PRÉPRODUCTION PUIS PRODUCTION APRÈS VALIDATION COMPLÈTE',
    };
  }
  if (name === '20261105270000_runtime_read_users_and_registry') {
    return {
      ...base,
      effect: 'accorder SELECT (et seulement SELECT) au runtime sur users et tracefab_runtime_function_registry, sous les politiques deja en place',
      evidence: 'test:neon:rls mesurait ces deux tables en « erreur de politique » (42501) ; les politiques de lecture existaient mais etaient inatteignables',
      risk: 'aucun INSERT/UPDATE/DELETE accorde ; RLS forcee et politiques de lecture verifiees par postcondition',
      prerequisite: '20261105260000 terminee ; verifier test:neon:rls sur base amorcee par db:seed-rls',
      action: 'APPLIQUER APRES LA GARDE EMAIL RUNTIME, EN PRÉPRODUCTION PUIS PRODUCTION APRÈS VALIDATION COMPLÈTE',
    };
  }
  if (name === '20261105240000_active_tenant_supplier_quality_guard') {
    return {
      ...base,
      effect: 'exiger le tenant fournisseur actif pour calculer et muter les scores/anomalies de qualité fournisseur',
      evidence: 'test PostgreSQL direct : le calcul passe sous le tenant fournisseur propriétaire et échoue active_tenant_mismatch depuis un autre tenant',
      risk: 'CREATE OR REPLACE doit préserver OID, propriétaire et ACL ; le helper reste non exécutable par tracefab_app',
      prerequisite: '20261105230000 terminée ; vérifier le parcours positif test_neon_quality_flow et le refus inter-tenant',
      action: 'APPLIQUER APRÈS LES GARDES INVITATIONS/DOCUMENTS/PASSEPORTS, EN PRÉPRODUCTION PUIS PRODUCTION APRÈS VALIDATION COMPLÈTE',
    };
  }
  if (name === '20261105210000_active_tenant_supplier_profile_passport_guards') {
    return {
      ...base,
      effect: 'exiger le tenant fournisseur actif pour modifier/soumettre le profil et créer/modifier le passeport fournisseur',
      evidence: 'les fonctions SECURITY DEFINER vérifiaient seulement l’appartenance ; les quatre routes de profil fournisseur sont désormais armées avec un tenant supplier explicite et testées avec un troisième tenant',
      risk: 'CREATE OR REPLACE doit préserver OID, propriétaire et ACL ; le helper reste non exécutable par tracefab_app',
      prerequisite: '20261105200000 terminée ; vérifier les quatre refus SQL directs inter-tenant et les parcours fournisseur positifs',
      action: 'APPLIQUER APRÈS LES GARDES MATIÈRES/CERTIFICATIONS, EN PRÉPRODUCTION PUIS PRODUCTION APRÈS VALIDATION COMPLÈTE',
    };
  }
  if (name === '20261105200000_active_tenant_material_certification_guards') {
    return {
      ...base,
      effect: 'exiger le tenant actif pour créer/modifier une matière et enregistrer/modifier une certification',
      evidence: 'les routes matériaux étaient déjà bornées ; les quatre fonctions SECURITY DEFINER vérifiaient seulement l’appartenance ; les routes certifications sont maintenant liées au tenant fournisseur explicite',
      risk: 'CREATE OR REPLACE doit préserver OID, propriétaire et ACL ; le helper reste non exécutable par tracefab_app',
      prerequisite: '20261105190000 terminée ; vérifier les quatre refus SQL directs inter-tenant et les parcours fournisseurs positifs',
      action: 'APPLIQUER APRÈS LES GARDES QUALITÉ/COLLECTE, EN PRÉPRODUCTION PUIS PRODUCTION APRÈS VALIDATION COMPLÈTE',
    };
  }
  if (name === '20261105190000_active_tenant_quality_collection_guards') {
    return {
      ...base,
      effect: 'exiger le tenant actif dans les sept fonctions SECURITY DEFINER de qualité et collecte : anomalies, items/demandes, soumission/réponse fournisseur et revue marque',
      evidence: 'inspection PostgreSQL des fonctions SECURITY DEFINER exécutables par tracefab_app : les contrôles de rôle vérifiaient l’appartenance mais pas le tenant actif ; routes concernées mises à jour et tests multi-tenant négatifs ajoutés',
      risk: 'CREATE OR REPLACE doit préserver OID, propriétaire et ACL ; les helpers de garde restent non exécutables par tracefab_app',
      prerequisite: '20261105180000 terminée ; vérifier les sept refus SQL directs inter-tenant et les parcours HTTP armant le tenant de la partie concernée',
      action: 'APPLIQUER APRÈS LA GARDE D’ENREGISTREMENT TC, EN PRÉPRODUCTION PUIS PRODUCTION APRÈS VALIDATION COMPLÈTE',
    };
  }
  if (name === '20261105180000_active_tenant_tc_registration_guard') {
    return {
      ...base,
      effect: 'exiger que le tenant actif soit vendeur ou acheteur dans tracefab_register_transaction_certificate, y compris en appel SQL direct',
      evidence: 'la route vérifiait déjà que le tenant actif est une partie, mais la fonction SECURITY DEFINER ne répétait pas ce contrôle ; un membre multi-tenant pouvait appeler la fonction directement avec deux tiers',
      risk: 'CREATE OR REPLACE dynamique doit préserver OID, propriétaire et ACL ; ne pas empêcher un vendeur ou acheteur actif autorisé de déclarer le certificat',
      prerequisite: '20261105170000 terminée ; vérifier le parcours positif vendeur actif et le refus direct lorsque le tenant actif n’est ni vendeur ni acheteur',
      action: 'APPLIQUER APRÈS LES GARDES DES 19 FONCTIONS SECURITY DEFINER, EN PRÉPRODUCTION PUIS PRODUCTION APRÈS VALIDATION COMPLÈTE',
    };
  }
  if (name === '20261105170000_active_tenant_security_definer_guards') {
    return {
      ...base,
      effect: 'imposer le tenant actif dans les 19 fonctions SECURITY DEFINER exposées au runtime : graphe, PEF, DPP, qualité, collecte, produits, mass-balance, publication, schémas',
      evidence: 'audit SQL des définitions SECURITY DEFINER et des routes appelantes ; la migration injecte des gardes typées dans les fonctions sans renommer les objets',
      risk: 'CREATE OR REPLACE doit préserver les OID, propriétaires et ACL ; helpers INVOKER sans EXECUTE PUBLIC ni tracefab_app ; préserver les opérations partagées fournisseur et les transitions publiques',
      prerequisite: '20261105160000 terminée ; valider les contextes brand/supplier, les routes schema-bindings, les appels worker/public et les 19 postconditions pg_get_functiondef',
      action: 'APPLIQUER APRÈS LE BORNAGE DES COMPOSITIONS PRODUIT-MATIÈRE, EN PRÉPRODUCTION PUIS PRODUCTION APRÈS VALIDATION COMPLÈTE',
    };
  }
  if (name === '20261105150000_active_tenant_dpp_claims_identity_rls') {
    return {
      ...base,
      effect: 'borner les lectures privées des claims, événements et identités DPP au tenant du produit ; refuser les fonctions SECURITY DEFINER exposées à l’API hors tenant actif',
      evidence: 'test direct sous tracefab_app : membre A+B, A actif, lecture de 1 claim et 1 identité privée de B ; pg_get_functiondef confirme plusieurs fonctions DPP/identité sans garde tenant',
      risk: 'CREATE OR REPLACE doit préserver OID, propriétaire et ACL ; ne pas ajouter de garde à tracefab_calculate_product_data_completion, fonction interne appelée par trigger et non exécutable par tracefab_app',
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
  { label: 'PREPRODUCTION', command: 'npx prisma migrate deploy', gate: '13 migrations historiques pending + 19 corrections forward ordonnées (PLM/GS1, graphe, tenant actif PLM/ERP, RLS produits/DPP/PEF, allégations vertes, claims/identités DPP, compositions produit-matière, 19 fonctions SECURITY DEFINER puis enregistrement TC) ; 1 variance checksum documentée et éprouvée par test Prisma ; aucun resolve' },
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
  '20261105170000_active_tenant_security_definer_guards',
  '20261105180000_active_tenant_tc_registration_guard',
  '20261105190000_active_tenant_quality_collection_guards',
  '20261105200000_active_tenant_material_certification_guards',
  '20261105210000_active_tenant_supplier_profile_passport_guards',
  '20261105220000_active_tenant_quality_cap_guards',
  '20261105230000_active_tenant_invite_document_passport_guards',
  '20261105240000_active_tenant_supplier_quality_guard',
  // Corrections ajoutees apres la revue finale : le locataire actif borne
  // documents, materiaux, fournisseurs, sites, certifications et partages ;
  // l'email du porteur redevient evaluable par le runtime ; deux tables que le
  // runtime doit lire lui sont enfin accordees en SELECT.
  '20261105250000_active_tenant_document_material_access',
  '20261105260000_runtime_user_email_definer_guard',
  '20261105270000_runtime_read_users_and_registry',
  // La mesure a montre que les chemins INDIRECTS de
  // `tracefab_can_access_document` n'etaient pas bornes au locataire actif : la
  // fuite traversait la politique de lecture, qui delegue a cette fonction.
  '20261105280000_active_tenant_document_indirect_paths',
])) {
  errors.push(`les dix-neuf corrections forward PLM/GS1, graphe, tenant actif, RLS produits/DPP/PEF, allégations vertes, claims/identités DPP, compositions produit-matière, gardes SECURITY DEFINER, enregistrement TC, qualité/collecte, matières/certifications, profil fournisseur, CAP qualité, invitations/documents/passeports et qualité fournisseur sont attendues, obtenu ${JSON.stringify(newNames)}`);
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
  console.log('1. PRÉPRODUCTION : npx prisma migrate status — 13 migrations historiques pending + 19 corrections forward PLM/GS1, graphe, tenant actif, RLS produits/DPP/PEF, allégations vertes, claims/identités DPP, compositions produit-matière, gardes SECURITY DEFINER, enregistrement TC, qualité/collecte, matières/certifications, profil fournisseur puis CAP qualité ; 1 écart historique documenté, aucun resolve.');
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
console.log('\nPlan cohérent : 51 via Prisma + 5 hors bande, 13 migrations historiques en attente + 19 corrections forward PLM/GS1, graphe, tenant actif, RLS produits/DPP/PEF, allégations vertes, claims/identités DPP, compositions produit-matière, gardes SECURITY DEFINER, TC, qualité/collecte, matières/certifications, profil fournisseur, CAP, invitations/documents/passeports et qualité fournisseur, 1 écart historique documenté, aucun resolve ni changement de checksum.');
