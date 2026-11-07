# P10.7 — Chaîne canonique de migrations et graphe des PR

**Date** : 2026-11-06 · **Branche de travail** : `arena/0f697b3e-tracefab` · **SHA de référence (Phase 0)** : `37552b198c0ef1d8b8d4507c802e5d1b79ff7733`

> Ce document est une **définition reproductible**, pas une branche distante. La session est liée à `arena/0f697b3e-tracefab` et interdit de créer, basculer ou pousser vers une autre branche ; aucune PR n'a donc été modifiée, fusionnée ou fermée. `npm run p107:chaines` matérialise la chaîne dans un répertoire temporaire, l'applique sur PostgreSQL jetable et détruit la copie.

> **Événement postérieur à la Phase 0.** Le 06-11 à **15:34:35Z**, la PR **#114 a avancé** : tête `537bc310d0b6e857c4f74ec0017a130987b22497` → `f0aeb51cb52ce778f7f9a5e857438603d81fa5ad`, branche `arena/b8fe1a44-tracefab`, `mergeStateStatus` passé de `CLEAN` à `BLOCKED`. Ce nouveau commit **renomme** `20261105120000_identite_systeme_signee` en `20261106130000_identite_systeme_signee` et durcit son propre vérificateur (forme canonique du MAC, plafond 600 s, comparaison à temps constant). **Toutes les mesures de ce document et des artefacts JSON ont été rejouées sur la nouvelle tête** ; l'ancienne est conservée comme témoin (`A2`, `B2`). La branche de travail `arena/0f697b3e-tracefab`, `main` et #108–#113 n'ont pas bougé.

## 1. Décision

| PR | État mesuré le 06-11 | Migrations ajoutées vs `main` | Contenu des 69 migrations de `main` modifié ? | Décision |
|---|---|---|---|---|
| #108 | OPEN, draft, `2d62609…`, `CLEAN` | 0 | non | **documentation seule** (preuve runtime historique du 03/11) : complémentaire, aucun code à intégrer |
| #109 | OPEN, `751004e…`, `BLOCKED` | 0 | non | **supersédée** par #113 (isolation du locataire actif, déjà appliquée sur cette branche) |
| #110 | OPEN, `9b86f18…` | 17 | **OUI, 7** | **concurrente, non intégrable** : réécrit des migrations déjà appliquées |
| #111 | MERGED dans #110 le 06/11 à 09:43:15Z, `064fb34…` | 17 | **OUI, 7** (identique à #110) | fusionnée dans #110 ; sa **dépendance outbox** est reprise par le correctif candidat |
| #112 | OPEN, draft, `da8fa54…` | 19 | **OUI, 7** | **concurrente** : même famille que #110 |
| #113 | OPEN, `37552b19…`, branche de travail | 2 | non | **conservée** : additive, 0 divergence |
| #114 | OPEN, **`f0aeb51…`, `BLOCKED`** | 1 (`20261106130000_identite_systeme_signee`) | non | **complémentaire mais DÉPENDANTE** : voir §4 et §6 |

Chaîne canonique : **`main` (69) + #113 (2) + #114 (1) + correctif candidat (1) = 73 entrées**. Les 69 migrations historiques sont conservées **byte pour byte** (empreintes dans `2026-11-06-p107-chaine-canonique.json`) ; aucun renommage n'est appliqué à une migration déjà appliquée. Le correctif candidat reste un fichier de démonstration sous `docs/security/candidats/`, **pas une migration ajoutée au dépôt**.

## 2. Les 7 migrations historiques réécrites par #110/#111/#112

- `20261005090000_supplier_portal_advanced_hardening`
- `20261009180000_public_read_context`
- `20261028120100_worker_identity_not_forgeable`
- `20261028120200_document_reserved_fields_internal_only`
- `20261028130000_product_computed_fields_column_scoped`
- `20261030140000_ingest_payload_role_guard_and_acl`
- `20261031120000_identite_hmac_liee_au_contexte`

Les renommer, les réécrire ou les ré-appliquer contreviendrait à l'interdiction de modifier une migration déjà appliquée sur un environnement partagé, et casserait `_prisma_migrations` (checksum). Le chantier de réconciliation Neon / checksum PLM/GS1 reste **indépendant** de P10.7. Ces sept exclusions sont assertées par `npm run test:reconciliation-chaine-canonique`.

## 3. Collisions d'horodatage

