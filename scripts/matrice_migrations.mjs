#!/usr/bin/env node
/**
 * Matrice des 65 migrations : le decompte est RECALCULE, jamais recopie.
 *
 * Le mandat interdit de reprendre « 54 appliquees + 9 absentes + 2 annulees »
 * comme un acquis. Cette matrice le refait donc depuis l'etat courant du depot,
 * et echoue si l'arithmetique ne ferme plus.
 *
 * CE QUI EST MESURE ICI, ET CE QUI EST REPRIS
 *
 *   mesure   : le nombre de migrations du depot, leurs empreintes SHA-256
 *              (Prisma hache le contenu de `migration.sql`), l'absence de
 *              prefixe d'horodatage en double, et la presence effective des
 *              migrations citees comme en ecart ;
 *   repris   : le STATUT D'HISTORIQUE de chaque migration, qui vient d'une
 *              lecture de `_prisma_migrations` en production. Ce script ne se
 *              connecte a rien : il qualifie ce qu'il ne peut pas relire.
 *
 * Une migration « attestee » l'est par une lecture du 28/10, pas par ce script.
 * La colonne « effets observes » ne dit donc jamais « identique » : elle dit
 * « mesure », « deduit » ou « NON PROUVE ».
 *
 *   node scripts/matrice_migrations.mjs            matrice lisible
 *   node scripts/matrice_migrations.mjs --markdown tableau Markdown
 *   node scripts/matrice_migrations.mjs --verifier sortie 1 si derive
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const dossier = join(racine, 'prisma', 'migrations');

/**
 * Les ecarts, NOMMES par la reconciliation du 28/10 sur `_prisma_migrations`.
 * `historique` : ANNULEE (ligne `rolled_back_at`) ou ABSENTE (aucune ligne).
 * `effets` : ce que la production porte, avec sa NATURE.
 */
const ECARTS = {
  '20261010120000_publication_explicite': {
    historique: 'ANNULEE',
    objet: 'tracefab_product_is_public exige reviewed_at ; products_select_public ; purge des public_slug non revus',
    effets: ['NON PROUVE', 'la fonction est creee par 20261009180000, deja appliquee : sa presence ne prouve rien'],
    suite: 'sonde de la chaine, fait 1',
  },
  '20261017120000_active_tenant_context': {
    historique: 'ANNULEE',
    objet: 'tracefab_active_organization_id, tracefab_in_active_tenant, tracefab_require_active_tenant',
    effets: ['DEDUIT', '20261021120000, atteste, echoue sans ces trois fonctions (mesure sur base jetable)'],
    suite: 'regularisation par resolve --applied, sur preuve',
  },
  '20261021170000_dpp_readiness_truthful_gates': {
    historique: 'ABSENTE',
    objet: 'profil DPP renomme, 13 prerequis, tracefab_dpp_requirement_met, tracefab_mark_dpp_ready_to_publish',
    effets: ['NON PROUVE', 'redéfinie par 20261027100000 et 20261027130000'],
    suite: 'sonde, fait 3',
  },
  '20261027100000_dpp_quality_gate_requires_assessment': {
    historique: 'ABSENTE',
    objet: 'quality.no_open_issues exige une evaluation persistee',
    effets: ['NON PROUVE', 'aucune mesure'],
    suite: 'sonde, fait 4',
  },
  '20261027130000_dpp_review_preservation_and_publication_coherence': {
    historique: 'ABSENTE',
    objet: 'tracefab_suspend_nonconforming_publication, tracefab_compute_dpp_readiness, tracefab_mark_dpp_ready_to_publish',
    effets: ['NON PROUVE', 'aucune mesure'],
    suite: 'sonde, fait 5',
  },
  '20261028120000_runtime_function_registry': {
    historique: 'ABSENTE',
    objet: 'table tracefab_runtime_function_registry (RLS + FORCE), tracefab_apply_runtime_function_grants',
    effets: ['MESURE', 'table lue absente en production le 28/10'],
    suite: 'prerequis de 20261028120100 ; determine si un deploy passe',
  },
  '20261028120100_worker_identity_not_forgeable': {
    historique: 'ABSENTE',
    objet: 'role tracefab_worker, 11 politiques reindexees sur current_user',
    effets: ['NON PROUVE', 'depend du registre'],
    suite: 'deploy apres 20261028120000',
  },
  '20261028120200_document_reserved_fields_internal_only': {
    historique: 'ABSENTE',
    objet: 'tracefab_mark_document_scanning ; tracefab_app sans INSERT/UPDATE/DELETE sur documents',
    effets: ['NON PROUVE', 'aucune mesure'],
    suite: 'deploy',
  },
  '20261028130000_product_computed_fields_column_scoped': {
    historique: 'ABSENTE',
    objet: 'ecriture au niveau COLONNE sur tracefab_products ; le declencheur ne lit plus le GUC',
    effets: ['NON PROUVE', 'aucune mesure'],
    suite: 'decision separee : pas de deploy global pour ce seul point',
  },
  '20261028140000_supplier_invitation_owner_relationship_scope': {
    historique: 'ABSENTE',
    objet: 'tracefab_validate_member_invitation_role avec controle d appartenance et de statut',
    effets: ['NON PROUVE', 'aucune mesure'],
    suite: 'deploy',
  },
  // Ajoutee par le commit `963a524` de l utilisateur, APRES la derniere lecture
  // de production : elle ne peut donc pas y etre attestee. Elle n est pas
  // « probablement absente » — elle est absente par construction, et ses effets
  // ne sont pas prouves pour la meme raison.
  '20261028230000_plm_erp_gs1_policy_drift_repair': {
    historique: 'ABSENTE',
    objet: 'retire les 3 politiques derivees puis RECREE les 2 canoniques (sans garde fail-closed)',
    effets: ['NON PROUVE', 'creee apres la derniere lecture de production'],
    suite: 'redondante avec la reconciliation, mais elle RECREE ce que celle-ci ne fait que proteger',
  },
  '20261028150000_reconcile_plm_erp_sync_job_policies': {
    historique: 'ABSENTE',
    objet: '2 politiques permissives retirees de plm_erp_sync_jobs',
    effets: ['MESURE', 'la table porte 4 politiques au lieu de 2 (lecture du 28/10)'],
    suite: 'seul correctif PLM retenu ; sonde C fait 11 en confirmation',
  },
};

