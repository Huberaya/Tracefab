# Analyse des 15 PR ouvertes — prêtes pour la fusion ?

**Date :** 2026-11-21
**`main` analysé :** `3ebd98f9868b97ed1dd93ad9ac0f37bfe23c3973` (1238 commits)
**Méthode :** mesure par diff réel, `git merge-tree --write-tree`, CI lue **au SHA de tête** de chaque PR. Aucun titre de PR n'a été pris pour argent comptant.
**Issue (2026-11-22) :** ce document reste l'état de l'analyse. Les PR #119 et #118, alors « prête » et « prête sous réserve », ont depuis été **corrigées et fusionnées** — voir la section 10 en fin de document. Les 13 autres verdicts sont inchangés.

---

## 1. Réponse directe

**Sur 15 PR ouvertes, 2 sont fusionnables en l'état. 13 ne le sont pas.**

| Verdict | PR |
|---|---|
| **Prête** | **#108**, **#119** |
| **Prête sous réserve** | #118 (1 conflit `package.json` à résoudre) |
| **À ne pas fusionner** | #122, #123, #124, #125 (contredisent `main`) |
| **Obsolète — à fermer** | #70, #82 |
| **Doublon / chaîne d'itérations** | #91, #92, #93, #94 |
| **Bloquée** | #101, #80 |

---

## 2. Tableau de synthèse

| PR | Draft | CI au SHA de tête | Fusion | Apport réel | Verdict |
|---|---|---|---|---|---|
| **#108** | oui | **vert 4/4** | **propre** | Doc de preuve runtime Production (03/11) | **Prête** |
| **#119** | oui | **vert 4/4** | **propre** | Durcissement SSRF storage + antivirus | **Prête** |
| **#118** | oui | vert 4/4 | **1 conflit** `package.json` | Cache DPP : `stale-while-revalidate` sur passeport suspendu | Prête sous réserve |
| #70 | oui | **ROUGE** | 5 conflits | Réintroduit une migration **divergente** | **Fermer** |
| #82 | non | vert | 5 conflits | DML déjà couverte par `main` | **Fermer** |
| #122 | oui | **ROUGE** (Socle) | propre | Redondant avec `main` | **Ne pas fusionner** |
| #123 | oui | **ROUGE** (Base) | 2 conflits | idem | **Ne pas fusionner** |
| #124 | oui | **ROUGE** (Base) | 2 conflits | idem | **Ne pas fusionner** |
| #125 | oui | **ROUGE** (Base) | 2 conflits | idem + assertion inversée | **Ne pas fusionner** |
| #91 | non | vert | 2 conflits | Chantier P1-staging (itération 1) | Fermer, voir #94 |
| #92 | non | vert | 7 conflits | idem (itération 2) | Fermer, voir #94 |
| #93 | oui | vert | 3 conflits | idem (itération 3) | Fermer, voir #94 |
| #94 | non | vert | 5 conflits | idem (itération 4, la plus aboutie) | Reprise séparée |
| #101 | non | vert | **15 conflits** | Chantier documents/storage très divergent | **Bloquée** |
| #80 | non | vert | 1 conflit | Workflow Clerk + allowlist | **Bloquée** |

---

## 3. Les 2 PR réellement prêtes

### #108 — `ops/p107-runtime-proof-20261103`

**Ce qu'elle contient :** **un seul fichier**, `docs/security/2026-11-03-p107-preuve-runtime-production.md` (76 lignes). Absent de `main`.

**Ce que la doc prouve :** une mesure réelle du 03/11 sur la Production — rôle `tracefab_app`, `superuser: false`, `bypassRls: false`, aucune appartenance, `canEscalateToPrivilegedRole: false`, PostgreSQL 18.6.

**Risque de fusion : quasi nul.** Aucun fichier de code, aucun workflow, aucun test. Fusion propre, CI verte 4/4 au SHA de tête.

**Seule réserve :** la PR est en **brouillon** et `BEHIND` (3 commits de retard). Il faut la sortir du brouillon. Le retard n'a aucune importance ici : le document est daté et constitue une preuve historique — il ne doit **pas** être réécrit pour se mettre à jour.

**Une question de fond à trancher :** ce document atteste d'une mesure sur la **Production**. Sa fusion est une décision documentaire, pas technique. Elle ne modifie rien, mais elle inscrit dans `main` un état observé de la Production.

