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
- La contrainte d'identifiant accepte gs1_digital_link et gln ; les deux fonctions du graphe d'approvisionnement sont présentes.

Limite : la fonction courante incorpore des évolutions ultérieures du graphe. Cette lecture atteste l'état actuel commun, elle ne reconstitue pas le SQL original du 06/10.

## Test du comportement Prisma

Le test automatisé test:prisma:checksum-deploy, sur Prisma 6.19.3 et PostgreSQL local jetable, applique une première migration, modifie son checksum de test, ajoute une migration pending puis exécute migrate deploy. Résultat : code de sortie 0, la migration pending est appliquée, le checksum historique altéré reste inchangé. Aucun resolve ni réécriture n'est nécessaire.

## Garde-fous

- Seule cette paire exacte de checksums est autorisée ; toute autre divergence reste bloquante.
- L'écart reste affiché comme avertissement ; la CI ne prétend pas qu'il y a zéro divergence.
- Aucun migrate resolve et aucune écriture directe de _prisma_migrations.
- Préproduction d'abord ; contrôles du catalogue et tests après application ; Production uniquement après validation complète de Préproduction.
- Les 13 migrations pending restent à appliquer et à vérifier.
- Si le SQL original est retrouvé, restaurer le fichier, vérifier c944… puis retirer l'exception.
