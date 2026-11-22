# Matrice des 65 migrations — état recalculé au 28 octobre 2026

**Dépôt** : `Huberaya/Tracefab`, branche `arena/c27ddaa4-tracefab`, PR #102.
**Production** : branche `Primary`, lectures en **lecture seule** des 28/10.
**Ce document est GÉNÉRÉ** : `npm run matrice:migrations -- --markdown`.
Il échoue si l'arithmétique ne ferme plus — le décompte n'est donc pas recopié,
il est recalculé.

## 0. Les TROIS niveaux, et pourquoi ils ne se confondent pas

Le mandat demande de distinguer trois choses. Les confondre est l'erreur qui a
coûté le plus cher dans ce chantier :

| Niveau | Question | Source | Ce qu'il ne dit PAS |
|---|---|---|---|
| **(a) historique Prisma** | `_prisma_migrations` atteste-t-il l'exécution ? | lecture du 28/10 | que les effets sont présents |
| **(b) catalogue observé** | les objets et politiques sont-ils là ? | lectures de production | quelle migration les a créés |
| **(c) SQL du dépôt** | que ferait la migration si elle était jouée ? | le fichier | ce que la base porte |

Une migration **absente de l'historique ne prouve pas que ses effets sont
absents** : (b) peut être présent sans (a). Une migration **attestée ne prouve
pas que ses effets sont là** : (a) peut exister sans (b). Et (c) ne dit rien de
l'un ni de l'autre.

### Statuts — quatre valeurs, jamais « identique » par défaut

| Statut | Sens |
|---|---|
| `CONFORME` | (a) et (b) disent la même chose, et c'est l'attendu du dépôt |
| `DIVERGENCE` | (a) et (b) se contredisent, ou (b) contredit l'attendu |
| `NON PROUVÉ` | (b) n'a pas été lu — **on ne sait pas** |
| `À QUALIFIER` | (b) a été lu mais ne tranche pas (objet partagé, effet indistinguable) |

**Aucune migration n'est `CONFORME` à ce jour**, et ce n'est pas un oubli : le
catalogue de production n'a été lu que sur les points ciblés. Un `CONFORME` ici
serait une affirmation sans mesure.

## 1. Le décompte, recalculé

```
migrations du dépôt            : 65
appliquées (attestées)         : 49
  dont hors bande              : 5
annulées (rolled_back_at)      : 2
absentes de l'historique       : 9
écarts nommés                  : 11
arithmétique                   : 49 + 5 + 2 + 9 = 65
préfixes en double (connus)    : 4 / 4 déclarées

statut CONFORME   : 0
statut DIVERGENCE : 2
statut NON PROUVE : 57
statut A QUALIFIER: 6
```

Les deux `DIVERGENCE` sont les seules divergences **mesurées** :

- `20261028120000_runtime_function_registry` : la table
  `tracefab_runtime_function_registry` a été **lue absente** en production,
  alors que la migration est un prérequis de la suivante ;
- `20261028150000_reconcile_plm_erp_sync_job_policies` : la table porte **4**
  politiques au lieu de 2, et les 2 surnuméraires n'ont **aucun créateur dans le
  dépôt** — provenance établie hors dépôt (voir
  `scripts/test_provenance_politiques_plm.mjs`, 12 vérifications, et §4.1).

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

