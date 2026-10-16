# Tracefab — Validation indépendante de la PR #36 après correction CI

**Date** : 2026-10-12 (Europe/Paris) · **PR** : #36 (`Huberaya/Tracefab`) · **Branche** : `arena/879cd8db-tracefab`
**HEAD de référence communiqué** : `7145bb94c53d282c183017a4fdfd01c45d821783`
**HEAD réel relevé** : `3fd9e0ed0e6d28ad9af36fd65305031ce2b8a2dd` (`3fd9e0e`) — **le HEAD a changé** (§0)
**Nature de ce document** : rapport de validation. Aucun merge, aucun déploiement, aucune migration Neon, aucun secret ni paramètre de production modifié, GitHub Actions non réactivé.

Statuts employés : **RÉUSSI** (preuve directe) · **ÉCHEC** (test exécuté, résultat négatif) · **BLOQUÉ** (prérequis indisponible) · **NON EXÉCUTÉ** (aucune preuve).


> **Mise à jour (post-application).** Les deux correctifs décrits au §2.2 (chargeur) et
> au §5.1 (diagnostic) ont été **appliqués** sur la branche, testés puis publiés
> (voir l'addendum du même nom dans `docs/experience/pre-merge-validation-steps-2-to-4.md`
> et celui de `docs/security/REVUE-INDEPENDANTE-CORRECTIONS-CI-SQL-2026-10-12.md`).
> Le §7 ci-dessous décrit l'état **au moment de la rédaction** ; il n'est donc plus
> exact en ce qui concerne ces deux correctifs, et est conservé comme trace.

## Synthèse des statuts

| # | Contrôle | Statut |
|---|----------|--------|
| 1 | Correction CI déjà appliquée — 5 points de configuration (inspection statique) | **RÉUSSI** |
| 1 | `test:workflow-policy` et `test:workflow-policy-temoins` (exécution) | **RÉUSSI** |
| 1 | Exécution réelle par GitHub Actions du pipeline | **NON EXÉCUTÉ** (0 check-run sur le HEAD) |
| 2 | Harnais des routes A1–A4 (`npm run verify:routes:isolation`) | **BLOQUÉ** (3 prérequis manquants, §2.1) |
| 2 | Chargeur du lanceur pour les suites `.mjs` important du TypeScript | **ÉCHEC** sur le HEAD, correctif local éprouvé (§2.2) |
| 3 | Migration sur PostgreSQL jetable — les 6 preuves exigées | **RÉUSSI** |
| 3 | `npm run test:neon:privileges` sur base jetable identifiée | **RÉUSSI** |
| 4 | Dernier Preview et correspondance avec le HEAD final | **BLOQUÉ** (le dernier déploiement porte sur un ancêtre, §4.1) |
| 4 | Examen du diff complet de la PR | **RÉUSSI** |
| 4 | Documents historiques : correctifs annoncés « préparés » | **ÉCHEC partiel** (§4.3 : deux documents à compléter ; addendum non appliqué, cf. §7) |
| 5 | Diagnostic de production en lecture seule — exécution | **NON EXÉCUTÉ** (aucun accès autorisé) |
| 5 | Diagnostic de production — validité de l'outil | **ÉCHEC** puis correctif local éprouvé (§5) |

---

## 0. Première action obligatoire — HEAD réel et delta

`git fetch origin --prune` puis `git rev-parse origin/arena/879cd8db-tracefab` :

```
origin/arena/879cd8db-tracefab : 3fd9e0ed0e6d28ad9af36fd65305031ce2b8a2dd
HEAD de référence communiqué   : 7145bb94c53d282c183017a4fdfd01c45d821783
=> DIFFERENT
```

**Delta `7145bb9` → `3fd9e0e`** (5 commits, 6 fichiers, 388 +/6 −) :

| Commit | Objet | Fichiers |
|---|---|---|
| `5d32e79` | `fix(securite)` : exemption documentée dans la précondition de la migration + déclaration/routage de la suite d'isolation | `migration.sql` (+26/−5), `package.json` (1 ligne), `scripts/test_destructive_suite_routing.mjs` (+2), rapport, 2 patches |
| `2550d19`, `c8904f7`, `ca50620`, `3fd9e0e` | documentation seule (rapport de validation finale : SHA, relevé Preview, addendum, renvois internes) | 1 document |

