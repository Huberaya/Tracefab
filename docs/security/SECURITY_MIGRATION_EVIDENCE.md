# Preuves de migration — quatre migrations additives, mesurées sur PostgreSQL 17

Branche : `arena/8cb8c0b6-tracefab` · base `origin/pr111` = `3d1eb1c` ·
chaîne complète : **88 migrations** appliquées sur une base vierge.
Aucune migration historique n'a été réécrite ; aucun `_prisma_migrations` n'a été modifié à la
main ; aucune base Neon de Production ni de Préproduction n'a été touchée.

---

## 1. Les quatre migrations

| Ordre | Nom | Nature | Effet |
|---|---|---|---|
| 85 | `20261105250000_active_tenant_document_material_access` | remplace 7 politiques + 2 fonctions | locataire actif sur `documents`, `materials`, `suppliers`, `supplier_sites`, `certifications` ; bénéficiaire de partage actif |
| 86 | `20261105260000_runtime_user_email_definer_guard` | `CREATE OR REPLACE` d'une fonction | `tracefab_current_user_email()` en `SECURITY DEFINER` à `search_path` figé |
| 87 | `20261105270000_runtime_read_users_and_registry` | `GRANT SELECT` | le runtime peut lire `users` et `tracefab_runtime_function_registry` sous RLS |
| 88 | `20261105280000_active_tenant_document_indirect_paths` | `CREATE OR REPLACE` d'une fonction | branches indirectes de `tracefab_can_access_document` bornées au locataire actif |

Chacune est **additive** : aucune ne modifie un fichier `migration.sql` existant, aucune ne
supprime d'objet, et toutes peuvent être rejouées (remplacement de politique, `CREATE OR
REPLACE`, `GRANT` conditionnel).

---

## 2. Procédure reproductible (PostgreSQL 17.11 réel)

```bash
initdb -D /tmp/pgdata -U postgres --auth=trust
pg_ctl -D /tmp/pgdata -o "-p 5432 -k /tmp/pgsock -c listen_addresses=127.0.0.1 \
        -c fsync=off -c max_connections=200" start
createdb -h 127.0.0.1 -U postgres tracefab_test

export DATABASE_URL=postgresql://postgres@127.0.0.1:5432/tracefab_test
export TF_APP_PASSWORD=<mot de passe jetable, jamais un secret réel>
export TF_RLS_APP_URL=postgresql://tracefab_app:<le même>@127.0.0.1:5432/tracefab_test

npm run db:prepare-ci-role          # crée tracefab_app, sans BYPASSRLS
TF_ALLOW_WRITE=oui node scripts/migrer_fidelement.mjs   # 88 migrations
TF_EXIGER_LOCAL=oui npm run db:seed-rls                 # 2 organisations, 2 utilisateurs
```

`db:prepare-ci-role` **refuse** tout nom de base autre que `tracefab_test` : c'est la garde de
cible, pas une commodité. Le mot de passe est jetable et n'ouvre rien hors de cette base.

---

## 3. Ce que chaque migration vérifie d'elle-même

### 3.1 `20261105250000` — 7 politiques, 2 fonctions

Préconditions : politiques et fonctions cibles présentes ; fonctions `SECURITY DEFINER` ;
propriétaire ≠ `tracefab_app`.
Postconditions : le texte de chacune des 7 politiques contient `tracefab_in_active_tenant` ; les
politiques **publiques** (`products_select_public`, `dpp_select_public`, `materials_select_public`)
n'ont pas été emportées ; `tracefab_app` conserve `EXECUTE` sur les fonctions remplacées ;
`tracefab_can_access_shared_subject` exige que le **bénéficiaire** soit le locataire actif.

### 3.2 `20261105260000` — email du porteur

Défaut mesuré avant : `select id from organizations` sous `tracefab_app` →
`42501 permission denied for table users`. Cause : fonction `SECURITY INVOKER` lisant
`public.users`, privilège contrôlé à l'analyse même sur une branche `CASE` non empruntée.
Postconditions : même OID, même propriétaire, même ACL qu'avant le remplacement ;
`prosecdef = true` ; `proconfig` contient `search_path` ; exécutable par `tracefab_app` ; **non**
possédée par `tracefab_app`.
Note de méthode : une première version exigeait « le runtime n'a pas `SELECT` sur `users` ». Cette
postcondition encodait le **provisionnement d'un environnement**, pas le dépôt, et elle a fait
échouer `test:neon:isolation-lignes` sur un environnement où le privilège est légitimement accordé.
Elle a été retirée — une postcondition qui décrit l'environnement se casse toute seule.

### 3.3 `20261105270000` — lecture runtime

Défaut mesuré avant : `test:neon:rls` classait `users` et `tracefab_runtime_function_registry` en
« erreur de politique » (42501) alors que les politiques de lecture existaient
(`users_select_self`, registre déclaré « lisible par conception »).
Postconditions : `SELECT` accordé ; **aucun** `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE` ;
`relrowsecurity` **et** `relforcerowsecurity` vrais ; politique de lecture présente.
Après application : `test:neon:rls` interroge **50 tables, aucune erreur de politique**.

### 3.4 `20261105280000` — chemins indirects

Défaut mesuré avant (voir § 4 pour la trace) : un administrateur de A et de B, locataire A actif,
obtenait `true` pour une pièce de B atteinte par un point de donnée, et la RLS laissait passer
1 pièce sur 3 — parce que `documents_select_authorized` délègue à cette fonction.
Postconditions : OID/propriétaire/ACL inchangés ; `search_path` figé ; exécutable par le runtime ;
non exécutable par `PUBLIC` ; au moins 7 occurrences du prédicat de locataire dans la définition.
Après application : locataire A actif → `false` et 0 pièce ; locataire B actif → `true` et 3 pièces.

---

## 4. Trace des mesures avant / après

### F1/F2 — documents, matières, fournisseurs (avant `20261105250000`)

```
sous tracefab_app, locataire A actif, utilisateur membre de A et de B :
  select count(*) from documents where id = <pièce de B>        -> 1     (fuite)
  select tracefab_can_access_document(<pièce de B>)             -> true  (fuite)
  select count(*) from suppliers where id = <fournisseur de B>  -> 1     (fuite)
