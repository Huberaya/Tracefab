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

## 4. Constat nº2 — cinq migrations appliquées HORS BANDE : expliqué, pas anodin

`applied_steps_count = 0` alors que `finished_at` est renseigné, sur cinq
migrations :

| Migration | Tables créées | Lanceur du dépôt |
|---|---|---|
| `20261006220000_esg_pef_footprint_engine` | `pef_emission_factors`, `product_pef_assessments` | `test_pef_chantier3.mjs` |
| `20261006230000_green_claims_anti_greenwashing_engine` | `green_claims_rules`, `product_green_claims`, `green_claims_audits` | `test_green_claims_chantier4.mjs` |
| `20261006240000_quality_corrective_action_plans_cap` | `quality_corrective_action_plans`, `quality_cap_messages` | `test_quality_cap_chantier5.mjs` |
| `20261006250000_universal_supplier_passport` | `supplier_universal_passports`, `supplier_passport_access_requests` | `apply_migration_chantier6_passport.mjs` |
| `20261006260000_mass_balance_anti_fraud_engine` | `transaction_certificates`, `mass_balance_allocations`, `mass_balance_reconciliations` | `apply_migration_chantier7_mass_balance.mjs` |

**Vérification en production (lecture seule) : les douze tables existent.**
Mon alerte du tour 26 (« onze tables peuvent manquer ») est donc **infirmée** —
et c'est une bonne nouvelle.

**L'explication est dans le dépôt, et elle est nette.** Ces cinq migrations
correspondent une à une à cinq scripts qui exécutent **exactement** leur fichier
`migration.sql` sans passer par `prisma migrate deploy` :

```
apply_migration_chantier6_passport.mjs:9
  const sqlFile = path.resolve('prisma/migrations/20261006250000_universal_supplier_passport/migration.sql');
```

Ces scripts **n'écrivent pas** `_prisma_migrations` (vérifié : aucun ne
mentionne la table). La ligne d'historique a donc été posée autrement — un
`resolve --applied`, qui enregistre `applied_steps_count = 0`. Les cinq lignes
sont horodatées à `15:47` le 06/10, à cinq secondes d'intervalle : la signature
d'une résolution groupée, pas d'une application.

**Conséquence réelle, et c'est l'enseignement à retenir** : le SQL exécuté est
bien celui du fichier, mais il l'a été **hors du contrôle de Prisma** — ni la
même transaction, ni le même ordre. Le schéma devrait donc être équivalent, sans
que ce soit prouvé. Un contrôle ciblé reste souhaitable (§6 bis), mais **ce
n'est plus un obstacle au déploiement**.

Ce constat n'était pas signalé au départ, et il ne pouvait pas être déduit de
`_prisma_migrations` seul : c'est la confrontation avec le dépôt qui l'explique.
L'outil de réconciliation fait désormais cette corrélation lui-même et sépare
« appliquée hors bande » (lanceur connu) de « marquée appliquée sans exécuteur
connu » (anomalie réelle).

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
| 0 | ~~Vérifier les onze tables~~ — **fait** : les douze existent | non | levé |
| 1 | Revue humaine des trois diffs du §3 | non | **ouvert** |
| 2 | `prisma migrate deploy` : applique les sept manquantes | **oui**, schéma | faible, voir ci-dessous |
| 3 | Re-exporter et réconcilier : attendu 63 attestées, 0 écart | non | — |
| 4 | M6 mesurable, puis M3 tranchable | non | — |

**Pas de `resolve`.** Aucune entrée n'est bloquante : l'étape du tour 25 devient
inutile. C'est un allègement, pas un renoncement.

**L'angle mort du §4 est levé** : les douze tables existent, et les cinq
migrations ont été exécutées par des lanceurs du dépôt qui jouent le même
fichier. `deploy` les ignorera, ce qui est ici **sans conséquence connue**.
Il reste prudent de vérifier que le schéma produit hors bande correspond à celui
que produirait la migration (§6 bis) — mais ce n'est plus un préalable bloquant.

### Risque résiduel de l'étape 2, nommé précisément

Les sept migrations manquantes incluent le registre runtime et le durcissement
worker — les plus structurantes du dépôt. Elles ont été validées sur base
reconstruite depuis zéro (tour 23, 63/63) mais **jamais sur une base à
l'historique partiel**. Deux d'entre elles (`20261028120100`,
`20261028120200`) créent et altèrent des rôles : leur exécution dépend des
privilèges du rôle de migration, ce qui est exactement l'objet du bloc 5 bis du
relevé M6. **Lancer le bloc 5 bis avant l'étape 2** évite de découvrir un
`42501` en cours de déploiement.

### 6 bis. Contrôle d'équivalence du schéma hors bande (facultatif, lecture seule)

Les cinq migrations du §4 ont été appliquées hors Prisma. Les tables existent ;
reste à vérifier que leur **forme** correspond au fichier. Comparer, pour ces
douze tables, `information_schema.columns` (nom, type, nullabilité, défaut) et
`pg_policies` à ce que produit une base reconstruite depuis zéro suffit. Ce
n'est pas un préalable bloquant : c'est une vérification de cohérence.

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
