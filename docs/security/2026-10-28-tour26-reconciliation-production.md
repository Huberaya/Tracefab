# Tour 26 — réconciliation de l'export réel : le diagnostic change

Branche `arena/c27ddaa4-tracefab`, commit `e0d6894`. Export de
`_prisma_migrations` fourni par l'opérateur (58 lignes, lecture seule).
Réconciliation exécutée **hors ligne**, sans aucune connexion.

Aucune écriture, aucune fusion, aucun déploiement, aucun secret.

## 0. Résultat en une phrase

**L'historique n'est pas bloqué.** Le registre runtime est absent parce que
**sept migrations n'ont jamais été déployées**, pas parce qu'un incident bloque
la chaîne. Deux constats nouveaux, non signalés, sont plus préoccupants que
l'incident rapporté.

## 1. Ce que l'export contient réellement

```
depot      : 63 migrations
production : 58 lignes, 56 noms distincts
attestees  : 56 / 63
```

Les **58 lignes** correspondent à **56 migrations** : deux noms portent deux
lignes chacun. Le rapport initial annonçait « 2 non terminées et 2 annulées » —
ce sont les **mêmes deux lignes**, comptées deux fois. Une ligne annulée a
mécaniquement `finished_at = NULL` : elle est à la fois « non terminée » et
« annulée ». Il n'y a donc **aucune entrée bloquante** :

> `prisma migrate deploy` n'est pas bloqué. Il appliquera les sept migrations
> manquantes.

## 2. Les deux incidents rapportés : résolus, et ce qu'ils apprennent

| Migration | Ligne annulée | Ligne retenue | Empreinte |
|---|---|---|---|
| `20261010120000_publication_explicite` | `2026-10-16 02:04:36` | `2026-10-16 02:04:39` | **différentes** : `30b214…` → `8b741e…` |
| `20261017120000_active_tenant_context` | `2026-10-18 00:04:00` | `2026-10-18 00:07:54` | **identiques** : `e15c07…` |

Deux lectures, et elles sont décisives :

- **`publication_explicite`** : l'empreinte a changé entre l'échec et la
  réussite. C'est la signature du P3018 du 15/10 — le contenu a été corrigé
  **puis** rejoué. La ligne retenue (`8b741e…`) **correspond au dépôt actuel** :
  c'est bien le contenu corrigé qui est en production. L'incident est clos.
- **`active_tenant_context`** : empreinte **identique** avant et après. Le
  contenu n'a pas changé, seule l'exécution a réussi au second essai — donc le
  défaut était **environnemental**, exactement comme le diagnostic « refus de
  privilèges sur le schéma `public` » l'indiquait. L'incident est clos.

Aucun des deux ne demande d'action sur la migration elle-même.

## 3. Constat nouveau nº1 — trois empreintes divergent du dépôt

Ce ne sont **pas** les migrations rapportées. Le fichier a changé **après**
l'exécution en production :

| Migration | Empreinte du dépôt | Empreinte en production |
|---|---|---|
| `20261005090000_supplier_portal_advanced_hardening` | `13581e6c…` | `560356c2…` |
| `20261006210000_plm_erp_gs1_interoperability` | `330b6689…` | `c944ce0c…` |
| `20261009180000_public_read_context` | `9100ed08…` | `c12ee333…` |

**Conséquence à ne pas minimiser** : la production a exécuté un contenu qui
n'est plus celui du dépôt. `migrate deploy` ne compare pas les empreintes des
migrations déjà appliquées — il passera sans rien signaler. Si ces
modifications sont fonctionnelles (et pas seulement des commentaires), le
schéma de production **n'est pas reproductible** depuis le dépôt.

Je ne peux pas en juger : le dépôt n'a qu'un commit pour ces fichiers
(`bf55f2a`), l'historique antérieur n'est pas disponible. **Ce point exige une
revue humaine** des trois diffs. C'est la question la plus importante du
rapport et elle n'était pas dans la liste initiale.

## 4. Constat nouveau nº2 — cinq migrations « appliquées » sans aucune étape

`applied_steps_count = 0` alors que `finished_at` est renseigné :

| Migration | Tables créées |
|---|---|
| `20261006220000_esg_pef_footprint_engine` | `pef_emission_factors`, `product_pef_assessments` |
| `20261006230000_green_claims_anti_greenwashing_engine` | `green_claims_rules`, `product_green_claims`, `green_claims_audits` |
| `20261006240000_quality_corrective_action_plans_cap` | `quality_corrective_action_plans`, `quality_cap_messages` |
| `20261006250000_universal_supplier_passport` | `supplier_universal_passports`, `supplier_passport_access_requests` |
| `20261006260000_mass_balance_anti_fraud_engine` | `transaction_certificates`, `mass_balance_allocations`, `mass_balance_reconciliations` |

