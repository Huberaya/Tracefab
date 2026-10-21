# TRACEFAB — durcissement du rôle runtime et de l'isolation RLS

Date : 2026-10-21  
Branche de correction : `security/identity-rls-hardening-20261021-1200`  
Statut : **candidat de correction en validation isolée — aucune bascule Production exécutée**

## Mesures sur la base Neon Production (lecture seule)

- `neondb_owner` : `rolbypassrls = true`, `rolsuper = false`, `rolcreaterole = true`, `rolcreatedb = true`.
- `tracefab_app` : `rolbypassrls = false`, `rolsuper = false`, `rolcreaterole = false`, `rolcreatedb = false`, `rolcanlogin = true`.
- Les 50 tables métier observées ont RLS activée et forcée. Cela ne protège pas contre un rôle qui contourne RLS.
- Avant correction, `tracefab_app` avait `INSERT/UPDATE/DELETE` sur `_prisma_migrations`.
- Le catalogue comptait 168 fonctions dans `public`, dont 117 `SECURITY DEFINER`; 117 étaient exécutables par le rôle applicatif avant le durcissement observé.
- Le rôle du processus Vercel n'a **pas** été mesuré depuis une requête du runtime. Les secrets de connexion ne sont pas exposés dans ce rapport.

## Corrections préparées dans cette branche

1. Nouvelle migration `20261021120000_limit_app_function_execute` : allowlist explicite des fonctions d'entrée runtime et des helpers requis par les politiques RLS; retrait des droits EXECUTE directs superflus; révocation d'EXECUTE PUBLIC sur les fonctions `SECURITY DEFINER` détenues par le rôle de migration; retrait du défaut EXECUTE pour les fonctions futures.
2. `scripts/lib/tracefab_app_role.mjs` : le bootstrap ne donne plus EXECUTE global ni EXECUTE par défaut à `tracefab_app`, et ferme le défaut EXECUTE PUBLIC.
3. Nouvelle migration `20261021130000_reconcile_runtime_dml_and_migration_history` : conserve la lecture du graphe de traçabilité mais interdit le DML direct sur `supply_chain_links` et `supply_chain_nodes` (les mutations doivent passer par les fonctions `SECURITY DEFINER`); retire tous les privilèges applicatifs sur `_prisma_migrations`.
4. `scripts/test_privileges_role_app.mjs` : contrôle de cohérence de l'allowlist avec les appels API et les fonctions des politiques RLS, mesure des privilèges réels sur base jetable, et contrôle négatif des privilèges par défaut.

## Validation isolée effectuée

Branche Neon de test : `br-broad-breeze-b1lxgpyd`, créée depuis la branche Production; aucune écriture sur la branche Production.

Résultats après exécution manuelle des blocs SQL candidats sur la branche isolée (sans enregistrer ces migrations dans `_prisma_migrations`; la chaîne Prisma complète est testée séparément par GitHub Actions) :

- `tracefab_app` se connecte comme `tracefab_app`, avec `rolbypassrls = false` et `rolsuper = false`.
- `tracefab_app` conserve SELECT sur les deux tables du graphe, mais n'a pas INSERT/UPDATE/DELETE direct sur celles-ci.
- `tracefab_app` n'a plus INSERT/UPDATE/DELETE sur `_prisma_migrations`.
- `SECURITY DEFINER` exécutables par PUBLIC : 0.
- Les fonctions de validation/déclencheur `tracefab_validate_supply_chain_link` et `tracefab_validate_supply_chain_node` ne sont pas exécutables directement par `tracefab_app`; les fonctions d'entrée de graphe requises restent exécutables.

Le workflow d'intégration des migrations sur PostgreSQL jetable a validé la migration de privilèges après correction du défaut PUBLIC EXECUTE observé sur cinq fonctions dans le scénario base neuve. La CI complète doit encore être verte sur le SHA final avant proposition de fusion.

## Conditions restantes avant la bascule Production

- Valider la CI complète sur le SHA final et le parcours Preview.
- Vérifier depuis le runtime Preview que `current_user` est bien `tracefab_app`, puis exercer les routes publiques, l'authentification Clerk, les webhooks, les mutations supply-chain et l'isolation de deux organisations.
- Confirmer que le Preview utilise exclusivement la branche Neon isolée dédiée à cette correction.
- Seulement après ces preuves, planifier la modification de `DATABASE_URL` Production, conserver le retour arrière et surveiller les erreurs RLS. Aucune variable Production, aucun déploiement Production et aucune migration Production n'ont été modifiés par ce chantier.
