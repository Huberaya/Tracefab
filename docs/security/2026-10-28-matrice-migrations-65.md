# Matrice des 65 migrations — état recalculé au 28 octobre 2026

**Dépôt** : `Huberaya/Tracefab`, branche `arena/c27ddaa4-tracefab`, PR #102.
**Production** : branche `Primary`, lectures en **lecture seule** des 28/10.
**Ce document est GÉNÉRÉ** : `npm run matrice:migrations -- --markdown`.
Il échoue si l'arithmétique ne ferme plus — le décompte n'est donc pas recopié,
il est recalculé.

## 0. Ce qui est mesuré ici, et ce qui ne l'est pas

| Colonne | Source | Nature |
|---|---|---|
| Nombre de migrations, empreintes SHA-256 | `prisma/migrations` | **mesuré** (ce script) |
| Préfixes d'horodatage en double | idem | **mesuré** (ce script) |
| Statut d'historique (appliquée / annulée / absente) | `_prisma_migrations` | **repris** d'une lecture du 28/10, non relu ici |
| Objets attendus | le fichier `migration.sql` | **lu** (résumé rédigé) |
| Effets observés | lectures de production ponctuelles | **MESURÉ**, **DÉDUIT** ou **NON PROUVÉ** |

Le script ne se connecte à **rien**. Une migration « appliquée » l'est parce
qu'une ligne terminée existe dans `_prisma_migrations` — pas parce que ses
effets sont présents. Les deux sont séparés dans le tableau, et
`applied_steps_count = 0` n'est **pas** traité comme « SQL jamais exécuté ».

## 1. Le décompte, recalculé

```
migrations du dépôt            : 65
appliquées (attestées)         : 49
  dont hors bande              : 5
annulées (rolled_back_at)      : 2
absentes de l'historique       : 9
écarts nommés                  : 11
arithmétique                   : 54 + 2 + 9 = 65
préfixes en double (connus)    : 4 / 4 déclarées
effets MESURÉS                 : 7
effets DÉDUITS                 : 1
effets NON PROUVÉS             : 57
```

**Ce qui a changé depuis la matrice précédente.** Le dépôt comptait encore
`20261028150000_plm_erp_policy_convergence` (ajoutée par un agent, jamais
déployée) et `20261028230000_plm_erp_sync_jobs_policy_deduplication` : toutes
deux retirées au commit `9208391`, la première parce qu'elle **collisionnait**
avec `20261028150000_reconcile_plm_erp_sync_job_policies` et faisait échouer la
CI, la seconde parce que sa redondance est **mesurée** (chaîne complète avec et
sans → catalogue identique) et qu'elle était de surcroît **inatteignable** : la
migration `reconcile` échoue *avant* elle dès que les politiques canoniques
dérivent. Le compte reste 65 parce que la paire retirée était postérieure à la
dernière lecture de production, non attestée, et que le total d'avant incluse
les deux.

## 2. Les quatre préfixes en double, déclarés

`20261006120000`, `20261006200000`, `20261006220000`, `20261017120000`.

Ils sont **antérieurs** à ce chantier, ne bloquent pas `prisma migrate deploy`
(Prisma ordonne sur le **nom du dossier**, pas sur le préfixe) et les retirer
reviendrait à réécrire l'historique — interdit. Le script les **déclare** et
échoue sur toute cinquième paire : c'est précisément ce contrôle qui manquait
le 28/10, quand une collision `20261028150000` a mis la CI en échec alors que
quatre collisions dormaient déjà dans le dépôt.

## 3. Les cinq migrations hors bande