Prisma enregistre `0` lorsqu'une migration est **marquée appliquée sans être
exécutée** (`migrate resolve --applied`). Les onze tables ci-dessus peuvent donc
**ne pas exister en production**, alors que l'historique affirme le contraire.
Toutes les autres migrations du même lot portent `applied_steps_count = 1`.

À noter : ces cinq lignes ont été enregistrées à `15:47` le 06/10, en rafale de
cinq secondes — la signature d'une résolution en masse, pas d'une application.

## 5. Constat nouveau nº3 — sept migrations non attestées, pas cinq

```
20261021170000_dpp_readiness_truthful_gates          <- antérieure au dernier déploiement
20261027100000_dpp_quality_gate_requires_assessment
20261027130000_dpp_review_preservation_and_publication_coherence
20261028120000_runtime_function_registry             <- le registre
20261028120100_worker_identity_not_forgeable
20261028120200_document_reserved_fields_internal_only
20261028130000_product_computed_fields_column_scoped
```

Cinq sont postérieures au dernier déploiement (`20261023120000`, le 22/10) :
simple retard de déploiement.

**La sixième ne l'est pas.** `20261021170000` est **antérieure** à la dernière
migration appliquée, et pourtant absente. Elle a donc été ajoutée au dépôt
**après** le déploiement du 22/10, avec un horodatage plus ancien. C'est une
entorse à l'ordre des migrations : `deploy` l'appliquera quand même (il traite
les manquantes dans l'ordre lexicographique), mais la chronologie du dépôt ne
reflète plus celle de la production. À documenter, pas à corriger par un renommage.

## 6. Ce que cela change dans le plan de reprise

Le plan du tour 25 (`resolve --rolled-back` puis `deploy`) était **fondé sur une
hypothèse fausse**. Il est remplacé par ceci — plus simple, et sans écriture sur
`_prisma_migrations` :

| # | Action | Écriture | Risque |
|---|---|---|---|
| 0 | Vérifier les onze tables du §4 en lecture seule | non | — |
| 1 | Revue humaine des trois diffs du §3 | non | — |
| 2 | `prisma migrate deploy` : applique les sept manquantes | **oui**, schéma | les cinq migrations à 0 étape ne sont **pas** rejouées |
| 3 | Re-exporter et réconcilier : attendu 63 attestées, 0 écart | non | — |
| 4 | M6 mesurable, puis M3 tranchable | non | — |

**Pas de `resolve`.** Aucune entrée n'est bloquante : l'étape du tour 25 devient
inutile. C'est un allègement, pas un renoncement.

**Mais un angle mort subsiste, et il est sérieux** : `deploy` ne rejouera **pas**
les cinq migrations marquées appliquées. Si leurs onze tables manquent, il faut
décider séparément quoi faire — et ce ne sera pas un `deploy`, ce sera une
décision explicite (marquer non appliquées puis rejouer, ou appliquer le SQL à
la main). **C'est pourquoi l'étape 0 conditionne tout le reste.**

### Requête de vérification à exécuter (lecture seule)

```sql
SELECT t.nom,
       to_regclass('public.' || t.nom) IS NOT NULL AS existe
  FROM (VALUES
    ('pef_emission_factors'), ('product_pef_assessments'),
    ('green_claims_rules'), ('product_green_claims'), ('green_claims_audits'),
    ('quality_corrective_action_plans'), ('quality_cap_messages'),
    ('supplier_universal_passports'), ('supplier_passport_access_requests'),
    ('transaction_certificates'), ('mass_balance_allocations'),
    ('mass_balance_reconciliations')
  ) AS t(nom)
 ORDER BY 1;
```

Si une seule répond `false`, le §4 est confirmé et le plan doit être révisé
**avant** toute écriture.

## 7. Ce qui reste `BLOCKED`

- **M6** : les blocs 1 à 5 du relevé (rôles, propriétaires, politiques,
  privilèges) n'ont pas été exécutés — seul l'historique a été exporté.
- **M3** : inchangé, dépend de M6.
- **Les trois divergences** : je ne peux pas comparer les contenus, la
  production n'a pas été exportée au-delà de l'historique.

## 8. Livré dans ce tour

| Fichier | Nature |
|---|---|
| `scripts/reconcilier-historique-migrations.mjs` | gère le JSON, les lignes multiples, la ligne retenue ; imprime le commit |
| `scripts/test_reconcilier_historique_migrations.mjs` | 41 vérifications, dont le cas réel « annulée puis réussie » ; mutation éprouvée |
| `docs/security/2026-10-28-tour25-reprise-migrations.md` | bandeau de correction de l'hypothèse fausse |

Aucune migration créée ni modifiée, aucun changement de posture.
