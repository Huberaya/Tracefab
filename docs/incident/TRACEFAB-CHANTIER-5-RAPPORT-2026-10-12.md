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

---

## 10. Vérification finale des preuves — 2026-10-12

Six questions ont été posées, dans cet ordre : le diff Prisma exact, la garde
PostgreSQL et ses tests, les tests RLS perdus quand `DATABASE_URL` manque,
le contenu réel des deux branches, la recherche de l'identifiant de corrélation,
et la liste des commandes, fichiers, commits, risques et contrôles bloqués.
Chaque réponse ci-dessous cite la commande et sa sortie.

> **Ce paragraphe corrige un chiffre du §4.** La garde ne compte plus 20
> vérifications mais **35** : le §4.1 décrivait la première version. Les 20
> d'origine sont inchangées et restent listées en §10.2 ; les 15 nouvelles
> couvrent des cas nommés par la demande.

### 10.1 Diff exact des changements Prisma

Fichiers et commits (commande : `git log --format=%h main..HEAD -- <fichier>`) :

| Fichier | Commits |
|---|---|
| `package.json` | `0a7df1b 1a3d7a7 9a126ee 62fc3b3 21f9340 3ba3064` |
| `scripts/prisma-generate.mjs` | `4545759 b0d332f 50acb92` |
| `scripts/verify_prisma_client.mjs` | `4545759 2d03cc4 50acb92` |
| `scripts/test_prisma_client_check.mjs` | `4545759 2d03cc4 50acb92` |

**Génération.** `package.json` reçoit un cycle de vie qui ne dépend plus de
`@prisma/client` : `"postinstall": "node scripts/prisma-generate.mjs"`. Le
script génère le client, **vérifie ce qui a été produit**, et sort en erreur si
quoi que ce soit manque. `@prisma/client` passe des `devDependencies` aux
`dependencies`, sans quoi la génération ne se déclenche pas sur un déploiement
qui n'installe que les dépendances de production.

**Validation du client.** `"verify:prisma-client": "node scripts/verify_prisma_client.mjs"`
est inséré en tête de `build`, juste après la génération. Ce contrôle lit le
schéma, construit le client, et refuse : un client factice
(« did not initialize yet »), un client incomplet, un client sans moteur de
requêtes, ou une surface de client imitée (absence de `$disconnect`).

**Traitement de l'échec de génération.** `scripts/prisma-generate.mjs` sort en
**1** à chaque étape manquante (`process.exit(1)` aux lignes 69, 87, 95), et
propage le code de sortie du contrôle final (`process.exit(verification.status ?? 1)`).
Le contournement du cycle de vie est **fermé** : la ligne 57 calcule
`const contexte = deployment || (process.env.VERCEL ? 'VERCEL=1' : '')`, donc
`VERCEL=1` — posé dans **tous** les environnements Vercel, y compris quand
`VERCEL_ENV` vaut `development` ou n'est pas renseigné — compte comme un
déploiement. Avant cette correction, `PRISMA_SKIP_POSTINSTALL_GENERATE=true VERCEL=1`
sortait en **0**.

**Comportement au build.** Une génération qui échoue fait échouer le build par
trois chemins indépendants : le `postinstall` sort en 1 ; `verify:prisma-client`
sort en 1 ; `npm run build` propage le code de sortie.

**Preuve qu'une génération ratée ne peut pas produire un faux succès**
(laboratoire `/tmp/install-fail`, commande `npm run postinstall` dans chaque
état, puis lecture du code de sortie) :

| État simulé | Attendu | Obtenu |
|---|---|---|
| A — la génération échoue | 1 | **1** |
| B — la génération « réussit » sans rien produire | 1 | **1** |
| C — le client restant est un stub (« did not initialize yet ») | 1 | **1** |
| D — le moteur de requêtes est absent | 1 | **1** |
| E — moteur + client + `@prisma/client` présents (cas conforme) | 0 | **0** |

Le cas E est le témoin négatif : sans lui, les quatre refus ne prouveraient rien.
Le mécanisme d'origine, lui, a été mesuré : un `prisma generate` qui échoue
**dans** le `postinstall` de `@prisma/client` rend **exit 0** et laisse un stub —
c'est l'installation verte sans client du §5.3.

**Limite honnête.** Je ne peux pas exécuter une vraie génération Prisma dans cet
environnement (`binaries.prisma.sh` est injoignable) ; les cinq états sont donc
simulés par des clients de forme contrôlée. En revanche la CI au commit de
production (`b0c976f`) contient l'étape « Générer le client Prisma » **[success]**
— voir §10.5 : la génération fonctionne bien dans l'environnement de CI réel.

