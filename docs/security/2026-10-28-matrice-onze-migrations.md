# Matrice des onze migrations en écart — état mesuré au 28 octobre 2026

**SHA de référence** : `f03c934` (avant ce document)
**Production** : branche `Primary`, lectures du 28/10, lecture seule.
**Source des chiffres** : `_prisma_migrations` (lecture du 28/10) et mesures
reproductibles sur base jetable (`npm run test:deploiement-simule`,
`test:rejeu-migrations`, `test:reconciliation-options`).

---

## 1. Le décompte, réconcilié

| Élément | Nombre | Source |
|---|---|---|
| Migrations dans le dépôt | **65** | `prisma/migrations` |
| Lignes `_prisma_migrations` avec `finished_at` | **56** | lecture production |
| dont lignes **annulées** (`rolled_back_at` renseigné) | **2** | lecture production |
| **Migrations réellement appliquées** | **54** | 56 − 2 |
| Migrations du dépôt sans ligne d'historique | **9** | comparaison nommée |
| Migrations marquées **annulées** | **2** | idem |
| **Écarts totaux** | **11** | 9 + 2 |
| Migrations hors bande (`applied_steps_count = 0`, `finished_at` renseigné) | **5** | réconciliation du 28/10 |

Vérification arithmétique : `54 + 9 + 2 = 65`. Le compte est clos.

---

## 2. La matrice

Colonne « effets mesurés » : ce que la **production** porte. Une seule entrée y
est établie avec certitude — et elle l'est par **déduction**, pas par lecture :
voir §3.

| # | Migration | Historique | Effets attendus (dépôt) | Effets mesurés (production) | Dépendances | Verdict |
|---|---|---|---|---|---|---|
| 36 | `20261010120000_publication_explicite` | **ANNULÉE** | `tracefab_product_is_public` exige `reviewed_at` ; politique `products_select_public` sur `tracefab_products` ; purge des `public_slug` non revus | **INCONNU** — la fonction qui la porte est créée par `20261009180000`, déjà appliquée : sa présence ne prouve rien | aucune migration ultérieure ne la retouche | **en attente de la sonde** (sonde C, fait 1) |
| 47 | `20261017120000_active_tenant_context` | **ANNULÉE** | `tracefab_active_organization_id`, `tracefab_in_active_tenant`, `tracefab_require_active_tenant` | **PRÉSENTS — prouvé par déduction** (§3) | `20261021120000` **exige** ces trois fonctions | **à régulariser par `resolve --applied`**, sur preuve |
| 56 | `20261021170000_dpp_readiness_truthful_gates` | ABSENTE | profil DPP renommé « technical readiness », 13 prérequis ; `tracefab_dpp_requirement_met`, `tracefab_mark_dpp_ready_to_publish` | **INCONNU** | redéfinie par `20261027100000` et `20261027130000` | en attente de la sonde (fait 3) |
| 58 | `20261027100000_dpp_quality_gate_requires_assessment` | ABSENTE | `quality.no_open_issues` exige une évaluation persistée (`data_quality_scores` par produit) | **INCONNU** | aucune | en attente de la sonde (fait 4) |
| 59 | `20261027130000_dpp_review_preservation_and_publication_coherence` | ABSENTE | `tracefab_suspend_nonconforming_publication`, `tracefab_compute_dpp_readiness`, `tracefab_mark_dpp_ready_to_publish` | **INCONNU** | aucune | en attente de la sonde (fait 5) |
| 60 | `20261028120000_runtime_function_registry` | ABSENTE | table `tracefab_runtime_function_registry` (RLS + `FORCE`), `tracefab_apply_runtime_function_grants` | **INCONNU — et c'est le point dur** | **prérequis de `20261028120100`** | en attente de la sonde (fait 6) ; **détermine si un `deploy` passe ou casse** |
| 61 | `20261028120100_worker_identity_not_forgeable` | ABSENTE | rôle `tracefab_worker`, 11 politiques réindexées sur `current_user` | **INCONNU** | dépend du registre (60) | en attente de la sonde (fait 7) |
| 62 | `20261028120200_document_reserved_fields_internal_only` | ABSENTE | `tracefab_mark_document_scanning` ; `tracefab_app` **sans** `INSERT/UPDATE/DELETE` sur `documents` | **INCONNU** | aucune | en attente de la sonde (fait 8) |
| 63 | `20261028130000_product_computed_fields_column_scoped` | ABSENTE | écriture au niveau **colonne** sur `tracefab_products` ; le déclencheur ne lit plus le GUC | **INCONNU** | aucune | en attente de la sonde (fait 9) |
| 64 | `20261028140000_supplier_invitation_owner_relationship_scope` | ABSENTE | `tracefab_validate_member_invitation_role` avec contrôle d'appartenance et de statut | **INCONNU** | aucune | en attente de la sonde (fait 10) |
| 65 | `20261028150000_reconcile_plm_erp_sync_job_policies` | ABSENTE | 2 politiques retirées de `plm_erp_sync_jobs` | **ABSENTS — prouvé** : la table porte **4** politiques au lieu de 2 (lecture du 28/10) | aucune | **correctif à appliquer**, sonde C fait 11 en confirmation |