| # | Migration | Empreinte (12) | (a) Historique Prisma | (b) Catalogue observe | (c) SQL attendu | Nature | Statut | Suite |
|---|---|---|---|---|---|---|---|---|
| 1 | `20260923130000_tracefab_neon_initial` | `6c755b436b9e` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 2 | `20260923140000_tracefab_clerk_context` | `534dc2d4a166` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 3 | `20260923150000_fix_invitation_acceptance` | `89847200c5f5` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 4 | `20260923160000_tracefab_product_api_functions` | `2153575d97dd` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 5 | `20260923170000_fix_data_collection_workflow_context` | `cebd301a044d` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 6 | `20260923180000_fix_data_response_progress_guard` | `e1456e2fb8dc` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 7 | `20260923190000_tracefab_notification_outbox` | `0ddde924c3fc` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 8 | `20260923200000_tracefab_collection_reminders` | `cce36f145c0d` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 9 | `20261005090000_supplier_portal_advanced_hardening` | `13581e6c99a7` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 10 | `20261005100000_supplier_invitation_compatibility` | `362607435775` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 11 | `20261006100000_security_force_rls_and_document_access` | `ee73157701cf` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 12 | `20261006110000_quality_center_shared_access` | `64256414f28d` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 13 | `20261006113000_clerk_directory_membership_sync` | `6e4f38601f2e` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 14 | `20261006120000_data_collection_bridge_and_quality_automation` | `a784cc042bc3` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 15 | `20261006120000_external_schema_bindings` | `df965ab28aa2` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 16 | `20261006123000_clerk_sync_security_functions` | `f6732d8d5788` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 17 | `20261006130000_tracefab_manual_data_request_reminders` | `17a756ec1c70` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 18 | `20261006140000_supply_chain_traceability_api` | `3aec3897c43e` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 19 | `20261006160000_dpp_readiness_exposure` | `bacfe553ee18` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 20 | `20261006180000_supplier_self_onboarding` | `b9e3f5ea1b8d` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 21 | `20261006190000_catalog_import_export` | `036dc97d63f1` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 22 | `20261006200000_catalog_import_kind` | `d5241ea690e1` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 23 | `20261006200000_document_ai_automated_verification` | `0eb5036c85c2` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 24 | `20261006210000_plm_erp_gs1_interoperability` | `330b6689d2d1` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 25 | `20261006220000_esg_pef_footprint_engine` | `2d4f41bf4c29` | APPLIQUEE HORS BANDE | PRESENT MESURE — les 12 tables existent en production | cree pef_emission_factors, product_pef_assessments | **MESURE** | **A QUALIFIER** | schema equivalent, non prouve ; controle cible souhaitable |
| 26 | `20261006220000_production_hardening` | `66ce9341c7ef` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 27 | `20261006230000_green_claims_anti_greenwashing_engine` | `8430fc087102` | APPLIQUEE HORS BANDE | PRESENT MESURE — les 12 tables existent en production | cree green_claims_rules, product_green_claims, green_claims_audits | **MESURE** | **A QUALIFIER** | schema equivalent, non prouve ; controle cible souhaitable |
| 28 | `20261006240000_quality_corrective_action_plans_cap` | `fad3c6ba25db` | APPLIQUEE HORS BANDE | PRESENT MESURE — les 12 tables existent en production | cree quality_corrective_action_plans, quality_cap_messages | **MESURE** | **A QUALIFIER** | schema equivalent, non prouve ; controle cible souhaitable |
| 29 | `20261006250000_universal_supplier_passport` | `cbb5af324a9f` | APPLIQUEE HORS BANDE | PRESENT MESURE — les 12 tables existent en production | cree supplier_universal_passports, supplier_passport_access_requests | **MESURE** | **A QUALIFIER** | schema equivalent, non prouve ; controle cible souhaitable |
| 30 | `20261006260000_mass_balance_anti_fraud_engine` | `d0328a36291e` | APPLIQUEE HORS BANDE | PRESENT MESURE — les 12 tables existent en production | cree transaction_certificates, mass_balance_allocations, mass_balance_reconciliations | **MESURE** | **A QUALIFIER** | schema equivalent, non prouve ; controle cible souhaitable |
| 31 | `20261007100000_security_definer_execute_hardening` | `61e18ea4c858` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 32 | `20261007120000_force_rls_schema_bindings` | `c1f8585dd9b8` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 33 | `20261008100000_rate_limit_counters` | `7d7b7a6cb9bb` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 34 | `20261009120000_fix_materials_policy_recursion` | `44c230dc2f9c` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 35 | `20261009180000_public_read_context` | `9100ed08cef2` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 36 | `20261010120000_publication_explicite` | `8b741eab1ff1` | ANNULEE | NON LU — la fonction qui la porte (20261009180000) existe deja | tracefab_product_is_public exige reviewed_at ; products_select_public ; purge des public_slug non revus | **NON PROUVE** | **NON PROUVE** | sonde de la chaine, fait 1 |
| 37 | `20261012120000_close_public_execute_gap` | `4f6e710f5439` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 38 | `20261014100000_revoke_material_visible_public` | `ff6d95415e4d` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 39 | `20261014110000_revoke_dpp_functions_public` | `0a141838e80d` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 40 | `20261014120000_close_global_default_function_execute` | `cfb6ebac4a60` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 41 | `20261014130000_revoke_public_schema_privileges` | `c6df54676462` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 42 | `20261014140000_remove_public_supplier_passport_share_token` | `d73f1c2d3cf2` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 43 | `20261016130000_dynamic_dpp_lifecycle` | `10b7d8627b18` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 44 | `20261016150000_dpp_claim_evidence_chain` | `8c3e0f1e77a0` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 45 | `20261016170000_dpp_resolvable_identity` | `f9406fbe10d0` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 46 | `20261017100000_fix_document_lifecycle_access` | `7cc1cbfd98a7` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 47 | `20261017120000_active_tenant_context` | `e15c0786ca0b` | ANNULEE | PRESENT — deduit : 20261021120000, attestee, echoue sans ces 3 fonctions | tracefab_active_organization_id, tracefab_in_active_tenant, tracefab_require_active_tenant | **DEDUIT** | **A QUALIFIER** | regularisation par resolve --applied, sur preuve |
| 48 | `20261017120000_harden_dpp_table_privileges` | `5366746f7ff7` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 49 | `20261017150000_harden_finalize_ops_gate` | `bee1dbce4973` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 50 | `20261019120000_restreindre_dml_role_applicatif` | `19dc214f731e` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 51 | `20261019140000_restreindre_suppression_compteurs_debit` | `1120041bd9f6` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 52 | `20261019160000_retablir_dml_tables_ecrites_directement` | `477789e475f0` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 53 | `20261020120000_structured_supply_chain_graph_membership` | `1e42d60bf6d8` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 54 | `20261021120000_limit_app_function_execute` | `e9f00fb17be9` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 55 | `20261021130000_reconcile_runtime_dml_and_migration_history` | `ec998cc29967` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 56 | `20261021170000_dpp_readiness_truthful_gates` | `3ead8852d9ad` | ABSENTE | NON LU — redéfinie par 20261027100000 et 20261027130000 | profil DPP renomme, 13 prerequis, tracefab_dpp_requirement_met, tracefab_mark_dpp_ready_to_publish | **NON PROUVE** | **NON PROUVE** | sonde, fait 3 |
| 57 | `20261023120000_revoke_app_default_dml` | `fa6bcc2447b5` | APPLIQUEE | NON LU | — | **NON PROUVE** | **NON PROUVE** | — |
| 58 | `20261027100000_dpp_quality_gate_requires_assessment` | `238976748996` | ABSENTE | NON LU | quality.no_open_issues exige une evaluation persistee | **NON PROUVE** | **NON PROUVE** | sonde, fait 4 |
| 59 | `20261027130000_dpp_review_preservation_and_publication_coherence` | `53fee8be3f0e` | ABSENTE | NON LU | tracefab_suspend_nonconforming_publication, tracefab_compute_dpp_readiness, tracefab_mark_dpp_ready_to_publish | **NON PROUVE** | **NON PROUVE** | sonde, fait 5 |
| 60 | `20261028120000_runtime_function_registry` | `54e1679cf9d7` | ABSENTE | ABSENT — table tracefab_runtime_function_registry lue absente | table tracefab_runtime_function_registry (RLS + FORCE), tracefab_apply_runtime_function_grants | **MESURE** | **DIVERGENCE** | prerequis de 20261028120100 ; determine si un deploy passe |
| 61 | `20261028120100_worker_identity_not_forgeable` | `7adbab6591cc` | ABSENTE | NON LU — depend du registre, dont l absence a ete lue | role tracefab_worker, 11 politiques reindexees sur current_user | **NON PROUVE** | **NON PROUVE** | deploy apres 20261028120000 |
| 62 | `20261028120200_document_reserved_fields_internal_only` | `e19bcff17a33` | ABSENTE | NON LU — les droits sur documents se lisent avec le SQL des privileges effectifs | tracefab_mark_document_scanning ; tracefab_app sans INSERT/UPDATE/DELETE sur documents | **NON PROUVE** | **NON PROUVE** | deploy |
| 63 | `20261028130000_product_computed_fields_column_scoped` | `19b34a90620a` | ABSENTE | NON LU — les droits sur tracefab_products se lisent de meme | ecriture au niveau COLONNE sur tracefab_products ; le declencheur ne lit plus le GUC | **NON PROUVE** | **NON PROUVE** | decision separee : pas de deploy global pour ce seul point |
| 64 | `20261028140000_supplier_invitation_owner_relationship_scope` | `6a94aea73674` | ABSENTE | NON LU — decision separee, aucun deploy global pour ce seul point | tracefab_validate_member_invitation_role avec controle d appartenance et de statut | **NON PROUVE** | **NON PROUVE** | deploy |
| 65 | `20261028150000_reconcile_plm_erp_sync_job_policies` | `19062d095519` | ABSENTE | DIVERGENCE MESUREE — 4 politiques au lieu de 2 ; les 2 surnumeraires n ont AUCUN createur dans le depot (provenance hors depot) | 2 politiques permissives retirees de plm_erp_sync_jobs | **MESURE** | **DIVERGENCE** | seul correctif PLM retenu ; sonde C fait 11 en confirmation |
## 4.1 Provenance des quatre politiques de `plm_erp_sync_jobs`

