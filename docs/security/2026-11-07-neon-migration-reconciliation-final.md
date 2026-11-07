# TraceFab — état final de réconciliation Neon (07/11/2026)

## Verdict

<NO-GO> **Production et Préproduction restent NO-GO pour l'application des 30 migrations en attente.**

La barrière réseau qui empêchait le téléchargement du moteur Prisma dans le Codespace n'empêche plus les validations CI : le runner GitHub a installé et exécuté Prisma 6.19.3. Les 86 migrations de la branche passent sur PostgreSQL 17 jetable, et leurs 86 fichiers SQL ont également été rejoués sur un projet Neon 18.6 isolé.

Le blocage restant est l'identité de migration dans les environnements réels : le rôle attendu n'existe pas en Production et il est sous-privilégié en Préproduction. Aucune migration n'a été appliquée à ces deux environnements pendant cette vérification.

## Références et périmètre

- Dépôt : `Huberaya/Tracefab`.
- `main` inchangé : `788df22019c0d2b39301678ecfbc43ac868561bf`.
- Branche PR #110 : `fix/neon-migration-reconciliation-20261104`.
- SHA du code audité avant l'ajout de ce rapport : `9a0fa5add34dc97dd321ee6c31ebac4c5f41ceda`.
- CI Prisma : run `42389872681`, succès.
- Intégration PostgreSQL : run `42389872683`, succès.
- Aucun merge, aucun déploiement Production, aucun déploiement Vercel manuel, aucun changement de secret, `migrate resolve`, écriture manuelle de `_prisma_migrations`, ni migration Production/Préproduction. Le commit documentaire a reçu un déploiement Vercel Preview `READY` (alias `tracefab-git-fix-n-ad44d4-baya-ibraimmayoanouedu-8164s-projects.vercel.app`) ; aucun déploiement `target=production` ni alias Production n'existe pour ce SHA.

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

## Défaut supplémentaire du provisioning migrateur — mesuré le 07/11

Le contrat du rôle ne se limite pas à ses attributs et aux droits du schéma. Les migrations pending doivent aussi modifier des objets déjà existants.

### Mesure sur les bases réelles (lecture seule)

| Environnement | Propriétaire du schéma public | Propriétaire de la base | Objets publics possédés par neondb_owner | Objets possédés par tracefab_migrator |
|---|---|---|---:|---:|
| Production | pg_database_owner | neondb_owner | 51 | 0 |
| Préproduction | pg_database_owner | neondb_owner | 51 | 0 |

La migration 20261028120100 et les migrations active-tenant modifient des tables/fonctions existantes. Le simple fait de donner CREATE sur le schéma ne confère pas le droit ALTER sur une table détenue par un autre rôle.

### Test contrôlé sur la branche de validation existante

La création d'une nouvelle branche Neon a été refusée par la limite de branches. Le test a donc utilisé la branche non-production `br-sweet-king-b1n2f4u6`, déjà dédiée à la validation (71 migrations réussies, 2 annulées).

- Le rôle `tracefab_migrator` y a été créé par l'API Neon.
- Les attributs BYPASSRLS et CREATEROLE ont été posés ; NOSUPERUSER, NOCREATEDB, LOGIN et INHERIT sont restés conformes.
- Le schéma `public` a été transféré à `tracefab_migrator`, avec USAGE/CREATE.
- Le test atomique `ALTER TABLE public.tracefab_products ADD COLUMN …` puis DROP, exécuté sous `tracefab_migrator`, a échoué avec SQLSTATE `42501` : **`must be owner of table tracefab_products`**. La transaction a été annulée ; aucune colonne de test n'a été conservée.
- `tracefab_migrator` ne peut pas endosser `neondb_owner` (`pg_has_role(..., 'SET') = false`).

Cette branche de validation est désormais modifiée par ce probe de rôle et ne doit plus être traitée comme un témoin vierge. Production et Préproduction n'ont reçu aucune de ces modifications.

### Conséquence

Le script `scripts/provisionner_roles_db.mjs` crée/vérifie les rôles et transfère le propriétaire du schéma `public`, mais ne transfère pas la propriété des objets préexistants. Le test P10.5 vérifie la chaîne sur une base vierge où le migrateur crée lui-même les objets ; il ne prouve pas le droit ALTER sur les 51 objets déjà détenus par `neondb_owner`.

**Nouveau bloqueur P0 :** définir et tester une stratégie sûre pour que le migrateur puisse modifier les objets existants, sans donner d'appartenance d'administration à `tracefab_app), sans rendre les fonctions SECURITY DEFINER moins sûres et sans transférer aveuglément la propriété de toutes les fonctions. Les options (transfert sélectif de propriété ou rôle de connexion avec SET ROLE encadré) doivent être éprouvées sur une branche isolée avant tout provisionnement Préproduction.

## Blocage réel : rôles Production / Préproduction

Lecture directe des rôles PostgreSQL :

- Production : `tracefab_migrator` absent ; `tracefab_worker` absent.
- Préproduction : `tracefab_migrator` existe, mais est LOGIN, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB. Il peut se connecter et utiliser le schéma `public`, mais n'a ni privilège CREATE sur la base ni CREATE sur le schéma `public`. Il ne respecte donc pas le contrat migrateur.
- Dans les deux environnements, `tracefab_app` reste non privilégié : NOBYPASSRLS, NOCREATEROLE, NOCREATEDB. Il n'est membre ni de `tracefab_migrator` ni de `tracefab_worker`.
- `neondb_owner` est un rôle d'administration BYPASSRLS/CREATEROLE ; l'utiliser comme substitut permanent au migrateur contournerait la séparation de privilèges recherchée.

Le contrat cible des attributs du migrateur est : LOGIN, NOSUPERUSER, BYPASSRLS, CREATEROLE, NOCREATEDB, INHERIT, avec CONNECT sur la base et USAGE + CREATE sur le schéma `public`. Il doit aussi être propriétaire (ou disposer d'un mécanisme d'ownership équivalent, strictement testé) des objets qu'il modifie. Le runtime `tracefab_app` doit rester NOBYPASSRLS et NOCREATEROLE.

Aucun changement de rôle n'a été fait en Production ou Préproduction. Aucun secret de connexion direct Production/Préproduction n'a été créé ou modifié.

## Décision et suite nécessaire

**NO-GO Production et Préproduction.** Les migrations SQL et les tests CI sont validés, mais l'identité réelle qui doit les exécuter n'est pas prête.

1. Provisionner/corriger le rôle `tracefab_migrator` en Préproduction selon le contrat ci-dessus, sans accorder de privilèges supplémentaires à `tracefab_app`.
2. Provisionner son URL directe non poolée dans un environnement GitHub protégé, sans l'exposer dans les logs ou dans le dépôt.
3. Sur une branche Neon jetable issue de Préproduction, exécuter avec le vrai CLI Prisma 6.19.3 : `migrate status`, `migrate deploy`, `migrate status`, puis un second `migrate deploy` sans migration pending. Vérifier les 30 migrations et le catalogue.
4. Seulement après succès complet de Préproduction, provisionner le rôle/secret Production et répéter la procédure.
5. Garder HMAC strict désactivé jusqu'au provisionnement sécurisé de `TRACEFAB_IDENTITY_KEY` et à la preuve de couverture des routes signées.
6. Faire relire la PR #110 avant tout merge. Elle reste ouverte ; aucun merge ni déploiement n'a été effectué.

La seule action manuelle désormais nécessaire n'est plus l'autorisation réseau du CDN Prisma : c'est le provisionnement sécurisé des rôles et des secrets de connexion des environnements réels.
