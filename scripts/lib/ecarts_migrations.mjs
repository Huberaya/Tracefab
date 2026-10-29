/**
 * Faits MESURES sur `_prisma_migrations` et le catalogue de production,
 * lectures en lecture seule des 28/10.
 *
 * Ce fichier ne contient QUE des faits releves : aucun calcul, aucune
 * conclusion. Il est partage par `matrice_migrations.mjs` (qui compte) et
 * `plan_reconciliation_migrations.mjs` (qui ordonne), pour qu'une seule source
 * alimente les deux — un fait corrige ici se propage aux deux.
 *
 * Chaque entree est datee et attribuee dans le corps du document de matrice.
 */

/**
 * Migrations creees APRES le releve de production du 28/10 : elles n'ont jamais
 * ete deployees, et ce n'est pas une derive. Les confondre avec les onze ecarts
 * ferait dire a la matrice qu'elles sont « appliquees » — ce qui serait faux.
 */
export const NOUVELLES = {
  '20261029150000_plm_sync_jobs_policy_alignment': {
    historique: 'NOUVELLE',
    objet: 'retire les deux memes politiques derivees que 20261028150000, puis verifie les canoniques',
    effets: ['NON DEPLOYEE', 'aucune ligne _prisma_migrations ; migration ecrite le 29/10'],
    suite: 'decision de fusion : deux migrations font le meme DROP (voir rapport)',
  },
};

export const ECARTS = {
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
  '20261028150000_reconcile_plm_erp_sync_job_policies': {
    historique: 'ABSENTE',
    objet: '2 politiques permissives retirees de plm_erp_sync_jobs',
    effets: ['MESURE', 'la table porte 4 politiques au lieu de 2 (lecture du 28/10)'],
    suite: 'seul correctif PLM retenu ; sonde C fait 11 en confirmation',
  },
};

export const CATALOGUE = {
  '20261010120000_publication_explicite': {
    catalogue: 'NON LU — la fonction qui la porte (20261009180000) existe deja',
    statut: 'NON PROUVE',
  },
  '20261017120000_active_tenant_context': {
    catalogue: 'PRESENT — deduit : 20261021120000, attestee, echoue sans ces 3 fonctions',
    statut: 'A QUALIFIER',
  },
  '20261021170000_dpp_readiness_truthful_gates': {
    catalogue: 'NON LU — redéfinie par 20261027100000 et 20261027130000',
    statut: 'NON PROUVE',
  },
  '20261027100000_dpp_quality_gate_requires_assessment': {
    catalogue: 'NON LU',
    statut: 'NON PROUVE',
  },
  '20261027130000_dpp_review_preservation_and_publication_coherence': {
    catalogue: 'NON LU',
    statut: 'NON PROUVE',
  },
  '20261028120000_runtime_function_registry': {
    catalogue: 'ABSENT — table tracefab_runtime_function_registry lue absente',
    statut: 'DIVERGENCE',
  },
  '20261028120100_worker_identity_not_forgeable': {
    catalogue: 'NON LU — depend du registre, dont l absence a ete lue',
    statut: 'NON PROUVE',
  },
  '20261028120200_document_reserved_fields_internal_only': {
    catalogue: 'NON LU — les droits sur documents se lisent avec le SQL des privileges effectifs',
    statut: 'NON PROUVE',
  },
  '20261028130000_product_computed_fields_column_scoped': {
    catalogue: 'NON LU — les droits sur tracefab_products se lisent de meme',
    statut: 'NON PROUVE',
  },
  '20261028140000_supplier_invitation_owner_relationship_scope': {
    catalogue: 'NON LU — decision separee, aucun deploy global pour ce seul point',
    statut: 'NON PROUVE',
  },
  '20261028150000_reconcile_plm_erp_sync_job_policies': {
    catalogue: 'DIVERGENCE MESUREE — 4 politiques au lieu de 2 ; les 2 surnumeraires n ont AUCUN createur dans le depot (provenance hors depot)',
    statut: 'DIVERGENCE',
  },
};

export const HORS_BANDE = {
  '20261006220000_esg_pef_footprint_engine': ['pef_emission_factors', 'product_pef_assessments'],
  '20261006230000_green_claims_anti_greenwashing_engine': ['green_claims_rules', 'product_green_claims', 'green_claims_audits'],
  '20261006240000_quality_corrective_action_plans_cap': ['quality_corrective_action_plans', 'quality_cap_messages'],
  '20261006250000_universal_supplier_passport': ['supplier_universal_passports', 'supplier_passport_access_requests'],
  '20261006260000_mass_balance_anti_fraud_engine': ['transaction_certificates', 'mass_balance_allocations', 'mass_balance_reconciliations'],
};

