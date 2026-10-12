# TRACEFAB — Chantier 5 : sécurisation des workflows et diagnostic de l'erreur de production

**Date** : 2026-10-12 (Europe/Paris)
**Dépôt** : `Huberaya/Tracefab`
**Branche de travail** : `arena/879cd8db-tracefab` — PR **#36** (brouillon, non fusionnée)
**Branche isolée** : `securite/ci-sans-secret-depuis-main`
**Aucun merge. Aucun déploiement. Aucune migration. Aucune suppression de secret. Aucune réactivation de CI. Aucune modification de `main`.**

Statuts : `CORRIGÉ ET PROUVÉ` · `CORRIGÉ EN ENVIRONNEMENT ISOLÉ` · `PRÉPARÉ NON APPLIQUÉ` · `BLOQUÉ` · `NON VÉRIFIÉ`.

---

## 0. Ce que cette session a trouvé de neuf, en une page

1. **La production est en panne aujourd'hui, et on sait laquelle.** Le couple
   d'observations fourni (`/api/health` → `internal_error` ;
   `/api/catalog/schemas` → 200) a été **reproduit à l'identique** sur l'arbre
   déployé, en ne changeant qu'une seule chose : l'état du client Prisma. Le
   triangle de mesures (§5) **exclut** la panne de base de données, qui
   produirait `503 database_unavailable` — pas un `internal_error`.
2. **Le mécanisme qui produit ce couple est démontré, y compris l'installation
   verte.** Un `prisma generate` qui échoue laisse le `postinstall` du paquet à
   **code de sortie 0** : l'installation réussit, le déploiement part, et le
   client déployé est factice. Mesuré (§5.3), avec l'erreur d'aujourd'hui
   (`binaries.prisma.sh` injoignable) comme scénario.
3. **La garde de cible avait une faille réelle, refermée ici.** Une chaîne
   `postgresql://<utilisateur>@localhost/<base>?host=<hôte manage>` était classée **jetable** par
   la garde alors que le pilote s'y connecte réellement à l'hôte manage : le
   paramètre l'emporte sur l'autorité de l'URL. C'est exactement « un test qui
   utilise silencieusement une base réelle ». Corrigé, avec quatre témoins
   négatifs qui échouent si la faille revient (§4).
4. **Les conséquences du retrait de `DATABASE_URL` sont désormais démontrées**,
   forme par forme : refus fermé (sortie 2) ou étape sautée, jamais une cible
   réelle — mais sur les branches `experience/*`, le job ne ferait plus **rien**
   tout en restant vert (§2).

---

## 1. Les onze alertes critiques : risque réel et preuve

Toutes re-mesurées ce jour (`npm run audit:workflows`, `git fetch --all` inclus).
Les onze sont **toujours présentes**, réparties en deux classes qui n'ont ni le
même risque ni le même correctif.

Déclencheurs communs : `push` (toutes branches), `pull_request`,
`workflow_dispatch`. Une seule de ces branches déclare des permissions
(`arena/91844ee9-tracefab` : `contents: read`) ; les autres n'en déclarent
aucune.

### Classe A — la cible vient d'un secret, donc potentiellement la production (8 alertes)

| # | Référence | Commit | Lignes du secret | Lignes des suites | Base jetable dans le job ? |
|---|---|---|---|---|---|
| 1 | `main` | `b0c976f` | L247 (`TF_SECRET_PRODUCTION`), L280 (`env.DATABASE_URL`) | L282-286 (5 suites) | **oui** (L241) |
| 2 | `correctifs/chantier-1a` | `052ae64` | L268, L316 | L318-322 (5 suites) | **oui** (L262) |
| 3 | `arena/e72cecf4-tracefab` | `49a2dc4` | L258, L313 | L315-319 (5 suites) | **oui** (L252) |
| 4 | `experience/chantier-16-securite-performance` | `1e71c6d` | L220, L238 | L240-244 (5 suites) | **NON** |
| 5 | `experience/chantier-17-ci` | `c9128a4` | L215, L233 | L235-239 (5 suites) | **NON** |
| 6 | `experience/chantier-18-production` | `438aa9c` | L220, L238 | L240-244 (5 suites) | **NON** |
| 7 | `experience/chantier-19-commercial` | `1051c05` | L220, L238 | L240-244 (5 suites) | **NON** |
| 8 | `experience/chantier-20-coherence` | `eee4817` | L220, L238 | L240-244 (5 suites) | **NON** |

