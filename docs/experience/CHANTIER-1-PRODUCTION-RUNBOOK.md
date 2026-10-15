# Chantier 1 — Runbook de préparation à une application contrôlée en production

**Statut au 14 octobre 2026 : PR #41 non fusionnée ; aucune migration de ce chantier appliquée à Neon production.**  
Ce document prépare l'opération ; il n'autorise pas à contourner les critères d'arrêt.

## 1. État des preuves

- Le job CI « Base — isolation RLS exécutée » a réussi sur PostgreSQL jetable : migrations, contrôle des privilèges avant seed, et tests d'isolation inter-organisations.
- Le job « Socle — types, compilation, isolation » a réussi sur le dernier run connu.
- Le run CI #242 (run ID `38641234349`) sur le commit `3dbe2edf76d88541cd5dbc2b32963dfe260331ba` a réussi sur les quatre jobs : socle/types/isolation, base PostgreSQL jetable + RLS, parcours navigateur réel (20 parcours) et suite complète des scripts `test:*`. Le run précédent avait échoué sur deux tests statiques ; leurs assertions ont été corrigées. Toute modification ultérieure de la branche doit être revalidée par une nouvelle CI.
- La vérification de migration du dépôt indique 39 migrations présentes = 39 attendues dans le dépôt. Ce n'est pas une preuve que les 39 sont appliquées sur Neon.
- Le Q2 transmis le 14 octobre s'arrête à `20261009180000_public_read_context`. Les cinq migrations de durcissement datées du 14 octobre ne figurent pas dans l'extrait : elles sont donc non confirmées comme appliquées en production. Cinq entrées plus anciennes ont `applied_steps_count = 0`, `finished_at = started_at`, `rolled_back_at = null` et `logs` vide ; leur origine doit être expliquée avant tout déploiement. Les objets Q8 présents ne prouvent pas que ces migrations ont été réellement exécutées.
- La migration `20261014130000_revoke_public_schema_privileges` limite les changements aux fonctions et relations dont `current_user` est propriétaire afin de ne pas modifier les ACL d'extensions détenues par `cloud_admin`.
- La migration `20261014140000_remove_public_supplier_passport_share_token` retire le jeton privé `shareToken` du JSON du passeport fournisseur public ; ce correctif est distinct du retrait des privilèges SQL et doit être validé par les tests statiques et d'intégration.

## 2. Coordination avec la PR #34 — blocage de séquencement

La PR #34 (`arena/91844ee9-tracefab`) est ouverte, sa dernière CI connue est verte, mais GitHub la signale `mergeable = false`. La migration `20261010120000_publication_explicite` existe dans cette branche et n'a pas été trouvée sur `main` lors de l'inspection du 14 octobre. Elle ne figure pas non plus dans l'historique de production fourni. La PR #41 est basée sur `main`, et ne contient pas cette migration.

Avant toute fusion ou déploiement combiné, résoudre les conflits de la PR #34, auditer son diff contre le `main` actuel, puis déterminer une séquence de fusion unique. Ne pas déployer la PR #41 en production avant que toutes les migrations attendues, notamment les migrations antérieures de publication DPP, soient présentes dans une chaîne validée et ordonnée. Si un déploiement automatique se déclenche à la fusion, suspendre ce déclenchement jusqu'à validation du séquencement.

## 3. Conditions impératives avant fusion

Ne pas fusionner tant que toutes les conditions suivantes ne sont pas documentées :