Question posée : les deux politiques surnuméraires viennent-elles d'une
**ancienne migration** (auquel cas un déploiement peut les recréer, et un `DROP`
ne suffit pas) ou d'un **correctif hors dépôt** (le `DROP` suffit, mais il faut
le documenter) ?

Le catalogue ne peut pas répondre : `pg_policy` ne porte **aucune date de
création**. La réponse vient d'un balayage exhaustif du dépôt **et de son
historique** (`scripts/test_provenance_politiques_plm.mjs`, 12 vérifications) :

| Politique | Créée par | Détruite par |
|---|---|---|
| `plm_sync_jobs_insert_brand` (canonique) | `20261006210000_plm_erp_gs1_interoperability` | — |
| `plm_sync_jobs_select_org` (canonique) | `20261006210000_plm_erp_gs1_interoperability` | — |
| `plm_erp_sync_jobs_insert_brand` (**surnuméraire**) | **AUCUNE migration** | `20261028150000_reconcile_…` |
| `plm_erp_sync_jobs_select_brand` (**surnuméraire**) | **AUCUNE migration** | `20261028150000_reconcile_…` |

Le balayage ne s'arrête pas à l'état courant : il ouvre **chaque commit** de
l'historique qui a fait varier le nom (`git log -S`), et cherche une ligne
**ajoutée** contenant `CREATE POLICY`. Résultat : **zéro** création, y compris
dans les migrations écrites puis retirées pendant la session (`963a524`,
`5b989b7`, `a5b6189`, `88758ce` n'ont fait que les **nommer pour les retirer**).

**Conclusion de provenance : hors dépôt.** Aucun chemin de déploiement ne les
recrée. Un `DROP` dans une migration corrective est donc suffisant **et
durable** — à condition que la migration refuse de détruire quoi que ce soit si
la base ne ressemble pas à celle attendue, ce que fait la réconciliation
(*fail-closed* : `RAISE` avant le premier `DROP`, transactionnel, ni `GRANT` ni
donnée touchée — trois assertions du même test).

**Ce que ce balayage ne dit pas** : *qui* les a créées, ni *quand*. Le dépôt
établit l'absence de chemin, pas l'auteur. Cette information n'existe dans
aucun catalogue PostgreSQL.

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

Les **cinq** migrations affectées en aval, dans l'ordre de la chaîne :

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
  déploiement global appliquerait les onze écarts d'un coup, y compris `…140000` qui
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