- **Aucun commit d'origine étrangère** : les cinq portent la même identité que le reste de la branche, et l'analyse de contenu montre qu'ils proviennent de la session de validation précédente (correctif de la précondition `SECURITY DEFINER`, ajout du rapport). Aucun changement applicatif, de configuration, de workflow ou de dépendance n'y figure.
- Delta de **code** exact : les 4 lignes de la précondition (`sans_secdef`, `IF NOT is_secdef AND NOT (signature = ANY(sans_secdef))`), le routage de `verify:routes:isolation` par le lanceur, et la déclaration de la suite dans `DESTRUCTIVE_DB_SUITES`.
- Conséquence : la référence que vous annoncez (`7145bb9`) n'est plus la tête ; **je n'ai rien poussé ni modifié sur la branche** (§7). Toutes les mesures ci-dessous portent sur le HEAD réel `3fd9e0e`.

---

## 1. Contrôle de la correction CI déjà appliquée

### 1.1 Inspection statique — `.github/workflows/ci.yml`, blob `2aa11779789e0aec4f6d86f8933ab65b64aff372` (HEAD `3fd9e0e`)

| Point exigé | Constat | Emplacement |
|---|---|---|
| `test:audit-script` exclu de la boucle `test:*` sans base | présent : `…&&k!=='test:audit-script'` | l. 165 |
| le test reste exécuté dans le job PostgreSQL jetable | `run: npm run test:audit-script` dans `base-de-donnees`, qui monte `postgres:17` | l. 325, service l. 265-267 |
| aucun secret de production injecté | **1 seule occurrence** de `secrets.` dans le fichier, **dans un commentaire** (l. 255) ; l'`env` du job est local et jetable (`…@localhost:5432/tracefab_test`, `TF_APP_PASSWORD: isolation_ci_jetable`) | l. 279-286 |
| permissions limitées | `permissions:` unique, au niveau du workflow : `contents: read` ; aucune autre déclaration, aucune valeur `write` | l. 18-19 |
| 4 `actions/checkout` avec `persist-credentials: false` | 4 checkout (l. 44, 111, 194, 288) et 4 `persist-credentials: false`, appariés deux à deux | — |

**Le patch n'a pas été réappliqué** : les cinq modifications sont bien présentes.

### 1.2 Exécution des contrôles disponibles

```
npm run test:workflow-policy            -> exit 0  (19 contrôles ok, « Politique des workflows : OK. »)
npm run test:workflow-policy-temoins    -> exit 0  (13 témoins ok ; 11 diagnostics négatifs attendus)
npm run test:db-routing                 -> exit 0  (40 contrôles ok)
npm run test:db-guard                   -> exit 0  (43 ok)
npm run test:db-guard-driver            -> exit 0  (12 ok)
npm run test:error-reporting            -> exit 0  (11 ok)
```

- Les témoins négatifs **détectent bien** les configurations fautives, notamment :
  `permissions-absentes.yml` → `ECHEC J. permissions explicites absentes au niveau du workflow` ;
  `checkout-credentials.yml` → `ECHEC J. checkout sans persist-credentials: false` ;
  `secrets.yml` → `ECHEC A. lit secrets.DATABASE_URL sans être déclaré au registre`.
- Les deux témoins propres (`propre.yml`, `job-base-jetable.yml`) sont **acceptés sans cri d'alarme** — le détecteur n'est donc pas un détecteur qui refuse tout.
- **Réserve de méthode** : ce sont des **exécutions locales** des scripts, pas l'exécution du pipeline GitHub. Sur le HEAD, `gh api …/commits/3fd9e0e/check-runs` renvoie **0 check-run** et un statut combiné `pending (0 contextes)` : le pipeline GitHub est **NON EXÉCUTÉ** (Actions désactivé, non réactivé).

**Statut : RÉUSSI** (configuration et détecteurs) — **NON EXÉCUTÉ** (pipeline distant).

---

## 2. Harnais des routes avec authentification réelle de test

### 2.1 Prérequis — trois causes indépendantes, mesurées