### 10.2 La garde PostgreSQL, son code, ses 35 tests

Code (`scripts/lib/require-throwaway-db.mjs`) — les quatre règles qui décident :

1. **hôte effectif** : un paramètre `?host=` de l'URL prime sur l'autorité de
   l'URL ; c'est l'hôte *effectif* qui est classé (faille réelle corrigée) ;
2. **hôtes managés refusés avant l'opt-in** : ni `ALLOW_REMOTE_DB`, ni liste
   blanche ne peuvent autoriser un hôte de base managée ;
3. **point final normalisé** : `ep-xxx.eu-central-1.aws.neon.tech.` (FQDN absolu)
   était accepté quand la liste blanche le contenait — c'était un contournement
   réel ;
4. **schéma restreint** : `postgres:` / `postgresql:` seulement ; `mysql://` et
   les chaînes sans schéma sont refusées avant toute autre analyse.

Résultat complet, `npm run test:db-guard` — **35 vérifications passées, 0 échec** :

- **A — ce qui doit être accepté (5)** : base jetable locale `localhost` ;
  `127.0.0.1` ; socket Unix ; cible distante explicitement autorisée (3
  déclarations) ; hôte effectif déclaré par paramètre (autorisation maintenue).
  *(Ces 5 forment, avec les 13 de B et les 2 de C, les **20 tests** du §4.1.)*
- **B — ce qui doit être refusé (13)** : contexte de déploiement de production,
  même en local ; hôte managé sans opt-in ; hôte managé **malgré** opt-in et
  autre liste blanche ; contournement par `?host=` vers un hôte managé ;
  contournement par `?host=` vers un hôte distant ; hôte effectif hors liste
  blanche malgré l'opt-in ; hôte managé inscrit dans la liste blanche ; nom de
  base évoquant la production ; nom de base « live » ; nom de base hors liste
  blanche ; valeur non analysable ; valeur absente ; variable non définie.
- **C — ce qui ne doit jamais sortir dans un message (2)** : aucune fuite de
  secret dans le rapport de refus ; publication d'une empreinte corrélable.
- **D — `host=`, sockets Unix, valeurs encodées, formes malformées (15, ajoutés
  ce tour)** : socket Unix encodée `%2F…` reconnue comme locale ; IPv6 littéral
  `[::1]` ; hôte en majuscules `LOCALHOST` ; point final `localhost.` ; nom de
  base encodé `tracefab%5Ftest` décodé ; hôte managé encodé `%65p-…` **refusé** ;
  hôte managé en majuscules **refusé** ; hôte managé avec point final, **même
  déclaré**, refusé ; nom de production encodé `prod%2Dduction` refusé ;
  protocole `mysql://` refusé par défaut ; URL sans schéma refusée ; loopback
  sous forme décimale refusée (sens sûr) ; hôte vide refusé ; chaîne sans
  schéma refusée ; valeur faite d'espaces refusée.

Les refus par défaut sont donc **fail-closed** : ce qui n'est pas reconnu comme
jetable est refusé, y compris des formes qui *pourraient* être locales.

### 10.3 Ce qui serait sauté sans `DATABASE_URL`, et le vert sans exécution

Sur les cinq branches `experience/chantier-1{6,7,8,9,0}`, le job qui porte le nom
`Base — isolation RLS exécutée` exécute en réalité, quand le secret est présent :

```
npm run test:neon:security
npm run test:neon:supplier
npm run test:neon:product
npm run test:neon:quality
npm run test:neon:collection
```

Trois constats, mesurés et non déduits :

1. **`test:neon:rls` n'est invoqué 0 fois sur les cinq branches** (1 fois sur
   `main`, 1 fois sur ma branche). La suite qui prouve l'isolation RLS n'est donc
   pas seulement sautée faute de secret : elle **n'est pas câblée** sur ces
   branches. Le nom du job annonce une preuve que le fichier ne contient pas.
2. Sans secret, **toutes** les étapes de base sont conditionnées
   (`if: steps.secret.outputs.present == 'true'`), y compris l'installation et la
   génération : le job se termine **vert** en n'ayant rien exécuté.
3. Côté `main`, la CI du commit de production prouve que la situation est
   différente : les étapes « Appliquer les migrations sur la base jetable »,
   « Créer le rôle `tracefab_app` et deux locataires » et « Isolation RLS prouvée
   par exécution » sont **[success]** — seule « Scénarios croisés contre la base
   de production » est **[skipped]**. Autrement dit la suite RLS tournait bien
   sur `main`, et c'est l'étape croisée qui dépendait du secret.

