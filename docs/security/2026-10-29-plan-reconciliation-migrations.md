# Plan de reconciliation des migrations — genere

`node scripts/plan_reconciliation_migrations.mjs --markdown` sur 67 migrations du depot.

**Aucune etape de ce plan n a ete executee.** Aucun acces en ecriture a la production.

## 1. Liste exacte

| Migration | Historique | Effets (production) | Action | Prerequis | Risque |
|---|---|---|---|---|---|
| `20261029150000_plm_sync_jobs_policy_alignment` | NOUVELLE | NON DEPLOYEE | **APPLIQUER SEULE (jamais deployee)** | decision sur les migrations jumelles : plusieurs fichiers font le meme DROP | aucun historique a reconcilier : elle n a jamais ete jouee |
| `20261029160000_plm_erp_sync_jobs_policy_drift` | NOUVELLE | NON DEPLOYEE | **APPLIQUER SEULE (jamais deployee)** | decision sur les migrations jumelles : plusieurs fichiers font le meme DROP | aucun historique a reconcilier : elle n a jamais ete jouee |
| `20261021170000_dpp_readiness_truthful_gates` | ABSENTE | NON PROUVE | **SONDE → APPLIED SI PRESENT, SINON APPLIQUER SEULE** | sonde de la chaine ; la branche est choisie par la mesure, pas par defaut | rejouable : un second passage est sans effet |
| `20261027100000_dpp_quality_gate_requires_assessment` | ABSENTE | NON PROUVE | **SONDE → APPLIED SI PRESENT, SINON APPLIQUER SEULE** | sonde de la chaine ; la branche est choisie par la mesure, pas par defaut | rejouable : un second passage est sans effet |
| `20261027130000_dpp_review_preservation_and_publication_coherence` | ABSENTE | NON PROUVE | **SONDE → APPLIED SI PRESENT, SINON APPLIQUER SEULE** | sonde de la chaine ; la branche est choisie par la mesure, pas par defaut | rejouable : un second passage est sans effet |
| `20261028120000_runtime_function_registry` | ABSENTE | MESURE | **APPLIQUER EN PREMIER** | releve du catalogue juste avant, et confirmation que la table est toujours absente | NON rejouable (CREATE TABLE sans IF NOT EXISTS) : un second passage casse et bloque les 5 suivantes |
| `20261028120100_worker_identity_not_forgeable` | ABSENTE | NON PROUVE | **SONDE → APPLIED SI PRESENT, SINON APPLIQUER SEULE** | sonde de la chaine ; la branche est choisie par la mesure, pas par defaut | rejouable : un second passage est sans effet |
| `20261028120200_document_reserved_fields_internal_only` | ABSENTE | NON PROUVE | **SONDE → APPLIED SI PRESENT, SINON APPLIQUER SEULE** | sonde de la chaine ; la branche est choisie par la mesure, pas par defaut | rejouable : un second passage est sans effet |
| `20261028130000_product_computed_fields_column_scoped` | ABSENTE | NON PROUVE | **SONDE → APPLIED SI PRESENT, SINON APPLIQUER SEULE** | sonde de la chaine ; la branche est choisie par la mesure, pas par defaut | rejouable : un second passage est sans effet |
| `20261028140000_supplier_invitation_owner_relationship_scope` | ABSENTE | NON PROUVE | **SONDE → APPLIED SI PRESENT, SINON APPLIQUER SEULE** | sonde de la chaine ; la branche est choisie par la mesure, pas par defaut | rejouable : un second passage est sans effet |
| `20261028150000_reconcile_plm_erp_sync_job_policies` | ABSENTE | MESURE | **APPLIQUER SEULE** | aucun (ne depend d aucune autre migration) | faible et borne : additive, idempotente, gardes fail-closed ; si la base ne ressemble pas a l attendu elle REFUSE et arrete la suite (c est voulu) |
| `20261010120000_publication_explicite` | ANNULEE | NON PROUVE | **SONDE → APPLIED SI PRESENT, SINON APPLIQUER SEULE** | sonde de la chaine ; la branche est choisie par la mesure, pas par defaut | NON rejouable (1 creation(s) sans garde) : la branche « appliquer » ne doit etre tentee qu UNE fois |
| `20261017120000_active_tenant_context` | ANNULEE | DEDUIT | **RESOLVE --APPLIED SUR PREUVE** | sonde confirmant les effets au moment de l execution | aucun DDL rejoue ; documente un etat deja present sans le modifier |

## 2. Deja materialisees (5) — ne rien rejouer

| Migration | Objets lus presents |
|---|---|
| `20261006220000_esg_pef_footprint_engine` | pef_emission_factors, product_pef_assessments |
| `20261006230000_green_claims_anti_greenwashing_engine` | green_claims_rules, product_green_claims, green_claims_audits |
| `20261006240000_quality_corrective_action_plans_cap` | quality_corrective_action_plans, quality_cap_messages |
| `20261006250000_universal_supplier_passport` | supplier_universal_passports, supplier_passport_access_requests |
| `20261006260000_mass_balance_anti_fraud_engine` | transaction_certificates, mass_balance_allocations, mass_balance_reconciliations |

## 3. Interdits du plan, verifies

Le generateur refuse : `UPDATE`/`DELETE` sur `_prisma_migrations`,
`resolve --rolled-back`, `deploy` global, `resolve --applied` sans preuve nommee.
`resolve --applied` n ecrit aucune ligne de migration : il documente un etat deja la.

Controles : aucune violation
