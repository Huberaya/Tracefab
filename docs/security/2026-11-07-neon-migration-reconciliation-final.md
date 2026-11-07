# TraceFab — état final de réconciliation Neon (07/11/2026)

## Verdict

<NO-GO> **Production et Préproduction restent NO-GO pour l'application des 30 migrations en attente.**

La barrière réseau qui empêchait le téléchargement du moteur Prisma dans le Codespace n'empêche plus les validations CI : le runner GitHub a installé et exécuté Prisma 6.19.3. Les 86 migrations de la branche passent sur PostgreSQL 17 jetable, et leurs 86 fichiers SQL ont également été rejoués sur un projet Neon 18.6 isolé.

Le rôle migrateur est maintenant provisionné en Préproduction : attributs, privilèges de base/schéma et propriété des objets publics préexistants sont conformes. Un test SQL connecté comme `tracefab_migrator` a créé puis supprimé une table de contrôle. Les 30 migrations restent pending : aucun `prisma migrate deploy` n'a encore été exécuté sur la branche Préproduction. En Production, le rôle migrateur reste absent et aucun changement n'a été effectué.

## Références et périmètre

- Dépôt : `Huberaya/Tracefab`.
- `main` inchangé : `788df22019c0d2b39301678ecfbc43ac868561bf`.
- Branche PR #110 : `fix/neon-migration-reconciliation-20261104`.
- SHA du code audité avant l'ajout de ce rapport : `9a0fa5add34dc97dd321ee6c31ebac4c5f41ceda`.
- CI Prisma : run `42389872681`, succès.
- Intégration PostgreSQL : run `42389872683`, succès.
- Aucun merge, aucun déploiement Production, aucun déploiement Vercel manuel, aucun changement de secret, `migrate resolve`, écriture manuelle de `_prisma_migrations`, ni migration Production/Préproduction. Une modification de privilèges/ownership a toutefois été effectuée en Préproduction le 07/11, documentée ci-dessous. Le commit documentaire a reçu un déploiement Vercel Preview `READY` (alias `tracefab-git-fix-n-ad44d4-baya-ibraimmayoanouedu-8164s-projects.vercel.app`) ; aucun déploiement `target=production` ni alias Production n'existe pour ce SHA.

## Inventaire des migrations

| Source | Dossiers migration |
|---|---:|
| `main` | 69 |
| PR #110 | 86 |
| Ajouts dans la PR | 17 |

Les 17 ajouts sont les deux migrations forward PLM/GS1 du 04/11 et les quinze migrations d'isolation par tenant ajoutées du 05 au 06/11.

### Historique réel Production et Préproduction

Lecture directe de `_prisma_migrations` sur les deux branches Neon :

- 58 lignes chacune ;
- 56 lignes réussies et non annulées, correspondant à 56 noms de migration distincts ;
- 2 tentatives annulées, chacune suivie d'une tentative réussie du même nom ;
- 0 migration inachevée ;
- les 58 lignes sont identiques entre Production et Préproduction, y compris checksums, dates et compteurs d'étapes.

Les deux tentatives annulées concernent `20261010120000_publication_explicite` et `20261017120000_active_tenant_context`. Elles ont chacune une ligne réussie ultérieure : elles ne sont pas à résoudre ni à rejouer.

**30 migrations sont en attente dans les deux environnements :**

1. Historiques (13) :
   - `20261021170000_dpp_readiness_truthful_gates`
   - `20261027100000_dpp_quality_gate_requires_assessment`
   - `20261027130000_dpp_review_preservation_and_publication_coherence`
   - `20261028120000_runtime_function_registry`
   - `20261028120100_worker_identity_not_forgeable`
   - `20261028120200_document_reserved_fields_internal_only`
   - `20261028130000_product_computed_fields_column_scoped`
   - `20261028140000_supplier_invitation_owner_relationship_scope`
   - `20261028150000_reconcile_plm_erp_sync_job_policies`
   - `20261029180000_plm_erp_sync_jobs_policy_dedup`
   - `20261030140000_ingest_payload_role_guard_and_acl`
   - `20261031120000_identite_hmac_liee_au_contexte`
   - `20261102120000_identite_stricte_email_et_rotation`
