# TRACEFAB — réconciliation de l'historique des migrations Neon Production

Date du contrôle : 2026-10-21  
Méthode : lecture seule du catalogue Neon et comparaison des noms avec le dépôt GitHub.  
Dépôt de référence : `Huberaya/Tracefab`, `main` au SHA `db06dca398fe9b39ceecb23b90a0de1cd08910cb`.  
Base : `neondb`; branche Neon Production : `br-broad-fog-b1rgt68c`.

## Résultat

| Mesure | Valeur observée |
|---|---:|
| Dossiers de migration dans le dépôt de référence | 53 |
| Lignes dans `_prisma_migrations` | 55 |
| Noms distincts dans `_prisma_migrations` | 53 |
| Noms distincts avec application réussie | 53 |
| Tentatives historiques annulées | 2 |
| Migrations inachevées (ni appliquées ni annulées) | 0 |
| Migrations du dépôt sans application réussie | 0 |
| Noms du registre Neon absents du dépôt | 0 |

Les 55 lignes ne représentent pas 55 migrations différentes : deux migrations ont chacune une tentative annulée et une application réussie. Les deux noms concernés sont `20261010120000_publication_explicite` et `20261017120000_active_tenant_context`; chacun présente une ligne appliquée et une ligne annulée. Aucun nom de migration supplémentaire n'est présent dans Neon, et chaque dossier de migration du SHA de référence possède une ligne d'application réussie.

## Limites

Cette vérification établit la cohérence **du registre Prisma**, pas l'identité du processus Vercel ni l'absence de dérive du schéma SQL. Elle ne prouve pas que toutes les politiques RLS sont correctes, que toutes les routes arment le contexte de locataire, ni que le runtime utilise `tracefab_app`.

Mesures de rôle, également obtenues en lecture seule :

- `neondb_owner` a `rolbypassrls = true`, `rolcreaterole = true` et `rolcreatedb = true`.
- `tracefab_app` a `rolbypassrls = false`, `rolsuper = false`, `rolcreaterole = false`, `rolcreatedb = false` et `rolcanlogin = true`.
- Le rôle effectif des requêtes Vercel Production reste à mesurer depuis le runtime; la valeur de `DATABASE_URL` n'a pas été exposée ni modifiée.

Les migrations candidates `20261021120000_limit_app_function_execute` et `20261021130000_reconcile_runtime_dml_and_migration_history` appartiennent à la branche de correction et ne sont pas dans le SHA de référence ni appliquées sur Neon Production.
