# Réconciliation de la PR #105 sur `main` réécrit — 2 novembre 2026

**Objet.** La PR #105 était `CONFLICTING` non par désaccord de contenu, mais parce que
`main` a été **réécrite** : `git merge-base main <branche>` rend une liste vide, il n'existe
plus d'ancêtre commun. GitHub ne peut donc pas calculer de fusion à trois points et refuse la
comparaison.

**Ce document ne remplace pas le rapport P10.5** (`p10.5-rapport.md`) : il consigne la
réconciliation mécanique, fichier par fichier, et les deux points de contrat qui restent soumis
à arbitrage.

## 1. État mesuré avant travaux

| Élément | Valeur |
|---|---|
| `main` (réécrite) | `f6d39aa027e4cdea1a2e7a381fe432310cc77fdc` — 1 seul commit |
| Branche P10.5 | `862c52f52f66e6dd20de8dec05650135d56d811d` |
| `git merge-base` | **vide** — aucune base commune |
| Diff `main` → branche | 40 fichiers, +4518 / −148 |
| Fichiers de `main` absents de la branche | **aucun** |
| Fichiers de la branche absents de `main` | 18 |

Conséquence : une fusion `--allow-unrelated-histories` produit **22 conflits `add/add`**,
y compris sur des fichiers où une seule ligne diffère, parce que Git n'a aucune base.

## 2. Méthode

1. `git merge origin/main --allow-unrelated-histories --no-commit`.
2. Pour chaque fichier en conflit, une **vraie** fusion à trois points est refaite avec
   `git merge-file`, en prenant comme base `5ed2745` — l'ancêtre réel des deux côtés
   (dernier commit de `main` avant sa réécriture, présent dans le dépôt).
3. 15 fichiers se réconcilient ainsi **sans conflit résiduel** ; 7 demandent une décision
   explicite. Aucun fichier n'est choisi « en bloc ».
4. Contrôles après fusion : `node --check` sur chaque `.mjs` modifié, `tsc --noEmit` sur `api/`,
   puis exécution des suites sur une base jetable.

Deux défauts silencieux ont été trouvés **par ces contrôles**, pas par relecture :