1. Le dernier commit de la PR a une CI entièrement verte, y compris tests, migrations PostgreSQL jetable, isolation RLS et tests navigateur.
2. Les trois tests statiques corrigés réussissent ; aucune autre suite n'est en échec.
3. Le fichier `CHANTIER-1-NEON-AUDIT-READONLY.sql` a été exécuté dans Neon en lecture seule. Les sorties Q1 à Q9 sont conservées sans secrets ; Q1b confirme le rôle runtime, Q4b les droits effectifs des tables/séquences, Q6b les privilèges par défaut et Q9 les anomalies Prisma sans divulguer les logs.
4. L'historique `_prisma_migrations` est comparé ligne par ligne aux migrations du dépôt : migrations appliquées, migrations échouées, annulées, doublons et ordre chronologique.
5. Le rôle réel utilisé par Prisma Migrate est confirmé, et il est propriétaire des objets applicatifs que les migrations veulent modifier. Les objets d'extension appartenant à `cloud_admin` sont hors périmètre.
6. Les privilèges actuels de `tracefab_app` sur les fonctions, tables et séquences nécessaires sont compris ; aucun accès applicatif requis n'est supposé à partir de la seule absence de PUBLIC.
7. Une sauvegarde/PITR vérifiable est disponible et la fenêtre d'intervention ainsi que le responsable du retour arrière sont identifiés.

## 4. Précontrôles immédiatement avant l'opération

Dans l'environnement de déploiement autorisé, avec la connexion de migration de production :

- Vérifier l'identité de base et de rôle sans imprimer la chaîne de connexion.
- Exécuter `prisma migrate status` en mode lecture seule et comparer le résultat à l'inventaire validé.
- Vérifier que les migrations en attente sont exactement celles approuvées, dans l'ordre. Ne jamais supposer que `migrate deploy` n'appliquera que les cinq migrations de durcissement : Prisma applique toutes les migrations en attente.
- Vérifier les droits du rôle de migration sur le schéma `public`, les fonctions applicatives et les relations qu'il doit modifier.
- Confirmer que la CI correspond au HEAD exact de la PR à fusionner.

**Arrêt immédiat** si l'historique est incohérent, si une migration antérieure est en échec, si des migrations non approuvées sont en attente, si le rôle réel diffère du rôle testé, ou si les ACL d'un objet fournisseur devraient être modifiées.

## 5. Application contrôlée — seulement après autorisation explicite et critères satisfaits

1. Fusionner la PR validée selon les règles du dépôt.
2. Déclencher le processus de déploiement approuvé pendant la fenêtre convenue. Ne pas exécuter de commande manuelle improvisée contre Neon.
3. Observer chaque étape du déploiement. Une erreur Prisma, une erreur de privilèges ou un statut incertain signifie arrêt : ne pas marquer manuellement une migration comme appliquée et ne pas éditer `_prisma_migrations`.
4. Après succès confirmé, réexécuter les requêtes en lecture seule Q1 à Q9.
5. Comparer les résultats avant/après et vérifier : zéro EXECUTE PUBLIC sur les fonctions TraceFab possédées par le rôle de migration, zéro privilège PUBLIC non prévu sur les relations applicatives, aucun CREATE PUBLIC sur `public`, et EXECUTE effectif sur les fonctions requises par `tracefab_app`.
6. Relancer les tests de parcours public, de RLS et d'isolation inter-organisations avec une identité applicative normale.
7. Archiver le SHA fusionné, l'ID du déploiement, le statut des migrations et les sorties SQL post-déploiement expurgées de toute donnée sensible.

## 6. Retour arrière / incident

- Les migrations de privilèges utilisent des transactions, mais une transaction réussie ne garantit pas que toutes les routes de l'application fonctionneront après changement d'ACL.
- En cas de régression, suspendre les opérations de déploiement suivantes, préserver les logs et sorties de contrôle, puis décider du correctif avec les preuves. Ne pas rétablir `PUBLIC EXECUTE` globalement comme mesure de contournement.
- Ne jamais restaurer une sauvegarde ni modifier les ACL de production sans décision explicite, évaluation d'impact et plan documenté.
- Ne jamais transmettre des mots de passe, URL de connexion, tokens ou secrets dans le chat.

## 7. Critère de clôture

Le chantier est clos uniquement quand la CI du commit exact est verte, l'historique Neon est réconcilié, l'application contrôlée est confirmée, les audits post-déploiement passent et les parcours applicatifs/RLS restent verts. Avant ces preuves, le statut reste **préparé / non exécuté en production**.
