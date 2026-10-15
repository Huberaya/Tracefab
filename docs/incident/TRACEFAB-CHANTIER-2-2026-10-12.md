# TRACEFAB — CHANTIER 2 : exécution des corrections

**Date :** 2026-10-12 · **Branche :** `arena/879cd8db-tracefab` · **Référence :** `main` = `b0c976f`
**Dernier commit poussé :** `243f7d0`
**Environnement :** GitHub accessible (lecture + écriture de branche). Vercel, Neon et Clerk **non accessibles** depuis cet environnement.

> **Ce que ce document n'est pas.** Aucune ligne de code n'a été déployée, aucune
> variable Vercel modifiée, aucune migration appliquée à Neon, aucun réglage
> GitHub modifié. Ces opérations attendent une autorisation de niveau C ou D et,
> pour Vercel et Neon, un accès qui n'existe pas ici.

---

# A. État d'avancement

| # | Chantier | Statut | Ce qui manque pour aller plus loin |
|---|---|---|---|
| 1.1 | Examen de la PR #35 | **CORRIGÉE ET TESTÉE** (examen fait) | décision de fusion — autorisation |
| 1.2 | Neutralisation du scénario destructif | **CORRIGÉE ET TESTÉE** — preuve d'exécution en environnement isolé ; **VÉRIFIÉE EN PRODUCTION : non** | un run CI réel |
| 1.3 | Réduction de privilège `Figer la reference visuelle` | **CORRIGÉE ET TESTÉE** (patch préparé, contrôle négatif fait) | application sur la branche qui détient le fichier |
| 1.4 | Protection de `main` | **BLOQUÉE** — réglages exacts fournis | accès en écriture à la configuration du dépôt |
| 2 | Génération Prisma | **CORRIGÉE ET TESTÉE** — échec bloquant prouvé | validation sur un déploiement Preview |
| 3 | Audit Neon réel | **BLOQUÉE** — l'outil est prêt et éprouvé | accès Neon en lecture seule |
| 3bis | Migration corrective des privilèges | **CORRIGÉE ET TESTÉE** en base isolée | audit préalable + autorisation d'application |
| 4 | Secrets et confinement | **EN COURS** — inventaire fait, décisions non prises | validation du propriétaire |
| 5 | Rétablissement des tests | **EN COURS** — suites hors ligne rétablies, suite RLS exécutée pour la première fois | environnement jetable pour les 5 suites `test:neon:*` |
| 6 | Rapport d'exécution | **CORRIGÉE ET TESTÉE** (ce document) | — |

---

# B. Actions réellement exécutées

## B.1 Le test destructif contre la production est neutralisé

**Fichiers :** `.github/workflows/ci.yml`, `scripts/lib/require-throwaway-db.mjs`,
`scripts/run-db-suite.mjs`, `scripts/test_db_target_guard.mjs`,
`scripts/test_destructive_suite_routing.mjs`
**Commit :** `64d3157`, câblage `3ba3064`
**Commande :** `npm run test:db-guard` · `npm run test:db-routing`

Le job `base-de-donnees` portait `TF_SECRET_PRODUCTION: ${{ secrets.DATABASE_URL }}`
et une étape lançant cinq suites destructives. Retirer l'étape protège ce
workflow, pas le suivant : la décision a été déplacée du workflow vers les
suites, derrière une garde de cible à refus par défaut.

**Preuves d'exécution :**

| Commande | Résultat |
|---|---|
| `DATABASE_URL=<neon> node scripts/run-db-suite.mjs scripts/test_neon_security.mjs` | **exit 3**, refus, aucune connexion ouverte |
| `VERCEL_ENV=production DATABASE_URL=<localhost> node scripts/run-db-suite.mjs …` | **exit 3**, `production_context` |
| `env -u DATABASE_URL node scripts/run-db-suite.mjs …` | **exit 2**, « NON EXECUTE » |
| `npm run test:db-guard` | 15 vérifications, 0 échec |
| `npm run test:db-routing` | OK — 10 suites gardées, 7 non rattachées déclarées, 2 outils d'exploitation hors chaînes automatiques |

