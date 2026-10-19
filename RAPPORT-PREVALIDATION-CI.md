# TRACEFAB — Rapport de prévalidation avant exécution CI distante

**Branche** `arena/ba652133-tracefab` · **HEAD** `29329b39d90370dccd87dae59f3238228117e8ea`
**Aucun push effectué dans le cadre de cette mission.**

Ce rapport ne déclare aucune CI verte. Il établit ce qui est vérifiable d'ici,
ce qui ne l'est pas, et ce qu'il faut exécuter pour le savoir.

---

## 1. Graphe des commits

Vérifié par `git cat-file -p` sur chaque commit, pas par lecture du rendu :

```
29329b3  (HEAD -> arena/ba652133-tracefab)  parents=[189ae4b]
189ae4b                                     parents=[b908de8]
b908de8                                     parents=[852076c]
852076c                                     parents=[bb1213c]
bb1213c  (origin/arena/ba652133-tracefab)   <- pointe distante
   ...
31ce446  (main)                             <- ancetre de HEAD
```

| propriété | mesuré |
|---|---|
| les 4 commits existent | `git cat-file -t` → `commit` pour les quatre |
| nombre de parents | **1 chacun** — aucune fusion |
| chaîne linéaire | `29329b3 → 189ae4b → b908de8 → 852076c → bb1213c`, vérifiée maillon par maillon |
| `main` ancêtre de HEAD | **oui** (`git merge-base --is-ancestor`) — pas de divergence |
| commits entre `main` et la pointe distante | **566** (`git rev-list --count`) |
| worktree, fichiers suivis | **propre** |

Le clone est **shallow** : `.git/shallow` contient `31ce446`, qui est précisément
`main`. Les comparaisons avec `main` sont donc valides, mais l'historique
antérieur à `31ce446` n'est pas consultable localement.

---

## 2. Diff cumulé

### 2.1 `main..HEAD` — périmètre complet de la branche

**60 fichiers, +8 367 / −144.**

| catégorie | fichiers |
|---|---|
| Migrations SQL | 5 (toutes en ajout) |
| Code applicatif `api/` | 9 |
| Routes internes | 1 (`api/_routes/internal/p2-readiness.ts`) |
| CI / workflows | 2 |
| Scripts de test et outillage | 35 |
| Documentation | 4 |
| Configuration dépôt | 2 (`.gitignore`, `package.json`) |
| Autres (`assets/js/dpp.*`, `dpp/index.html`) | 3 |

Les 5 migrations ajoutées :

```
20261017100000_fix_document_lifecycle_access
20261017120000_harden_dpp_table_privileges
20261017150000_harden_finalize_ops_gate
20261019120000_restreindre_dml_role_applicatif
20261019140000_restreindre_suppression_compteurs_debit
```

### 2.2 `bb1213c..HEAD` — ce que les 4 commits non poussés apportent

**29 fichiers, +4 310 / −25.** Les deux migrations de sécurité, la sonde
d'identité, la route interne, 11 scripts de test, l'entrée CI et le rapport.

---

## 3. Contrôles exécutés

### 3.1 Contenu des commits — aucun secret, aucun fichier temporaire

| contrôle | résultat |
|---|---|
| fichiers `.tmp`, `.bak`, `.log`, `.cluster-*`, `neon-etape*` commités | **aucun** |
| motifs de secret (`PRIVATE KEY`, URL avec mot de passe, `TF_VERCEL_BYPASS` valeur) | **aucun** |
| `.gitignore` ajouté capturant un fichier suivi | **0** pour `.cluster-*`, `*.tmp.mjs`, `*.tmp.sql` |

Deux points examinés et classés sans risque :

- **`TF_VERCEL_BYPASS`** n'apparaît que comme **nom de variable** lue depuis
  `process.env`, plus une chaîne d'aide. La valeur
  `valeur-tres-secrete-12345` est un jeu d'essai synthétique de
  `test_sonde_preview_hors_ligne.mjs`, dont les assertions vérifient justement
  que cette valeur **ne fuit pas** dans la sortie.
- **`sondage-preview.yml`** contient une URL de Preview réelle. Ce fichier est
  **préexistant sur la branche distante** (ajouté par `10e0c23`), il n'est pas
  introduit par les 4 commits. Signalé comme risque résiduel, pas comme
  régression de ce travail.

### 3.2 Câblage CI — vérifié contre le workflow réel, pas recopié

Le filtre d'auto-collecte a été extrait de `ci.yml` par appariement de
parenthèses puis exécuté tel quel :

```js
k=>k.startsWith('test:')&&!k.includes('neon')&&!k.includes('staging')
  &&k!=='test:p2'&&k!=='test:regression'&&k!=='test:audit-script'
```

**100 entrées auto-collectées** sur 131 `test:*`.