après 20261105250000 :
  -> 0 / false / 0   et locataire B actif : 1 / true / 1   (accès légitime préservé)
```

### F3 — email du porteur (avant `20261105260000`)

```
select id from organizations  ->  ERROR 42501 permission denied for table users
après : -> 0 ligne pour un utilisateur sans adhésion, N lignes pour ses organisations
```

### F4 — lecture runtime (avant/après `20261105270000`)

```
test:neon:rls  avant : users et tracefab_runtime_function_registry en erreur 42501
               après : 50 tables interrogées, aucune erreur de politique
```

### F5 — chemins indirects (avant/après `20261105280000`)

```
tenant A actif | fonction via point de donnée: true  | via certification: false | documents lisibles: 1
tenant B actif | true | true | 3
-- après --
tenant A actif | false | false | 0
tenant B actif | true  | true  | 3
```

---

## 5. Résultats des suites (PostgreSQL 17 réel, base jetable, 88 migrations)

Vertes après correction :

```
test:neon:rls                          test:neon:write-policies
test:neon:cross-tenant                 test:neon:active-tenant
test:neon:document-material-scope      test:neon:document-lifecycle
test:neon:dpp-lifecycle                test:neon:isolation-lignes
test:neon:privileges                   test:neon:privileges-role-app
test:neon:registre-fonctions           test:neon:worker-non-forgeable
test:neon:app-readiness                test:neon:bypass-control
test:neon-migration-reconciliation     test:reprise-migrations
test:application-une-par-une           test:rejeu-migrations
test:sondes-effets                     test:etat-production-correction
test:deploiement-simule                test:sql-errors
test:chantiers                         test:divergences-migrations
test:reconciliation-options            test:active-tenant:routes  (147 contrôles)
test:brand-console                     test:private-storage
test:workflow-policy                   test:db-routing
```

Attribution — la base PR #111 **sans** mes migrations échoue sur `rls` (5 tables en erreur de
politique), `write-policies` (1/8), `cross-tenant` (`permission denied for table users`),
`active-tenant` (`tracefab_private_bucket_required`) et `security`. La chaîne corrigée est donc
strictement meilleure que sa base, ce qui est l'exigence.

Non exécutables dans cet environnement (indépendant des changements) :

- 21 suites navigateur : binaire Chromium indisponible (`browserType.launch`), la CI les exécute
  avec ses propres navigateurs ;
- suites Prisma (`test:neon:security`, `test:neon:dpp-provenance`, produit/fournisseur/qualité/
  collecte) : `prisma generate --no-engine`, binaires Prisma indisponibles ; même échec sur la
  base PR #111 seule.

---

## 6. Ce qui exige une autorisation humaine

1. **Application en Préproduction puis Production.** Aucune migration de cette branche n'a été
   appliquée à une base distante. L'ordre est : PR #110, PR #111, puis ces quatre migrations.
   Avant toute application : réconciliation en lecture seule de `_prisma_migrations`, puis
   `npx prisma migrate status`, puis `npx prisma migrate deploy` **sans** `resolve`.
2. **Bascule du runtime** vers `tracefab_app` (en Production le runtime se connecte aujourd'hui
   avec une identité porteuse de `BYPASSRLS` : les politiques ne sont pas évaluées). Mes mesures
   ne valent que sous un rôle sans `BYPASSRLS`.
3. **Mode strict d'identité** (`tracefab_identity_politique.strict`) : la vérification du jeton
   n'est appliquée qu'aux jetons **présents** tant que `strict = false`. La bascule exige d'avoir
   constaté `identityTokens.configured = true` sur le déploiement réel.
4. **Parcours de bout en bout sur branche Neon isolée** : non réalisé ici (aucun accès Neon dans
   cette session). C'est la vérification qui manque pour transformer « testé en base réelle » en
   « testé en environnement réel ».

---

## 7. Ce qui a failli être livré faux — et pourquoi c'est documenté

- **Une postcondition décrivant l'environnement** (« le runtime n'a pas `SELECT` sur `users` »,
  puis « sur `orders` ») faisait échouer la chaîne là où le privilège est légitimement accordé.
  Les deux ont été retirées. `orders` a même été classée à tort « fermée par l'ACL » dans
  `scripts/lib/tracefab_app_role.mjs` : sur une base amorcée par `db:seed-rls`, le runtime reçoit
  un `SELECT` filtré par RLS sur `orders`, et `test_rls_isolation` a immédiatement protesté. La
  classification a été annulée, avec le raisonnement écrit dans le fichier.
- **Des fixtures laissées en base** faisaient échouer `test:neon:worker-non-forgeable`, qui mesure
  « aucune autre organisation visible ». Le ménage du test de périmètre est désormais explicite et
  **vérifié** ; la suite voisine repasse au vert sur la même base.
- **Une assertion de contrat statique** ne reconnaissait qu'une seule des deux formes légitimes
  d'armement du locataire. Elle a été généralisée par un module partagé
  (`scripts/lib/tenant-arming.mjs`) au lieu d'être assouplie sur place : la propriété vérifiée est
  identique, et elle est appliquée à davantage de routes.