**Qu'aucun job ne puisse annoncer un succès sans avoir exécuté** est désormais
un contrôle automatique : la section I de `scripts/test_workflow_policy.mjs`,
avec 11 témoins (`npm run test:workflow-policy-temoins` → **OK**). L'un des
témoins est le job extrait de `chantier-18` ; il a d'abord été **invisible** au
contrôle (la boucle lisait la clé YAML au lieu du `job.name` affiché) — c'est la
réécriture du contrôle qui l'a révélé, pas un raisonnement.

La correction est préparée pour les cinq branches, vérifiée applicable :
`docs/security/patches/ci-experience-chantier-{16,17,18,19,20}-job-base-sans-faux-vert.patch`.
Elle renomme le job en `Base — scénarios croisés exécutés` (le nom décrit alors
ce qu'il fait) et remplace la sortie « `present=false` + notice » par
`::error::` **et `exit 1`**. Compte de l'alerte I, mesuré en ré-exécutant le
contrôle sur chaque branche (`grep -c '^  ECHEC I\.'`) :

| Branche | ECHEC I avant | ECHEC I après |
|---|---|---|
| `experience/chantier-16` | 1 | **0** |
| `experience/chantier-17` | 1 | **0** |
| `experience/chantier-18` | 1 | **0** |
| `experience/chantier-19` | 1 | **0** |
| `experience/chantier-20` | 1 | **0** |

Le « 1 avant / 1 après » du tour précédent était un **défaut de mon propre
comptage** (il comptait les lignes `ok` comme des échecs) ; il est corrigé ici
par la mesure ci-dessus. **Les patches ne sont pas appliqués sur vos branches** :
ils sont préparés, testés sur copies de travail, et attendent votre décision.

### 10.4 Contenu réel des deux branches (sans supposer la cumulativité)

| Branche | HEAD | Écart à `main` | Fichiers |
|---|---|---|---|
| `arena/879cd8db-tracefab` (poussé) | `ae40e64` | 25 commits | 33 fichiers |
| `arena/879cd8db-tracefab` (local, après correctifs et §10) | `bff267b` | 28 commits | 38 fichiers |
| `securite/ci-sans-secret-depuis-main` | `826bc11` | 1 commit | 1 fichier (`2 insertions(+), 18 deletions(-)`) |

Les 38 fichiers de ma branche, par répertoire : `scripts` 14,
`docs/security/patches` 8, `docs/incident` 6, `docs/security` 3, `scripts/lib` 1,
`prisma/migrations/20261012120000_close_public_execute_gap` 1, puis 1 chacun pour
`package.json`, `package-lock.json`, `api/_lib`, `api`, `.github/workflows`.

**Elles ne se cumulent pas.** Vérifié et non supposé :
`git apply --check docs/security/patches/ci-main-sans-secret.patch` sur une copie
de travail détachée sur `origin/arena/879cd8db-tracefab` →
`error: patch failed: .github/workflows/ci.yml:8` /
`error: .github/workflows/ci.yml: patch does not apply`. Les deux touchent la
même section `base-de-donnees` avec une divergence de 64+/14−. Il faudra choisir
l'une des deux voies, ou que je réécrive le patch court sur la branche longue.

### 10.5 Recherche de l'identifiant de corrélation

Recherche refaite ce tour, pour ne pas recycler une conclusion :

```
curl -s -o /dev/null -w '%{http_code}' https://tracefab.vercel.app/api/health        → 000
curl -s -o /dev/null -w '%{http_code}' https://api.vercel.com/v6/deployments/6968252029 → 000
curl -s -o /dev/null -w '%{http_code}' https://console.neon.tech                    → 000
```

L'égress HTTP reste fermé (seul `registry.npmjs.org` répond). **Aucune requête
n'a atteint le site : aucun code de statut, aucun corps de réponse, aucune ligne
de journal du déploiement `6968252029` n'est cité dans ce rapport.** En
conséquence : **la cause de l'incident de production reste NON VÉRIFIÉE.** Le
diagnostic du §5.5 est une reproduction fidèle sur l'arbre déployé, pas un
constat sur la production.

Ce qui reste cherchable, et où : le journal du déploiement `6968252029`
(onglet Logs de Vercel), la chaîne `schema: "tracefab-error-report-v1"`
contenant `fd30b689-f50f-44f0-a0dd-43e5e1e51f0e`, avec trois valeurs possibles
de `error.message` : `export named 'PrismaClient'`, `Cannot find module
'.prisma/client/default'`, `Query engine library … could not be found`.

Deux éléments de preuve ont toutefois pu être obtenus par GitHub, qui est
accessible — ils affinent le diagnostic sans le clore :

- sur le commit de production, le job `Socle` et le job `Base` exécutent bien
  « Générer le client Prisma » **[success]** : la génération fonctionne dans
  l'environnement de CI ;
- le statut du déploiement `6968252029` est `success`, `log_url` pointant vers
  l'URL de prévisualisation `tracefab-b1i9vcmmb-…vercel.app`. Un déploiement
  `success` qui sert des `internal_error` est exactement le symptôme du §5.3
  (installation verte sans client) — cohérent, mais **pas** concluant seul.

### 10.6 Commandes, résultats, fichiers, risques, contrôles bloqués

Batterie complète après les corrections de ce tour
(`.cache/harness/batterie.sh` avec 14 cibles, code de sortie lu explicitement) :

```
test:db-guard                OK      test:neon:rls                OK
test:db-routing              OK      test:error-reporting         OK
test:workflow-policy         OK      schema:static                OK
test:workflow-policy-temoins OK      test:security:chantier1      OK
test:prisma-client           OK      test:routes                  OK
test:audit-script            OK      test:production-readiness    OK
test:neon:privileges         OK      test:cross-tenant            OK
----
echecs: 0
```

Fichiers touchés par ce tour : les 7 fichiers de `scripts/` listés en §10.1 plus
`scripts/lib/require-throwaway-db.mjs`, `scripts/test_db_target_guard.mjs`,
`scripts/test_workflow_policy.mjs`, `scripts/test_workflow_policy_detection.mjs`,
et les 5 patches `docs/security/patches/ci-experience-chantier-*`. Commits :
**`50acb92`** (correctifs de code), **`6d30db3`** (ce §10), **`bff267b`**
(patch `chantier-20` oublié par un glob — voir §10.8), puis le commit qui
clôt ce tour en documentant cet état. État du dépôt : arbre propre, 38 fichiers
au-dessus de `main`.

**Risques résiduels, inchangés et assumés :**

1. `prisma generate` et `api:typecheck` ne sont pas exploitables ici (registre
   de binaires injoignable ; 85 erreurs de types de référence, différentiel
   85→85). Les cinq états Prisma sont simulés, pas générés.
2. Les patches CI ne sont pas appliqués : les cinq branches restent vertes à
   vide, et `test:neon:rls` reste non câblé dessus.
3. Les deux branches de correction ne se cumulent pas en l'état.
4. Rien n'a été modifié côté GitHub, Vercel, Neon ni `main`.

**Contrôles bloqués** (avec l'accès précisément manquant) :

| Contrôle | Accès manquant |
|---|---|
| Recherche du `correlationId` en production | journaux du déploiement Vercel |
| Vérifier l'existence du secret `DATABASE_URL` | `gh secret list` → 403 (intégration) |
| Protection de `main` en détail | `…/branches/main/protection` → 403 |
| Permissions Actions du dépôt | `…/actions/permissions` → 403 |
| Audit Neon en lecture seule | chaîne en lecture seule, par mécanisme sécurisé |

### 10.7 Trois défauts trouvés dans mes propres contrôles ce tour

Écrits ici parce qu'ils changent la valeur des preuves ci-dessus :

1. **Comptage d'alertes faux** (§10.3) — le « 1 avant / 1 après » confondait
   lignes `ok` et `ECHEC`. Recompté : 1 → 0 sur les cinq branches.
2. **Contrôle de workflow aveugle au nom affiché** — la section I lisait la clé
   YAML `jobs.<id>.name` au lieu du `name` du job ; un job renommé par la branche
   (`chantier-18`) était invisible au contrôle. Corrigé, avec un témoin dédié.
3. **`verify_prisma_client.mjs` cassé sur un cas qu'il devait juger** —
   `await client.$disconnect?.().catch(...)` jetait un `TypeError` quand
   `$disconnect` était absent : le contrôle échouait sur une erreur de langage
   au lieu de nommer le défaut. Correction : vérification de surface explicite,
   nettoyage protégé, et un cinquième témoin (`client fabriqué à la main`).

Aucun de ces trois défauts n'était dans le code de production : ils étaient dans
mes contrôles. Ils auraient tous les trois produit des preuves fausses.

**Prochaine action prioritaire, inchangée** : une ligne du journal du
déploiement `6968252029`. Tant qu'elle manque, la cause en production reste
`NON VÉRIFIÉE` et je ne l'écrirai pas autrement.

### 10.8 État du dépôt à la fin de ce tour, et un défaut d'exécution de plus

- Branche : `arena/879cd8db-tracefab`, `main` = `b0c976f`.
- Commits de ce tour : `50acb92` (durcissement), `6d30db3` (§10), `bff267b`
  (patch `chantier-20`), plus le commit de ce bloc.
- Arbre de travail : **propre** (`git status --short` vide).
- Batterie : 14 cibles, **0 échec** (§10.6), re-mesurée après les correctifs.
- Rien d'écrit hors de cette branche : aucun push sur `main`, aucune fusion,
  aucun déploiement, aucune migration jouée, aucun secret supprimé ou lu,
  aucun réglage GitHub/Vercel/Neon modifié.

**Quatrième défaut trouvé ce tour — dans ma propre exécution, pas dans un
contrôle.** Le premier `git add` des cinq patches utilisait
`docs/security/patches/ci-experience-chantier-1*-…` : ce motif couvre 16 à 19 mais
**pas 20** (la chaîne commence par `2`). Le commit `50acb92` annonçait donc cinq
patches et n'en contenait que quatre ; le cinquième est ajouté par `bff267b`, et
le rapport annonçait 33 fichiers là où l'arbre en comptait déjà 37. C'est
exactement le type d'écart qu'une relecture par diff attrape et qu'une annonce
sans relecture laisse passer : les compteurs des §10.4 et §10.6 ont été
recalculés sur l'arbre, pas recopiés.

---

## 11. Pièce jointe `vercel.txt` annoncée et non reçue — ce qui est préparé à la place

Le 2026-10-12, l'utilisateur a annoncé un fichier `vercel.txt` « pour faire le
travail sur Vercel ». **Le fichier n'est pas arrivé dans l'espace de travail** :
`/home/user/uploads` n'existe pas, `find / -iname "vercel.txt"` ne renvoie rien,
et aucun fichier n'a été modifié dans l'intervalle. Aucun contenu n'a donc été
lu, et rien n'est supposé ici sur ce qu'il contenait.

### 11.1 La limite est réseau, pas une question d'autorisation

Test de sortie refait ce jour, sans aucun secret dans la commande :

| Hôte | Résultat |
|---|---|
| `api.vercel.com/v6/deployments?limit=1` | **HTTP 000** |
| `vercel.com` | **HTTP 000** |
| `registry.npmjs.org/-/ping` | **HTTP 200** |

L'accès sortant du bac à sable est restreint à quelques hôtes (GitHub, registre
npm, PyPI). **Un jeton Vercel, même valide, ne change rien** : `api.vercel.com`
n'est pas joignable d'ici. Ni les journaux de build, ni les journaux
d'exécution, ni les métadonnées du déploiement ne peuvent être lus dans cet
environnement. Le jeton annoncé **n'a pas été lu, affiché, copié, testé ni
enregistré** — conforme aux règles de la session, y compris pour une pièce
jointe déposée volontairement.

En conséquence : **la cause de l'incident de production reste NON VÉRIFIÉE**, et
le restera tant qu'une ligne de journal n'aura pas été obtenue. Le §5.5 reste une
reproduction fidèle sur l'arbre déployé, pas un constat sur la production.

### 11.2 Ce qui a été livré à la place, et qui est utilisable sans cet accès

1. **`scripts/diagnose_production_incident.mjs`** — lecture seule stricte : que
   des `GET` construits, aucun hôte autre que `api.vercel.com`, délai de 20 s,
   sorties distinctes **0** (ligne trouvée et affichée), **1** (rien trouvé —
   et l'absence est présentée comme une absence, avec le renvoi vers les
   journaux d'exécution), **2** (le contrôle n'a pas pu tourner). Tout ce qui est
   affiché passe par un caviardage : jeton, `Bearer …`, chaînes de connexion,
   identifiants opaques.
2. **`scripts/diagnose_production_incident.sh`** — saisie **masquée** du jeton,
   transmis par l'environnement du processus fils : il n'entre ni dans
   l'historique du shell, ni dans `ps`, ni dans un fichier. Refuse les textes de
   remplacement.
3. **`scripts/lib/fake-vercel-api.mjs` + `scripts/test_diagnose_incident_offline.mjs`**
   — 20 vérifications hors ligne, **0 échec** (`npm run test:diagnose-incident`) :
   sans jeton → 2 ; refus 403 → 2 ; ligne trouvée → 0 avec jeton et chaîne de
   connexion **masqués** ; rien trouvé → 1 ; aucune méthode d'écriture dans le
   source et **seulement des GET** dans le journal des requêtes interceptées ;
   un jeton présent dans un corps d'erreur reste masqué ; une requête vers un
   autre hôte et une méthode `POST` sont **refusées** par l'interception
   elle-même. L'interception ne s'active que sous `TF_FAKE_VERCEL` : sans cette
   variable, le module ne touche pas à `fetch`.
4. **`docs/security/patches/vercel-log-search.workflow.yml`** — workflow
   **préparé, NON installé** : lecture des journaux depuis la CI, classe
   **niveau C** (écriture GitHub + création d'un secret + exécution). Il rappelle
   les deux conséquences à valider : créer le secret `VERCEL_READONLY_TOKEN`, et
   déclarer le fichier au registre sinon **mes propres contrôles** lèveraient
   l'alerte A (secret lu sans déclaration) et C (action non épinglée).
5. **`docs/incident/TRACEFAB-RECHERCHE-CORRELATIONID-2026-10-12.md`** — les trois
   voies (tableau de bord, script local, workflow), la table de décision qui
   associe chaque valeur possible de `error.message` à sa conclusion — **y
   compris le cas où la ligne contredit le §5.5 et où c'est le §5.5 qui devra
   être réécrit** — et les règles de sécurité applicables au jeton.

### 11.3 Ce qui manque, réduit à une ligne

Une seule information débloque le diagnostic, et elle ne contient aucun secret :
la valeur de `error.message` du rapport d'erreur portant
`fd30b689-f50f-44f0-a0dd-43e5e1e51f0e`, telle qu'elle apparaît dans l'onglet
Logs du déploiement `6968252029`. Si ce déploiement n'a plus ses journaux, un
déploiement postérieur au 2026-10-09 fait l'affaire.

### 11.4 Hygiène du jeton déjà transmis

Un jeton qui a transité par une pièce jointe doit être considéré comme **exposé**,
même s'il n'a jamais servi : ne pas le coller à nouveau (chat, ticket, commit),
préférer un jeton dédié à portée minimale, identifier ses consommateurs
légitimes **avant** révocation, puis le révoquer et prouver la révocation par la
liste des jetons du fournisseur — jamais en publiant la valeur.

### 11.5 État du dépôt après ce tour

Fichiers ajoutés : les cinq ci-dessus (§11.2) plus deux entrées `package.json`
(`diagnose:prod`, `test:diagnose-incident`). Batterie : **15 cibles, 0 échec**.
Rien d'écrit hors de la branche `arena/879cd8db-tracefab` : aucun workflow créé,
aucun secret créé ou lu, aucun réglage GitHub, Vercel ou Neon modifié, `main`
intacte.

---

## 12. Jeton proposé, jeton refusé — et la seule voie qui atteint Vercel d'ici

### 12.1 Le jeton n'a pas été accepté, et il ne doit pas être envoyé

L'utilisateur a annoncé le 2026-10-12 qu'il transmettrait un lien et un jeton
Vercel, révoqué après le travail. **Je n'ai pas accepté ce jeton**, pour deux
raisons qui se cumulent :

1. **Règle de la session, posée par l'utilisateur lui-même** : « ne jamais
   demander ni accepter que des jetons soient postés dans le chat, les commits,
   les rapports ou les tickets ; tout accès supplémentaire passe par un
   mécanisme sécurisé ». Une pièce jointe de chat est un de ces canaux.
2. **Futilité technique, mesurée à l'instant** : `tracefab.vercel.app` → **HTTP
   000**, `api.vercel.com` → **HTTP 000**, `api.github.com` → **HTTP 200**.
   L'accès sortant de cet environnement est restreint ; **aucun jeton ne lève
   une restriction réseau**. Le lien, public ou non, ne serait pas davantage
   ouvrable.

Corollaire : le lien annoncé est inutile ici, et le jeton le serait aussi. Rien
n'a été lu, copié, testé ni enregistré.

### 12.2 Ce qui atteint Vercel : les runners GitHub, pas ce bac à sable

Les runners GitHub ont un accès Internet complet, et `api.github.com` est
joignable d'ici. La seule voie praticable consiste donc à faire porter la
requête par un workflow, le jeton restant dans le magasin de secrets GitHub —
c'est-à-dire **sans qu'il transite jamais par cette conversation**.

Le workflow est préparé : `docs/security/patches/vercel-log-search.workflow.yml`,
**non installé**. Il est en lecture seule (`permissions: {}`), n'exécute que le
script vérifié hors ligne, et son déclencheur est restreint à la branche de
travail — `main` reste intacte.

### 12.3 Ce que mes propres contrôles ont trouvé dans ce workflow préparé

Le contrôle `test:workflow-policy`, exécuté sur une copie du fichier avant
installation, l'a refusé — et pour de bonnes raisons :

| Version du fichier | Résultat du contrôle |
|---|---|
| épinglé `# v4`, non déclaré au registre | **ECHEC A** (secret non déclaré), **ECHEC C** (`# v4` n'est pas un numéro de version complet), **ECHEC F** (job rattaché à un environnement non déclaré) |
| épinglé `# v4.4.0`, déclaré dans les deux compartiments | **9 vérifications ok, 0 échec** |

Trois enseignements : le contrôle C exige `vX.Y.Z` et pas `v4` ; un job rattaché
à un environnement doit être déclaré au registre au même titre qu'un secret ; et
un workflow préparé qui n'est pas passé au contrôle serait arrivé chez vous avec
trois alertes.

### 12.4 Le compromis de sécurité, énoncé plutôt que contourné

Un **secret de dépôt** est lisible par tout workflow déclenché sur un `push` de
n'importe quelle branche : tout collaborateur ayant le droit d'écriture peut
donc, s'il le veut, pousser un workflow qui le lit. C'est exactement le
mécanisme de l'incident 2C. Le fichier préparé place donc le jeton dans un
**environnement GitHub `vercel-log-search` avec relecteurs obligatoires** :
l'exécution attend une approbation explicite, et un workflow poussé par un tiers
ne peut pas lire le secret sans elle.

Le repli (secret de dépôt, sans environnement) fonctionne aussi et ne demande
aucune configuration : il n'ajoute aucune barrière, et c'est un choix à assumer.

### 12.5 Ce qu'il reste à faire, et par qui

| Étape | Qui | Nature |
|---|---|---|
| créer l'environnement `vercel-log-search` + relecteurs obligatoires | vous | réglage GitHub |
| créer le secret `VERCEL_READONLY_TOKEN` (jeton dédié, à portée minimale) | vous | manipulation de secret |
| installer le workflow sur la branche de travail | moi, **après votre accord** | niveau C |
| lire les journaux et conclure | moi | lecture, sans secret transmis |
| révoquer le jeton | vous | manipulation de secret |

**Le jeton n'a jamais à passer par cette conversation.** La seule chose qui doit
remonter jusqu'ici est la valeur de `error.message` — une phrase, aucun secret.

---

## 13. Test du relais GitHub : il ne peut pas tourner — et pourquoi

Après le refus du jeton, j'ai construit la seule voie qui atteignait Vercel
depuis cette session : faire porter la requête par un runner GitHub. **Le test
est concluant, mais négatif** : les workflows ne s'exécutent pas dans ce dépôt.

### 13.1 Ce que j'ai mesuré, dans l'ordre

| Mesure | Résultat |
|---|---|
| `gh api …/actions/workflows` | `CI` → **`disabled_manually`** ; `Figer la reference visuelle` → `active` |
| exécutions sur `arena/879cd8db-tracefab` (toutes dates) | **0** |
| dernière exécution du dépôt, toutes branches | **2026-10-10T10:18:56Z** |
| dernier push d'une branche | `arena/91844ee9-tracefab` : 2026-10-10T10:18:50Z ; **ma branche : 2026-10-12T10:19:55Z** |
| nouvelle exécution après l'installation de `vercel-log-search.yml` (attente de 80 s, 4 relevés) | **aucune** |
| vérifications attachées à mon commit `0de0601` | `Vercel Preview Comments` seulement — aucune vérification d'Actions |
| `gh api …/actions/secrets` (lecture **et** écriture) | **403** « Resource not accessible by integration » |

Autrement dit : mon push du 2026-10-12 n'a déclenché **aucun** workflow, y compris
le fichier de workflow que je venais d'installer. Les exécutions s'arrêtent au
2026-10-10T10:18:56Z, soit l'instant où `CI` a été désactivé manuellement.

### 13.2 Ce que cela ferme, définitivement

1. **Le relais GitHub est inerte** tant que les exécutions de workflows sont
   désactivées. Le fichier `.github/workflows/vercel-log-search.yml` est
   installé, déclaré au registre, validé par `test:workflow-policy` (0 échec) —
   et il ne s'exécutera pas. Il est conservé parce qu'il ne gêne rien et servira
   si les exécutions reviennent ; il peut être retiré sur demande.
2. **Je ne peux pas poser de secret** : lecture et écriture des secrets
   d'Actions répondent **403**. Même si un jeton m'était transmis, je n'aurais
   aucun moyen de le placer dans le magasin de secrets GitHub — donc aucun moyen
   de le faire servir.
3. **`workflow_dispatch` est fermé de toute façon** : le déclenchement manuel
   n'apparaît que si le fichier est présent sur la branche par défaut, et `main`
   ne doit pas être modifiée.

Ces trois points ne dépendent ni d'une règle de la session, ni d'une
autorisation : ce sont des constats.

### 13.3 Ce qui reste ouvert, et ce que cela coûte

| Voie | Ce que vous faites | Ce que je fais | Ce que cela suppose |
|---|---|---|---|
| **A. Tableau de bord** *(recommandée)* | onglet Logs du déploiement `6968252029`, rechercher `fd30b689-…` | je conclus, ou je corrige le §5.5 | rien |
| **B. Script local** | `sh scripts/diagnose_production_incident.sh` sur un poste qui joint Vercel | idem, à partir d'une sortie déjà caviardée | rien |
| **C. Relais GitHub** | réactiver les exécutions Actions, créer l'environnement `vercel-log-search` et son secret, puis déclencher une exécution par un commit depuis l'interface web (un push par intégration ne déclenche rien, c'est mesuré) | je lis les journaux par l'API et je conclus | une règle que vous avez fixée serait levée : c'est vous qui décidez |

**Aucune de ces voies ne demande que le jeton transite par cette conversation**,
et c'est heureux : la voie C elle-même exige qu'il soit saisi dans GitHub, pas
transmis ici. Le refus n'était donc pas un obstacle posé par principe ; c'est le
seul chemin qui existe.

### 13.4 Confirmations d'état

- `CI` est `disabled_manually` : **je n'ai touché ni son état, ni aucun réglage
  du dépôt**. Le seul fichier ajouté est `vercel-log-search.yml`, sur la branche
  de travail, sans privilège (`permissions: {}`), déclaré au registre.
- Batterie après installation : `test:workflow-policy` **0 échec**,
  `test:diagnose-incident` **0 échec**.
- Aucun secret n'a été créé, lu, modifié ou supprimé. Aucun jeton n'a transité.
- Aucune fusion, aucun déploiement, aucune migration : `main` intacte
  (`b0c976f`), production intacte.

---

## 14. Journalisation d'un incident d'hygiène : un identifiant d'accès a été collé dans la conversation

**2026-10-12.** Un identifiant d'accès Vercel a été collé directement dans le
message de l'utilisateur, accompagné de l'URL du site. Voici ce qui a été fait
de cet identifiant, et ce qui n'en a pas été fait. La valeur n'est reproduite
nulle part dans ce rapport.

### 14.1 Traitement : ni utilisé, ni copié, ni testé, ni stocké

| Vérification | Résultat |
|---|---|
| recherche sur tout le disque du bac à sable d'un fichier contenant ce préfixe (hors `node_modules` et `.git`), **en n'imprimant que les noms de fichiers** | **aucun fichier** — rien n'a été écrit, ni dans le dépôt, ni ailleurs |
| requête vers `https://tracefab.vercel.app/` (sans aucun identifiant) | **HTTP 000** |
| requête vers `https://api.vercel.com/v6/deployments` (sans aucun identifiant) | **HTTP 000** |
| `gh api …/actions/secrets` (dépôt) | **403** « Resource not accessible by integration » |

Aucune commande n'a contenu la valeur, aucun fichier ne la contient, aucun test
d'authentification n'a été tenté. Elle n'a servi à rien — et elle n'aurait rien
pu servir :

1. **l'accès réseau de cette session à Vercel est fermé** (HTTP 000, mesuré
   trois fois au cours de la journée, dont à l'instant) : aucun identifiant ne
   lève une restriction réseau ;
2. **je ne peux pas déposer d'identifiant dans un secret GitHub** (403 en
   lecture comme en écriture) : il n'existe donc aucun chemin par lequel un
   identifiant reçu ici pourrait être utilisé par un runner ;
3. les workflows ne s'exécutent plus dans ce dépôt depuis le
   2026-10-10T10:18:56Z (§13), donc le relais GitHub est lui aussi inerte.

### 14.2 Action demandée, et sa preuve

**Révoquer cet identifiant maintenant**, sans attendre la fin du travail : il
n'apporterait rien de plus, et il reste lisible dans l'historique de la
conversation.

Preuve de révocation, à produire sans divulguer la valeur :

1. la liste des jetons du compte (et, le cas échéant, ceux de l'équipe) ne doit
   plus le mentionner ;
2. un appel quelconque effectué avec lui doit répondre **401** ou **403** ;
3. si l'identifiant avait des consommateurs légitimes (CI, script local,
   intégration), ils doivent être identifiés **avant** la révocation, puis
   remplacés — un identifiant de diagnostic n'en a normalement aucun.

### 14.3 Ce que cet incident ne change pas

- Aucun secret n'a été créé, lu, modifié ou supprimé côté GitHub, Vercel ou
  Neon.
- `main` reste `b0c976f` ; `CI` reste `disabled_manually` ; la production n'a
  pas été touchée ; aucun déploiement n'a été déclenché.
- Le diagnostic de production reste **NON VÉRIFIÉ** : il manque toujours une
  ligne de journal, et cette ligne ne contient aucun secret.
