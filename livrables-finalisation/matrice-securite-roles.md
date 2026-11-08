# Matrice de sécurité sous rôles réels

Source : `preuves/matrice-securite-roles.log` — **28/28 conformes**.
Commande : `node livrables-finalisation/sondes/matrice-securite-roles.mjs` avec `TF_APP_MDP` (session authentifiée).

## Méthode — et pourquoi pas `SET ROLE`

`SET ROLE tracefab_app` depuis `postgres` **ne simule aucune session applicative** : le `session_user` reste superutilisateur, et PostgreSQL autorise alors `SET ROLE tracefab_worker`. Cette erreur de méthode a produit deux faux échecs avant d'être comprise.

La mesure de référence est une **session réellement authentifiée** sous `tracefab_app` (mot de passe synthétique, cluster jetable, jamais journalisé). Sans mot de passe, le script retombe sur `SET SESSION AUTHORIZATION` et le dit dans sa sortie.

## `tracefab_app` (NOBYPASSRLS)

| # | Contrôle | Mesure |
|---|---|---|
| A0 | identité endossée | `session_user=tracefab_app` |
| A1 | lecture de sa propre organisation | 1 ligne |
| A2 | lecture d'une autre organisation | **0 ligne** (RLS) |
| A3 | colonne réservée de document | `42501` |
| A4 | `INSERT` direct `documents` | `42501` |
| A5 | périmètre runtime | 1 ligne |
| A6 | champ calculé du produit | `42501` |
| A7 | fonction hors registre | `42501` |
| A8 | création d'objet dans `public` | `42501` |
| A9 | appartenance au worker | `false` |
| A10 | `SET ROLE tracefab_worker` | `42501` |
| A11 | `SET SESSION AUTHORIZATION` worker | `42501` |

## `tracefab_worker` (NOLOGIN, NOBYPASSRLS)

| # | Contrôle | Mesure |
|---|---|---|
| W1 | fonctions possédées | 8 |
| W2 | exécution d'une fonction système | OK |
| W3 | création d'objet dans `public` | `42501` |
| W4 | attributs | `NOLOGIN NOBYPASSRLS NOSUPERUSER NOCREATEROLE` |
| W5 | `EXECUTE` hors domaine worker | `false` |
| W6 | isolation bidirectionnelle app ↔ worker | `false` / `false` |
| W7 | octroi à `PUBLIC` | 0 |

## Chemins Clerk (SECURITY DEFINER), propriétaire non superutilisateur

| # | Contrôle | Mesure |
|---|---|---|
| C1 | `sync_clerk_organization` | OK |
| C2 | `sync_clerk_membership` OWNER | OK |
| C2b | `sync_clerk_membership` VIEWER | OK |
| C2c | adhésions distinctes | 2 |
| C3 | `revoke_clerk_membership` VIEWER | `revoked` |
| C3b | **garde-fou** dernier OWNER | **refusé** `last_owner_membership_required` |
| C4 | re-sync idempotente | 1 organisation |
| C4b | **audit écrit** | 3 lignes |
| C6 | GUC falsifié | sans effet |

C6 est le contrôle le plus important : il prouve que l'autorisation vient du **rôle de session**, jamais d'un GUC que l'appelant pourrait poser.

## `main` (69) vs candidat (76), sous `tracefab_app`

| Lecture | `main` | Candidat |
|---|---|---|
| `organizations` | **`42501` users** | OK |
| `supplier_passport_access_requests` | **`42501` users** | OK |
| `users` | **`42501` users** | OK |
| `organization_memberships` | OK | OK |
| `tracefab_products` | OK | OK |
| contrôle de bascule | **OBSTACLE `orders`** | **prêt** |

Les trois `42501` et l'obstacle `orders` sont **préexistants** : mesurés à l'identique sur `origin/main`.


## Rôle omis par la matrice initiale : `tracefab_migrator`

La matrice initiale 28/28 ne testait ni la session authentifiée `tracefab_migrator`, ni sa capacité à endosser `tracefab_worker`. La revue indépendante a démontré une appartenance effective résiduelle et une lecture inter-tenant via le worker. Le résultat 28/28 ne prouve donc pas l'isolation complète.

La version corrective ajoute M0–M4 et exige `TF_MIGRATOR_MDP` : identité de session, absence d'appartenance effective, refus de `SET ROLE`, refus de `SET SESSION AUTHORIZATION` et absence d'ADMIN OPTION. Ces contrôles sont exécutés par la suite P10.5 après la chaîne complète, sous une véritable connexion migrator ; le résultat n'est valide qu'après exécution CI sur le SHA candidat.
