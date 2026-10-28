# Contexte worker : la faille est fermable, deux garde-fous du dépôt bloquent la livraison

Date : 28/10/2026 · Branche : `arena/c27ddaa4-tracefab` · Base d'essai : PostgreSQL 18.4 jetable, 60 migrations, rôle `tracefab_app` sans `BYPASSRLS`.

Ce document remplace et corrige `docs/security/2026-10-27-isolation-contexte-worker.md`
sur un point : l'option A n'était pas seulement coûteuse, elle est **incompatible avec
un invariant du dépôt**. Et l'option B, que ce tour a construite et mesurée, bute sur
un second garde-fou. Rien n'a été livré : voir §6.

---

## 1. Faits mesurés

| # | Fait | Preuve |
|---|---|---|
| 1 | `tracefab_app` seul, sans contexte : 0 ligne sur `organizations`, `users`, `organization_memberships` | `prouver_bypass_contexte_worker.mjs`, sortie 1 |
| 2 | même rôle, après `SET tracefab.worker_context = 'true'` : 2 / 2 / 2 | même script, avant correctif |
| 3 | 11 politiques RLS s'ouvrent sur ce GUC | catalogue `pg_policies` |
| 4 | Après réécriture des 11 politiques sur `current_user = 'tracefab_worker'` : le GUC ne donne plus **aucune** ligne (0 / 0 / 0) | même script, sortie 0 |
| 5 | Le test de non-régression **échoue** si une seule politique repasse sur le GUC | remise temporaire de `organizations_worker_select` → 2 échecs immédiats |
| 6 | `REVOKE SET ON PARAMETER` **ne protège pas** un paramètre personnalisé : `set_config()` et `SET` passent quand même | mesuré : les deux acceptés après révocation |
| 7 | Un rôle `tracefab_worker` NOLOGIN ne peut pas être endossé par `tracefab_app` : `SET ROLE` et `SET SESSION AUTHORIZATION` refusés | mesuré |
| 8 | Les six opérations système converties en fonctions nommées fonctionnent sous `tracefab_app` dans une transaction annulée | mesuré, 10 assertions |

Les faits 1 à 3 sont l'état d'origine ; 4 à 8 sont l'état du correctif candidat.

## 2. Option A écartée — et pourquoi cette fois c'est dirimant

L'option A consistait à créer une identité `tracefab_worker` connectable et à lui
donner un **second client Prisma**. Elle ferme bien la faille (fait 4), mais :

- elle exige un mot de passe de plus, donc un **nouveau secret** et une modification
  de rôle sur la base gérée ;
- surtout, elle **casse un invariant du dépôt** : « une seule variable de connexion,
  un seul client Prisma ». Le banc `test:inventaire:consommateurs` l'a refusée
  immédiatement — 4 cas en échec, dont « le rapport ne liste qu'un client Prisma —
  `["api/_lib/context.ts","api/_lib/prisma.ts"]` ».

Un correctif de sécurité qui désarme un garde-fou existant n'est pas un correctif.
L'option A est donc abandonnée, pas reportée.

## 3. Option B construite et mesurée

Six fonctions nommées remplacent les requêtes faites sous contexte worker :

| Fonction | Remplace | Portée |
|---|---|---|
| `tracefab_upsert_clerk_user` | `user.upsert` (`auth.ts`, webhook) | rend la seule ligne écrite |
| `tracefab_ensure_clerk_user` | `user.upsert` conditionnel | ne réécrit jamais un compte existant |
| `tracefab_soft_delete_clerk_user` | `user.updateMany` | une ligne, par identifiant Clerk |
| `tracefab_clerk_organization_uuid` | `organizations.findUnique` | rend un seul uuid |
| `tracefab_archive_clerk_organization` | `organizations.update` + `updateMany` | l'organisation désignée |
| `tracefab_notification_outbox_health` | `COUNT` direct | des compteurs, aucune donnée nominative |

Chacune : `SECURITY DEFINER`, `search_path = public` figé, `EXECUTE` retiré à `PUBLIC`,
accordé au seul rôle applicatif, paramètres contrôlés, aucune lecture en masse.

Deux détails appris par l'exécution, pas par la lecture :

- **Sans alias, la fonction ne compile pas en pratique** : les colonnes de sortie
  portent les mêmes noms que celles de `users`, et `ON CONFLICT (clerk_user_id)`
  devient ambigu. Les sorties sont donc préfixées `out_`.
- **`tracefab_archive_clerk_organization` échoue sur `last_owner_membership_required`**.
  Ce n'est pas une régression : le même `UPDATE` lancé par le propriétaire de la base,
  hors RLS et hors de la fonction, échoue à l'identique. Le garde métier préexiste ;
  l'ancien code le rencontrait déjà puisqu'il révoquait toutes les adhésions.

## 4. Ce qui bloque la livraison

### Blocage 1 — la liste d'autorisation des fonctions SQL ne peut pas grandir

Le dépôt tient une liste blanche des fonctions exécutables par le runtime, en deux
endroits qui doivent être **identiques** :

- `scripts/lib/tracefab_runtime_functions.mjs` ;
- le tableau `runtime_names text[] := ARRAY[...]` de la migration
  `20261021120000_limit_app_function_execute`.

Cette migration vérifie que **chaque** nom du tableau existe déjà à cet instant
(`missing, overloaded or foreign-owned functions`). Ajouter les six fonctions au
tableau casse donc la chaîne sur une base neuve — vérifié : `42883 Runtime EXECUTE
allowlist has missing…`. Ne pas les y ajouter laisse les deux listes désaccordées —
vérifié aussi : `module=90, migration=84`.

Le mécanisme n'accepte aujourd'hui **aucune fonction nouvelle appelée depuis `api/`**
sans modifier une migration déjà appliquée. Or cette modification change son empreinte,
et la réparation correspondante se fait en écrivant dans `_prisma_migrations` — geste
explicitement interdit sans autorisation.

### Blocage 2 — conséquence de service

La migration de correction, seule, **casse les chemins worker** : sans le GUC, plus
aucune de leurs requêtes ne passe. Elle n'est donc pas livrable sans le volet code,
et le volet code n'est pas livrable sans lever le blocage 1. Les deux vont ensemble
ou pas du tout.

## 5. Ce qu'il faudrait décider

Une seule décision débloque tout, et elle n'appartient pas au correctif :

> **Étendre le mécanisme de liste blanche pour qu'il accepte les fonctions créées par
> une migration postérieure**, par exemple en lisant le dernier instantané
> `runtime_names` au lieu du chemin figé, et en tolérant les noms qui n'existent pas
> encore à la date de la migration d'origine.

Une fois cette décision prise, la livraison est mécanique : le candidat SQL
`docs/security/candidats/2026-10-28-fermer-contexte-worker.sql` et son banc
`2026-10-27-test-worker-non-forgeable.mjs` sont prêts et **ont déjà tourné**.

## 6. État exact — rien n'est clos

- Correctif **prouvé** sur base jetable, **non livré** : les deux blocages ci-dessus.
- Aucune migration ajoutée au dépôt : le candidat est hors `prisma/migrations`, il ne
  peut donc pas partir en production par accident.
- Code applicatif **rendu à son état d'origine** : `git status` ne montre aucune
  modification de `api/`.
- Aucun secret créé, aucun rôle modifié ailleurs qu'en jetable, production non touchée.
- P0 : **OUVERT**.