| Prérequis | Mesure | Détail exact |
|---|---|---|
| Client Prisma généré | **BLOQUÉ** | `npm run db:generate` → **exit 1** : `Error: request to https://binaries.prisma.sh/all_commits/c2990dca591cba766e3b7ef5d9e8a84796e47ab7/debian-openssl-3.0.x/schema-engine.gz.sha256 failed, reason: Client network socket disconnected before secure TLS connection was established` |
| Clé d'instance Clerk **de test** | **BLOQUÉ** | `npm run verify:routes:isolation` → **exit 2** : `NON EXECUTE — CLERK_SECRET_KEY absente. Fournissez la cle d une instance Clerk DE TEST par un mecanisme securise (jamais dans un ticket ni un rapport).` |
| Joignabilité de l'API Clerk | **BLOQUÉ** | `curl https://api.clerk.com/v1/users` → HTTP 000 (aucune sortie réseau) ; idem `binaries.prisma.sh` |

**A1 (accès autorisé), A2 (absence de jeton), A3 (permissions insuffisantes), A4 (isolation entre locataires) : BLOQUÉ, aucune preuve d'exécution.** Aucune doublure d'authentification n'a été introduite dans le code, et aucune ne doit l'être : le harnais appelle le vrai `verifyToken` et les vrais gestionnaires.

**Méthode reproductible pour obtenir le binaire Prisma** (au choix, dans l'environnement de test) :
1. autoriser la sortie vers `binaries.prisma.sh` (et `registry.npmjs.org`) dans l'allowlist réseau de l'environnement d'exécution, puis `npm ci && npm run db:generate` ;
2. ou pointer un miroir interne : `PRISMA_ENGINES_MIRROR=https://<miroir>/` (+ `PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1` si le miroir ne publie pas les sommes) ;
3. ou pré-remplir le cache hors ligne : télécharger sur un poste disposant d'Internet les deux moteurs du commit exact (`libquery_engine-debian-openssl-3.0.x.so.node`, `schema-engine-debian-openssl-3.0.x.gz`) et fixer `PRISMA_QUERY_ENGINE_LIBRARY` / `PRISMA_SCHEMA_ENGINE_BINARY` sur leurs chemins absolus — aucun accès réseau n'est alors requis ;
4. en CI GitHub, ces étapes fonctionnent déjà (le runner a Internet) : `npm ci` y génère le client.

### 2.2 Défaut trouvé dans la PR — le lanceur ne sait pas charger les suites `.mjs` qui importent du TypeScript

- **Problème** : `scripts/run-db-suite.mjs` choisissait son chargeur sur la seule **extension** (`absolute.endsWith('.ts')`) et lançait donc toutes les suites `.mjs` avec `node` nu. Or trois suites `.mjs` importent des modules TypeScript du dépôt ; sous `node`, l'import `./_lib/http.js` pointant vers un `.ts` échoue.
- **Introduit par la PR** (pas par `main`) : le diff de `package.json` montre `test:neon:bulk:chantier8` passé de `npx tsx …` à `node scripts/run-db-suite.mjs scripts/test_neon_bulk_operations_chantier8.mjs` ; `verify:routes:isolation` est arrivé directement sous cette forme.
- **Mesure** (base jetable, `val_complet`) :
  ```
  npm run test:neon:bulk:chantier8   -> exit 1
     Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/…/api/_lib/plm-erp/gtin-engine.js'
     imported from /…/api/_lib/bulk-operations/bulk-importer.ts
  npm run verify:routes:isolation    -> exit 2
     NON EXECUTE — le routeur applicatif n a pas pu etre charge (Cannot find module
     '/…/api/_lib/http.js' imported from /…/api/index.ts).
  ```
  Avec le chargeur historique (`npx tsx scripts/test_routes_tenant_isolation.mjs`), la même suite dépasse ce point et n'échoue plus que sur le **vrai** prérequis (client Prisma), ce qui isole la cause : c'est le chargeur, pas la suite.
- **Correctif local préparé** (non poussé, §7) : `scripts/lib/choose-suite-loader.mjs` — décision fondée sur le contenu (`import … from '…/x.ts'`, `import('…/x.ts')`, re-export) ; `run-db-suite.mjs` l'utilise ; 7 contrôles ajoutés à `scripts/test_destructive_suite_routing.mjs` (matrice de chargeur + vérification que le lanceur consulte bien cette décision).
- **Preuve après correctif** : `npm run test:db-routing` → **exit 0, 40 ok** ; `npm run verify:routes:isolation` → **exit 2** avec le message attendu (`chargeur : tsx (la suite importe du TypeScript)` puis `client Prisma inutilisable…`) ; `test:neon:bulk:chantier8` atteint désormais le même prérequis réel au lieu de l'erreur de chargement. Non-régression : `test:db-guard` 43 ok, `test:db-guard-driver` 12 ok, `test:workflow-policy` 19 ok, tous exit 0.

**Statut : ÉCHEC** sur le HEAD (une suite de la PR ne peut pas s'exécuter) — correctif local éprouvé, **à appliquer** pour lever ce point.

---

## 3. Revalidation de la migration sur PostgreSQL jetable

Instance locale jetable (PostgreSQL **18.4**, `127.0.0.1:55432`), base recréée à chaque scénario, chaîne de migrations du dépôt rejouée à l'identique. Aucun accès Neon.

**Mesure appariée avant/après** (`node .cache/harness/S1_complet.mjs`) :

| Version testée | Code de sortie | Extrait |
|---|---|---|
| Migration de la référence `7145bb9` (blob `cfbc655e4adc…`) | **1** | `SQLSTATE = 42P17` · « Migration refusée : public.tracefab_public_context() n'est pas SECURITY DEFINER » · 6/6 fonctions encore exécutables par `PUBLIC` · cible non enregistrée |
| Migration du HEAD `3fd9e0e` (blob `6e003844de53…`) | **0** | `ok migration cible appliquee` · 0/6 ouvertes à `PUBLIC` · enregistrée |

Les six preuves exigées, sur la version **exacte du HEAD** :

| # | Preuve | Résultat |
|---|---|---|
| 1 | Les six fonctions existent et satisfont les préconditions | **RÉUSSI** — 6/6 présentes ; 5 `SECURITY DEFINER` + exemption nominative `public.tracefab_public_context()` (par conception : elle ne lit aucun catalogue) ; propriétaire = rôle migrateur pour 6/6 |
| 2 | `PUBLIC` n'a plus `EXECUTE` | **RÉUSSI** — 0/6 |
| 3 | `tracefab_app` conserve ses droits **lorsqu'il existe** | **RÉUSSI** — 6/6 (`scenario 2 (present) : 0 echec(s)`) ; branche symétrique `role absent` : migration **tolérée**, `0/6` ouvertes, `scenario 2 (absent) : 0 echec(s)` |
| 4 | Le défaut s'applique aux fonctions créées **ultérieurement** par le rôle migrateur | **RÉUSSI** — avant migration : `PUBLIC peut executer une fonction nouvelle = true`, `pg_default_acl` = 0 entrée ; après : `false`, `pg_default_acl = postgres/f{postgres=X/postgres}`, ACL de la sonde `{postgres=X/postgres}` |
| 5 | Une fonction obligatoire absente ⇒ échec | **RÉUSSI** — `42883` « Migration refusée : fonction obligatoire absente : public.tracefab_product_is_public(uuid) », non enregistrée ; variante exemption : `42883` sur `tracefab_public_context()`, non enregistrée |
| 6 | Échec volontaire ⇒ état antérieur intégralement restauré | **RÉUSSI** — échec provoqué sur le contrôle « Migration sans effet » (`42501`) puis : a) aucune fonction témoin résiduelle, b) état `PUBLIC` identique avant/après sur 6/6, c) `pg_default_acl` inchangé, d) aucune sonde résiduelle, e) migration non enregistrée |

