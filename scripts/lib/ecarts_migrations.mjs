/** Snapshot Neon du 04/11/2026 : Production et Préproduction ont le même historique.
 * Les 56 checksums réussis sont contrôlés contre le dépôt. Les cinq entrées
 * hors bande ont applied_steps_count=0 et leurs 12 objets ont été relus présents.
 * Les deux tentatives annulées sont séparées : chaque nom a aussi une ligne réussie.
 */
export const SNAPSHOT_DATE = "2026-11-04";
export const BORNE_RELEVE = '20261102120000';
export const PRODUCTION_APPLIED = {
  "20260923130000_tracefab_neon_initial": "6c755b436b9effd1a860dc5d07fb02bc1c38c405229fd4adb16d8c4582a14102",
  "20260923140000_tracefab_clerk_context": "534dc2d4a166c647c333314d3f5fa1e3f79b7b7a38bc0b45656177aded18771a",
  "20260923150000_fix_invitation_acceptance": "89847200c5f5ae04802dda82047648499c20d955013f0fce8e06538230679196",
  "20260923160000_tracefab_product_api_functions": "2153575d97dd82df6b5bd36257cd7cabed16c2493fabe56c5e62d524b5ee5d70",
  "20260923170000_fix_data_collection_workflow_context": "cebd301a044d4d713b5738028f3d3697e6099868467f54685500882a9fd3fc0e",
  "20260923180000_fix_data_response_progress_guard": "e1456e2fb8dc1f952ff335c54becbc603416f7ddb8d9e2200e8dacd7991ca08f",
  "20260923190000_tracefab_notification_outbox": "0ddde924c3fc022e7c1c208c18ffc9790bbb11db643849421b0db86afdcc0d8b",
  "20260923200000_tracefab_collection_reminders": "cce36f145c0de802b3c233a0d5a2bc7d6d321b0d96752bb961736d2c5a00ce7e",
  "20261005090000_supplier_portal_advanced_hardening": "560356c203df6d460f8488f44bdf1ce582d3f609eae1b4acd329ad3cd686bbb7",
  "20261005100000_supplier_invitation_compatibility": "3626074357755fdef4d158894c70580e89f3e4c728be604050efde599e3e26d5",
  "20261006100000_security_force_rls_and_document_access": "ee73157701cf4134c2498d31a552bfb0ce1c9851cf34536b50505accd9b3bcaf",
  "20261006110000_quality_center_shared_access": "64256414f28d96c3a55facd94d5adeb82d5252993538d2d63c38cc558154e4fe",
  "20261006113000_clerk_directory_membership_sync": "6e4f38601f2ed6c31164cb27f9c4dbc1bab841c57ec8cfab330ac8122aae7ba3",
  "20261006120000_data_collection_bridge_and_quality_automation": "a784cc042bc3f44b2f6c692d84cb5ebeff42608ca2829d03ad714497eb8e2c61",
  "20261006120000_external_schema_bindings": "df965ab28aa24b035576662da9552146f4b77c27a994da62466bc76344063c8d",
  "20261006123000_clerk_sync_security_functions": "f6732d8d578831e7253fb0b17751cda4cc9d1048705a3b1f5542efb29a9db805",
  "20261006130000_tracefab_manual_data_request_reminders": "17a756ec1c70027ca7e34ee415be5d933dea2e4ce017af3863f96e1d9469e7c6",
  "20261006140000_supply_chain_traceability_api": "3aec3897c43e026afc003b9fbb17a8cbc2f631d82f26f1e44add598ed6c938c9",
  "20261006160000_dpp_readiness_exposure": "bacfe553ee18fa61626925f5c069f0d5a48909612a518dbdb8e1a2aaff64d6bc",
  "20261006180000_supplier_self_onboarding": "b9e3f5ea1b8d3f956ba2525d5c1d69ecd872fbee8ec1b6501fefb28c7ae73b1d",
  "20261006190000_catalog_import_export": "036dc97d63f11b9972c4900f1c5646f9785a99bed205d2cc38868ad8db38e196",
  "20261006200000_catalog_import_kind": "d5241ea690e133703a4584cfb8d80e3281f4935a3fc914ba06c8ab3b60fa799b",
  "20261006200000_document_ai_automated_verification": "0eb5036c85c26b9009776702c190d1db5cb123f261e4223ea601e2fe4625d4ca",
  "20261006210000_plm_erp_gs1_interoperability": "c944ce0c21f128b8ee8c919de58179d4f25fdf3d2f7f087dacbca615b89c3861",
  "20261006220000_esg_pef_footprint_engine": "2d4f41bf4c2922c9cdc8ca6634c54572d11563c9e48d0f480a8760d8d81edc42",
  "20261006220000_production_hardening": "66ce9341c7efa7cdaa1b15ba56e2fb6253dea0c3816cfa451b6574609a02b8f9",
  "20261006230000_green_claims_anti_greenwashing_engine": "8430fc08710247140de7afaec8d14a2dd56027e15039ddf95b2f45aa7b97b816",
  "20261006240000_quality_corrective_action_plans_cap": "fad3c6ba25db488b23a8675eee5b59c78ad94bf34360bb1b79116fe47787c67f",
  "20261006250000_universal_supplier_passport": "cbb5af324a9fd23a85e8d828c1c12495aff3cd91b29d007478b8d00ad783f6f8",
  "20261006260000_mass_balance_anti_fraud_engine": "d0328a36291e20799ab9b2934d130bcb191e2762b219f3173a0d3b1d48c7a36e",
  "20261007100000_security_definer_execute_hardening": "61e18ea4c858e003e7505c18f738436d09261a44214feab457bf1f1414ac79b8",
  "20261007120000_force_rls_schema_bindings": "c1f8585dd9b84a96996c042817e5a76adde1ac3163fedd3ab525e5d3c7ec483b",
  "20261008100000_rate_limit_counters": "7d7b7a6cb9bb6ea824ff57c1ab418dd4ee77d40cc74fc457ae2c02c7eff0cabe",
  "20261009120000_fix_materials_policy_recursion": "44c230dc2f9c403da5a05613c6ba1af8924268b657b046640549beb3e0ac4131",
  "20261009180000_public_read_context": "c12ee33303084b6710284139786058b8d088b2619d92372ea57f282e86480d04",
  "20261010120000_publication_explicite": "8b741eab1ff17cb8aaed5f6fc02217209ec84ed44bcbc4617ec7c53ec8cddae6",
  "20261012120000_close_public_execute_gap": "4f6e710f543950838c796b10985745490165b354142abf35ad40d5b0111248a6",
  "20261014100000_revoke_material_visible_public": "ff6d95415e4d7f1fcf8bb7087278d2d93c3fe1b8b142e126c3ce06a41ab1ee04",
  "20261014110000_revoke_dpp_functions_public": "0a141838e80d480373032570638011d079d4402986b522962b7d64edd997633c",
  "20261014120000_close_global_default_function_execute": "cfb6ebac4a6035855d476962c11ade0d3f10df43ebe029dedd0a7c7e2d54de1c",
  "20261014130000_revoke_public_schema_privileges": "c6df54676462efca2f061e274f5c74f777e079a683fabd6542a083f5c0c6fe95",
  "20261014140000_remove_public_supplier_passport_share_token": "d73f1c2d3cf2d175e413603c37952c577d67b75bbf4da9a41fa5180378f1cab7",
  "20261016130000_dynamic_dpp_lifecycle": "10b7d8627b1811fcf2fc3a29864a21ac3d2be853e1a6a04d5318aa2175e55998",
  "20261016150000_dpp_claim_evidence_chain": "8c3e0f1e77a0b052a4fcbf62e06c9d9c4c2170f15e8d03634e1b38268458d260",
  "20261016170000_dpp_resolvable_identity": "f9406fbe10d07e4110596ef6e856345fd0fa0866a3b1b6014ba96288904f3d8f",
  "20261017100000_fix_document_lifecycle_access": "7cc1cbfd98a798ba2cad60de88225fac3401d0e491414fe11df14918125778a6",
  "20261017120000_active_tenant_context": "e15c0786ca0b666aebd9662c007dd4fbaba9304017c5ed1bfe5ef5681289c8bd",
  "20261017120000_harden_dpp_table_privileges": "5366746f7ff72ca64b88472fbda95ff47e000c85dd72e1f84559bd61caea6607",
  "20261017150000_harden_finalize_ops_gate": "bee1dbce49735b2030593b57590c4b6874f124369bb9bb774e7db3df9c65179b",
  "20261019120000_restreindre_dml_role_applicatif": "19dc214f731ecf47e42d44c82e0b13aa2020a19b8f7a0a3d81f4bf6e08c33a49",
  "20261019140000_restreindre_suppression_compteurs_debit": "1120041bd9f6aa6907a09d380a94edf95449d7b055860e83f2e28973e50c333a",
  "20261019160000_retablir_dml_tables_ecrites_directement": "477789e475f0a8009ade2e9444ff279991b6e3176ac38b267ced7afb72bb9842",
  "20261020120000_structured_supply_chain_graph_membership": "1e42d60bf6d808616b806993a15fbc41f6691e2370ecd7a6a9a67dabfa950614",
  "20261021120000_limit_app_function_execute": "e9f00fb17be91ece1925d159e8b128146fdb9eddb0f7d986202e7cc2ae299b6c",
  "20261021130000_reconcile_runtime_dml_and_migration_history": "ec998cc29967613d8fe299cf038a88b0b81d64896aa4ed76affecaa652249983",
  "20261023120000_revoke_app_default_dml": "fa6bcc2447b5e9da0f68c8ff284e63677b3ceaa7aae1e3f95c8e3dd1cadbea04"
};
export const ROLLED_BACK_ATTEMPTS = [
  {
    "name": "20261010120000_publication_explicite",
    "rolled_back_at": "2026-10-16T02:04:36.965512+00:00"
  },
  {
    "name": "20261017120000_active_tenant_context",
    "rolled_back_at": "2026-10-18T00:04:00.522159+00:00"
  }
];
export const CHECKSUM_EXCEPTIONS = {
  "20261006210000_plm_erp_gs1_interoperability": {
    "appliedChecksum": "c944ce0c21f128b8ee8c919de58179d4f25fdf3d2f7f087dacbca615b89c3861",
    "repositoryChecksum": "6a8d03eb507b824e2a308d7e29113478d60d726255fcc1883cef56c506783044",
    "evidence": "docs/security/2026-11-04-neon-checksum-variance-attestation.md",
    "status": "DOCUMENTED_NON_BLOCKING_FOR_PRISMA_MIGRATE_DEPLOY",
    "test": "test:prisma:checksum-deploy",
    "exactHistoricalSqlRecovered": false
  }
};