Aucun message de la garde ne contient mot de passe, hôte, identifiant ou chaîne
de connexion — vérifié par le contrôle C du test de la garde.

## B.2 La génération Prisma est garantie, et son échec bloque

**Fichiers :** `scripts/prisma-generate.mjs`, `scripts/verify_prisma_client.mjs`,
`scripts/test_prisma_client_check.mjs`, `scripts/test_router_module_load.mjs`,
`package.json` (`postinstall`, `dependencies`)
**Commit :** `4545759`

Cause établie : `vercel.json` porte un tableau `builds`, ce qui fait ignorer les
réglages de build du projet ; aucun script `build` n'y était branché ; aucun
`postinstall` n'existait ; `@prisma/client` était en `devDependencies` alors
qu'il est importé au chargement de chaque route de données.

**Preuves d'exécution :**

| Commande | Résultat |
|---|---|
| `npm install` (sans réseau vers les binaires Prisma) | **échec de l'installation**, avec le message qui nomme la conséquence |
| `npm ci` avec `PRISMA_SKIP_POSTINSTALL_GENERATE=true` | passe, en annonçant que le client n'est pas généré |
| `VERCEL_ENV=production PRISMA_SKIP_POSTINSTALL_GENERATE=true npm ci` | **refusé** — le contournement ne peut pas s'appliquer là où il ferait taire l'incident |
| `node scripts/verify_prisma_client.mjs` sur le client factice | **exit 1** — « le client est le repli factice » |
| `npx tsx scripts/test_router_module_load.mjs` sur le client factice | **exit 1** — 119/125 modules de route ne se chargent pas ; diagnostic nommant l'incident |
| idem avec un client conforme | **exit 0** — 125/125 modules chargés, `/api/catalog/schemas` 200, route inconnue 404 |
| `npm run test:prisma-client` | OK — 3 cas distingués (factice, conforme, incomplet) |

## B.3 L'exécution publique des fonctions `SECURITY DEFINER` est fermée

**Fichiers :** `prisma/migrations/20261012120000_close_public_execute_gap/migration.sql`,
`scripts/test_neon_privileges.mjs`
**Commit :** `3b04bdd`

**Cause racine, mesurée et non déduite.** La migration
`20261007100000_security_definer_execute_hardening` a posé
`ALTER DEFAULT PRIVILEGES FOR ROLE x IN SCHEMA public REVOKE EXECUTE ON
FUNCTIONS FROM PUBLIC`. Cette instruction ne fait rien : les défauts par schéma
ne font qu'ajouter au défaut global, et l'`EXECUTE` de `PUBLIC` sur les
fonctions est un défaut intégré du moteur. `REVOKE` ne retire qu'un `GRANT`
antérieur. Mesuré sur PostgreSQL 18.4, base vierge :

| Instruction | `pg_default_acl` | Fonction créée ensuite |
|---|---|---|
| — | vide | PUBLIC **peut** exécuter |
| forme `IN SCHEMA public` | **vide** | PUBLIC **peut** exécuter |
| forme globale, sans `IN SCHEMA` | `{role=X/…}` | PUBLIC **ne peut plus** |

Conséquence : toute fonction créée après le durcissement est née exécutable par
`PUBLIC`. Sur la chaîne des 36 migrations : **107 fonctions `SECURITY DEFINER`,
5 exécutables par `PUBLIC`** — dont `tracefab_material_visible_via_product`, qui
reçoit en plus un `GRANT … TO PUBLIC` explicite, contredisant
`docs/operations/p0-neon-reconciliation.md`.

**Preuves d'exécution :**

| Étape | Résultat |
|---|---|
| `npm run test:neon:privileges` avant la migration | **échec** — invariants A, C et D faux |
| application de la migration sur la base isolée | 1 migration appliquée |
| `npm run test:neon:privileges` après | **OK** — 6 vérifications |
| retrait du `GRANT` à `tracefab_app` pour mesurer la nécessité | `permission denied for function tracefab_material_visible_via_product` |
| `npm run test:neon:rls` après la migration | **OK** — 47 tables, aucune erreur de politique, deux locataires disjoints |