| Migration | Tables créées | Lanceur du dépôt |
|---|---|---|
| `20261006220000_esg_pef_footprint_engine` | `pef_emission_factors`, `product_pef_assessments` | `test_pef_chantier3.mjs` |
| `20261006230000_green_claims_anti_greenwashing_engine` | `green_claims_rules`, `product_green_claims`, `green_claims_audits` | `test_green_claims_chantier4.mjs` |
| `20261006240000_quality_corrective_action_plans_cap` | `quality_corrective_action_plans`, `quality_cap_messages` | `test_quality_cap_chantier5.mjs` |
| `20261006250000_universal_supplier_passport` | `supplier_universal_passports`, `supplier_passport_access_requests` | `apply_migration_chantier6_passport.mjs` |
| `20261006260000_mass_balance_anti_fraud_engine` | `transaction_certificates`, `mass_balance_allocations`, `mass_balance_reconciliations` | `apply_migration_chantier7_mass_balance.mjs` |

Exécutées par un lanceur, **puis** marquées par `resolve --applied` : d'où
`applied_steps_count = 0` avec `finished_at` renseigné. Les **douze tables
existent en production** (lecture du 28/10) — donc `applied_steps_count = 0`
ne signifie **pas** « SQL jamais exécuté ». Ce qui reste non prouvé : que le
schéma produit hors de Prisma soit **équivalent** à celui de la chaîne (même
transaction, même ordre). Contrôle ciblé souhaitable, non bloquant.

## 4. Matrice complète