---

## 3. La seule preuve positive, et comment elle est faite

`20261021120000_limit_app_function_execute` est **appliquée** en production —
elle ne fait pas partie des onze écarts. Or, mesuré sur base jetable
(`npm run test:deploiement-simule`) :

```
sauter 20261017120000 SEULE fait echouer la chaine a 20261021120000 :
  « Runtime EXECUTE allowlist has missing, overloaded or foreign-owned
     functions: tracefab_active_organization_id, tracefab_in_active_tenant,
     tracefab_require_active_tenant »
```

Donc :

| Fait | Nature |
|---|---|
| production a appliqué `20261021120000` | mesuré (lecture `_prisma_migrations`) |
| `20261021120000` échoue sans ces trois fonctions | mesuré (base jetable) |
| **ces trois fonctions existent en production** | **déduit** |
| **les effets de `20261017120000` sont présents** | **déduit** |

C'est la première preuve positive, dans ce chantier, qu'une ligne marquée
`rolled_back_at` **ne dit rien de la base**. Elle ne vient d'aucune lecture de
production supplémentaire : elle vient de ce que l'historique de production
**s'auto-contredit**.

**Corollaire** : l'état « 54 appliquées, aucun effet de plus » n'est **pas
constructible** — sauter les onze casse la chaîne à la 54ᵉ. Cet état n'a donc
jamais existé en production.

---

## 4. Réexécution et échec — ce qui est mesuré

`npm run test:rejeu-migrations` (4 vérifications) :

| Résultat | Migrations |
|---|---|
| rejouables (10/11) | toutes sauf une |
| **casse** (1/11) | `20261028120000_runtime_function_registry` — `CREATE TABLE` sans `IF NOT EXISTS` |

`npm run test:deploiement-simule` (11 vérifications) — échec injecté : si la
table du registre existe déjà, `20261028120000` échoue et bloque **cinq**
migrations : `…12010000`, `…12020000`, `…130000`, `…140000`, `…150000` — dont
les **deux correctifs**. La transaction annulée ne laisse **aucune trace
partielle** (mesuré).

`npm run test:reconciliation-options` (12 vérifications) — les deux options,
comparées :

| | Option A : `deploy` direct | Option B : `resolve --applied` sur preuve, puis `deploy` |
|---|---|---|
| Réécrit l'historique | non | non (aucune ligne supprimée, aucun checksum recalculé) |
| Applique les deux annulées | oui, inutilement | non |
| Casse si l'effet du registre est présent | **oui, 5 migrations bloquées** | non, si le registre est déclaré appliqué sur preuve |
| Dépend de la sonde | **oui** | **oui** |

Aucune des deux n'est sûre sans la sonde. C'est la conclusion, et elle n'est pas
un refus de conclure : elle nomme l'unique information manquante.

---

## 5. Ce que la matrice ne dit pas

- **Les effets réels** des dix migrations marquées « INCONNU ». Une seule
  lecture les donnera : `2026-10-28-tour30-C-sondes-effets.sql`, 11 sondes.
- **Les données** transformées par `20261010120000` (purge de `public_slug`) et
  `20261017120000` : la sonde lit des objets, pas des lignes. Une migration dont
  les objets sont présents peut avoir laissé des données non transformées.
- **L'ordre réel** dans lequel la production a reçu ces migrations.