- `scripts/test_destructive_suite_routing.mjs` : la fusion avait **dupliqué** le bloc
  `SELF_GUARDED_DB_TOOLS` (les deux côtés l'ajoutaient, à deux endroits différents).
  `node --check` a échoué sur déclaration en double ; le doublon a été supprimé.
- `scripts/lib/tracefab_app_role.mjs` : la première résolution avait **perdu le bloc
  `ALTER ROLE … PASSWORD`** du chemin « rôle préexistant conforme ». Détecté par
  `test_ensure_app_role_garde` (30/30 après correction, 29/30 avant) — c'est exactement le
  rôle de cette suite.

## 3. Résolution, fichier par fichier

| Fichier | Résolution | Justification |
|---|---|---|
| `api/_lib/context.ts`, `api/_routes/internal/p2-readiness.ts`, `docs/operations/variables-environnement.md`, `package.json`, `scripts/lib/tracefab_runtime_functions.mjs`, `scripts/lire-disponibilite-role-app.mjs`, `scripts/test_deploiement_simule.mjs`, `scripts/test_destructive_suite_routing.mjs`, `scripts/test_etat_production_correction.mjs`, `scripts/test_etendue_champs_reserves_sql.mjs`, `scripts/test_p2_readiness.ts`, `scripts/test_privileges_role_app.mjs`, `scripts/test_reconciliation_options.mjs`, `scripts/test_registre_fonctions_runtime.mjs`, `scripts/test_rls_isolation.mjs` | fusion à trois points, aucun conflit résiduel | les deux côtés sont conservés |
| `.github/workflows/ci.yml` | côté P10.5 sur les 4 hunks | ajoute les 5 étapes P10.5 et remplace `set -e` par un accumulateur qui **nomme** la suite en échec (`::error::`) ; `main` n'apporte rien dans ces hunks |
| `scripts/migrer_fidelement.mjs` | côté P10.5 sur les 5 hunks | élévation bornée, rattrapage `dejaSuperuser`, `MIGRATIONS_ASSISTEES` : absents de `main` |
| `docs/experience/CHANTIERS-RESTANTS.md` | côté P10.5 | 68 migrations + paragraphe de la 68<sup>e</sup> |
| `scripts/prepare_ci_db_role.mjs` | côté `main` sur les 3 hunks | garde B4 (`verifierAucuneAppartenance`) **et** `ALTER ROLE` sans `NOSUPERUSER`/`NOBYPASSRLS` : mêmes garanties (refus préalable + assertion post-ALTER) avec **moins** de privilège exigé de l'exécutant |
| `scripts/test_verrou_cluster.mjs` | côté P10.5 | sur-ensemble : déclare les 4 scripts P10.5 dans la section critique |
| `scripts/lib/tracefab_app_role.mjs` | **fusion explicite** (voir §4) | garder B4 de `main` **et** B3 de la branche |
| `scripts/test_provisioning_role_app.mjs` | **fusion explicite** (voir §5) | restaurer les scénarios B3/B4 de `main`, en adaptant B3 au contrat durci |

## 4. `ensureAppRole` — ce qui est retenu

Les deux côtés avaient raison sur un point différent ; la fusion garde **les deux contrôles**,
ce qui est strictement plus fort que chacun pris seul.

1. **B4 de `main`, conservée** : `verifierAucuneAppartenance()` (CTE récursive sur
   `pg_auth_members`, grantors multiples inclus) est appelée **avant toute écriture** dès que
   le rôle existe. Une appartenance directe ou transitive rend `SET ROLE` possible : elle est
   refusée, message `B4 REFUSE`.
2. **B3 de la branche, conservée** : plus aucun `ALTER ROLE` d'attribut quand le rôle est déjà
   conforme. PostgreSQL 16+ réserve le changement de l'attribut `SUPERUSER` aux
   superutilisateurs ; l'ancien `ALTER ROLE … NOSUPERUSER` faisait donc dépendre le démarrage
   d'un privilège d'administration. Un rôle divergent est **refusé**, pas rabattu en silence.
3. Le mot de passe reste posé sur un rôle préexistant conforme (meilleur effort, échec non
   fatal, motif journalisé) : c'est le comportement de la branche, couvert par
   `test_privileges_role_app` (42/42).
4. `provoquerRole` devient `creerRole` : sur `42710` (rôle créé par un autre processus entre la
   lecture et le `CREATE`), le code **ne bascule plus sur un `ALTER ROLE` aveugle** — il relit
   l'état réel et applique la même règle fail-closed. L'ancien enchaînement
   `CREATE`/`ALTER` pouvait réécrire le mot de passe d'un rôle qu'il n'avait pas créé.
5. La garde de conservation de `main` (SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB, propriétaire
   d'objets) et l'assertion de `LOGIN manquant` sont réunies dans `exigerConformite()`.

## 5. `test_provisioning_role_app.mjs` — aucun test supprimé

`main` avait ajouté 60 lignes de scénarios B3/B4 ; la branche les supprimait. Ils sont
**restaurés**. Le scénario B3 est réécrit, ce qui est un **durcissement**, pas un
affaiblissement :

- ancienne version : la cible est créée `NOLOGIN`, et l'on attend que le provisionneur
  `CREATEROLE` la rabatte par `ALTER ROLE … LOGIN` ;
- version réconciliée : la cible est créée **déjà conforme** (c'est l'état réel de la
  production) et le provisionnement doit réussir **sans aucun `ALTER` d'attribut** ; une
  **nouvelle assertion négative** vérifie qu'une cible sans `LOGIN` est **refusée** et reste
  sans `LOGIN` (aucun auto-octroi).

## 6. Résultats mesurés sur base jetable (PostgreSQL 17.11, cluster local `127.0.0.1:55436`)

68/68 migrations appliquées par `scripts/migrer_fidelement.mjs` sur base vierge, après
provisionnement du rôle par `db:prepare-ci-role`.

| Suite | Résultat |
|---|---|
| `test_provisioning_role_app` (B3/B4 restaurés + 2 assertions négatives) | **25/25** |
| `test_ensure_app_role_garde` | **30/30** |
| `test_privileges_role_app` | **42/42** |
| `test_verrou_cluster` | **32/32** |
| `test_verrou_fail_closed` / `test_concurrence_suites` | 29/29 · 9/9 |
| `test_ressources_fixes_garde` / `test_destruction_verrouillee` / `test_reprise_ressources_jetables` | 40/40 · 30/30 · 38/38 |
| `test_garde_cible_ecriture` | **80/80** (68/80 avant génération du client Prisma — cause environnementale, pas régression) |
| `test_p105:roles-et-migrations` / `hmac` / `jeton` / `ingestion` | 19 · 21 · 19 · 10 assertions |
| `verifier_hierarchie_roles` | 19 assertions (fichier inchangé par la fusion) |
| `test_destructive_suite_routing`, `test_rls_isolation`, `test_registre_fonctions_runtime`, `test_reconciliation_options`, `test_deploiement_simule`, `test_etat_production_correction`, `test_etendue_champs_reserves_sql`, `test_rls_write_policies`, `test_rls_bypass_controle_negatif`, `test_ingest_payload_acl`, `test_tables_ecriture_directe` | toutes vertes |
| `test:workflow-policy`, `test:workflow-policy-temoins`, `test:db-guard`, `test:db-routing`, `test:scripts-migration-obsoletes`, `test:routes`, `test:assets` | verts |
| `tsc --noEmit` racine + `api:typecheck` | propres |

## 7. Défaut corrigé dans `migrer_fidelement.mjs` (trouvé par cette recette)

Quand l'exécutant est **déjà** superutilisateur (`dejaSuperuser`, compte d'administration du
cluster), `clientAdmin` vaut `NULL`. Le rattrapage `apres` de la migration assistée
`20261028120100` appelait malgré tout `clientAdmin.query(...)` : la chaîne s'arrêtait en
« Cannot read properties of null (reading 'query') » **après le COMMIT** de la migration, donc
sur un état mi-rattrapé. Le repli `clientAdmin ?? client` exécute le `GRANT` sur la connexion de
migration, qui porte alors elle-même le privilège. Aucune migration historique n'est modifiée.

## 8. Points soumis à arbitrage (non tranchés unilatéralement)

1. **Contrat de `ensureAppRole` sur un rôle préexistant divergent** : refus fail-closed
   (§4.2) plutôt que rabattement par `ALTER ROLE`. Conséquence opérationnelle : un
   `tracefab_app` provisionné à la main avec `LOGIN` manquant ne sera **pas** corrigé par le
   démarrage — il faut un administrateur.
2. **Scénario B3** : réécrit pour affirmer le nouveau contrat (§5) au lieu de l'ancien.

Ces deux points sont réversibles en un commit et n'affaiblissent aucun contrôle : le premier
retire une écriture, le second ajoute une assertion négative.

## 9. Non vérifié

- Aucun passage de CI n'a pu être observé depuis la session (`actions:write` absent, logs de job
  non téléchargeables). Le verdict CI doit être lu sur la PR.
- Rien n'a été appliqué en production : ni migration, ni rôle, ni secret, ni rétention PITR.
