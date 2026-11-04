# Neon — écart historique de checksum PLM (04/11/2026)

La migration 20261006210000_plm_erp_gs1_interoperability est enregistrée comme réussie dans Production et Préproduction avec le SHA-256 :
c944ce0c21f128b8ee8c919de58179d4f25fdf3d2f7f087dacbca615b89c3861

Le fichier versionné conserve le SHA-256 :
6a8d03eb507b824e2a308d7e29113478d60d726255fcc1883cef56c506783044

La copie exacte du SQL du 06/10 n'a pas été retrouvée. L'écart reste visible et n'est pas présenté comme une équivalence octet pour octet. Une exception unique est épinglée à cette paire.

## Recherche historique complémentaire (04/11/2026)

La ligne Neon situe l'application réussie au **2026-10-06 10:36:24.845 UTC**. Le premier commit Git qui contient le dossier de migration est `142fdf583c6b2c2b03b4aa04f3375fdde60beca0`, horodaté **2026-10-06 16:01:52 UTC**. Le fichier a donc été versé au dépôt environ 5 h 25 après l'exécution enregistrée en base.

Ce même commit contient `scripts/apply_migration_chantier2.mjs`. Ce script constitue une piste historique utile, mais **pas une preuve du fichier exact** : il contient notamment les fonctions `tracefab_create_supply_chain_node` et `tracefab_add_supply_chain_link`, absentes du `migration.sql` de ce commit. Il n'est donc ni identique au fichier Prisma, ni un candidat pouvant être renommé ou substitué sans preuve. La recherche des versions du chemin dans les branches et l'historique Git n'a pas révélé de version correspondant au SHA-256 Neon.

Conséquence : la chronologie explique comment le SQL initial a pu ne pas être préservé dans Git, mais ne permet pas d'inférer son contenu. La paire de checksums demeure une exception opérationnelle strictement bornée, et non une réconciliation octet pour octet.

## Catalogue actuel observé en lecture seule sur les deux bases

- plm_erp_integrations et plm_erp_sync_jobs existent ; RLS et FORCE RLS actifs ; propriétaire neondb_owner.
- Les quatre politiques canoniques sont présentes avec les mêmes commandes et prédicats.
- tracefab_ingest_plm_erp_payload existe, SECURITY DEFINER, propriétaire neondb_owner, search_path public, EXECUTE accordé à tracefab_app et révoqué à PUBLIC.
- MD5 de la définition courante dans les deux environnements : c1b63651c4eb36fc4fd753b41e22a66a.
- La contrainte d'identifiant autorise actuellement `gtin`, `ean`, `upc`, `internal`, `gs1_digital_link` et `gln`, mais pas encore `gpc` ; les deux fonctions du graphe d'approvisionnement sont présentes.
- Les quatre CHECK attendus sur `plm_erp_integrations` (`system_type`, `name`, `auth_type`, `status`) sont absents dans les deux environnements. La table contient 0 ligne ; aucun enregistrement existant ne viole les valeurs cibles.
- `product_identifiers` contient uniquement `gtin` et `gs1_digital_link` sur les deux bases ; 0 ligne `gpc` et 0 type invalide. La contrainte actuelle est l'ancienne liste sans `gpc`.

Limite : la fonction courante incorpore des évolutions ultérieures du graphe. Cette lecture atteste l'état actuel commun, elle ne reconstitue pas le SQL original du 06/10.

## Correction forward du catalogue (ajoutée le 04/11)

La divergence de checksum n'est pas assimilée à une équivalence de schéma. Une migration distincte, `20261104090000_plm_integrations_and_gs1_constraints`, est ajoutée après les 13 migrations historiques en attente. Elle :

- refuse les lignes PLM ou identifiants qui ne respectent pas le contrat cible ;
- ajoute les quatre CHECK PLM manquants avec `NOT VALID`, puis `VALIDATE CONSTRAINT` ;
- remplace uniquement l'ancienne contrainte GS1 exacte par la même contrainte étendue à `gpc` ;
- refuse toute définition de contrainte inattendue ou un état partiel des quatre CHECK ;
- ne modifie jamais `_prisma_migrations`, ne lance aucun `migrate resolve`.

Le même contrôle catalogue complet a été exécuté en lecture seule sur Production et Préproduction. La migration forward est testée par simulation PGlite en reproduisant précisément l'état mesuré (quatre CHECK absents et contrainte GS1 sans GPC), puis en vérifiant la réparation et son idempotence.

## Test du comportement Prisma

Le test automatisé test:prisma:checksum-deploy, sur Prisma 6.19.3 et PostgreSQL local jetable, applique une première migration, modifie son checksum de test, ajoute une migration pending puis exécute migrate deploy. Résultat : code de sortie 0, la migration pending est appliquée, le checksum historique altéré reste inchangé. Aucun resolve ni réécriture n'est nécessaire.