### #119 — `fix/private-storage-antivirus-transport-20261109`

**Ce qu'elle corrige :** `api/_lib/storage.ts`. Durcissement **SSRF** réel :

- credentials présents dans l'URL de l'endpoint → refus (`private_storage_endpoint_invalid`) ;
- HTTP autorisé **uniquement** en local hors production — auparavant une simple variable d'environnement permettait du HTTP en clair ;
- `redirect: 'error'` sur les requêtes signées — une redirection ne peut plus détourner une requête AWS signée ;
- `AbortSignal.timeout(5000)` — plus de blocage indéfini ;
- **pinning** de l'endpoint antivirus : l'URL est résolue **une seule fois** puis réutilisée, pour qu'un DNS rebinding ne puisse pas déplacer la cible entre la validation et l'appel.

**Préuve d'utilité mesurée :** j'ai exécuté son test `scripts/test_private_storage_runtime.mjs` **contre le code actuel de `main`** — il **échoue** (`ERR_ASSERTION`, `private_storage_https_required` non levé). Le défaut est donc réel dans `main` aujourd'hui.

Fusion propre, CI verte 4/4.

**Réserve importante :** son test (`test:private-storage`) **n'est branché dans aucun workflow CI** — ni dans sa branche, ni dans `main`. La correction serait donc livrée sans garde-fou automatique. Ce n'est pas bloquant pour fusionner, mais c'est à corriger juste après, sinon la régression reviendra sans être vue.

### #118 — `fix/public-dpp-cache-contract-20261109` (sous réserve)

**Ce qu'elle corrige :** `Cache-Control: public, max-age=60, stale-while-revalidate=300` → `public, max-age=60, must-revalidate`.

Le défaut est réel : `stale-while-revalidate=300` fait servir un passeport **suspendu** jusqu'à 5 minutes après la suspension. Contredit l'exigence de revalidation immédiate.

**Preuve mesurée :** son test exécuté contre `main` échoue sur **2 contrôles réels** (`cache public revalide apres 60 secondes`, `aucun stale-while-revalidate apres suspension`). Un 3ᵉ échec est un artifact du test (il attend `resolveDppPassData(tx, gtinOrRef)` alors que `main` passe un 3ᵉ argument).

**Pourquoi « sous réserve » :** **1 conflit** sur `package.json`. Résolution triviale, mais elle doit être faite et la CI relancée avant fusion.

---

## 4. Le piège #122–#125 — à ne surtout pas fusionner

Ces 4 PR sont **quatre itérations du même correctif** (+7 104 lignes chacune, 5 fichiers identiques). Leur objet : faire passer la chaîne de migrations en CI. **`main` l'a déjà résolu, et mieux**, via le commit `a24406d`.

Comparaison directe :