**Preuve** : lecture directe de chaque fichier par `git show <ref>:…`. Les cinq
suites (`test:neon:security`, `:supplier`, `:product`, `:quality`,
`:collection`) créent et suppriment des rôles, écrivent et modifient des lignes.

**Risque réel, nuance mesurée** :

- branches 1-3 : l'étape destructrice est **conditionnée** à la présence du
  secret (`if: ${{ env.TF_SECRET_PRODUCTION != '' }}`). Le job contient par
  ailleurs une base jetable, donc le reste de l'étanchéité tient. Le risque est
  concentré sur cette étape, et il est **réel** si le secret existe ;
- branches 4-8 : **aucune base jetable dans le job** — les cinq suites sont son
  unique contenu, alimentées directement par le secret. Une poussée y écrit dans
  la cible du secret ;
- **exploitabilité** : toutes sont conditionnées à l'existence du secret.
  `gh secret list` répond 403 à cette intégration : je ne peux pas dire si le
  secret existe. Je ne le suppose donc pas, et je ne le supprime pas.

### Classe B — écrivent sans garde, mais sur la base jetable du runner (2 alertes)

| # | Référence | Commit | Lignes | Constat |
|---|---|---|---|---|
| 9 | `arena/91844ee9-tracefab` | `19a867a` | L284 (`node scripts/seed_rls_fixture.mjs`), L295, L307, L312 | 5 écritures non gardées, cible jetable |
| 10 | `security/incident-3b-remove-production-db-from-ci` | `8fe013e` | L265, L270 | idem |

**Risque réel** : aucune atteinte à la production. L'écart est la disparition du
**point de passage unique** : sans la garde, rien ne prouve que la cible est
jetable autrement que par la lecture du fichier — et la faille du §4 montre
justement qu'une cible peut mentir sur son identité. **C'est corrigé côté
garde**, pas côté branche.

### Alerte 11 — jeton d'écriture au niveau du workflow

`arena/91844ee9-tracefab`, `figer-reference-visuelle.yml`, déclencheurs
`push` (chemin `tests/regression/reference/.figer`) et `workflow_dispatch`,
`permissions: contents: write` **au niveau du workflow** : tous les jobs
héritent du droit d'écriture. Les jobs exécutent `npm ci`, Playwright et des
suites de régression. Atténuation de fait : pousser le marqueur exige déjà
l'écriture. Le correctif est préparé
(`docs/security/patches/figer-reference-visuelle.permissions.patch`, vérifié
applicable) mais **non appliqué**.

---

## 2. Inventaire des workflows et usages de `DATABASE_URL`

Analyse de **tous** les workflows de **toutes** les références distantes (23),
par lecture (`git show` + `yaml.parse`), sans exécution. Nouveauté de ce
chantier : la cible **effective** est calculée par étape (env d'étape, sinon env
de job) et classée « jetable (runner) » ou « SECRET (potentiellement réelle) ».

Les 9 couples (référence, fichier) portant un enjeu base de données :

| Référence | Cible effective des suites | Garde | Secret |
|---|---|---|---|
| `arena/879cd8db-tracefab` (cette branche) | jetable (runner) | oui | aucun |
| `securite/ci-sans-secret-depuis-main` | jetable (runner) | oui | aucun |
| `security/incident-3b-…` | jetable (runner) | **non** (appel direct) | aucun |
| `arena/91844ee9-tracefab` | jetable (runner) | **non** (appel direct) | aucun |
| `arena/e72cecf4-tracefab` | jetable **et** SECRET | oui | oui |
| `correctifs/chantier-1a` | jetable **et** SECRET | oui | oui |
| `experience/chantier-16,17,18,19,20` | **SECRET seul** | oui | oui |
| `main` | jetable **et** SECRET | oui | oui |