Le retrait n'est donc pas aveugle : le `GRANT` au rôle applicatif est
**nécessaire** (sans lui la lecture de `materials` casse) et **suffisant** (avec
lui, l'isolation complète passe).

## B.4 Audit Neon en lecture seule

**Fichiers :** `scripts/audit_neon_readonly.mjs`, `scripts/test_audit_neon_readonly.mjs`
**Commit :** `d5406bd`

Liste blanche de requêtes vérifiée au démarrage ; lecture seule appliquée par
PostgreSQL (`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`) ;
non-divulgation vérifiée avant affichage.

**Preuves :**

| Commande | Résultat |
|---|---|
| `node scripts/audit_neon_readonly.mjs` sans `DATABASE_URL` | **exit 2** |
| contre la base isolée | **exit 0**, rapport complet |
| `npm run test:audit-script` | OK — écriture **tentée** et refusée par le serveur (« read-only transaction ») |
| contrôle négatif : requête reconstituant une chaîne de connexion | **exit 4**, rapport retenu, rien imprimé |

## B.5 Politique des workflows et réduction de privilège `Figer`

**Fichiers :** `scripts/test_workflow_policy.mjs`,
`docs/security/workflow-privileged-allowlist.json`,
`docs/security/patches/figer-reference-visuelle.{durci.yml,permissions.patch}`
**Commit :** `90eecbd`

**Preuves :**

| Cas | Résultat |
|---|---|
| `npm run test:workflow-policy` sur l'arbre corrigé | **OK** |
| contrôle négatif : `secrets.DATABASE_URL` réintroduit | **échec sur 3 assertions** |
| version d'origine de `figer` placée dans `.github/workflows/` | **échec** sur D et H |
| version durcie | **OK** — le job `pousser` détient `contents: write` sans exécuter de code du dépôt |

## B.6 Branches et commits

Branche unique : `arena/879cd8db-tracefab` (contrainte de session — un seul
bord de travail, chaque correction isolée en commit identifiable).

```
243f7d0  fix(ci): deux faux positifs du contrôle de routage, corrigés sans l'affaiblir
968e1f9  docs(security): réglages GitHub/Vercel et état des privilèges PostgreSQL
3ba3064  fix(ci): retirer le test destructif contre la production et brancher les gardes
90eecbd  feat(ci): politique des workflows — déclarer plutôt que subir
d5406bd  feat(security): audit Neon en lecture seule, garanti par le serveur
3b04bdd  fix(security): fermer l'exécution publique des fonctions SECURITY DEFINER
4545759  fix(build): générer le client Prisma et échouer plutôt que déployer sans lui
64d3157  fix(ci): garde de cible — refus par défaut avant toute suite destructive
b03bdf3  docs(incident): bilan de récupération du 2026-10-12   (chantier 1)
```

Aucune branche distante supprimée, aucun historique réécrit, aucun `reset`,
aucune fusion. Les 20 branches distantes existantes sont intactes.

## B.7 Fichiers modifiés ou ajoutés

**Ajoutés (16) :** `scripts/lib/require-throwaway-db.mjs`, `scripts/run-db-suite.mjs`,
`scripts/prisma-generate.mjs`, `scripts/verify_prisma_client.mjs`,
`scripts/audit_neon_readonly.mjs`, `scripts/test_db_target_guard.mjs`,
`scripts/test_destructive_suite_routing.mjs`, `scripts/test_workflow_policy.mjs`,
`scripts/test_prisma_client_check.mjs`, `scripts/test_router_module_load.mjs`,
`scripts/test_neon_privileges.mjs`, `scripts/test_audit_neon_readonly.mjs`,
`prisma/migrations/20261012120000_close_public_execute_gap/migration.sql`,
`docs/security/PHASE-1-PIPELINE-GITHUB.md`, `docs/security/PHASE-3-PRIVILEGES-NEON.md`,
`docs/security/workflow-privileged-allowlist.json` (+ les deux fichiers du patch `figer`).

**Modifiés (3) :** `.github/workflows/ci.yml`, `package.json`, `package-lock.json`.

Aucun fichier applicatif, aucune route, aucun composant d'interface n'a été
touché. Aucune politique RLS, aucune table, aucune donnée.

## B.8 Tests exécutés et résultats

| Suite | Résultat |
|---|---|
`test:db-guard` | OK (15/15)
`test:db-routing` | OK
`test:workflow-policy` | OK (+ 2 contrôles négatifs concluants)
`test:prisma-client` | OK (3 cas)
`verify:prisma-client` | **échec attendu** localement (client non généré — binaires Prisma inaccessibles)
`test:router-load` | échec avec client factice (attendu) / OK avec client conforme
`test:audit-script` | OK
`test:neon:privileges` | échec avant migration / OK après
`test:neon:rls` | **OK — première exécution réelle** (47 tables, 2 locataires disjoints)
`test:production-readiness`, `schema:static`, `test:security:chantier1`, `test:assets`, `test:routes`, `test:cross-tenant`, `test:private-storage`, `test:questionnaires` | OK

**Non exécutées, et présentées comme telles :** `test:regression` (navigateur),
les parcours et personas, et les cinq suites `test:neon:*` autres que `rls`.
Elles exigent un environnement jetable applicatif complet ; aucune n'est
comptée comme passée.

---

# C. Problèmes restants

## C.1 Ce qui n'a pas pu être établi

1. **Cause de la panne de production non confirmée.** Le mode de défaillance
   est reproduit localement (client Prisma non généré → 119/125 modules de
   route ne se chargent pas → `internal_error` avec identifiant de corrélation),
   et c'est la seule forme compatible avec la réponse observée. Mais **la
   preuve côté production manque** : les journaux Vercel sont inaccessibles.
   L'identifiant de corrélation qui apparaît dans la réponse de production
   n'est pas persisté côté application ; il ne se retrouve que dans les
   journaux Vercel.
2. **État réel de Neon inconnu.** Migrations appliquées, `rolbypassrls` de
   `neondb_owner`, privilèges effectifs des 107 fonctions, nombre réel de tables
   et de politiques : rien n'est constaté.
3. **Réglages GitHub et Vercel non appliqués.** Fournis en §B et dans le
   document de phase, avec chemin d'interface et valeurs.
4. **La garde n'a jamais tourné en CI réelle.** Un workflow `CI` vert n'est pas
   une preuve de sécurité ; ici il manque même le vert.

## C.2 Ce qui a été trouvé et mérite une décision

5. **`docs/operations/p0-neon-reconciliation.md` contredit le code** — il
   affirme qu'aucune fonction n'est exécutable par `PUBLIC`, ce que la migration
   `20261009120000` dément. Le document est présenté comme un constat. Il doit
   être corrigé ou daté comme historique.
6. **La PR #35 ne contient aucun garde-fou.** Son diff est exactement le retrait
   minimal plus la documentation de l'incident 3B.4. Elle corrige P0-4 pour ce
   chemin, et rien n'empêche la réintroduction. Sa fusion est sans risque de
   régression, mais elle ne clôt pas le sujet.
7. **Le workflow `CI` est `disabled_manually`.** Rendre un check obligatoire
   avant de le réactiver **bloquerait toute fusion** : un check attendu et jamais
   produit n'est jamais vert.
8. **Les protections GitHub ne bloquent pas les déploiements Vercel.** La
   production est produite par l'intégration Vercel (`vercel[bot]`), jamais par
   un workflow. Protéger `main` filtre les commits, pas les déploiements.
9. **Les cinq suites `test_neon:*` écrivent** (`CREATE ROLE`, `DROP ROLE`,
   `REVOKE ALL PRIVILEGES ON ALL TABLES`, `DELETE`). Sept autres suites
   destructives existent dans le dépôt sans être rattachées à aucune commande.
   Elles sont désormais déclarées ; les brancher exige un environnement jetable.

---

# D. État de sécurité

| Domaine | État constaté |
|---|---|
**Confinement des secrets** | Le workflow de CI ne lit plus le contexte `secrets`. Aucun secret affiché, copié ou testé au cours de ce chantier. La garde de cible ne publie ni URL, ni hôte, ni identifiant, ni mot de passe.
**Secrets EXP-01/02/03, CL-11, DEC-36** | **Introuvables** dans le dépôt et dans son historique. Ni résolus, ni inventés. La liste des vérifications à faire par le propriétaire reste celle de l'incident 3B.4 (IR-01 à IR-08).
**Workflows** | Étape destructive retirée ; dix suites routées par la garde ; actions épinglées par SHA ; contrôle automatique des privilèges. `CI` toujours `disabled_manually`.
**GitHub** | **Rien n'a été modifié.** `main` sans protection, environnements sans règle, un collaborateur. Réglages exacts fournis.
**Vercel** | **Rien n'a été modifié.** Variables d'environnement non touchées — un correctif de code ne doit pas être remplacé par une modification de variable.
**Neon** | **Rien n'a été modifié.** Aucune connexion à une base distante.
**RLS et privilèges** | Isolation **prouvée par exécution** sur base isolée : deux locataires voient des ensembles disjoints, le contexte public ne laisse passer que les produits publiés, 47 tables sans erreur de politique. En production, l'isolation reste **non démontrée** : `neondb_owner` porte `BYPASSRLS`, donc les politiques n'y sont pas évaluées. La régression `PUBLIC EXECUTE` est corrigée **dans le dépôt**, pas en base.
**Authentification** | Non modifiée. Le repli de sel du limiteur de débit (`TRACEFAB_RATE_LIMIT_SALT` → `CLERK_SECRET_KEY` → `DATABASE_URL`) reste à traiter : définir le sel **avant** de toucher à `DATABASE_URL`.
**Multi-locataire** | Politiques inchangées. La migration corrective ne touche ni aux tables, ni aux politiques, ni aux données.
**Vulnérabilités résiduelles** | (1) Cause de production non confirmée. (2) État des privilèges Neon inconnu. (3) `main` non protégée. (4) CI désactivée. (5) Sel de limitation de débit non posé.

**Aucune des affirmations suivantes n'est faite :** « tout est corrigé »,
« sécurisé », « prêt pour la production ». Aucun problème antérieur n'est
considéré comme résolu sans vérification courante.

---

# E. Résultat final

**Exécuté et vérifié :** la neutralisation du scénario destructif (avec une
garde éprouvée dans les deux sens), la garantie de génération du client Prisma
(avec un échec bloquant prouvé et un test de non-régression qui reproduit
l'incident), la fermeture de l'exécution publique des fonctions `SECURITY DEFINER` (cause racine mesurée, migration corrective testée, non-régression
RLS verte), l'audit en lecture seule (garanti par le serveur), la politique des
workflows (éprouvée par contrôle négatif) et la réduction de privilège de
`Figer la reference visuelle` (patch préparé, contrôle négatif concluant).
**La suite d'isolation RLS a été exécutée pour la première fois dans des
conditions où elle mesure quelque chose.**

**Préparé, non appliqué :** la migration corrective n'est pas appliquée à Neon ;
les réglages GitHub et Vercel ne sont pas posés ; le patch `figer` n'est pas
appliqué ; aucun commit n'est fusionné, aucun déploiement déclenché.

**Prochaine action concrète, dans l'ordre :**

1. **Propriétaire** — exécuter l'audit en lecture seule contre Neon
   (`scripts/audit_neon_readonly.mjs`, lecture seule appliquée par le serveur).
   C'est le déverrouillage qui conditionne les points 3, 4 et 5.
2. **Propriétaire** — réactiver le workflow `CI`, puis appliquer les réglages de
   protection de `main` (§5.2 de `docs/security/PHASE-1-PIPELINE-GITHUB.md`).
3. **Propriétaire** — appliquer le patch `figer` sur la branche qui détient le
   fichier, et attacher des relecteurs obligatoires à l'environnement
   `figer-reference-visuelle`.
4. **Après audit seulement** — décider de l'application de
   `20261012120000_close_public_execute_gap` en production, avec autorisation
   explicite et preuve datée.
5. **Ensuite** — monter un environnement jetable pour les cinq suites
   `test:neon:*`, seule façon de les rétablir sans écriture vers la production.