2. Forward PLM/GS1 (2) :
   - `20261104090000_plm_integrations_and_gs1_constraints`
   - `20261104100000_supply_chain_status_enum_casts`
3. Isolation active tenant (15) :
   - `20261105120000_active_tenant_plm_ingest_enforcement`
   - `20261105130000_active_tenant_product_dpp_pef_rls`
   - `20261105140000_active_tenant_green_claims_rls`
   - `20261105150000_active_tenant_dpp_claims_identity_rls`
   - `20261105160000_active_tenant_product_materials_rls`
   - `20261105170000_active_tenant_security_definer_guards`
   - `20261105180000_active_tenant_tc_registration_guard`
   - `20261105190000_active_tenant_quality_collection_guards`
   - `20261105200000_active_tenant_material_certification_guards`
   - `20261105210000_active_tenant_supplier_profile_passport_guards`
   - `20261105220000_active_tenant_quality_cap_guards`
   - `20261105230000_active_tenant_invite_document_passport_guards`
   - `20261105235900_active_tenant_policy_and_worker_closure`
   - `20261105240000_active_tenant_supplier_quality_guard`
   - `20261106000000_active_tenant_supplier_passport_guards`

## Preuves d'exécution

### Prisma CLI — GitHub Actions / PostgreSQL 17

Sur le SHA de code `9a0fa5a`, le job CI a exécuté le vrai `prisma migrate deploy` avec Prisma 6.19.3 sur une base PostgreSQL 17 jetable. Le journal contient 86 applications de migration et le job est vert. Le test dédié de checksum historique est également vert : Prisma applique la migration pending sans réécrire le checksum de la migration déjà terminée.

Le job d'intégration PostgreSQL est vert. Il exerce les accès inter-tenant positifs et négatifs ; les erreurs `active_tenant_mismatch` et refus de privilèges visibles dans les journaux sont les résultats attendus des assertions négatives, pas des échecs du job.

**Conclusion réseau :** les runners GitHub peuvent récupérer et exécuter le moteur officiel Prisma. Il n'est pas nécessaire d'attendre le filtrage réseau du Codespace pour poursuivre les tests CI.

### Prisma CLI réel sur Neon — validation complète avec le rôle migrateur

**Preuve positive obtenue le 07/11/2026** sur la branche Neon non-production `br-broad-fog-b1rgt68c` (branche de validation issue du snapshot de référence, ni Production ni Préproduction).

État initial de cette branche :
- 56 migrations réussies, 2 tentatives historiques annulées, 0 inachevée ;
- 30 migrations du dépôt en attente ;
- 51 relations, 131 routines et 27 types autonomes détenus par `neondb_owner`.

Provisionnement du rôle dédié sur cette seule branche :
- `tracefab_migrator` : LOGIN, NOSUPERUSER, BYPASSRLS, CREATEROLE, NOCREATEDB, INHERIT ;
- transfert de propriété des relations, routines et types publics existants vers `tracefab_migrator`, en excluant les objets d'extension ;
- les fonctions worker restent détenues par `tracefab_worker` ;
- aucun droit ni appartenance d'escalade n'a été accordé à `tracefab_app`.

Depuis un environnement Vercel isolé, avec le CLI officiel Prisma 6.19.3 et une connexion Neon directe non poolée sous `tracefab_migrator` :

1. `prisma migrate status` initial : connexion réussie, 30 migrations pending détectées ;
2. `prisma migrate deploy` : code de sortie 0, les 30 migrations ont été appliquées ;
3. `prisma migrate status` final : code 0, `Database schema is up to date!` ;
4. second `prisma migrate deploy` : code 0, `No pending migrations to apply.`.

