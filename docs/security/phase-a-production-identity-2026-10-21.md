# TRACEFAB — sécurité production : identité DB et privilèges

**Date de mesure :** 2026-10-21  
**Portée :** diagnostic Neon en lecture seule sur la branche de production, puis vérification ACL isolée sur une branche de test.  
**Production modifiée : non.** Aucun changement de `DATABASE_URL` de production, aucune migration distante, aucune fusion.

## État Neon observé

- Base : `neondb`, branche `production`.
- Historique Prisma : 55 entrées, 53 appliquées, 2 annulées, 0 incomplète.
- Dernière migration appliquée : `20261020120000_structured_supply_chain_graph_membership`.
- Tables ordinaires du schéma public : 51 ; RLS activée et forcée sur 50 tables métier. `_prisma_migrations` est l'unique table technique hors RLS.
- Objets courants : 133 politiques RLS et 117 fonctions `SECURITY DEFINER`. Ces comptes sont cohérents avec l'application de la migration du 20 octobre et ne doivent pas être comparés aux anciens comptes sans prendre en compte cette migration.
- `tracefab_app` : `rolsuper=false`, `rolbypassrls=false`, `rolcreaterole=false`, `rolcreatedb=false`.
- `neondb_owner` : `rolbypassrls=true`, `rolcreaterole=true`, `rolcreatedb=true`. Il ne faut jamais employer ce rôle comme rôle applicatif.
- `pg_stat_activity` n'a exposé que la connexion d'administration `neondb_owner` au moment de la mesure. Cela ne prouve pas quel rôle le runtime Vercel utilise.

## Écart de privilèges confirmé

Le rôle `tracefab_app` avait des droits DML explicites sur `public._prisma_migrations`, table non protégée par RLS. Cette table technique ne fait pas partie de la liste des tables métier que l'application écrit directement.

La migration `20261021110000_revoke_app_migration_table_dml` retire à `tracefab_app` les privilèges `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES` et `TRIGGER` sur cette table, tout en conservant `SELECT`. Elle est idempotente et ne modifie aucune donnée métier.

## Vérification isolée

Sur la branche Neon de test `tracefab-security-audit-20261021` (`br-frosty-boat-b1qnhglj`) :

- connexion vérifiée : `current_user = tracefab_app` ;
- `rolbypassrls = false` ;
- après application de la révocation, `has_table_privilege` renvoie `false` pour `INSERT`, `UPDATE` et `DELETE` sur `_prisma_migrations` ;
- la liste des privilèges DML explicites du rôle ne contient plus `_prisma_migrations`.

L'équivalent SQL de la migration a été exécuté uniquement sur cette branche de test. La migration versionnée doit encore passer la CI avant toute application en production.

## Suite obligatoire

1. Valider la CI sur la PR #70 et confirmer que le test de privilèges exact passe sur la chaîne complète des migrations.
2. Mesurer l'identité du runtime Vercel avec la sonde interne existante `/api/internal/p2-readiness?identity=1`, qui exige `x-tracefab-worker-secret`. Ne pas déduire cette identité à partir de la variable Vercel seule.
3. Sur la branche de test, exécuter les parcours positifs/négatifs sous `tracefab_app`, notamment l'isolation inter-organisations et les fonctions `SECURITY DEFINER`.
4. Seulement après validation, préparer une bascule de `DATABASE_URL` de production vers le rôle applicatif, avec contrôle post-déploiement et retour arrière documenté.

## Verdict à ce stade

**Correction isolée préparée et éprouvée ; non livrée en production.** L'identité du rôle utilisé par le runtime Vercel de production reste non mesurée. Aucun niveau de sécurité de production ne doit être déclaré validé tant que ce point et les tests inter-organisations ne sont pas démontrés.