### Conséquences démontrées du retrait de `DATABASE_URL`

Mesuré, pas raisonné :

| Situation | Comportement observé | Code |
|---|---|---|
| Secret absent, garde appelée (`run-db-suite.mjs`) | « NON EXECUTE — DATABASE_URL absent », **rien n'est lancé** | **2** |
| Secret absent, `else if` de présence dans un `run:` (`experience/*`) | branche non prise → étapes sautées | — |
| Secret absent, `if: env.TF_SECRET_PRODUCTION != ''` (`main`, 1a, e72cecf4) | étape sautée | — |
| Secret absent, script destructif lancé **directement** | échec fermé, rien n'est écrit | **2** |
| `DATABASE_URL` vide au lieu d'absent | même refus | **2** |

**Conclusion démontrée** : le retrait du secret **ne peut pas** produire une
écriture sur une base réelle — soit l'étape est sautée, soit la garde refuse en
sortie 2. Il n'existe **aucun** chemin où une variable vide se traduit par une
connexion ailleurs : le pilote n'a pas de valeur par défaut dans ce dépôt.

**Mais deux réserves que je dois énoncer** :

1. sur les branches `experience/16…20`, le job s'appelle « Base — isolation RLS
   exécutée » et, le secret retiré, il ne ferait **plus rien** en restant vert.
   C'est le « vert obtenu sans travail » que ce dépôt refuse ailleurs. Retirer
   le secret **ne suffit pas** pour ces cinq branches : il faut leur donner la
   base jetable de `main` (le poste `services: postgres`), ce qui est le vrai
   correctif ;
2. aucune étape légitime de quelque branche ne lit ce secret : il n'alimente que
   les suites destructrices. Le retrait est donc **sans perte de couverture
   réelle** sur les branches 1-3, et **avec perte apparente** sur les branches
   4-8 (qui ne couvrent rien aujourd'hui : leurs suites n'ont pas de base
   jetable, donc ne devraient pas viser un secret).

### `DATABASE_URL` hors workflows

Références dans le dépôt : `api/_lib/prisma.ts` (datasource), `scripts/lib/`
(garde), `scripts/audit_neon_readonly.mjs` (lecture seule, cible déclarée),
scripts de suites (jetables), et les documents de sécurité. Aucune valeur en
clair, aucun secret dans le code.

---

## 3. Diff exact des deux branches et divergences

```
securite/ci-sans-secret-depuis-main : 826bc11 = main + 1 commit
   1 fichier changé, 2 insertions, 18 suppressions  (.github/workflows/ci.yml)

arena/879cd8db-tracefab : 1379cd5 = main + 23 commits
   32 fichiers changés, 6 473 insertions, 109 suppressions
```

**Divergence mesurée sur `ci.yml`** : 64 insertions / 14 suppressions entre les
deux. Et le point qui compte pour la décision :

```
git apply --check docs/security/patches/ci-main-sans-secret.patch
  (sur un worktree de arena/879cd8db-tracefab)
  → error: patch failed: .github/workflows/ci.yml:8
  → NON APPLICABLE
```

Les deux voies sont donc des **alternatives, pas des étapes cumulables** :

- voie courte : `securite/ci-sans-secret-depuis-main` — 1 fichier, 20 lignes,
  retire le secret et l'étape qui l'utilise. Elle ne change **rien** d'autre ;
- voie complète : PR #36 — ajoute la garde de cible, l'épingle SHA, le poste
  Postgres jetable, la vérification du client Prisma, la politique des
  workflows et ses témoins. Elle **réécrit** la même section du même fichier.