| # | Migration | Empreinte (12) | Historique | Objets attendus | Effets observes | Nature | Suite |
|---|---|---|---|---|---|---|---|
| 1 | `20260923130000_tracefab_neon_initial` | `6c755b436b9e` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 2 | `20260923140000_tracefab_clerk_context` | `534dc2d4a166` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 3 | `20260923150000_fix_invitation_acceptance` | `89847200c5f5` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 4 | `20260923160000_tracefab_product_api_functions` | `2153575d97dd` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 5 | `20260923170000_fix_data_collection_workflow_context` | `cebd301a044d` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 6 | `20260923180000_fix_data_response_progress_guard` | `e1456e2fb8dc` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 7 | `20260923190000_tracefab_notification_outbox` | `0ddde924c3fc` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 8 | `20260923200000_tracefab_collection_reminders` | `cce36f145c0d` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 9 | `20261005090000_supplier_portal_advanced_hardening` | `13581e6c99a7` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 10 | `20261005100000_supplier_invitation_compatibility` | `362607435775` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 11 | `20261006100000_security_force_rls_and_document_access` | `ee73157701cf` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 12 | `20261006110000_quality_center_shared_access` | `64256414f28d` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 13 | `20261006113000_clerk_directory_membership_sync` | `6e4f38601f2e` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 14 | `20261006120000_data_collection_bridge_and_quality_automation` | `a784cc042bc3` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 15 | `20261006120000_external_schema_bindings` | `df965ab28aa2` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 16 | `20261006123000_clerk_sync_security_functions` | `f6732d8d5788` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 17 | `20261006130000_tracefab_manual_data_request_reminders` | `17a756ec1c70` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 18 | `20261006140000_supply_chain_traceability_api` | `3aec3897c43e` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 19 | `20261006160000_dpp_readiness_exposure` | `bacfe553ee18` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 20 | `20261006180000_supplier_self_onboarding` | `b9e3f5ea1b8d` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 21 | `20261006190000_catalog_import_export` | `036dc97d63f1` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 22 | `20261006200000_catalog_import_kind` | `d5241ea690e1` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 23 | `20261006200000_document_ai_automated_verification` | `0eb5036c85c2` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 24 | `20261006210000_plm_erp_gs1_interoperability` | `330b6689d2d1` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 25 | `20261006220000_esg_pef_footprint_engine` | `2d4f41bf4c29` | APPLIQUEE HORS BANDE | cree pef_emission_factors, product_pef_assessments | les 12 tables existent en production (lecture du 28/10) | **MESURE** | schema equivalent, non prouve ; controle cible souhaitable |
| 26 | `20261006220000_production_hardening` | `66ce9341c7ef` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 27 | `20261006230000_green_claims_anti_greenwashing_engine` | `8430fc087102` | APPLIQUEE HORS BANDE | cree green_claims_rules, product_green_claims, green_claims_audits | les 12 tables existent en production (lecture du 28/10) | **MESURE** | schema equivalent, non prouve ; controle cible souhaitable |
| 28 | `20261006240000_quality_corrective_action_plans_cap` | `fad3c6ba25db` | APPLIQUEE HORS BANDE | cree quality_corrective_action_plans, quality_cap_messages | les 12 tables existent en production (lecture du 28/10) | **MESURE** | schema equivalent, non prouve ; controle cible souhaitable |
| 29 | `20261006250000_universal_supplier_passport` | `cbb5af324a9f` | APPLIQUEE HORS BANDE | cree supplier_universal_passports, supplier_passport_access_requests | les 12 tables existent en production (lecture du 28/10) | **MESURE** | schema equivalent, non prouve ; controle cible souhaitable |
| 30 | `20261006260000_mass_balance_anti_fraud_engine` | `d0328a36291e` | APPLIQUEE HORS BANDE | cree transaction_certificates, mass_balance_allocations, mass_balance_reconciliations | les 12 tables existent en production (lecture du 28/10) | **MESURE** | schema equivalent, non prouve ; controle cible souhaitable |
| 31 | `20261007100000_security_definer_execute_hardening` | `61e18ea4c858` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 32 | `20261007120000_force_rls_schema_bindings` | `c1f8585dd9b8` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 33 | `20261008100000_rate_limit_counters` | `7d7b7a6cb9bb` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 34 | `20261009120000_fix_materials_policy_recursion` | `44c230dc2f9c` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 35 | `20261009180000_public_read_context` | `9100ed08cef2` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 36 | `20261010120000_publication_explicite` | `8b741eab1ff1` | ANNULEE | tracefab_product_is_public exige reviewed_at ; products_select_public ; purge des public_slug non revus | la fonction est creee par 20261009180000, deja appliquee : sa presence ne prouve rien | **NON PROUVE** | sonde de la chaine, fait 1 |
| 37 | `20261012120000_close_public_execute_gap` | `4f6e710f5439` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 38 | `20261014100000_revoke_material_visible_public` | `ff6d95415e4d` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 39 | `20261014110000_revoke_dpp_functions_public` | `0a141838e80d` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 40 | `20261014120000_close_global_default_function_execute` | `cfb6ebac4a60` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 41 | `20261014130000_revoke_public_schema_privileges` | `c6df54676462` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 42 | `20261014140000_remove_public_supplier_passport_share_token` | `d73f1c2d3cf2` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 43 | `20261016130000_dynamic_dpp_lifecycle` | `10b7d8627b18` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 44 | `20261016150000_dpp_claim_evidence_chain` | `8c3e0f1e77a0` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 45 | `20261016170000_dpp_resolvable_identity` | `f9406fbe10d0` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 46 | `20261017100000_fix_document_lifecycle_access` | `7cc1cbfd98a7` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 47 | `20261017120000_active_tenant_context` | `e15c0786ca0b` | ANNULEE | tracefab_active_organization_id, tracefab_in_active_tenant, tracefab_require_active_tenant | 20261021120000, atteste, echoue sans ces trois fonctions (mesure sur base jetable) | **DEDUIT** | regularisation par resolve --applied, sur preuve |
| 48 | `20261017120000_harden_dpp_table_privileges` | `5366746f7ff7` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 49 | `20261017150000_harden_finalize_ops_gate` | `bee1dbce4973` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 50 | `20261019120000_restreindre_dml_role_applicatif` | `19dc214f731e` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 51 | `20261019140000_restreindre_suppression_compteurs_debit` | `1120041bd9f6` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 52 | `20261019160000_retablir_dml_tables_ecrites_directement` | `477789e475f0` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 53 | `20261020120000_structured_supply_chain_graph_membership` | `1e42d60bf6d8` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 54 | `20261021120000_limit_app_function_execute` | `e9f00fb17be9` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 55 | `20261021130000_reconcile_runtime_dml_and_migration_history` | `ec998cc29967` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 56 | `20261021170000_dpp_readiness_truthful_gates` | `3ead8852d9ad` | ABSENTE | profil DPP renomme, 13 prerequis, tracefab_dpp_requirement_met, tracefab_mark_dpp_ready_to_publish | redéfinie par 20261027100000 et 20261027130000 | **NON PROUVE** | sonde, fait 3 |
| 57 | `20261023120000_revoke_app_default_dml` | `fa6bcc2447b5` | APPLIQUEE | — | aucune mesure ciblee | **NON PROUVE** | — |
| 58 | `20261027100000_dpp_quality_gate_requires_assessment` | `238976748996` | ABSENTE | quality.no_open_issues exige une evaluation persistee | aucune mesure | **NON PROUVE** | sonde, fait 4 |
| 59 | `20261027130000_dpp_review_preservation_and_publication_coherence` | `53fee8be3f0e` | ABSENTE | tracefab_suspend_nonconforming_publication, tracefab_compute_dpp_readiness, tracefab_mark_dpp_ready_to_publish | aucune mesure | **NON PROUVE** | sonde, fait 5 |
| 60 | `20261028120000_runtime_function_registry` | `54e1679cf9d7` | ABSENTE | table tracefab_runtime_function_registry (RLS + FORCE), tracefab_apply_runtime_function_grants | table lue absente en production le 28/10 | **MESURE** | prerequis de 20261028120100 ; determine si un deploy passe |
| 61 | `20261028120100_worker_identity_not_forgeable` | `7adbab6591cc` | ABSENTE | role tracefab_worker, 11 politiques reindexees sur current_user | depend du registre | **NON PROUVE** | deploy apres 20261028120000 |
| 62 | `20261028120200_document_reserved_fields_internal_only` | `e19bcff17a33` | ABSENTE | tracefab_mark_document_scanning ; tracefab_app sans INSERT/UPDATE/DELETE sur documents | aucune mesure | **NON PROUVE** | deploy |
| 63 | `20261028130000_product_computed_fields_column_scoped` | `19b34a90620a` | ABSENTE | ecriture au niveau COLONNE sur tracefab_products ; le declencheur ne lit plus le GUC | aucune mesure | **NON PROUVE** | decision separee : pas de deploy global pour ce seul point |
| 64 | `20261028140000_supplier_invitation_owner_relationship_scope` | `6a94aea73674` | ABSENTE | tracefab_validate_member_invitation_role avec controle d appartenance et de statut | aucune mesure | **NON PROUVE** | deploy |
| 65 | `20261028150000_reconcile_plm_erp_sync_job_policies` | `19062d095519` | ABSENTE | 2 politiques permissives retirees de plm_erp_sync_jobs | la table porte 4 politiques au lieu de 2 (lecture du 28/10) | **MESURE** | seul correctif PLM retenu ; sonde C fait 11 en confirmation |