## Garde-fous

- Seule cette paire exacte de checksums est autorisée ; toute autre divergence reste bloquante.
- L'écart reste affiché comme avertissement ; la CI ne prétend pas qu'il y a zéro divergence.
- Aucun migrate resolve et aucune écriture directe de _prisma_migrations.
- Préproduction d'abord ; contrôles du catalogue et tests après application ; Production uniquement après validation complète de Préproduction.
- Les 13 migrations historiques pending restent à appliquer et à vérifier, puis la correction forward PLM/GS1 post-snapshot (14 migrations à appliquer au total sur les environnements actuels).
- Si le SQL original est retrouvé, restaurer le fichier, vérifier c944… puis retirer l'exception.


## Validation réelle sur Neon isolé (04/11/2026)

Une branche de validation Neon existante, distincte de Production et Préproduction, a été utilisée pour exécuter la chaîne avec le vrai CLI Prisma 6.19.3 :

- Branche : `br-sweet-king-b1n2f4u6` (`tracefab-dpp-readiness-validation-current-20261027`), issue du snapshot `br-broad-fog-b1rgt68c`.
- État avant test : 56 migrations terminées ; 15 migrations en attente (les 13 historiques absentes de Production/Préproduction et les deux corrections forward du 04/11).
- Commande : `npx prisma migrate deploy --schema prisma/schema.prisma` ; code de sortie **0**.
- Résultat : les 15 migrations sont appliquées dans l'ordre, sans réécrire l'entrée PLM historique.
- Recontrôle : `prisma migrate status` retourne `Database schema is up to date!`; un second `prisma migrate deploy` retourne `No pending migrations to apply.`.
- Historique après test : 71 migrations réussies, 2 tentatives antérieurement annulées, 0 migration inachevée (73 lignes au total).
- La ligne `20261006210000_plm_erp_gs1_interoperability` conserve exactement `c944ce0c21f128b8ee8c919de58179d4f25fdf3d2f7f087dacbca615b89c3861` et sa date `2026-10-06 10:36:24.845 UTC`.

Cette preuve établit que le checksum divergent **ne bloque pas le déploiement des migrations pending avec Prisma sur une base Neon**. Elle n'établit pas que le fichier SQL versionné est identique octet pour octet au fichier exécuté le 06/10. Aucun `migrate resolve`, UPDATE ou DELETE de `_prisma_migrations` n'a été effectué.

### Contrôles de catalogue après les 15 migrations

- `tracefab_worker` existe en NOLOGIN, sans SUPERUSER, BYPASSRLS ni CREATEROLE ; les six fonctions Clerk attendues lui appartiennent, sont SECURITY DEFINER et ne sont pas exécutables par PUBLIC.
- `tracefab_app` n'est pas membre de `tracefab_worker`. Sur cette branche Neon, les deux lignes de membership attendues sont distinguées : bootstrap `cloud_admin` (ADMIN, sans INHERIT/SET) et octroi explicite `neondb_owner` (INHERIT/SET, sans ADMIN).
- `plm_erp_integrations` et `plm_erp_sync_jobs` ont RLS et FORCE RLS ; les deux politiques canoniques de chaque table sont présentes.
- `tracefab_ingest_plm_erp_payload` contient la garde `ingest_role_not_allowed`, est SECURITY DEFINER, a un `search_path` épinglé à `pg_catalog, public`, et n'est pas exécutable par PUBLIC.
- Les quatre fonctions de noeuds/liens utilisent les casts explicites vers `public.data_value_status`; la contrainte GS1 accepte `gpc` et les CHECK PLM sont validés.
- La politique HMAC reste volontairement en mode permissif (`strict=false`) et aucune clé n'est provisionnée sur cette branche de validation. L'activation stricte demeure une opération séparée, après provisionnement sécurisé de `TRACEFAB_IDENTITY_KEY` dans l'application.

### Branche historique écartée comme baseline propre

Une autre branche de validation préexistante, `br-late-truth-b1q7gy8j`, contenait déjà le registre runtime (92 entrées) et des effets de migrations ultérieures sans ligne réussie pour `20261028120000_runtime_function_registry`. Le premier essai Prisma sur cette branche s'est donc arrêté sur `42P07 relation already exists`. Cette branche n'est pas une base propre et n'a pas été utilisée comme preuve positive. L'essai a laissé une ligne Prisma en échec sur cette branche de validation uniquement ; aucun `migrate resolve` n'a été exécuté. Production et Préproduction n'ont pas été touchées.

**Conclusion de cette section :** la compatibilité opérationnelle du checksum historique est démontrée sur Neon ; la récupération de son SQL exact reste ouverte et doit être close uniquement si une archive ou un workspace du 06/10 est retrouvé.