| entrée npm | exécution en CI |
|---|---|
| `test:neon:compteurs-debit` | étape explicite (25) |
| `test:neon:sonde-identite` | étape explicite (26) |
| `test:neon:isolation-lignes` | étape explicite (24) |
| `test:neon:privileges-role-app` | étape explicite (23) |
| `test:objets-sql:comparaison` | auto-collectée |
| `test:migrations:controle` | auto-collectée |
| `test:migrations:horodatages` | auto-collectée |
| `test:tls:validation` | auto-collectée |

**Aucune entrée non exécutée. Aucune exécutée deux fois.** Le job
`base-de-donnees` compte **27 étapes**.

Une première tentative d'extraction par expression régulière avait produit
« 159 entrées » et marqué les `test:neon:*` comme auto-collectées — résultat
faux, corrigé. Le filtre littéral utilise `k!=='test:regression'` (égalité
stricte), et non `!k.includes('regression')`.

### 3.3 Jobs et checks requis

Les 4 checks requis du ruleset `protection-main` (id `25012843`, actif,
cible `refs/heads/main`) correspondent chacun à un job réel :

| context requis | job |
|---|---|
| `Socle — types, compilation, isolation` | `socle` |
| `Verification — suite de tests` | `verification` |
| `Parcours — navigateur reel` | `parcours` |
| `Base — isolation RLS executee` | `base-de-donnees` |

Aucun context orphelin.

### 3.4 Suites exécutées localement, sur PostgreSQL 18.4 jetable

| suite | sortie | assertions |
|---|---|---|
| `test:neon:compteurs-debit` | 0 | 39/39 |
| `test:neon:sonde-identite` | 0 | 30/30 |
| `test:neon:isolation-lignes` | 0 | 18/18 |
| `test:neon:privileges-role-app` | 0 | 16/16 |
| `test:objets-sql:comparaison` | 0 | 14/14 |
| `test:migrations:controle` | 0 | 8/8 |
| `test:migrations:horodatages` | 0 | 4 doublons préexistants, **0 nouveau** |
| `test:tls:validation` | 0 | — |

Contrôles négatifs : RLS retirée de `documents` → **sortie 1** ; migration
`20261019140000` retirée → **sortie 1**. Restauration vérifiée par empreinte
SHA-256 `1120041bd9f6aa69…`, identique avant et après.

### 3.5 Les 100 entrées auto-collectées face à l'absence de base

Les jobs `socle` et `verification` ne déclarent **ni service ni variable
d'environnement**. Dix entrées auto-collectées référencent une base. Exécutées
**sans `DATABASE_URL`**, comme en CI :

| entrée | sortie |
|---|---|
| `test:dossier`, `test:db-guard`, `test:db-throwaway`, `test:db-guard-driver`, `test:db-routing`, `test:workflow-policy`, `test:prisma-client`, `test:workflow-policy-temoins`, `test:ci-no-production-access` | **0** — 9/9 |
| `test:pilot` | **1** — voir risque R1 |

---

## 4. Risques identifiés

### R1 — `test:pilot` échoue localement, mais pas pour une raison de branche

`test:pilot` (`npx tsx scripts/seed_pilot.ts --dry-run`) tombe sur
`SyntaxError: The requested module '@prisma/client' does not provide an export
named 'PrismaClient'`. Vérifié : **`scripts/seed_pilot.ts` est identique à
`main`** (`git diff 31ce446 HEAD -- scripts/seed_pilot.ts` → vide) et l'entrée
existe déjà sur `main` avec la même commande. En CI, `db:generate` précède, donc
le client est généré. **Risque faible**, mais non prouvé sans exécution réelle.

### R2 — build et typage non validés, blocage réseau

`prisma generate`, `prisma validate` et `npm run build` échouent tous sur
`binaries.prisma.sh` (`HTTP 000`, `SSL_ERROR_SYSCALL`). Ce n'est ni le schéma ni
une dépendance : `prisma` 6.19.3 = `@prisma/client` 6.19.3 = lockfile v3, et le
registre npm répond. Localement : `api:typecheck` → 89 erreurs, `test:router-load`
→ 130/135, toutes de la même cause. **En CI cet hôte est joignable**, donc ces
deux checks devraient passer — mais c'est une attente, pas un résultat.

### R3 — `bootstrap_app_role.mjs` n'est pas une étape CI

Le rôle est préparé en CI par `db:prepare-ci-role` puis `db:seed-rls`.
`bootstrap_app_role.mjs` n'est invoqué par aucune étape. **Ce n'est pas un
défaut** : `test_privileges_role_app.mjs` crée sa propre base éphémère
(`CREATE DATABASE` L127, `DROP DATABASE` L306) et y rejoue l'ordre réel —
rôle avant migrations — parce que la migration `20261014130000` contient un bloc
`$preserve_runtime_acl$` dont le comportement dépend de cet ordre (36 tables en
écriture dans l'ordre réel, 4 dans l'ordre inverse). Les privilèges vus par les
autres suites ne sont pas modifiés.

