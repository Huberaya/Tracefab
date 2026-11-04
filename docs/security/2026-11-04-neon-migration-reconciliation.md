# TraceFab — réconciliation Neon des migrations (04/11/2026)

> **État : investigation en lecture seule terminée ; correctifs et exception de checksum strictement bornée préparés sur une branche dédiée ; application en Préproduction et Production non encore exécutée.**
>
> Branche de correction : `fix/neon-migration-reconciliation-20261104`.
>
> Ce document remplace les hypothèses de l'ancien plan daté du 29/10. Les nombres ci-dessous proviennent d'une lecture réelle de `_prisma_migrations` et du catalogue PostgreSQL sur les branches Production et Préproduction le 04/11/2026.

## 1. Historique Prisma réellement mesuré

Production et Préproduction présentent le même état :

- 58 lignes dans `_prisma_migrations`.
- 56 migrations terminées et non annulées : 51 exécutées par Prisma et 5 marquées terminées hors bande avec `applied_steps_count = 0`.
- Les 5 hors bande sont les migrations PEF, green claims, quality CAP, supplier passport et mass balance ; leurs 12 objets attendus ont été relus présents sur Production et Préproduction. Ne pas les rejouer.
- 2 tentatives annulées, toutes deux suivies d'une migration terminée du même nom.
- 0 migration inachevée.
- 69 dossiers de migration dans `main`.
- 13 migrations absentes de l'historique réussi.
- 3 empreintes de migrations déjà appliquées différentes des fichiers de `main` au début de l'audit.

Les deux migrations ayant une tentative annulée **ne sont pas en attente** : `20261010120000` et `20261017120000` ont chacune une ligne réussie. Ne pas exécuter `migrate resolve --applied` pour ces deux noms.

### Les trois divergences d'empreinte

Les empreintes suivantes sont celles enregistrées dans les deux bases :

| Migration | SHA-256 enregistré |
|---|---|
| `20261005090000_supplier_portal_advanced_hardening` | `560356c203df6d460f8488f44bdf1ce582d3f609eae1b4acd329ad3cd686bbb7` |
| `20261006210000_plm_erp_gs1_interoperability` | `c944ce0c21f128b8ee8c919de58179d4f25fdf3d2f7f087dacbca615b89c3861` |
| `20261009180000_public_read_context` | `c12ee33303084b6710284139786058b8d088b2619d92372ea57f282e86480d04` |

Deux versions exactes ont été retrouvées et restaurées dans la branche dédiée : `20261005090000` et `20261009180000`. Pour `20261006210000`, l'empreinte Production/Préproduction (`c944ce0c…`) ne correspond à aucune version retrouvée dans l'historique Git, les branches actives ou les versions examinées. Le fichier courant est conservé sans modification spéculative ; l'écart reste visible et non résolu au niveau des octets. Une exception unique, épinglée aux deux SHA-256 exacts, est documentée dans 2026-11-04-neon-checksum-variance-attestation.md. Un test dédié sur Prisma 6.19.3 et PostgreSQL prouve que migrate deploy applique les migrations pending sans rejouer l'entrée terminée ni réécrire son checksum. La matrice accepte cette seule paire documentée et reste rouge pour toute autre divergence. Aucun migrate resolve ni modification des checksums en base.

Les changements fonctionnels ultérieurs restent portés par des migrations forward :
- invitation fournisseur : `20261005100000_supplier_invitation_compatibility` ;
- normalisation des politiques PLM : `20261028150000` et `20261029180000` ;
- provisionnement du rôle applicatif sur base vierge : exécuter séparément `bootstrap_app_role.mjs` avant `npm run db:deploy` ; le script `db:deploy` lui-même lance uniquement `prisma migrate deploy`.

## 2. Les 13 migrations réellement en attente