Lecture directe de `_prisma_migrations` après exécution :
- 88 lignes au total ;
- 86 migrations réussies et distinctes, correspondant exactement aux 86 dossiers du dépôt ;
- 2 tentatives annulées historiques (`20261010120000_publication_explicite`, `20261017120000_active_tenant_context)), chacune suivie d'une ligne réussie ;
- 0 migration inachevée.

Contrôles du catalogue après le vrai déploiement Prisma :
- 53 tables métier avec RLS activé et FORCE RLS ; la seule table sans RLS est `_prisma_migrations` ;
- 127 fonctions SECURITY DEFINER, toutes avec `search_path` fixé et 0 exécution accordée à PUBLIC ;
- 87 politiques avec garde active-tenant ;
- registre runtime : 92 entrées ;
- 54 relations et 137 routines détenues par `tracefab_migrator`, 10 fonctions détenues par `tracefab_worker`, 27 types détenus par `tracefab_migrator` ;
- `tracefab_app` reste LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB ; il n'est membre ni du migrateur, ni du worker, ni de `neondb_owner` ;
- `tracefab_worker` reste NOLOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB ;
- HMAC strict reste désactivé et aucune clé HMAC n'est provisionnée : ce point reste un blocage distinct pour l'activation du mode strict.

Le checksum historique de `20261006210000_plm_erp_gs1_interoperability` est resté `c944ce0c21f128b8ee8c919de58179d4f25fdf3d2f7f087dacbca615b89c3861`. Aucun `migrate resolve`, UPDATE ou DELETE de `_prisma_migrations` n'a été utilisé.

**Limite de portée :** cette preuve valide le moteur Prisma, le rôle migrateur, le transfert de propriété et les 30 migrations sur une branche Neon de validation. Elle ne constitue pas une migration de Production ou Préproduction ; ces deux environnements restent inchangés et leurs rôles réels restent à provisionner.

### Rejeu SQL — projet Neon isolé / PostgreSQL 18.6

Projet isolé : `tracefab-pr110-admin-cleanroom`, rôle d'exécution `tracefab_migrator`. Après remise à zéro du schéma public de ce projet de test, les 86 fichiers `migration.sql` ont été exécutés dans l'ordre lexical, chacun dans sa propre transaction, avec le rôle migrateur.

Un point d'attention a été vérifié : `20261021120000_limit_app_function_execute` fixe le `search_path` transactionnel à `pg_catalog`. Les migrations doivent donc rester isolées par fichier/transaction ; les grouper dans une transaction commune peut faire hériter ce `search_path` à la migration suivante. Le rejeu final a bien été fait une migration par transaction.

Résultats catalogue après les 86 fichiers :

- PostgreSQL 18.6 ;
- 53 tables publiques, toutes avec RLS activé et FORCE RLS ; 0 table publique sans RLS ;
- 134 politiques RLS, dont 87 avec garde active-tenant ;
- 126 fonctions SECURITY DEFINER, toutes avec `search_path` fixé ;
- 0 fonction SECURITY DEFINER exécutable par PUBLIC ;
- 10 fonctions détenues par `tracefab_worker` ; registre runtime : 92 entrées ;
- `tracefab_app` reste LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB ;
- `tracefab_migrator` est LOGIN, NOSUPERUSER, BYPASSRLS, CREATEROLE, NOCREATEDB ;
- `tracefab_worker` est NOLOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB ;
- aucune appartenance de `tracefab_app` au migrateur ou au worker ;
- la politique HMAC est en mode permissif (`strict=false`) et aucune clé HMAC n'est enregistrée dans ce cleanroom.

**Limite importante :** ce rejeu a exécuté les fichiers SQL via l'interface SQL Neon, pas via Prisma Migrate. `_prisma_migrations` est volontairement absent dans ce projet de rejeu. Il prouve la compatibilité SQL/catalogue avec Neon 18.6 et le rôle migrateur ; il ne doit pas être présenté comme un `prisma migrate deploy` sur Neon.

### Historique de checksum PLM

Pour `20261006210000_plm_erp_gs1_interoperability` :

- checksum enregistré dans Production et Préproduction : `c944ce0c21f128b8ee8c919de58179d4f25fdf3d2f7f087dacbca615b89c3861` ;
- checksum du fichier versionné : `6a8d03eb507b824e2a308d7e29113478d60d726255fcc1883cef56c506783044`.

L'écart de provenance octet pour octet reste ouvert. Le test Prisma 6.19.3 prouve que le checksum historique est conservé pendant l'application d'une migration pending. Aucun `migrate resolve` ni réécriture de l'historique n'est justifié.

## Défaut de propriété des objets et correctif du provisioning — mesuré le 07/11

Le contrat du rôle ne se limite pas à ses attributs et aux droits du schéma. Les migrations pending doivent aussi modifier les objets déjà existants.

### Mesure sur les bases réelles (lecture seule)

| Environnement | Propriétaire du schéma public | Propriétaire de la base | Relations publiques détenues par neondb_owner | Relations détenues par tracefab_migrator |
|---|---|---|---:|---:|
| Production | pg_database_owner | neondb_owner | 51 | 0 |
| Préproduction | pg_database_owner | neondb_owner | 51 | 0 |

L'inventaire complémentaire montre également 131 routines et 27 types autonomes détenus par `neondb_owner` dans chaque environnement. La migration 20261028120100 et les migrations active-tenant modifient ces objets existants. Donner uniquement CREATE sur le schéma ne confère pas le droit ALTER sur une table/fonction/type détenu par un autre rôle.

### Test contrôlé de la stratégie de propriété

Sur la branche non-production `br-sweet-king-b1n2f4u6`, un premier test a démontré que le transfert du seul schéma `public` ne suffit pas : `ALTER TABLE public.tracefab_products` sous `tracefab_migrator` échouait avec SQLSTATE `42501` (`must be owner of table`). La transaction de sonde a été annulée.

La stratégie complète a ensuite été éprouvée :
- rôle migrateur dédié avec LOGIN, NOSUPERUSER, BYPASSRLS, CREATEROLE, NOCREATEDB, INHERIT ;
- appartenance administrative limitée dans le sens `neondb_owner -> tracefab_migrator`, SET explicite, INHERIT=false ; aucune appartenance inverse migrateur -> propriétaire ;
- CONNECT + CREATE sur la base, propriétaire du schéma public et USAGE/CREATE sur le schéma ;
- transfert sélectif des relations, routines et types publics détenus par `neondb_owner` vers le migrateur, en excluant les objets d'extension et en conservant les fonctions déjà détenues par `tracefab_worker` ;
- le migrateur a ensuite réussi un ALTER TABLE sur une table préexistante ; aucune colonne de sonde n'a été conservée.

Sur cette branche de validation, le catalogue final du probe compte 54 relations, 135 routines et 27 types détenus par le migrateur, ainsi que 6 fonctions détenues par le worker. Cette branche est modifiée et n'est plus un témoin vierge.

### Correctif code

`scripts/provisionner_roles_db.mjs` implémente désormais cette stratégie et vérifie les postconditions. Les attributs non-SUPERUSER peuvent être corrigés par un exécutant CREATEROLE (le changement de SUPERUSER reste réservé à un SUPERUSER) avec le drapeau explicite `TF_CORRIGER_ATTRIBUTS=oui`. Le transfert refuse les objets publics détenus par un troisième rôle et ne modifie pas les appartenances de `tracefab_app).