| Horodatage | Noms en conflit | Provenance | État mesuré après l'avancée de #114 |
|---|---|---|---|
| `20261105120000` | `active_tenant_plm_ingest_enforcement` / `identite_systeme_signee` | #110/#111/#112 vs **ancienne** #114 | **résolue EN AMONT par #114 elle-même** : sa migration s'appelle désormais `20261106130000_identite_systeme_signee`. Chaîne étendue : 6 collisions avant → **5** avant préparation ; canonique : 4, toutes historiques |
| `20261105180000` | `active_tenant_access_guards` / `active_tenant_tc_registration_guard` | #113 vs #110/#111/#112 | **subsiste dans la chaîne étendue uniquement** : renom de préparation `…180000` → `…180010` mesuré, `94/94` appliquée. Aucun renom appliqué sur la chaîne canonique |
| `20261106120000` | `p107_hmac_forme_canonique_et_ttl` | #113 uniquement | **aucune collision** : la corrective ne crée ni ne masque de collision antérieure |
| `20261106130000` | `identite_systeme_signee` | #114 uniquement | **aucune collision** |

Quatre paires historiques restent acceptées et figées par `verifier-horodatages-migrations.mjs` : `20261006120000`, `20261006200000`, `20261006220000`, `20261017120000`. `npm run test:migrations:horodatages` et `npm run test:reconciliation-chaine-canonique` PASS sur la chaîne canonique.

## 4. Dépendance outbox (#114 / #111)

#114 rend `tracefab_claim_notification_outbox` et `tracefab_complete_notification_outbox` dépendantes de `public.tracefab_identite_systeme()` (`SECURITY INVOKER`, `EXECUTE` accordé à `tracefab_worker` seulement). Sur `main`, ces deux fonctions restent possédées par le rôle de migration ; avec un propriétaire non superutilisé modélisé `tracefab_migrator` et une **véritable connexion applicative** (`SET SESSION AUTHORIZATION tracefab_app`), le claim échoue : `42501 permission denied for function tracefab_identite_systeme`. #111 (`20261105235900`) transfère la propriété au worker et accorde les DML.

**Conclusion : #114 n'est pas autonome de #111.** Le correctif minimal `docs/security/candidats/2026-11-06-proprietaire-outbox-identite-systeme.sql` (une seule migration candidate `20261106120300_outbox_owner_identite_systeme`) rétablit la chaîne canonique sans importer les 7 réécritures de #110/#111/#112. Voir `2026-11-06-p107-outbox-scenarios.json`.

## 5. Reproduction

```bash
# Refs locales de lecture seule (aucune branche distante modifiée)
git fetch origin +refs/heads/arena/b8fe1a44-tracefab:refs/remotes/audit/pr114-nouveau
npm run p107:chaines          # 6 chaînes + vérification des 73 empreintes + scénario E
npm run p107:outbox           # 4 scénarios claim/complete sur ligne réellement éligible
npm run test:reconciliation-chaine-canonique   # 90 assertions statiques, sans accès distant
```

Le harnais recalcule les **73 empreintes sha256** sur le contenu réellement appliqué et les compare au manifeste : toute divergence fait échouer la commande. Ce contrôle empêche le manifeste de se périmer en silence après une nouvelle avancée de PR.

## 6. Risque mesuré : rejeu du renommage #114 sur un état déjà migré

Une Preview Vercel a déployé l'ancienne tête `537bc31…` le 06-11 à 09:30:00Z (déploiement GitHub `7596820548`, `state=success`). Son journal `_prisma_migrations` contient donc potentiellement le nom `20261105120000_identite_systeme_signee`, alors que la nouvelle chaîne attend `20261106130000_identite_systeme_signee`.

Scénario `E_rejeu_renommage_114` (`npm run p107:chaines`) : base jetable, chaîne historique de 72 migrations appliquée, journal `_prisma_migrations` **simulé** avec l'ancien nom, puis ré-application du SQL de la nouvelle tête et enregistrement du nouveau nom comme le ferait Prisma. **Mesure** : `SQL REUSSI (idempotent)`, `noms_distincts=2`, `fonction_verif=1`, `colonne_mode=1`. Le SQL est idempotent (`CREATE OR REPLACE`, `ADD COLUMN IF NOT EXISTS`, `ON CONFLICT DO NOTHING`), mais le journal finit avec **deux noms distincts et deux checksums pour une seule définition d'objets**.

**Ce risque n'est pas transformé en PASS.** La lecture du journal **réel** de cette Preview exige un accès Neon/Vercel non accordé (`BLOCKED`). Toute tentative de conclure à la compatibilité sur un environnement déjà migré serait une déduction, pas une preuve. La procédure sûre : lire `_prisma_migrations` sur la branche isolée, comparer les checksums, puis décider humainement d'une réconciliation explicite ; **jamais** réécrire une migration déjà appliquée.

## 7. Limites

Aucune preuve Neon, Preview authentifiée ou Production dans ce document. Les lectures par `git show` ne modifient aucune branche distante. PostgreSQL jetable = **PGlite / PostgreSQL 18.6** ; la CI utilise `postgres:17` et la version mineure exacte n'est mesurée que par le step CI ajouté (`NOT RUN` tant qu'il n'a pas été poussé et exécuté). Les harnais `p107:*` exigent les refs d'audit locales et ne font pas partie de la boucle `test:*` de CI ; seul `test:reconciliation-chaine-canonique` y entre.