Si les deux étaient appliquées, il faudrait résoudre un conflit dans le job
`base-de-donnees` en gardant la version la plus stricte — celle de la PR #36,
qui n'utilise aucun secret, épingle les actions et fait passer les suites par la
garde. Je ne fusionne ni l'une ni l'autre.

---

## 4. Corrections préparées et tests correspondants

### 4.1 Faille réelle de la garde de cible — CORRIGÉ ET PROUVÉ (local)

**Problème** : la classification portait sur l'hôte de l'URL
(`parsed.hostname`), pas sur l'hôte que le pilote joint réellement.

**Preuve, mesurée** :

```
pg-connection-string.parse("postgresql://<utilisateur>@localhost:5432/<base>?host=<hote manage>")
   → host effectif = ep-xxx.….neon.tech

avant correctif : classifyTarget(… ) → ACCEPTEE | classe=throwaway_local
après correctif : classifyTarget(… ) → refusee | code=managed_host
```

**Cause** : le paramètre `host=` prime sur l'autorité de l'URL dans
`pg-connection-string`, donc dans `pg`. Une chaîne qui *paraît* locale joint la
base du paramètre.

**Correctif** (`scripts/lib/require-throwaway-db.mjs`, 26 insertions /
11 suppressions) :

1. l'hôte **effectif** est calculé : `host=/chemin` → socket Unix locale (cas
   légitime, toujours accepté) ; tout autre `host=` → nom d'hôte, qui prime sur
   celui de l'URL ;
2. un hôte **managé** (`*.neon.tech`, `*.supabase.*`, `*.rds.amazonaws.com`,
   `*.azure.com`, …) est refusé **avant** toute lecture d'opt-in ou de liste
   blanche : aucune déclaration ne peut rendre jetable la plateforme qui
   héberge la production. L'en-tête du module est mis en accord avec ce
   comportement (il promettait « s'il n'est pas explicitement autorisé », ce qui
   laissait la porte entrouverte via la liste blanche).

**Tests ajoutés** (`scripts/test_db_target_guard.mjs`, 4 témoins qui échouent
sur la configuration dangereuse et passent sur la sûre) :

| Témoin | Avant | Après |
|---|---|---|
| `?host=<hôte managé>` depuis une autorité locale | accepté | **refusé** (`managed_host`) |
| `?host=<hôte distant>` depuis une autorité locale | accepté | **refusé** |
| hôte effectif hors liste blanche, opt-in activé | — | **refusé** (`host_not_allowlisted`) |
| hôte managé **inscrit dans la liste blanche** + opt-in + nom autorisé | accepté | **refusé** (`managed_host`) |
| `?host=<hôte déclaré>` (contrôle positif : ne pas sur-refuser) | — | **accepté** (`allowlisted_remote`) |

`npm run test:db-guard` → **20 vérifications passées, 0 échec**. Les messages de
refus ne divulguent ni hôte, ni identifiant, ni mot de passe (vérifié par la
section C, qui reste verte).

### 4.2 Instrumentation de diagnostic — CORRIGÉ ET PROUVÉ (local)

`phase` (`module_load` / `handler`), `error.code`, `error.moduleSpecifier`.
Onze contrôles verts, dont l'absence de toute chaîne de connexion dans la ligne
écrite. **Non présente dans le déploiement servi** (voir §5.4).

### 4.3 Correctif minimal de `main` — PRÉPARÉ NON APPLIQUÉ

`docs/security/patches/ci-main-sans-secret.patch` (2 insertions, 18
suppressions), appliqué sur la branche isolée `securite/ci-sans-secret-depuis-main`
(commit `826bc11`), vérifié sur un worktree de `main`. Le fichier résultant ne
contient **plus aucune référence à `secrets.`**.

### 4.4 Batterie exécutée après ces correctifs