**Conséquence à connaître** : la mesure locale décrit l'ordre de déploiement
réel ; l'étape CI `db:prepare-ci-role` suit un chemin différent. Les deux sont
légitimes, ils ne mesurent pas la même chose.

### R4 — quatre horodatages de migration dupliqués

`20261006120000`, `20261006200000`, `20261006220000`, `20261017120000`. Tous
préexistants et inscrits sur la liste d'exceptions ; `test:migrations:horodatages`
rend « duplications NOUVELLES : 0 ». **Risque de dette, pas de régression.**

### R5 — identité du runtime non mesurée

La sonde est prête et éprouvée (30/30), mais **elle n'a jamais été exécutée sur
un runtime réel**. Aucune conclusion sur la sécurité de Production ne peut être
tirée. Un check CI vert ne changera rien à ce point : il n'y a pas de runtime
en CI.

### R6 — objets SQL divergents non identifiés

Les deux politiques et la fonction supplémentaires restent sans nom, sans
propriétaire, sans définition. Aucune connexion autorisée à la cible.
`DATABASE_URL` et `TF_RLS_APP_URL` absentes de cet environnement.

---

## 5. Prérequis d'une exécution CI distante

1. **Autorisation explicite de pousser** sur `arena/ba652133-tracefab`
   (4 commits, `bb1213c..29329b3`). Aucun push sans elle.
2. Le runner doit joindre `binaries.prisma.sh` — condition des checks `socle`
   et `verification`.
3. Le service `postgres:17` du job `base-de-donnees` doit démarrer ; les
   variables du job sont déjà déclarées dans le workflow.
4. Aucune dépendance nouvelle à installer : les suites ajoutées n'utilisent que
   `node`, `pg` et le service PostgreSQL existant.

## 6. Commandes exactes

Pousser la branche, sans jamais toucher `main` :

```
git push origin arena/ba652133-tracefab
```

Suivre l'exécution :

```
gh run list --branch arena/ba652133-tracefab --limit 3
gh run watch <run-id>
gh run view <run-id> --log-failed
```

Vérifier les quatre checks requis sur le commit poussé :

```
gh api repos/Huberaya/Tracefab/commits/29329b39d90370dccd87dae59f3238228117e8ea/check-runs \
  --jq '.check_runs[] | [.name, .conclusion] | @tsv'
```

Les quatre attendus : `Socle — types, compilation, isolation`,
`Verification — suite de tests`, `Parcours — navigateur reel`,
`Base — isolation RLS executee`.

**Interdits dans ce cadre** : `--force`, toute commande visant `main`, toute
fusion, tout déploiement, toute modification de Vercel, de Preview, de
Production ou d'une base distante, tout affaiblissement d'une règle de
protection pour faire passer un check.

---

## 7. Recommandation

### PRÊT pour une exécution CI distante, sous réserve d'autorisation de push.

Ce qui le justifie, mesuré :

- graphe linéaire vérifié, aucune fusion, `main` ancêtre — un push est un
  simple ajout de 4 commits sur la branche de travail ;
- worktree propre, aucun fichier temporaire ni secret dans les commits ;
- les 8 entrées de test sont réellement exécutées par la CI, aucune en double,
  aucune oubliée ;
- les 4 checks requis correspondent à des jobs existants ;
- les suites ajoutées passent localement, et leurs contrôles négatifs rougissent
  pour la raison attendue ;
- les 9 entrées auto-collectées touchant une base passent sans `DATABASE_URL`.

Ce qui reste **non prouvé** et ne doit pas être annoncé vert avant exécution :

- `socle` (build, `api:typecheck` à 0 erreur, `test:router-load` 135/135) —
  dépend de `binaries.prisma.sh`, injoignable d'ici ;
- `verification` — dont `test:pilot`, préexistant et identique à `main` ;
- `parcours` — navigateur réel, non exécutable ici ;
- `base-de-donnees` — les suites passent localement, mais jamais sur le service
  `postgres:17` de GitHub.

### Toujours bloqué, indépendamment de la CI

| point | ce qu'il faut |
|---|---|
| identité effective du runtime Production | exécuter la sonde sur le runtime réel, via un accès autorisé |
| objets SQL divergents | connexion en lecture seule à la cible autorisée, procédure §7.10 du rapport principal |

**La sécurité de Production n'est pas validée.** Elle ne le sera pas par une CI
verte : la CI ne mesure pas l'identité du runtime. Ces deux points exigent un
accès autorisé et une décision explicite.