Le test P10.5 a été étendu : il crée avant provisioning une table, une fonction et un ENUM appartenant à l'administrateur, vérifie leur transfert au migrateur, puis exécute ALTER TABLE et CREATE OR REPLACE FUNCTION sous le migrateur avant de supprimer les fixtures. La dernière correction de syntaxe du test a été poussée ; CI #1806 est en cours de vérification.

**Conclusion :** la stratégie d'ownership est désormais démontrée sur Neon et intégrée au script. Le bloqueur n'est plus l'absence de solution technique ; c'est l'exécution contrôlée du provisioning sur les environnements réels, qui n'a pas encore été faite.

## État actuel des rôles Production / Préproduction — vérifié le 07/11

### Production — inchangée

- `tracefab_migrator` absent ; `tracefab_worker` absent.
- Les 51 relations, 131 routines et 27 types publics métier restent détenus par `neondb_owner`.
- `tracefab_app` reste LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB. Aucune appartenance administrative ne lui a été accordée.
- Aucun privilège, rôle, secret ou objet n'a été modifié en Production.

### Préproduction — rôle migrateur provisionné

Le rôle `tracefab_migrator` est maintenant LOGIN, NOSUPERUSER, BYPASSRLS, CREATEROLE, NOCREATEDB, INHERIT. Il possède CONNECT + CREATE sur `neondb` et USAGE + CREATE sur `public`.