| | #125 (la plus aboutie) | `main` aujourd'hui |
|---|---|---|
| `pgcrypto` | `CREATE EXTENSION IF NOT EXISTS` par le script | installée par un bootstrap SUPERUSER jetable, puis **EXECUTE révoqué à PUBLIC** (vérifié) |
| admin CI | **BYPASSRLS** | **NOBYPASSRLS** |
| migrateur CI | BYPASSRLS | BYPASSRLS (inchangé, c'est le contrat) |
| assertion | `!r.rolbypassrls` → **exige** BYPASSRLS sur les deux | `adminAttrs.rolbypassrls` → **refuse** BYPASSRLS sur l'admin |
| CI au SHA de tête | **ROUGE** (`Base`) | **VERTE** |

**Le point décisif :** l'assertion de #125 est **l'inverse** de celle de `main`. Si on fusionnait #125, le script de préparation des identités CI **refuserait** l'état actuel de `main` et casserait le job `Base`.

Accorder BYPASSRLS à l'admin CI élargit en outre un privilège que `main` a délibérément restreint. **Ces 4 PR vont dans le sens inverse de la sécurité.**

**Recommandation : fermer les 4.** Rien n'y est à sauver.

---

## 5. #70 et #82 — obsolètes, et #70 est dangereuse

### #70 — `security/production-rls-identity-20261021`

- **CI rouge** au SHA de tête (`Base` en échec).
- Réintroduit `20261021120000_limit_app_function_execute`, **déjà dans `main`**, mais avec un **contenu différent** (`DIFFERENT`). C'est exactement le scénario de divergence de migration que la mission n°8 interdisait.
- Ajoute `20261021110000_revoke_app_migration_table_dml` à un horodatage **antérieur** à des migrations déjà appliquées — donc jamais rejouable dans l'ordre.
- Son objet est déjà couvert : `main` fait `REVOKE ALL PRIVILEGES ON TABLE public._prisma_migrations FROM tracefab_app`, **plus strict** que le `REVOKE INSERT, UPDATE, DELETE…` de #70.

**Verdict : fermer.** Fusionner introduirait une migration divergente sur un horodatage déjà consommé.

### #82 — `security/minimum-table-dml-20261022`

- CI verte, mais **5 conflits** sur des scripts cœur de sécurité (`tracefab_app_role.mjs`, `test_privileges_role_app.mjs`).
- Sa migration `20261022120000_minimize_app_table_dml` est **antérieure** à `main` (`20261023120000_revoke_app_default_dml`, `20261019120000_restreindre_dml_role_applicatif`) qui traitent le même sujet.
- **La PR est en état `DRAFT` ET `non-draft` incohérent** : GitHub indique `isDraft=false` mais `mergeStateStatus=DIRTY`.

**Verdict : fermer.** La minimisation DML est déjà faite dans `main` par deux migrations plus récentes.

---

## 6. #91–#94 — une chaîne d'itérations, pas quatre PR

Les 4 partent du **même merge-base** (`b1ae726f`) et couvrent le chantier P1-staging (workflows `p1-staging-*`, `scripts/prepare_p1_staging_sessions.mjs`, rapports). Ce sont des **itérations successives** : #94 est la plus complète (28 fichiers, 53 commits).

Toutes ont une CI verte sur leur tête, mais **les 4 sont en conflit** — principalement sur `.gitignore`, `docs/security/workflow-privileged-allowlist.json`, et `package.json`/`ci.yml` pour #92 et #94.

**Aucune n'est fusionnable directement.** Il faudrait :
1. choisir **#94** comme base (la plus aboutie),
2. la rebaser sur `main` et résoudre ses 5 conflits,
3. relancer la CI,
4. fermer #91, #92, #93.

**Ce n'est pas un travail d'analyse : c'est une reprise de chantier.** Cela demande de comprendre l'intention de chaque itération — hors périmètre d'une analyse de « prêt pour fusion ».

---

## 7. #101 et #80 — bloquées

### #101 — `arena/647ac97c-tracefab`

**15 conflits**, dont `api/_routes/documents.ts`, `brand-console/index.html`, `dpp/index.html`, `index.html`, `assets/js/brand-console.1.js`. 72 fichiers, +6 457/−136, **518 commits de retard**.

C'est une branche `arena/*` de développement massif, très divergente. **Pas fusionnable sans reprise complète.**

### #80 — `security/clerk-tenant-journeys-20261021`

CI verte, **1 seul conflit** (`docs/security/workflow-privileged-allowlist.json`), 3 fichiers. C'est le cas le plus **récupérable** après #118.

Mais : 545 commits de retard, et le conflit porte sur l'**allowlist des workflows privilégiés** — un fichier de sécurité. Le résoudre demande de vérifier que son workflow ne contourne pas une restriction ajoutée depuis. **Ce n'est pas mécanique.**

---

## 8. Ce qu'il faut faire, concrètement

**Immédiatement fusionnables, sans travail préalable :**

1. **#108** — sortir du brouillon, fusionner. Doc seule.
2. **#119** — sortir du brouillon, fusionner. Puis brancher `test:private-storage` dans la CI.

**Avec un travail de résolution léger :**

3. **#118** — résoudre le conflit `package.json`, relancer la CI, fusionner. Puis brancher `test:public-dpp-route` dans la CI.

**À fermer :**

4. **#122, #123, #124, #125** — redondantes et **contredisent `main`**.
5. **#70** — migration divergente, CI rouge, objet déjà couvert.
6. **#82** — objet déjà couvert par deux migrations plus récentes.
7. **#91, #92, #93** — au profit de #94.

**À reprendre comme un chantier, pas comme une fusion :**

8. **#94** — rebaser + résoudre 5 conflits + CI.
9. **#80** — résoudre le conflit d'allowlist en vérifiant le sens sécurité.
10. **#101** — reprise complète (15 conflits, 518 commits de retard).

---

## 9. Ce que je n'ai pas vérifié

- **Aucune de ces PR n'a été exécutée en local sur un vrai PostgreSQL.** Je n'ai mesuré que #118 et #119 (tests statiques) et lu leur CI.
- **Je n'ai pas ouvert le détail des 39 commits de #91–#94** pour déterminer si une intention a été perdue entre les itérations. Seule l'analyse de #94 le dirait.
- **Le contenu de la doc #108 n'a pas été confronté** aux preuves P10.7 déjà archivées (`preuves/p107/`). Il pourrait exister deux récits d'une même mesure.
- **Aucune fusion n'a été effectuée.** La demande était une analyse.

---

## 10. Issue de l'analyse — #119 et #118 fusionnées (2026-11-22)

Les deux PR déclarées traitables par l'analyse ont été traitées jusqu'à la fusion. Une réserve non prévue dans l'analyse initiale a été trouvée et levée dans les deux cas : **ni l'une ni l'autre n'était gardée par la CI.**

### #119 — `fix/private-storage-antivirus-transport-20261109`

| | |
|---|---|
| Merge commit | `da55e0fb8b05e0751ba2b44296261e487c98fbcb` |
| Fusionnée | 2026-11-22T08:33:30Z |
| CI sur `main` | **4/4 verts** |
| Périmètre | `api/_lib/storage.ts` (+55/−11), test +87, `ci.yml` +8 |

Correctif : garde credentials-dans-l'URL, HTTP en clair autorisé seulement hors production et hors loopback, `redirect: 'error'` sur requête signée, `AbortSignal.timeout(5000)`, pinning de l'endpoint antivirus.

**Réserve levée :** `test:private-storage` existait mais n'était branché dans **aucun** workflow — ni dans la branche, ni dans `main`. Le durcissement aurait été livré sans garde. Étape ajoutée au job `Socle`, mesurée verte au run `45005244493`.

### #118 — `fix/public-dpp-cache-contract-20261109`

| | |
|---|---|
| Merge commit | `ae3c5b6a23e428550c0967e71fc2745c25f5ce05` |
| Fusionnée | 2026-11-22T09:15:51Z |
| CI sur `main` | **4/4 verts** |
| Périmètre | `api/_routes/dpp/[gtin].ts` (+1/−1), test +52, `ci.yml` +9, `package.json` +3 |

Correctif : `Cache-Control` passe de `stale-while-revalidate=300` à `must-revalidate`. Un passeport **suspendu** ne reste donc plus servi cinq minutes.

Deux obstacles, tous deux levés :

1. **Le conflit `package.json` annoncé** — insertion au même point de l'objet `scripts`. Résolu de façon **additive** : `main` 289 scripts préservés, aucun perdu, aucun modifié, 3 nouveaux ajoutés.
2. **Un faux négatif dans le test**, non prévu par l'analyse. Le contrôle comparait la chaîne littérale `resolveDppPassData(tx, gtinOrRef)` ; `main` a depuis ajouté un troisième argument (`publicBaseUrl.origin`), donc 20/21 en permanence. Le test vérifie désormais l'**appel** à la fonction canonique et non son arité. Garde vérifiée toujours sensible **par mutation** : remplacer `gtinOrRef` par un autre symbole refait échouer le contrôle.

**Réserve levée :** `test:public-dpp-route` n'était branché nulle part non plus. Étape ajoutée au job `Socle`.

### Une conséquence à retenir

Les deux PR se sont disputé **le même point d'insertion** dans `.github/workflows/ci.yml`. #118, verte avant la fusion de #119, est devenue `CONFLICTING` dès celle-ci, et a dû repasser par une fusion de `main`. Toute étape CI ajoutée à une PR en attente doit être réintégrée après la fusion de la précédente.

### Ce qui reste non gardé

Le document listait 13 autres PR non fusionnables. **Aucune n'a été touchée.** En particulier #70 et #82 restent à fermer, et #122–#125 restent à ne pas fusionner : leurs contrôles sont l'inverse du contrat de `main`.