| Migration | État du catalogue mesuré | Traitement attendu |
|---|---|---|
| `20261021170000_dpp_readiness_truthful_gates` | Profil DPP encore à 9 exigences au lieu des 13 définies par la migration ; fonction de contrôle ancienne | Appliquer |
| `20261027100000_dpp_quality_gate_requires_assessment` | Contrôle `quality.no_open_issues` absent de la définition active | Appliquer après la précédente |
| `20261027130000_dpp_review_preservation_and_publication_coherence` | Colonnes de base de revue présentes, mais `review_basis_fingerprint`, `reviewed_basis_fingerprint`, `review_invalidated_at`, `review_invalidation_reason` absentes ; fonction de suspension absente | Appliquer ; les nouvelles colonnes sont déclarées `IF NOT EXISTS` |
| `20261028120000_runtime_function_registry` | Table `tracefab_runtime_function_registry` absente | Appliquer avant 28120100 |
| `20261028120100_worker_identity_not_forgeable` | Rôle `tracefab_worker` et fonction `tracefab_upsert_clerk_user` absents | Appliquer après correction de la migration dans cette branche |
| `20261028120200_document_reserved_fields_internal_only` | `tracefab_app` possède encore `UPDATE` sur `documents` | Appliquer |
| `20261028130000_product_computed_fields_column_scoped` | Des droits d'écriture couvrent encore des colonnes calculées de `tracefab_products` | Appliquer |
| `20261028140000_supplier_invitation_owner_relationship_scope` | Le trigger existe, mais le validateur actuel ne vérifie pas encore tous les liens et statuts de relation | Appliquer |
| `20261028150000_reconcile_plm_erp_sync_job_policies` | Les deux politiques canoniques sont déjà présentes | Recréation idempotente attendue |
| `20261029180000_plm_erp_sync_jobs_policy_dedup` | Les deux politiques canoniques sont déjà présentes | Recréation idempotente attendue |
| `20261030140000_ingest_payload_role_guard_and_acl` | Fonction SECURITY DEFINER exécutable par `tracefab_app`, sans garde de rôle de session ; le corps réel utilise déjà les colonnes de version et les helpers du graphe | Appliquer après correction de compatibilité |
| `20261031120000_identite_hmac_liee_au_contexte` | Tables d'identité HMAC absentes | Appliquer avec le mode strict désactivé |
| `20261102120000_identite_stricte_email_et_rotation` | Dépend des tables HMAC précédentes | Appliquer après 31120000, strict toujours désactivé |

## 3. État de sécurité réellement observé

### Rôles et exécution des migrations

- `tracefab_app` est le rôle runtime mesuré : non-superutilisateur, sans `BYPASSRLS`, sans privilège `CREATEROLE`, sans appartenance à un rôle privilégié.
- `neondb_owner` est le propriétaire de la base et des fonctions actuellement examinées ; il est non-superutilisateur, avec `CREATEROLE` et `BYPASSRLS`.
- `tracefab_migrator` est absent de Production.
- `tracefab_worker` est absent de Production.
- Le propriétaire du schéma `public` est `pg_database_owner`.

Pour l'existant Neon, le rôle de migration mesuré est donc le propriétaire administrateur de la base (`neondb_owner`), et non le rôle runtime `tracefab_app`. Le rôle dédié `tracefab_migrator` du scénario local ne doit pas être provisionné en Production sans une procédure distincte de transfert de propriété validée sur Neon.

Ne pas utiliser la variable `DATABASE_URL` de Vercel pour migrer : elle correspond au runtime applicatif. Utiliser une connexion directe, non poolée, du rôle de migration.

### DPP

Le profil actif ne comporte que 9 exigences. La nouvelle exigence `quality.no_open_issues` n'est pas présente. La fonction actuelle ne doit donc pas être considérée comme équivalente aux migrations DPP en attente.

### Documents et produits

- `tracefab_app` possède encore un droit `UPDATE` sur `documents`.
- Les droits colonne par colonne sur `tracefab_products` couvrent encore des champs calculés, dont `data_readiness`, `data_completion`, `data_ready_at` et `version`.

Ces deux écarts doivent être fermés par 28120200 et 28130000, puis revérifiés par les privilèges effectifs du rôle, pas seulement par la présence des migrations.

### PLM/ERP et invitations

- `plm_erp_sync_jobs` possède déjà les deux politiques canoniques. Les deux migrations de normalisation peuvent les recréer, mais ne doivent pas être présentées comme la preuve d'un écart actuel à quatre politiques.
- Le validateur d'invitation fournisseur accepte déjà un `owner` lorsqu'un `relationship_id` est présent. Le trigger et la fonction de la migration 28140000 doivent encore vérifier le rattachement exact et l'état de la relation.

### Confrontation PLM/ERP directe du 04/11

Relecture SQL en lecture seule sur les branches Neon réelles :

| Objet | Production | Préproduction | Référence |
|---|---|---|---|
| `plm_erp_integrations` | RLS + FORCE RLS ; propriétaire `neondb_owner` | identique | RLS + FORCE RLS |
| `plm_erp_sync_jobs` | RLS + FORCE RLS ; propriétaire `neondb_owner` | identique | RLS + FORCE RLS |
| `plm_integrations_mutate_brand` | ALL ; owner/admin/manager en USING et WITH CHECK | identique | conforme |
| `plm_integrations_select_org` | SELECT ; `tracefab_is_org_member` | identique | conforme |
| `plm_sync_jobs_insert_brand` | INSERT ; owner/admin/manager en WITH CHECK | identique | conforme |
| `plm_sync_jobs_select_org` | SELECT ; `tracefab_is_org_member` | identique | conforme |