/**
 * Les cinq migrations appliquees HORS BANDE (`applied_steps_count = 0` alors
 * que `finished_at` est renseigne) : executees par un lanceur du depot, puis
 * marquees par `resolve --applied`. Le SQL est celui du fichier ; l'execution
 * n'est pas passee par Prisma.
 */
const HORS_BANDE = {
  '20261006220000_esg_pef_footprint_engine': ['pef_emission_factors', 'product_pef_assessments'],
  '20261006230000_green_claims_anti_greenwashing_engine': ['green_claims_rules', 'product_green_claims', 'green_claims_audits'],
  '20261006240000_quality_corrective_action_plans_cap': ['quality_corrective_action_plans', 'quality_cap_messages'],
  '20261006250000_universal_supplier_passport': ['supplier_universal_passports', 'supplier_passport_access_requests'],
  '20261006260000_mass_balance_anti_fraud_engine': ['transaction_certificates', 'mass_balance_allocations', 'mass_balance_reconciliations'],
};

// --- 1. Lecture mesuree du depot -----------------------------------------
const migrations = readdirSync(dossier, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

const empreinte = (nom) => {
  const f = join(dossier, nom, 'migration.sql');
  if (!existsSync(f)) return null;
  return createHash('sha256').update(readFileSync(f)).digest('hex');
};

const lignes = migrations.map((nom) => {
  const sha = empreinte(nom);
  const ecart = ECARTS[nom];
  const horsBande = HORS_BANDE[nom];
  let historique;
  if (ecart) historique = ecart.historique;
  else if (horsBande) historique = 'APPLIQUEE HORS BANDE';
  else historique = 'APPLIQUEE';
  return {
    nom,
    sha,
    historique,
    objet: ecart?.objet ?? (horsBande ? `cree ${horsBande.join(', ')}` : '—'),
    effets: ecart?.effets ?? (horsBande ? ['MESURE', 'les 12 tables existent en production (lecture du 28/10)'] : ['NON PROUVE', 'aucune mesure ciblee']),
    suite: ecart?.suite ?? (horsBande ? 'schema equivalent, non prouve ; controle cible souhaitable' : '—'),
  };
});

// --- 2. Controles de coherence -------------------------------------------
const erreurs = [];

const compter = (h) => lignes.filter((l) => l.historique === h).length;
const appliquees = compter('APPLIQUEE');
const horsBande = compter('APPLIQUEE HORS BANDE');
const annulees = compter('ANNULEE');
const absentes = compter('ABSENTE');

const total = lignes.length;
if (total !== 66) erreurs.push(`le depot ne contient pas 66 migrations mais ${total}`);
if (appliquees + horsBande + annulees + absentes !== total) {
  erreurs.push(`l arithmetique ne ferme pas : ${appliquees}+${horsBande}+${annulees}+${absentes} != ${total}`);
}
if (annulees + absentes !== 12) erreurs.push(`${annulees + absentes} ecarts nommes, 12 attendus`);
if (horsBande !== 5) erreurs.push(`${horsBande} migrations hors bande, 5 attendues`);

// Les migrations citees comme en ecart doivent exister : sinon la matrice
// decrit un depot qui n'existe plus.
for (const nom of Object.keys(ECARTS)) {
  if (!migrations.includes(nom)) erreurs.push(`ecart cite mais absent du depot : ${nom}`);
}
for (const nom of Object.keys(HORS_BANDE)) {
  if (!migrations.includes(nom)) erreurs.push(`hors bande cite mais absent du depot : ${nom}`);
}

// Une empreinte nulle = un dossier sans migration.sql : la matrice serait vide
// pour cette ligne sans que rien ne le signale.
for (const l of lignes) if (!l.sha) erreurs.push(`migration.sql illisible : ${l.nom}`);

/**
 * Prefixes d'horodatage en double.
 *
 * Quatre paires existent dans le depot, anterieures a ce chantier. Elles ne
 * bloquent pas `migrate deploy` (Prisma ordonne sur le NOM du dossier, pas sur
 * le prefixe), et les retirer reviendrait a reecrire l'historique — interdit.
 * Elles sont donc DECLAREES, pas tolerees en silence : la liste ci-dessous est
 * exacte, et toute cinquieme paire fait echouer ce script. C'est ce qui a
 * manque le 28/10, quand une collision `20261028150000` a mis la CI en echec
 * alors que quatre collisions dormaient deja dans le depot.
 */
const PREFIXES_DOUBLES_CONNUS = [
  '20261006120000',
  '20261006200000',
  '20261006220000',
  '20261017120000',
];
const prefixes = migrations.map((m) => m.slice(0, 14));
const doubles = [...new Set(prefixes.filter((p, i) => prefixes.indexOf(p) !== i))].sort();
for (const d of doubles) {
  if (!PREFIXES_DOUBLES_CONNUS.includes(d)) {
    erreurs.push(`NOUVEAU prefixe d horodatage en double : ${d}`);
  }
}
for (const d of PREFIXES_DOUBLES_CONNUS) {
  if (!doubles.includes(d)) {
    erreurs.push(`prefixe declare en double mais unique dans le depot : ${d} (liste a mettre a jour)`);
  }
}

// --- 3. Sorties -----------------------------------------------------------
if (process.argv.includes('--markdown')) {
  console.log('| # | Migration | Empreinte (12) | Historique | Objets attendus | Effets observes | Nature | Suite |');
  console.log('|---|---|---|---|---|---|---|---|');
  lignes.forEach((l, i) => {
    console.log(`| ${i + 1} | \`${l.nom}\` | \`${(l.sha ?? '').slice(0, 12)}\` | ${l.historique} | ${l.objet} | ${l.effets[1]} | **${l.effets[0]}** | ${l.suite} |`);
  });
} else {
  console.log('Matrice des migrations — etat recalcule depuis le depot\n');
  console.log(`  migrations du depot            : ${total}`);
  console.log(`  appliquees (attestees)         : ${appliquees}`);
  console.log(`    dont hors bande              : ${horsBande}`);
  console.log(`  annulees (rolled_back_at)      : ${annulees}`);
  console.log(`  absentes de l historique       : ${absentes}`);
  console.log(`  ecarts nommes                  : ${annulees + absentes}`);
  console.log(`  arithmetique                   : ${appliquees + horsBande} + ${annulees} + ${absentes} = ${total}`);
  console.log(`  prefixes en double (connus)    : ${doubles.length} / ${PREFIXES_DOUBLES_CONNUS.length} declares`);
  const mesures = lignes.filter((l) => l.effets[0] === 'MESURE').length;
  const deduits = lignes.filter((l) => l.effets[0] === 'DEDUIT').length;
  console.log(`\n  effets MESURES      : ${mesures}`);
  console.log(`  effets DEDUITS      : ${deduits}`);
  console.log(`  effets NON PROUVES  : ${total - mesures - deduits}`);
  console.log('\n  (le statut d historique vient d une lecture de production ;');
  console.log('   il n est pas relu par ce script, qui ne se connecte a rien)');
}

if (erreurs.length > 0) {
  console.error('\nDIVERGENCES :');
  for (const e of erreurs) console.error(`  - ${e}`);
  process.exit(1);
}
if (!process.argv.includes('--markdown')) {
  console.log('\nLa matrice ferme : 66 migrations, 12 ecarts, 5 hors bande,');
  console.log('aucun nouveau prefixe en double.');
}