Contrôles négatifs complémentaires : prédicat privé de `SECURITY DEFINER` ⇒ `42P17` (l'exemption reste étroite) ; propriétaire ≠ migrateur ⇒ `42501`.

**Test de privilèges du dépôt**, base jetable explicitement identifiée (`val_complet`, PostgreSQL 18.4 local, identifiants jetables non publiés) :

```
npm run db:seed-rls        (fixture RLS)        -> exit 0
npm run test:neon:privileges                    -> exit 0
  ok A. aucune des 107 fonctions SECURITY DEFINER n est executable par PUBLIC
  ok B. tracefab_app peut executer les 12 fonction(s) appelee(s) par les politiques
  ok C. … SECURITY DEFINER, fermee a PUBLIC, ouverte a tracefab_app
  ok D. une fonction creee par postgres n est plus executable par PUBLIC (acl {…,tracefab_app=X/postgres})
  ok D. la fonction temoin a bien ete annulee par ROLLBACK
  ok F. un role sans aucun droit ne peut executer aucune des 6 fonction(s) visees
  ok G. porte rouverte expres : le detecteur de A la vue immediatement
  ok G. la porte rouverte a ete refermee par ROLLBACK : la base est dans son etat initial
```

Sondes transactionnelles : **aucun résidu** (aucune fonction/rôle/table de sonde, `152` fonctions dans `public` avant/après).

**Statut : RÉUSSI** (les six preuves + test de privilèges). **Réserve** : la migration **n'a pas été appliquée** à Neon ; l'état de production reste inconnu.

---

## 4. Preuves de déploiement et examen du diff

### 4.1 Dernier Preview et correspondance avec le HEAD

```
2026-10-12T15:32:03Z | sha=c8904f7 | success
2026-10-12T15:07:21Z | sha=2550d19 | success
2026-10-12T15:07:06Z | sha=5d32e79 | success
2026-10-12T15:03:54Z | sha=7145bb9 | success
2026-10-12T15:03:00Z | sha=0b6f90e | success
```

- **Le dernier déploiement porte sur `c8904f7`, un ancêtre, pas sur le HEAD final `3fd9e0e`** : `gh api …/deployments?per_page=1` renvoie `c8904f7`, et la recherche par SHA pour `3fd9e0e` et `ca50620` ne renvoie **aucun déploiement**. Vercel traite visiblement les commits par vagues (déjà observé : un déploiement de `61ae908` créé 15 minutes après le push).
- Conséquence : le contrôle « le déploiement correspond au HEAD final et atteint `READY` » est **BLOQUÉ** — il faudra re-relever après que Vercel ait rattrapé, ou déclencher un déploiement. Les états `success` **ne valent que pour les SHA listés**.
- **Portée de cette preuve, mesurée** : un Preview vert ne démontre pas la conformité CI. Le commit `61ae908` a un Preview `success` alors que, sur son propre arbre, `node scripts/test_destructive_suite_routing.mjs` sort en **exit 1** ; le Preview n'exécute donc pas les contrôles de scripts de la CI (ni `npm run build`, qui les embarque).
- Les échecs de Preview d'ancêtres (`911f53a`, `46fbcc9`) restent **inexpliqués** : `api.vercel.com` est injoignable depuis cet environnement (HTTP 000) et aucun jeton exploitable n'existe — un jeton Vercel communiqué en clair précédemment est traité comme exposé et **n'a pas été utilisé**.

### 4.2 Diff complet de la PR (pas seulement CI/SQL)

`main` → `3fd9e0e` : **60 fichiers, 11 857 +/126 −**.

| Catégorie | Fichiers | Examen |
|---|---|---|
| `api/**` (code applicatif) | 6 | Remontée d'erreurs et refus par défaut : `phase: 'module_load' \| 'handler'`, `code`, `moduleSpecifier` (nom du module absent) ; les routes `integrations*` distinguent erreur métier et erreur inattendue et rendent un **500 générique** (`internal_server_error`) en journalisant côté serveur ; `verify-ai` renvoie 500 si la décision est incomplète. **Aucune donnée interne renvoyée au client** ; le caviardage des secrets est conservé. |
| `scripts/**` (harnais) | 21 | harnais de sécurité/CI de la PR (privilèges, politique de workflows et témoins, garde de cible, lanceur, routage) |
| `docs/**` | 25 | rapports de chantiers et revues — documentation seule |
| `prisma/**` | 1 | la migration objet du §3 |
| `.github/**` | 2 | `ci.yml`, `vercel-log-search.yml` |
| racine | 2 | `package.json` / `package-lock.json` (scripts de test, `postinstall`, dépendance `yaml`) |

Test applicatif correspondant exécuté : `npm run test:error-reporting` → **exit 0, 11 ok**, dont `ok aucune chaine de connexion, aucun jeton dans la ligne ecrite` et `ok aucun hote de base dans la ligne ecrite` : la charge utile ajoutée ne divulgue pas de secret. Les autres tests applicatifs (`typecheck`, `api:typecheck`, `test:router-load`, `test:prisma-client`) restent **NON EXÉCUTÉS** ici (client Prisma indisponible, §2.1).

### 4.3 Documents historiques — correctifs annoncés « préparés »

| Document | Constat | Suite à donner |
|---|---|---|
| `docs/experience/pre-merge-validation-steps-2-to-4.md` | §10 « Ce qui la rendrait fusionnable » liste encore « appliquer `docs/security/patches/ci.yml.garde-de-cible…patch` », alors que l'équivalent a été appliqué en `0b6f90e` **et** que le §11 porte déjà l'addendum correspondant. En revanche, **aucun addendum ne mentionne** le correctif de la précondition de la migration (`5d32e79`) ni le défaut de chargeur (§2.2). | addendum §12 proposé (texte prêt, **non appliqué** — §7) |
| `docs/security/REVUE-INDEPENDANTE-CORRECTIONS-CI-SQL-2026-10-12.md` | décrit la migration d'une révision antérieure (blob `9e73c903833d`, 218 lignes) et conclut « NON FUSIONNABLE » sans indiquer que le fichier a changé depuis (`cfbc655e4adc` → `6e003844de53`) ni que les points 2, 3 et 4 de sa liste « reste à faire » sont désormais mesurés | addendum proposé (**non appliqué**) |
| `docs/incident/TRACEFAB-CHANTIER-3-VALIDATION-2026-10-12.md` (P2-16, `figer-reference-visuelle`) | « PRÉPARÉ NON APPLIQUÉ » est **toujours exact** : le workflow `figer-reference-visuelle.yml` **n'existe pas** sur cette branche (voir ci-dessous). Aucune correction de document nécessaire. | — |

### 4.4 Problèmes de cette PR vs éléments d'autres branches

`figer-reference-visuelle.yml` est cité 13 fois dans les documents du dépôt et possède des patches dans `docs/security/patches/`, mais **n'existe que sur une autre branche** :

```
origin/arena/879cd8db-tracefab          : ci.yml vercel-log-search.yml
origin/arena/91844ee9-tracefab          : ci.yml figer-reference-visuelle.yml
origin/experience/chantier-17-ci        : ci.yml
origin/securite/ci-sans-secret-depuis-main : ci.yml
origin/main                             : ci.yml
```

Le test de politique analyse **exactement les deux workflows présents** ici (`2 workflow(s) analyse(s) : ci.yml, vercel-log-search.yml`) : les questions liées à `figer-reference-visuelle.yml` (P2-16) **ne sont pas des problèmes de la PR #36** et ne doivent pas bloquer sa fusion.

---

## 5. Hypothèses de production — diagnostic en lecture seule

### 5.1 Défaut trouvé dans l'outil de diagnostic (ÉCHEC, puis correctif local)

`docs/security/diagnostic-pre-migration-close-public-execute-gap.sql` est bien un script **de lecture** (0 instruction d'écriture, vérifié). Mais il **échouait sur l'état même qu'il doit mesurer** :

```
error: ACL arrays must be one-dimensional     (SQLSTATE 22023)
```
- **Cause racine isolée** : `aclexplode(COALESCE(e.proacl, '{}'))`. Un tableau vide `'{}'::aclitem[]` a `array_ndims = NULL` ; `aclexplode` exige un tableau mono-dimensionnel → erreur. Or sur une base **non migrée**, 5 des 6 fonctions ont `proacl IS NULL` (aucune ACL explicite) : le diagnostic plantait donc exactement dans l'état « avant migration ».
- **Correctif local préparé** (non poussé, §7) : `aclexplode(COALESCE(e.proacl, acldefault('f', e.proowner)))` — l'ACL effective par défaut d'une fonction est `{propriétaire=X/propriétaire,=X/propriétaire}`, c'est-à-dire `EXECUTE` à `PUBLIC`, ce qui **est** l'information utile.
- **Preuve après correctif**, exécuté tel quel sur deux bases jetables : base non migrée → **66 lignes de mesure, critère final « fonctions encore ouvertes à PUBLIC » = 6** ; base migrée → **51 lignes, critère = 0** ; exit 0 dans les deux cas. Extrait (base non migrée) : `[1-reperes] fonctions_cibles_trouvees = 6 / 6`, `[2-fonctions] tracefab_public_context — droits explicites = PUBLIC, postgres, tracefab_app`, `[3-defauts] aucun defaut enregistre pour fonctions = vrai`, `[6-critere] = 6`.

### 5.2 Exécution sur production

**NON EXÉCUTÉ** : aucun accès en lecture seule à Neon n'est disponible ni autorisé dans cet environnement. Les hypothèses **H1** (le rôle qui joue la migration est propriétaire des six fonctions), **H2** (aucun rôle non-propriétaire ne dépend de l'`EXECUTE` que `PUBLIC` fournissait) et **H3** (défauts de privilèges enregistrés pour le rôle exécutant) restent **non tranchées**.

Rappel de méthode, sans ambiguïté : **le diagnostic ne vaut pas autorisation d'appliquer la migration.** Toute migration ou modification de privilèges en production exige une décision distincte du propriétaire. À noter d'ailleurs que, sur le banc local, le rôle exécutant est **superutilisateur** (`role_executeur_est_superutilisateur = true`) : la lecture de H1 sur Neon devra être interprétée en tenant compte du rôle réellement employé.

---

## 6. Décision motivée et conditions restantes

**Décision : la PR #36 (`3fd9e0e`) n'est pas fusionnable en l'état.**

Motifs, dans l'ordre de gravité :

1. **Une suite de la PR ne peut pas s'exécuter** (mesuré, §2.2) : le lanceur commun charge les `.mjs` avec `node` nu, ce qui casse `test:neon:bulk:chantier8` (et `verify:routes:isolation`). Ce n'est pas un test qui échoue — c'est un test qui **ne tourne pas**, donc une couverture annoncée et absente. Le correctif est écrit, éprouvé localement et prêt à être appliqué.
2. **Le harnais d'isolation A1–A4 n'a toujours aucune preuve d'exécution** (§2.1) : trois prérequis manquent (moteur Prisma, clé Clerk de test, accès réseau à Clerk). Tant qu'il n'a pas tourné jusqu'à sortie 0, l'affirmation « les routes rendent à qui a le droit » reste non vérifiée — c'est l'un des deux objets de la PR.
3. **Le diagnostic de production était inutilisable sur l'état pré-migration** (§5.1) : l'outil qui doit trancher H1/H2/H3 avant toute application plantait. Corrigé localement, éprouvé ; reste à intégrer.
4. **Aucun déploiement ne correspond au HEAD final** (§4.1) : le dernier Preview porte sur `c8904f7`. Ni le `READY` du SHA exact ni un run GitHub Actions (0 check-run) ne viennent confirmer le HEAD.
5. Points documentaires (§4.3) : deux documents de référence doivent porter un addendum pour ne pas présenter des correctifs déjà appliqués comme « à appliquer ».

Ce qui est, à l'inverse, **établi par exécution** (et ne doit pas être refait) : la correction CI appliquée est conforme aux cinq exigences et ses détecteurs fonctionnent dans les deux sens ; la migration du HEAD **s'applique** sur une base reconstruite par la chaîne du dépôt, ferme `PUBLIC` (0/6), préserve `tracefab_app` (6/6), ferme les fonctions futures, échoue proprement sur fonction absente et **annule intégralement** ses effets en cas d'échec ; `test:neon:privileges` sort à **0** sur cette base.

### Conditions restantes, dans l'ordre

1. Appliquer le correctif de chargeur (§2.2) et re-exécuter `npm run test:db-routing` (attendu : exit 0, 40 ok) **puis** `npm run verify:routes:isolation` (attendu : plus d'erreur de chargement).
2. Fournir une instance Clerk **de test** (clé via mécanisme sûr, jamais dans un ticket) et un environnement où `npm run db:generate` aboutit ; exécuter `verify:routes:isolation` jusqu'à **sortie 0** sur A1–A4, avec pour chaque cas : requête, identité de test non sensible, statut HTTP, résultat métier, résultat attendu.
3. Intégrer le correctif du diagnostic (§5.1) et l'exécuter en **lecture seule** sur la cible de production, dans un environnement autorisé, pour trancher H1, H2, H3. Rapport séparé attendu.
4. Obtenir un déploiement **du SHA final** en état `success`/`READY` (ou re-relever après rattrapage Vercel) ; ne pas extrapoler depuis un SHA ancêtre.
5. Ajouter les deux addenda documentaires (§4.3).
6. Décider, **séparément**, de l'application de la migration en production (niveau D) : elle ne découle ni de la fusion, ni du diagnostic, ni de ce rapport.

---

## 7. Limites de ce tour, et ce qui n'a pas été fait

- **Aucune modification poussée** : le HEAD distant a changé par rapport à la référence annoncée ; conformément à la consigne, je n'ai ni commité ni poussé. Les correctifs du chargeur (§2.2) et du diagnostic (§5.1) sont **écrits et éprouvés localement**, disponibles sous forme de patches dans `docs/security/patches/` (`lanceur-chargeur-tsx-suite-mjs.patch`, `diagnostic-aclexplode-tableau-vide.patch`), et **non appliqués** à la branche.
- **Aucune action distante** en dehors des **lectures** (`gh api`, `git fetch`, relevés de déploiements). Aucun merge, aucun tag, aucun réglage, aucun secret, aucune protection de branche, Actions non réactivé, aucune migration Neon.
- **Aucune valeur secrète** dans ce rapport : ni clé Clerk, ni jeton, ni chaîne de connexion. Les mesures locales sont désignées par le nom de base (`val_complet`, `val_diag_avant`, `val_diag_apres`) et l'hôte `127.0.0.1:55432`.
- **Tests statiques vs tests d'exécution** : les contrôles `test:workflow-policy*`, `test:db-routing`, `test:db-guard*`, `test:error-reporting`, les 8 scénarios de migration et les 2 exécutions du diagnostic sont des **exécutions** (codes de sortie fournis) ; l'inspection de `ci.yml` (§1.1), l'analyse du diff (§4.2) et l'audit documentaire (§4.3) sont des **inspections statiques** et ne sont pas présentées comme des tests réussis.
- **Ce qui n'a pas pu être exécuté** : pipeline GitHub Actions (désactivé), harnais A1–A4 (trois prérequis), `typecheck`/`api:typecheck`/`test:router-load`/`test:prisma-client` (client Prisma), diagnostic sur production (accès absent), tests de charge et d'interface (hors périmètre).

---

## Annexe — addenda documentaires prêts à coller (non appliqués, cf. §7)

**A. À ajouter à la fin de `docs/experience/pre-merge-validation-steps-2-to-4.md`**

```markdown
## 12. Addendum — état des correctifs au 2026-10-12 (tête `3fd9e0e`)

- Le correctif ciblé de `.github/workflows/ci.yml` annoncé au §10 est **appliqué** (`0b6f90e`, décrit au §11).
- La migration `20261012120000_close_public_execute_gap` du §2 a été **corrigée** en
  `5d32e79` : exemption nominative et documentée pour `public.tracefab_public_context()`,
  seul point de la précondition `SECURITY DEFINER` qui la rendait inatteignable. Version
  mesurée : blob `6e003844de53`, appliquée sur base jetable — 0/6 fonctions exécutables
  par `PUBLIC`, `tracefab_app` 6/6, rollback complet vérifié.
- Le routage de `verify:routes:isolation` par `scripts/run-db-suite.mjs` a révélé un
  défaut de chargeur : toute suite `.mjs` important du TypeScript devient inutilisable
  (`test:neon:bulk:chantier8` notamment). Correctif préparé, **non appliqué**.
- Rapports de référence : `docs/security/RAPPORT-VALIDATION-FINALE-CI-SQL-2026-10-12.md`
  et `docs/security/RAPPORT-VALIDATION-INDEPENDANTE-PR36-2026-10-12.md`.
```

**B. À ajouter à la fin de `docs/security/REVUE-INDEPENDANTE-CORRECTIONS-CI-SQL-2026-10-12.md`**

```markdown
## Addendum — 2026-10-12, tête `3fd9e0e`

- La migration décrite ci-dessus est une révision antérieure du fichier
  (`9e73c903833d` → `cfbc655e4adc` → `6e003844de53`). La précondition `SECURITY DEFINER`
  ajoutée entre-temps la rendait inappliquable telle quelle ; une exemption nominative,
  documentée et éprouvée dans les deux sens a été appliquée en `5d32e79`.
- Points 2 (épreuve sur base jetable), 3 (rollback complet) et 4 (contrôles après
  modification, SHA à l'appui) de la liste « reste à faire » : désormais **exécutés**.
- Point 5 (Preview `READY` pour le commit exact) : **BLOQUÉ** — le dernier déploiement
  porte sur un ancêtre (`c8904f7`), pas sur le HEAD.
- Point 6 (réglages de l'environnement `vercel-log-search`) : **BLOQUÉ** — API de
  réglages GitHub en 403 dans cet environnement.
- Décision : « ne pas fusionner en l'état » maintenue, pour des motifs mis à jour
  (chargeur des suites `.mjs`, harnais A1–A4 non exécuté, diagnostic de production
  inutilisable avant correctif) — voir le rapport de validation indépendante.
```