13 suites, **0 échec** : `test:db-guard`, `test:db-routing`,
`test:workflow-policy`, `test:workflow-policy-temoins`, `test:prisma-client`,
`test:audit-script`, `test:neon:privileges`, `test:neon:rls`,
`test:error-reporting`, `schema:static`, `test:security:chantier1`,
`test:routes`, `test:production-readiness`.

---

## 5. Diagnostic de production

### 5.1 Limite d'accès, énoncée sans ambiguïté

Depuis cet environnement, les deux URL répondent `HTTP 000` (connexion TLS
refusée : résolution DNS OK, `registry.npmjs.org` en 200, `api.vercel.com` et
`console.neon.tech` en 000). **Ce n'est pas une preuve d'indisponibilité du
site** : les observations fournies montrent qu'il répond, et bien. C'est une
limite de mon environnement, et je n'en tire aucune conclusion sur le service.
Conséquence directe : **aucun journal Vercel n'est accessible d'ici**, et je ne
présente donc aucune ligne de journal comme consultée.

### 5.2 Les deux identifiants de corrélation sont deux incidents distincts

| Identifiant | Origine | État |
|---|---|---|
| `c3696f22-41d0-4981-8d99-4e6a177021a3` | cité au chantier 2 | **NON VÉRIFIÉ** — journal non consulté |
| `fd30b689-f50f-44f0-a0dd-43e5e1e51f0e` | observation de ce jour, `/api/health` | **NON VÉRIFIÉ** — journal non consulté, mais **le couple d'observations qui l'accompagne tranche le diagnostic** (§5.5) |

Les deux concernent **le même déploiement** : la production sert toujours
`6968252029` = `b0c976f` (2026-10-09), 28 déploiements de production au total,
le dernier étant celui-là. Aucun déploiement de production n'a eu lieu depuis.

À noter : `internal_error` + `correlationId` est émis **uniquement** par la
barrière d'erreur de `api/index.ts`, en statut 500. C'est le seul émetteur du
dépôt — vérifié par lecture, à ce commit comme au mien.

### 5.3 Le mécanisme de l'installation verte sans client — DÉMONTRÉ

Rejoué localement, avec l'erreur d'aujourd'hui comme scénario (téléchargement du
moteur Prisma impossible) :

```
postinstall du paquet @prisma/client, CLI local présent, génération en échec :
  sortie  : « Error: request to https://binaries.prisma.sh/… failed »
            « Error: Failed to download engines. »
  code    : 0        ← l'installation RÉUSSIT
  laissé  : node_modules/.prisma/client/{index,default}.js — client factice
  et      : new PrismaClient() → « @prisma/client did not initialize yet »
```