La fonction `tracefab_ingest_plm_erp_payload` diverge du référentiel historique : elle est `SECURITY DEFINER`, détenue par `neondb_owner`, `search_path=public`, ACL effective limitée au propriétaire et à `tracefab_app`, empreinte de définition `c1b63651c4eb36fc4fd753b41e22a66a`. Son corps réel utilise `tracefab_create_supply_chain_node` et `tracefab_add_supply_chain_link`, ainsi que `tracefab_products.version` et `product_materials.product_version`.

La migration `20261006210000_plm_erp_gs1_interoperability` est bien terminée par Prisma sur les deux bases (`applied_steps_count=1`), avec le checksum `c944ce0c…`. Elle ne fait pas partie des cinq migrations à zéro étape. La définition actuelle de la fonction a évolué après l'état initial ; elle ne permet pas de reconstituer le SQL historique exact.

Le fichier en attente `20261030140000_ingest_payload_role_guard_and_acl` contenait encore l'ancien chemin d'écriture directe dans `supply_chain_nodes` et `supply_chain_links`. Or `20261020120000_structured_supply_chain_graph_membership`, déjà appliquée, impose `graph_product_id` et les validations via les fonctions du graphe. La version initiale de 30140000 aurait donc remplacé une fonction compatible par un corps incompatible avec le schéma courant.

**Correction préparée dans cette branche** : 30140000 conserve les contrôles de rôle de session, mais utilise le modèle de version produit/BOM et les helpers du graphe ; les tests PLM vérifient statiquement l'absence de DML direct, et le test P10.5 exerce désormais BOM + deux étapes de traçabilité dans sa transaction annulée. Cette correction attend encore une exécution CI sur le SHA final.

**Aucune migration n'a été appliquée sur les branches Neon.** Le checksum historique PLM non retrouvé reste le blocage absolu avant tout déploiement.

### Identité HMAC

La variable Vercel `TRACEFAB_IDENTITY_KEY` n'est pas configurée. Les migrations HMAC peuvent être appliquées avec le mode strict désactivé ; ne pas activer le mode strict tant que la clé n'est pas provisionnée et que la couverture des routes signées n'est pas prouvée.

## 4. Correction de la migration worker préparée dans cette branche

La migration `20261028120100_worker_identity_not_forgeable` n'est pas appliquée en Production. Elle peut donc être corrigée avant sa première exécution.

La version préparée :
1. crée `tracefab_worker` directement avec `NOLOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEROLE`, `NOCREATEDB`, `NOINHERIT` ;
2. refuse un rôle préexistant non conforme au lieu de tenter un `ALTER ROLE ... NOSUPERUSER` qui exige un superutilisateur ;
3. accorde au rôle de migration `INHERIT TRUE, SET TRUE`, sans `ADMIN OPTION` ;
4. accorde temporairement `CREATE` sur `public` au worker pour le transfert des six fonctions ;
5. retire immédiatement `CREATE` au worker après le transfert ;
6. conserve l'appartenance `SET` du rôle de migration pour les migrations suivantes ;
7. vérifie que `tracefab_app` n'est pas membre du worker.

Le test P10.5 est modifié pour exécuter la chaîne sans `TF_ALLOW_ELEVATION` et vérifier que le rôle de migration reste non-superutilisateur. Cette correction reste candidate jusqu'à validation CI.

## 5. Séquence d'exécution — ne pas sauter d'étape

1. Terminer les corrections de code de cette branche et obtenir une CI entièrement verte.
2. Dans un worktree Codespace séparé, récupérer cette branche. Ne pas remplacer ni réinitialiser le worktree de travail existant.
3. Avec une connexion directe de migration à Préproduction, vérifier l'identité SQL (`current_user`), les attributs de rôle, la propriété des fonctions et `prisma migrate status`. Résultat exigé : zéro divergence de checksum et 13 migrations en attente.
4. Exécuter `prisma migrate deploy` en Préproduction seulement après cette pré-vérification.
5. Vérifier que les 69 migrations sont terminées, puis contrôler le catalogue : profil DPP, fonctions, triggers, politiques, privilèges sur documents/produits, rôle worker, registre runtime et ACL.
6. Exécuter les tests d'intégration et les parcours applicatifs sur une cible Preview dont l'isolation de base a été prouvée.
7. Après réussite complète en Préproduction, appliquer la même procédure en Production avec le rôle administrateur de migration, jamais avec `tracefab_app`.
8. Provisionner séparément la clé HMAC dans Neon et Vercel. Garder le mode strict désactivé jusqu'à preuve de couverture de toutes les routes.

### Interdictions de cette procédure

- Aucun `migrate resolve --applied` pour les migrations déjà terminées.
- Aucun UPDATE de checksum dans `_prisma_migrations`.
- Aucun `prisma migrate deploy` global avant restauration des trois fichiers historiques et validation de 28120100.
- Aucun déploiement, fusion ou activation du mode strict avant validation des tests et du catalogue.