export const ECARTS = {
  "20261021170000_dpp_readiness_truthful_gates": { historique: 'ABSENTE', objet: "profil DPP à 9 exigences ; le profil attendu en définit 13", effets: ['MESURE', "profil DPP à 9 exigences ; le profil attendu en définit 13"], suite: "appliquer avant 20261027100000" },
  "20261027100000_dpp_quality_gate_requires_assessment": { historique: 'ABSENTE', objet: "quality.no_open_issues absent de la définition active", effets: ['MESURE', "quality.no_open_issues absent de la définition active"], suite: "appliquer après 20261021170000" },
  "20261027130000_dpp_review_preservation_and_publication_coherence": { historique: 'ABSENTE', objet: "review_basis_fingerprint, reviewed_basis_fingerprint, review_invalidated_at et review_invalidation_reason absents ; fonction de suspension absente", effets: ['MESURE', "review_basis_fingerprint, reviewed_basis_fingerprint, review_invalidated_at et review_invalidation_reason absents ; fonction de suspension absente"], suite: "appliquer ; les colonnes ajoutées sont IF NOT EXISTS" },
  "20261028120000_runtime_function_registry": { historique: 'ABSENTE', objet: "tracefab_runtime_function_registry absente", effets: ['MESURE', "tracefab_runtime_function_registry absente"], suite: "appliquer avant 20261028120100 ; vérifier l'absence juste avant" },
  "20261028120100_worker_identity_not_forgeable": { historique: 'ABSENTE', objet: "tracefab_worker et tracefab_upsert_clerk_user absents", effets: ['MESURE', "tracefab_worker et tracefab_upsert_clerk_user absents"], suite: "appliquer après le registre ; migration corrigée pour un exécutant non-superutilisateur" },
  "20261028120200_document_reserved_fields_internal_only": { historique: 'ABSENTE', objet: "tracefab_app conserve UPDATE sur documents", effets: ['MESURE', "tracefab_app conserve UPDATE sur documents"], suite: "appliquer après le registre et le worker" },
  "20261028130000_product_computed_fields_column_scoped": { historique: 'ABSENTE', objet: "tracefab_app conserve des droits d'écriture sur des colonnes calculées de tracefab_products", effets: ['MESURE', "tracefab_app conserve des droits d'écriture sur des colonnes calculées de tracefab_products"], suite: "appliquer puis vérifier les droits colonne par colonne" },
  "20261028140000_supplier_invitation_owner_relationship_scope": { historique: 'ABSENTE', objet: "trigger présent, mais validateur sans contrôle complet du rattachement et du statut de relation", effets: ['MESURE', "trigger présent, mais validateur sans contrôle complet du rattachement et du statut de relation"], suite: "appliquer ; DROP/CREATE du trigger et CREATE OR REPLACE" },
  "20261028150000_reconcile_plm_erp_sync_job_policies": { historique: 'ABSENTE', objet: "les deux politiques canoniques sont déjà présentes ; pas quatre", effets: ['MESURE', "les deux politiques canoniques sont déjà présentes ; pas quatre"], suite: "appliquer de façon idempotente" },
  "20261029180000_plm_erp_sync_jobs_policy_dedup": { historique: 'ABSENTE', objet: "les deux politiques canoniques sont déjà présentes", effets: ['MESURE', "les deux politiques canoniques sont déjà présentes"], suite: "appliquer de façon idempotente" },
  "20261030140000_ingest_payload_role_guard_and_acl": { historique: 'ABSENTE', objet: "fonction SECURITY DEFINER sans garde session_user ; EXECUTE tracefab_app, PUBLIC déjà révoqué", effets: ['MESURE', "fonction SECURITY DEFINER sans garde session_user ; EXECUTE tracefab_app, PUBLIC déjà révoqué"], suite: "appliquer pour fermer la garde de rôle de session" },
  "20261031120000_identite_hmac_liee_au_contexte": { historique: 'ABSENTE', objet: "tables d'identité HMAC absentes ; TRACEFAB_IDENTITY_KEY non configurée", effets: ['MESURE', "tables d'identité HMAC absentes ; TRACEFAB_IDENTITY_KEY non configurée"], suite: "appliquer en mode strict désactivé ; provisionner la clé séparément" },
  "20261102120000_identite_stricte_email_et_rotation": { historique: 'ABSENTE', objet: "dépendance HMAC absente ; mode strict non activable", effets: ['MESURE', "dépendance HMAC absente ; mode strict non activable"], suite: "appliquer après 20261031120000 ; strict reste désactivé" },
};
export const CATALOGUE = {
  "20261021170000_dpp_readiness_truthful_gates": { catalogue: "profil actif à 9 exigences ; les 13 attendues ne sont pas installées", statut: 'DIVERGENCE' },
  "20261027100000_dpp_quality_gate_requires_assessment": { catalogue: "quality.no_open_issues absent du profil et du contrôle actif", statut: 'DIVERGENCE' },
  "20261027130000_dpp_review_preservation_and_publication_coherence": { catalogue: "champs de base de revue présents ; nouveaux champs et fonction de suspension absents", statut: 'DIVERGENCE' },
  "20261028120000_runtime_function_registry": { catalogue: "table du registre absente", statut: 'DIVERGENCE' },
  "20261028120100_worker_identity_not_forgeable": { catalogue: "rôle worker et fonction upsert absents", statut: 'DIVERGENCE' },
  "20261028120200_document_reserved_fields_internal_only": { catalogue: "UPDATE sur documents encore accordé à tracefab_app", statut: 'DIVERGENCE' },
  "20261028130000_product_computed_fields_column_scoped": { catalogue: "champs calculés de produits encore modifiables par tracefab_app", statut: 'DIVERGENCE' },
  "20261028140000_supplier_invitation_owner_relationship_scope": { catalogue: "trigger présent mais validation de relation incomplète", statut: 'DIVERGENCE' },
  "20261028150000_reconcile_plm_erp_sync_job_policies": { catalogue: "deux politiques canoniques déjà présentes ; migration de normalisation sans écart catalogue actuel", statut: 'A QUALIFIER' },
  "20261029180000_plm_erp_sync_jobs_policy_dedup": { catalogue: "deux politiques canoniques déjà présentes ; migration de normalisation sans écart catalogue actuel", statut: 'A QUALIFIER' },
  "20261030140000_ingest_payload_role_guard_and_acl": { catalogue: "garde de rôle de session absente de la fonction SECURITY DEFINER", statut: 'DIVERGENCE' },
  "20261031120000_identite_hmac_liee_au_contexte": { catalogue: "tables HMAC absentes", statut: 'DIVERGENCE' },
  "20261102120000_identite_stricte_email_et_rotation": { catalogue: "tables HMAC absentes ; clé runtime absente", statut: 'DIVERGENCE' },
};
export const HORS_BANDE = {
  "20261006220000_esg_pef_footprint_engine": [
    "pef_emission_factors",
    "product_pef_assessments"
  ],
  "20261006230000_green_claims_anti_greenwashing_engine": [
    "green_claims_rules",
    "product_green_claims",
    "green_claims_audits"
  ],
  "20261006240000_quality_corrective_action_plans_cap": [
    "quality_corrective_action_plans",
    "quality_cap_messages"
  ],
  "20261006250000_universal_supplier_passport": [
    "supplier_universal_passports",
    "supplier_passport_access_requests"
  ],
  "20261006260000_mass_balance_anti_fraud_engine": [
    "transaction_certificates",
    "mass_balance_allocations",
    "mass_balance_reconciliations"
  ]
};
