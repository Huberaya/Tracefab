# État des lieux des 13 PR encore ouvertes

**Date :** 2026-11-22
**`main` mesuré :** `6ef90c6` (1241 commits)
**Contexte :** suite de `2026-11-21-analyse-15-pr-ouvertes.md`. `main` a avancé (`3ebd98f` → `6ef90c6` : #136, puis #119, #118 et #137). Tout a été **remesuré**, aucun verdict recopié.

**Méthode :** `git merge-tree --write-tree origin/main <tête>` pour les conflits réels ; retard = `rev-list --count <tête>..main` ; CI lue **au SHA de tête** via `commits/<sha>/check-runs` ; tests non branchés vérifiés dans l'arbre **de la PR** (pas celui de `main`).

---

## 1. Réponse directe

**Aucune des 13 PR n'est fusionnable en l'état.** Deux sont proches (#108, #80), le reste demande une décision.

| Catégorie | PR | Nombre |
|---|---|---|
| Prêtes à fusionner | — | **0** |
| Proches, 1 décision à prendre | #108, #80 | 2 |
| À ne pas fusionner : contredisent `main` | #122, #123, #124, #125 | 4 |
| À fermer : couvertes par `main` | #70 | 1 |
| À fermer ou reprendre : périmées | #82 | 1 |
| Chaîne d'itérations, à trier | #91, #92, #93, #94 | 4 |
| Bloquée | #101 | 1 |

**Trois verdicts de mon rapport du 21/11 étaient faux.** Ils sont corrigés en §3. Les causes : j'avais lu le diff *depuis la base de la PR* au lieu de le confronter à `main` actuel, et j'avais comparé les tests non branchés aux workflows de `main` au lieu de ceux de la PR.

---

## 2. Tableau mesuré

`retard` = commits de `main` absent de la PR.

| PR | État | Fichiers | Retard | Conflits | CI (SHA de tête) |
|---|---|---|---|---|---|
| **#108** | draft | 1 | **468** | **0** | **VERT 4/4** |
| **#80** | prête | 3 | **548** | **1** | **VERT 8/8** |
| **#101** | prête | 72 | **521** | **16** | 1 en cours |
| **#94** | prête | 28 | 541 | 5 | **ROUGE** (3 jobs) |
| **#93** | draft | 21 | 541 | 3 | 1 en cours |
| **#92** | prête | 26 | 541 | 7 | VERT 5/5 |
| **#91** | prête | 15 | 541 | 2 | **ROUGE** (1 job) |
| **#82** | prête | 7 | 548 | **5** | VERT 9/9 |
| **#70** | draft | 7 | **619** | 5 | **ROUGE** (3 jobs) |
| **#122** | draft | 1 | 110 | **0** | **ROUGE** Socle |
| **#123** | draft | 5 | 110 | 2 | **ROUGE** Base |
| **#124** | draft | 5 | 110 | 2 | **ROUGE** Base |
| **#125** | draft | 5 | 110 | 2 | **ROUGE** Base |

Une CI verte ne dit pas « fusionnable » : elle dit « la branche est cohérente avec elle-même ». #82 est verte 9/9 et a 5 conflits. #108 est verte 4/4 et a 468 commits de retard.

---

## 3. Trois corrections à mon rapport précédent

### #70 — je disais « fermer pour contenu divergent ». C'était faux.

J'avais écrit que #70 « réintroduit `20261021120000_limit_app_function_execute` au contenu **différent** ». **C'est un artefact de mesure.** Ce fichier n'existait pas dans la base de #70 (`md5` de la base = celui de la chaîne vide) : `main` l'a créé **après** le fork. La « modification » venait de là, pas de #70.

Ce qui reste vrai, et suffit : #70 apporte `20261021110000_revoke_app_migration_table_dml`, qui fait un `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER` sur `_prisma_migrations`. `main` fait déjà **plus fort** dans `20261021130000_reconcile_runtime_dml_and_migration_history` : `REVOKE ALL PRIVILEGES` **suivi d'une vérification** `has_table_privilege` qui lève une exception si un privilège subsiste.

**#70 est un sous-ensemble strictement plus faible de `main`.** Verdict inchangé (fermer), **raison corrigée**.

### #80 — je disais « 1 conflit sur un fichier de sécurité ». Incomplet.

Le conflit porte sur `docs/security/workflow-privileged-allowlist.json`, mais je n'avais pas dit que #80 **ajoute une entrée documentée et justifiée** pour son workflow `clerk-tenant-journeys.yml` : `secret: CLERK_SECRET_KEY`, `portee: workflow_dispatch seulement, refs/heads/main seulement, environnement avec relecteur obligatoire`, clé `sk_test_` exclusivement, base PostgreSQL éphémère sur le runner. C'est le pattern que ce fichier existe pour documenter.

Ce n'est donc pas un conflit de fond, c'est **un conflit de voisinage** dans un fichier que `main` a aussi modifié. Fusionnable à la main, avec revue de la ligne `//updated`.

### #82 — mes deux arguments étaient faux.

J'avais dit « couvert par `20261019120000` + `20261023120000` » et « 5 conflits ».

- Sa migration **n'existe pas dans `main`** (`20261022120000_minimize_app_table_dml`). Elle retire **tous** les `INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER` de `tracefab_app` sur **toutes** les tables de `public`, puis réaccorde une matrice explicite table par table. C'est une forme *plus stricte* : une table ajoutée plus tard est **fermée par défaut**. `main` n'a pas cet effet de liste blanche.
- Ses 5 conflits ne sont pas dans les migrations, mais dans `CHANTIERS-RESTANTS.md` et quatre scripts de rôle/tests (`tracefab_app_role.mjs`, `lire-disponibilite-role-app.mjs`, `test_isolation_lignes_reelles.mjs`, `test_tables_ecriture_directe.mjs`) — c'est-à-dire précisément ce que #136 a réécrit.

**#82 n'est donc pas « à fermer » : c'est un chantier à reprendre.** La migration est la partie intéressante ; les 5 conflits sont du recalage sur #136. C'est la PR la plus récupérable des six « à fermer ».

---

## 4. #122 → #123 → #124 → #125 : une chaîne, pas quatre PR

Les quatre sont des **itérations successives sur le même sujet** (préparer les identités de migration CI), chacune empilée sur la précédente. #122 est la base, #125 la plus aboutie.

**Le point de rupture, vérifié :** #125 écrit `CREATE ROLE admin ... CREATEROLE BYPASSRLS` **et** `CREATE ROLE migrator ... CREATEROLE BYPASSRLS`, puis contrôle `!r.rolbypassrls` pour **les deux** rôles.

`main` fait l'inverse, délibérément :

```
admin    : CREATEROLE NOCREATEDB NOBYPASSRLS NOSUPERUSER NOINHERIT
migrator : CREATEROLE NOCREATEDB BYPASSRLS   NOSUPERUSER INHERIT
contrôle : adminAttrs.rolbypassrls  -> rejet
           !migratorAttrs.rolbypassrls -> rejet
```

Donner `BYPASSRLS` à l'administrateur annule l'isolation RLS que #122–#125 prétendent sécuriser. **Ne pas fusionner.** Les quatre sont aussi **rouges** (Socle pour #122, Base pour #123/#124/#125).

**Ce qui mérite d'être récupéré :** #125 apporte deux choses que `main` n'a pas — un script npm `db:prepare-ci-migration-roles` (absent de `main`, dont l'étape CI appelle `node scripts/...` en dur, l. 757) et un test de routage vers la base jetable. Mais elle réintroduit aussi `ALTER SCHEMA public OWNER`, que `main` fait déjà l. 161. Ce serait à reprendre à la main, pas à fusionner.

---

## 5. #91 → #94 : un chantier, quatre états

Même merge-base (`b1ae726f`, désormais 541 commits de retard), même sujet (preuve P1 staging sur Preview). Ordre d'aboutissement réel mesuré par la CI au SHA de tête :

| PR | CI | Lecture |
|---|---|---|
| #92 | VERT 5/5 | la seule verte de la série |
| #93 | en cours | draft |
| #94 | ROUGE 3 jobs | la plus **aboutie en contenu** (28 fichiers), mais ses 3 preuves échouent |
| #91 | ROUGE 1 job | 15 fichiers |

Ces quatre PR **ajoutent toutes leurs propres workflows** (`p1-staging-authenticated.yml`, `p1-staging-bypass-proof.yml`, …), donc mon test « est-ce branché ? » était mal posé au départ : je l'ai refait sur l'arbre de chaque PR. Résultat : **`test_p1_staging_harness.mjs` et `test_preview_deployment_selection.mjs` ne sont référencés dans aucun workflow** de #91, #92, #93 ni #94. C'est le même défaut qu'on vient de corriger sur #119 et #118, répété deux fois.

**Recommandation :** choisir **une** base (#94 pour le contenu, #92 pour l'état CI), y rebrancher les deux harnais, fermer les trois autres. Ne pas fusionner en l'état.

---

## 6. #101 — la seule vraiment bloquée

72 fichiers, **16 conflits**, 521 commits de retard, CI non concluante. C'est la PR la plus grosse et la plus ancienne. Elle n'est pas récupérable par un simple recalage : la découper en lots thématiques serait le seul chemin raisonnable. Ses six scripts de test ajoutés ne sont pas branchés non plus (dont `local_test_services.mjs` et `clerk`-adjacents).

---

## 7. #108 — 0 conflit, CI verte, mais ce n'est pas un simple document

**1 fichier** (`docs/security/2026-11-03-p107-preuve-runtime-production.md`, 76 lignes), **0 conflit**, **CI verte 4/4**, 468 commits de retard. En draft. Je l'ai lu intégralement.

**Ce n'est pas de la documentation inerte : c'est une preuve d'audit d'une mesure réellement exécutée en Production** le 2026-11-03T15:25:01Z, sur le déploiement `dpl_DhWFDPARLyHcppioNkjywHeu4zcm` (commit `e0653b9`), via un Vercel Cron authentifié par `CRON_SECRET`.

**Contrôle de fuite :** 0 occurrence de motif sensible (`postgresql://`, `sk_live`, `npg_`, `PASSWORD`, `@ep-`, `neon.tech`). Le document affirme qu'aucun secret ni URL de connexion n'a été journalisé ; les champs présents sont des attributs de rôle, des noms de base et le verdict. C'est cohérent.

**Contenu mesuré :** `current_user` et `session_user` = `tracefab_app` ; `superuser`, `bypassRls`, `createRole`, `createDb` tous `false` ; aucune appartenance transitive ; `canEscalateToPrivilegedRole: false` ; contexte de session visible dans sa transaction puis absent ; `SQLSTATE 25006` en transaction `READ ONLY` ; verdict `IDENTITE_CONFORME`.

**Le document est honnête sur ses propres limites**, et c'est ce qui le rend utilisable : il précise que le témoin `25006` ne prouve pas l'absence de DML ordinaire, qu'il ne distingue pas connexion directe et pooler en mode session (`session_or_direct`), que `TRACEFAB_IDENTITY_KEY` est **absente** donc la signature HMAC **n'est pas prouvée**, et que cette preuve **ne vaut pas GO** pour l'activation `strict`, les migrations 68/69 ni la chaîne HMAC.

**Décision : la seule des 13 qui est techniquement fusionnable aujourd'hui.** Le fait qu'elle consigne une mesure de Production n'est pas un obstacle : la mesure a déjà eu lieu (3 novembre), le document ne fait que la rapporter, et la règle « ne rien modifier en production » a été respectée — le document atteste lui-même qu'aucune donnée, migration, variable ou secret n'a été touché, et que le déploiement a été restauré depuis `main`.

**Une réserve avant de sortir du draft**, qui est une décision de politique et non de technique : fusionner revient à **acter par écrit dans `main`** qu'une mesure de Production a été exécutée hors du périmètre habituel. C'est à vous de le valider, pas à moi.

---

## 8. Ce que je recommande, dans l'ordre

1. **#108** — lu intégralement, 0 motif sensible. Sortir du draft et fusionner, sous réserve de votre accord sur le principe (§7) : le document acte qu'une mesure de Production a été exécutée.
2. **#80** — résoudre le conflit d'allowlist à la main (une entrée à réinsérer, pas un arbitrage de fond), fusionner après CI.
3. **#82** — reprendre : extraire la migration `20261022120000_minimize_app_table_dml` (elle vaut le coup : liste blanche, fermée par défaut), la rejouer sur `main` actuel, abandonner les 5 conflits de scripts périmés par #136.
4. **#91→#94** — choisir #94 comme base, rebrancher les 2 harnais manquants, fermer #91/#92/#93.
5. **#122→#125** — fermer les quatre. Le contrat `main` est correct et l'inverse de leur proposition.
6. **#70** — fermer (sous-ensemble plus faible de `main`).
7. **#101** — découper, ne pas tenter de recaler.

**Aucune fermeture n'a été exécutée.** Elle demande un accord explicite, PR par PR.

---

## 9. Ce qui n'a pas été vérifié

- **#108 : lue intégralement**, y compris le contrôle de fuite. Ce qui reste non vérifié est **hors de portée** : je ne peux pas confirmer que la mesure de Production du 3 novembre a bien eu lieu telle que décrite, ni que le déploiement `dpl_DhWFDPARLyHcppioNkjywHeu4zcm` correspond à ce qui est dit. Je n'ai vérifié que la cohérence interne et l'absence de secret.
- **#101, #91–#94 : je n'ai pas exécuté leurs tests.** Ce sont des preuves staging/Preview qui exigent des secrets et un déploiement ; je n'ai lu que la CI et les workflows.
- **#82 : la migration n'a pas été rejouée** sur une base jetable. L'analyse porte sur son SQL, pas sur son exécution.
- Le clone Git de cet environnement **redevient superficiel tout seul** (`rev-list --count` retombé à 1) : toute vérification d'ascendance doit être précédée d'un `git fetch --unshallow`, sinon `merge-base --is-ancestor` renvoie de faux négatifs.