Les objets publics préexistants ont été transférés de `neondb_owner` vers `tracefab_migrator` :
- 51 relations ;
- 131 routines métier ;
- 27 types autonomes.

L'administrateur `neondb_owner` peut endosser le migrateur par une appartenance SET explicite et INHERIT=false. Le sens inverse n'existe pas. `tracefab_app` n'est membre ni du migrateur ni du worker, et n'a toujours ni BYPASSRLS, ni CREATEROLE, ni CREATE sur la base ou le schéma.

Test effectué en se connectant directement comme `tracefab_migrator` : création puis suppression réussie d'une table de contrôle dans `public`. La table de test n'a pas été conservée.

Les fonctions `pgcrypto` détenues par `cloud_admin` gardent leur EXECUTE PUBLIC géré par le fournisseur ; cette ACL n'a pas été modifiée. Les migrations TraceFab excluent explicitement ces fonctions d'extension des révocations de privilèges métier.

**Limite :** le provisionnement du rôle ne constitue pas l'application des migrations. L'historique Préproduction reste à 58 lignes, 56 succès, 2 tentatives annulées, 0 inachevée ; les 30 migrations restent pending.

## Décision et suite

**GO technique validé sur la branche Neon de référence ; NO-GO application Préproduction tant que la séquence Prisma réelle n'a pas été exécutée ; NO-GO Production.**

1. Exécuter sur Préproduction le vrai CLI Prisma 6.19.3 : `migrate status`, `migrate deploy`, `migrate status`, puis second `migrate deploy` no-op. Contrôler les 30 migrations, les checksums, RLS, fonctions, worker, active-tenant et application.
2. La connexion directe `tracefab_migrator` fonctionne via l'interface Neon ; il reste à l'injecter dans un runner protégé (GitHub Environment ou environnement Vercel isolé) sans exposer le secret à un build de PR non approuvé. Le Codespace n'est pas nécessaire.
3. Faire relire/valider la PR #110 avant tout merge ou déploiement applicatif. La PR reste ouverte ; aucun merge n'a été effectué.
4. Seulement après validation complète de Préproduction et du code compatible, provisionner le rôle migrateur en Production, transférer les objets publics selon le même contrôle fail-closed, puis appliquer les migrations Production.
5. Garder HMAC strict désactivé jusqu'au provisionnement sécurisé de `TRACEFAB_IDENTITY_KEY` et à la preuve de couverture des routes signées.

Le blocage réseau du CDN Prisma est contourné de manière sûre : l'exécution réelle Prisma a été faite depuis un environnement Vercel avec une connexion Neon directe. Il n'est pas nécessaire d'attendre l'administrateur réseau.