Le `try/catch` du `postinstall` du paquet **avale** l'échec de `prisma
generate`. C'est la pièce qui manquait au raisonnement du chantier 4 : il n'est
pas nécessaire que Vercel échoue — il suffit que la génération échoue pour que
le déploiement partage un paquet sans client utilisable. Le dépôt a corrigé ce
point sur sa branche (le `postinstall` du projet échoue, lui, fermement), mais
**la production n'a pas ce correctif** : elle est à `b0c976f`.

### 5.4 L'instrumentation n'est pas déployée

`git show b0c976f:api/index.ts` : un seul `try/catch` autour du chargement **et**
de l'appel du gestionnaire. `phase` n'existe pas. Le harnais, exécuté sur
l'arbre déployé, l'a confirmé : la ligne de journal produite porte un
`correlationId` et **pas** de `phase`. Conséquence pratique : la ligne est
exploitable (elle contient `error.message` et la pile tronquée), mais elle ne
nomme pas l'étape — c'est ce que ma branche ajoute.

### 5.5 Discrimination par reproduction sur l'arbre déployé — CORRIGÉ ET PROUVÉ (local)

`api/index.ts` de production (`b0c976f`), les deux routes, trois états du client
Prisma, **rien d'autre ne change** :

| État | `/api/health` | `/api/catalog/schemas` | Ligne de journal |
|---|---|---|---|
| **client absent (factice)** | **500 `{"error":"internal_error","correlationId":"…"}`** | **200**, clés `material-data-core, product-data-core, supplier-profile-core` | JSON avec `correlationId`, `error = SyntaxError: The requested module '@prisma/client' does not provide an export named 'PrismaClient'`, `route = ^health$` |
| client conforme | 200 `{"ok":true,…}` | 200, mêmes clés | aucune |
| client conforme, base injoignable | **503 `{"ok":false,"error":"database_unavailable"}`** | 200, mêmes clés | `GET /api/health failed …` **sans** identifiant de corrélation |

**Le couple observé par l'utilisateur correspond exactement à la première
ligne** — y compris les trois clés de schéma, dans le même ordre. Et il
**exclut** la troisième : une panne de base donnerait `503
database_unavailable`, pas `internal_error`, et n'émettrait pas
d'identifiant de corrélation.

Pourquoi ces deux routes divergent, dans le code déployé :

- `api/_routes/catalog/schemas.ts` n'importe **aucun** module Prisma : il lit
  `catalog/schemas/**` sur le disque (inclus par `includeFiles`). Il fonctionne
  donc même sans client ;
- `api/_routes/health.ts` importe `_lib/prisma.js`, qui construit
  `new PrismaClient()` **au chargement du module**. Si le client est factice,
  l'import échoue, `route.load()` jette, la barrière d'erreur répond 500.
  Le `try/catch` du gestionnaire — celui qui produirait `503` — **n'est jamais
  atteint**.

Conséquence utile et vérifiable par le propriétaire : ce n'est pas un problème
généralisé, c'est **la classe des routes qui importent Prisma**, exactement les
119 modules sur 125 mesurés localement. `/api/catalog/schemas` est l'une des 6
exceptions.

### 5.6 Verdict, avec ce qui reste non prouvé

| Question | État |
|---|---|
| Le site répond-il ? | **oui** — observé par l'utilisateur ; mes HTTP 000 sont une limite d'environnement |
| Quelle est la mécanique de la panne ? | **reproduite à l'identique** sur l'arbre déployé (§5.5) |
| La cause « base de données » est-elle possible ? | **exclue** : elle produirait 503 sans identifiant de corrélation |
| Le client Prisma est-il réellement absent du déploiement ? | **NON VÉRIFIÉ** — exige une ligne de journal |
| Le déploiement est-il globalement cassé ? | **non** : la fonction démarre, la route catalogue répond 200 |

**La ligne à chercher, précisément** : dans les journaux d'exécution Vercel du
déploiement `6968252029` (Production), la chaîne
`fd30b689-f50f-44f0-a0dd-43e5e1e51f0e`. La ligne est un objet JSON dont
`schema` vaut `tracefab-error-report-v1`. Trois messages possibles, et ils
désignent trois causes distinctes :

| `error.message` | Cause | Correctif |
|---|---|---|
| `The requested module '@prisma/client' does not provide an export named 'PrismaClient'` | client factice déployé | postinstall ferme + vérification (PR #36) |
| `Cannot find module '.prisma/client/default'` | client jamais généré | idem |
| `Query engine library … could not be found` | client généré, moteur absent du paquet | génération avec moteur + contrôle du moteur (déjà ajouté) |

Si la ligne a expiré de la rétention, **la cause restera NON VÉRIFIÉE** et je ne
la déclarerai pas prouvée. Le test discriminant à deux requêtes reste alors
disponible : il ne demande aucun accès et reproduit la même discrimination.

---

## 6. Limites, hypothèses restantes, actions non exécutées

**Limites d'accès** : pas de réseau vers Vercel/Neon/Clerk depuis cet
environnement ; pas d'accès aux journaux ; `gh secret list` et
`/actions/permissions` en 403 ; `binaries.prisma.sh` injoignable, donc
`prisma generate` et `api:typecheck` **non exécutables ici** (85 erreurs de type
dues au client absent ; différentiel nul sur mes modifications, mais un
différentiel nul n'est pas une réussite).

**Hypothèses non prouvées** :

1. le client Prisma est absent du paquet déployé — mécanisme reproduit,
   **occurrence non constatée** ;
2. le secret `DATABASE_URL` existe ou non : non vérifiable ici ;
3. les échecs Preview intermittents (§ chantier 4) : cause non établie.

**Actions explicitement non exécutées** : aucune suppression de secret, aucune
réactivation de CI, aucune modification de `main`, aucune fusion, aucun
déploiement, aucune migration, aucun test destructif hors base jetable locale,
aucun changement de paramètre GitHub.

---

## 7. Commits, branches, PR — état exact

| Objet | Valeur |
|---|---|
| `main` / `origin/main` | `b0c976f` — inchangé |
| Production servie | déploiement `6968252029`, commit `b0c976f`, 2026-10-09 |
| `arena/879cd8db-tracefab` | `1379cd5` + le commit de ce rapport — 23 commits au-dessus de `main` |
| PR #36 | **brouillon**, ouverte, non fusionnée |
| `securite/ci-sans-secret-depuis-main` | `826bc11` — `main` + 1 commit, poussée, non fusionnée |
| Branches distantes | 23 — aucune supprimée |
| Workflow `CI` | `disabled_manually` — inchangé |
| Exécutions de workflow sur mes branches | **0** |

## 8. Confirmation explicite

- **Aucun changement de production** : `main`, la production et son déploiement
  sont à l'état constaté au début de la session ; aucun déploiement de
  production n'a été créé ni promu.
- **Aucune fusion** : aucune PR fusionnée, aucune branche fusionnée.
- **Aucune suppression de secret** : le secret `DATABASE_URL` n'a été ni lu, ni
  affiché, ni modifié, ni supprimé. Son innocuité de retrait est *démontrée*
  (§2), mais le retrait est une action du propriétaire.
- **Aucune modification des paramètres GitHub** : ni protection, ni
  environnement, ni permission, ni réactivation.
- **Aucune migration**, aucun accès à une base réelle, aucun test destructif
  hors de la base jetable locale.
- **Aucun secret dans ce rapport** : seuls des noms de variables et des classes
  d'hôtes y figurent.

---

## 9. Décisions qui nécessitent votre autorisation

1. **Chercher `fd30b689-f50f-44f0-a0dd-43e5e1e51f0e`** dans les journaux du
   déploiement `6968252029` et me transmettre la valeur de `error.message`, ou
   exécuter le test discriminant à deux requêtes. *(aucune autorisation
   technique requise — c'est la seule action qui transforme le diagnostic en
   constat)*
2. **Retirer le secret `DATABASE_URL`** ou confirmer son absence. Conséquences
   démontrées au §2, y compris la réserve sur les branches `experience/*`.
3. **Choisir la voie CI** : branche courte `securite/ci-sans-secret-depuis-main`
   (20 lignes) **ou** PR #36 (complète, conflit à résoudre si les deux). Les
   deux sont prêtes ; elles ne se cumulent pas en l'état.
4. **Réactiver `CI`** — seulement après 2 et 3.
5. **Ne pas fusionner les branches `experience/16…20`** avant de leur avoir
   donné une base jetable : leur job « Base — isolation RLS exécutée » ne
   prouverait rien.
6. **Appliquer le durcissement du workflow visuel** (`figer`) sur sa branche, et
   décider du sort de la PR #35 (classe B + épingle par SHA).
7. **Audit Neon en lecture seule** : fournir une chaîne en lecture seule par un
   mécanisme sécurisé, ou exécuter le script soi-même (commande au §5 du rapport
   du chantier 4).

**Prochaine action prioritaire** : la recherche du journal de l'identifiant
`fd30b689-…`. Le diagnostic est complet au point qu'il ne manque qu'une ligne
pour être prouvé ; inversement, si cette ligne contredit le §5.5, c'est le
§5.5 qui devra être corrigé, et je le ferai.