## 5. Ordre de remédiation proposé — **aucune étape n'a été exécutée**

Rien de ce qui suit n'a été lancé. Aucune migration n'a été appliquée en
production, aucune ligne de `_prisma_migrations` n'a été touchée.

### 5.1 La contrainte qui commande tout : `20261028120000` n'est pas rejouable

`20261028120000_runtime_function_registry` **crée** la table
`tracefab_runtime_function_registry`. Rejouée sur une base où elle existe déjà,
elle échoue. Or c'est un **prérequis** de `20261028120100`. Donc :

- si le déploiement s'arrête au milieu, la relance ne reprend pas toute seule ;
- l'instruction de reprise est **`prisma migrate resolve --applied
  <nom>`**, après avoir **constaté** que l'objet attendu existe — jamais
  `--rolled-back`, qui ferait rejouer un fichier non rejouable.

Les cinq migrations affectées en aval, dans l'ordre de la chaîne :

| # | Migration | Dépendance | Si `…120000` échoue |
|---|---|---|---|
| 1 | `20261028120100_worker_identity_not_forgeable` | **exige** le registre | non atteinte |
| 2 | `20261028120200_document_reserved_fields_internal_only` | indépendante, mais ordonnée après | non atteinte |
| 3 | `20261028130000_product_computed_fields_column_scoped` | indépendante | non atteinte |
| 4 | `20261028140000_supplier_invitation_owner_relationship_scope` | indépendante | non atteinte |
| 5 | `20261028150000_reconcile_plm_erp_sync_job_policies` | indépendante | non atteinte |

**Conséquence pratique** : le correctif PLM (`…150000`), qui est le seul dont
l'écart est *mesuré* en production (4 politiques au lieu de 2), ne peut pas
arriver tant que `…120000` bloque. C'est ce qui justifie de traiter `…120000`
en premier, et non la migration PLM en premier.

### 5.2 L'ordre

| Étape | Action | Prérequis | Contrôle AVANT | Contrôle APRÈS | Retour arrière |
|---|---|---|---|---|---|
| 1 | Relever le catalogue de production (script `…tour30-A…sql`) | aucun | — | 85 faits enregistrés, servent de référence | sans objet (lecture) |
| 2 | Trancher le **sens** des appartenances (`…appartenances-roles-production.sql`) | accès SQL Editor | — | Q2 : 2 lignes | sans objet (lecture) |
| 3 | Appliquer `20261028120000` **seule** | accord explicite distinct | registre absent | table + `FORCE RLS` présente | rien à défaire : migration additive |
| 4 | `resolve --applied` **si et seulement si** l'étape 3 a échoué après création de l'objet | constat catalogue | objet absent | objet présent, `steps=0` assumé | sans objet |
| 5 | Appliquer `…120100`, `…120200`, `…130000`, `…140000` dans l'ordre | étape 3 | politiques en place | 11 politiques réindexées sur `current_user` | `…120100` **retire** des droits : le retour arrière est un `GRANT` explicite, à préparer |
| 6 | Appliquer `20261028150000_reconcile_…` | étape 1 (état 4 politiques) | 4 politiques | **2** politiques | recréer les 2 politiques retirées — SQL à rédiger |
| 7 | Relever le catalogue et confronter | étapes 1-6 | référence de l'étape 1 | 0 divergence, ou divergences nommées | sans objet |

### 5.3 Risques propres à chaque étape

- **Étape 3** : `CREATE TABLE` sans `IF NOT EXISTS` → non rejouable (voir 5.1).
- **Étape 5** : `…120200` **retire** `INSERT/UPDATE/DELETE` à `tracefab_app` sur
  `documents`. Si une route applicative écrit encore directement dans
  `documents`, elle casse **silencieusement** en production. Le test
  `test:neon:privileges-role-app` et l'audit `audit:privileges` couvrent le
  catalogue ; **le parcours applicatif, lui, n'est couvert que par les tests
  d'intégration** — c'est le risque le plus élevé de la séquence.
- **Étape 4** : `resolve --applied` inscrit une migration comme exécutée sans
  l'exécuter. À n'utiliser que sur **constat** du catalogue, jamais pour
  « débloquer ».
- **Aucune étape ne doit être faite par `prisma migrate deploy` global** : le
  déploiement global appliquerait les onze d'un coup, y compris `…140000` qui
  est une **décision séparée** (point 2 du plan de l'utilisateur).

## 6. Ce que cette matrice ne prouve pas

- Que les **effets** de chaque migration appliquée soient présents : 57 lignes
  sont `NON PROUVÉ`. Elles ne sont pas « conformes », elles sont **non lues**.
- Que les **empreintes** correspondent : la comparaison empreinte dépôt /
  empreinte production n'a pas été refaite ici. La lecture du 28/10 signalait
  **trois divergences** (`supplier_portal_advanced_hardening`,
  `public_read_context`, et une troisième) — voir
  `docs/security/2026-10-28-tour28-divergences-empreintes.md`. Elles ne sont
  **pas** résolues par ce document.
- Que la production soit dans l'état décrit : tout repose sur des lectures du
  28/10, pas sur une lecture datée du jour du rapport.
