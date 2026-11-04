# Neon — écart historique de checksum PLM (04/11/2026)

La migration 20261006210000_plm_erp_gs1_interoperability est enregistrée comme réussie dans Production et Préproduction avec le SHA-256 :
c944ce0c21f128b8ee8c919de58179d4f25fdf3d2f7f087dacbca615b89c3861

Le fichier versionné conserve le SHA-256 :
6a8d03eb507b824e2a308d7e29113478d60d726255fcc1883cef56c506783044

La copie exacte du SQL du 06/10 n'a pas été retrouvée. L'écart reste visible et n'est pas présenté comme une équivalence octet pour octet. Une exception unique est épinglée à cette paire.

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
