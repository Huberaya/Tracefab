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

## Écart EXECUTE des fonctions — correction isolée préparée

La mesure de catalogue en production a montré que `tracefab_app` pouvait exécuter les **131 fonctions appartenant au rôle propriétaire** dans le schéma `public`, dont les 117 fonctions `SECURITY DEFINER`. Le défaut provenait de l'octroi global du bootstrap et du privilège par défaut `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO tracefab_app`. L'absence d'EXECUTE pour `PUBLIC` ne limitait donc pas le rôle applicatif.

La migration `20261021120000_limit_app_function_execute` :
- révoque les droits EXECUTE explicites sur les fonctions appartenant au rôle migrateur ;
- retire l'octroi EXECUTE par défaut pour `tracefab_app` ;
- accorde seulement les 81 fonctions explicitement référencées par les appels SQL de l'API et les politiques RLS ;
- échoue avant la révocation si une fonction manque, est surchargée, n'appartient pas au rôle migrateur ou si une fonction de politique RLS manque à l'allowlist ;
- vérifie qu'aucune fonction `SECURITY DEFINER` appartenant au migrateur ne reste exécutable par `PUBLIC`, et qu'aucun droit direct EXECUTE non autorisé ne subsiste.

L'équivalent de cette migration a été exécuté uniquement sur la branche Neon de test. Vérifications mesurées après application :
- **81** fonctions TraceFab ont un droit EXECUTE direct explicite, et la liste observée correspond exactement à l'allowlist ;
- **0** droit direct EXECUTE ne subsiste sur une fonction TraceFab hors allowlist ;
- parmi les **117** fonctions `SECURITY DEFINER`, **77** restent exécutables par le rôle applicatif, car elles sont dans la liste API/RLS ; les autres ne le sont plus ;
- l'ACL par défaut du schéma `public` ne donne plus EXECUTE à `tracefab_app` pour les futures fonctions ;
- un contrôle négatif sur une fonction temporaire nouvellement créée donne `has_function_privilege = false` et aucun droit direct app ;
- aucune fonction `SECURITY DEFINER` non allowlistée n'est accessible par héritage de `PUBLIC`.

Le module `scripts/lib/tracefab_runtime_functions.mjs` sert de référence de test et est comparé à la liste SQL de la migration. Le bootstrap ne réintroduit plus d'octroi global. La validation CI sur une base PostgreSQL jetable reste obligatoire.

## Suite obligatoire

1. Valider la CI sur la PR #70 et confirmer que le test de privilèges exact passe sur la chaîne complète des migrations.
2. Mesurer l'identité du runtime Vercel avec la sonde interne existante `/api/internal/p2-readiness?identity=1`, qui exige `x-tracefab-worker-secret`. Ne pas déduire cette identité à partir de la variable Vercel seule.
3. Sur la branche de test, exécuter les parcours positifs/négatifs sous `tracefab_app`, notamment l'isolation inter-organisations et les fonctions `SECURITY DEFINER`.
4. Seulement après validation, préparer une bascule de `DATABASE_URL` de production vers le rôle applicatif, avec contrôle post-déploiement et retour arrière documenté.

## Verdict à ce stade

**Correction isolée préparée et éprouvée ; non livrée en production.** L'identité du rôle utilisé par le runtime Vercel de production reste non mesurée. Aucun niveau de sécurité de production ne doit être déclaré validé tant que ce point et les tests inter-organisations ne sont pas démontrés.
