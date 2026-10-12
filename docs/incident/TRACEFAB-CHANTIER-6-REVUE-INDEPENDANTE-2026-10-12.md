# TRACEFAB — Chantier 6 : revue indépendante des chantiers 4 et 5, et décision de préparation à la fusion

**Date** : 2026-10-12 · **Nature** : revue technique et sécurité, **lecture seule** · **Aucune fusion, aucun déploiement, aucune migration, aucun secret touché, aucune CI réactivée, aucun réglage GitHub/Vercel/Neon modifié.**

Périmètre : les correctifs des chantiers 4 (privilèges PostgreSQL / audit Neon en lecture seule) et 5 (sécurisation CI, client Prisma, garde de cible), sur `arena/879cd8db-tracefab`. La revue est indépendante au sens où elle **re-teste les affirmations du rapport précédent** au lieu de les reprendre, et où une divergence trouvée par un test différentiel a été corrigée dans la foulée.

Repères : `main` = **`b0c976f`** · branche de revue = **`601bde5`** (38 commits, 47 fichiers, +9562/−109) · `securite/ci-sans-secret-depuis-main` = **`826bc11`** (1 commit, 1 fichier) · PR #36 = brouillon, tête `601bde5`.

---

## 1. État exact du dépôt

### 1.1 SHA et têtes

| Référence | SHA | Contenu |
|---|---|---|
| `main` (local et `origin/main`) | `b0c976f` | production |
| `arena/879cd8db-tracefab` (HEAD et `origin`) | `601bde5` | 38 commits, 47 fichiers, +9562/−109 |
| `securite/ci-sans-secret-depuis-main` (`origin`) | `826bc11` | 1 commit, 1 fichier, 2+/18− |
| PR #36 | ouverte, **brouillon**, tête `601bde5`, 47 fichiers, `MERGEABLE/CLEAN` | |

Arbre de travail **propre** : `git status --porcelain` vide. Il n'existe **aucune modification non commitée**, y compris à la fin de cette revue.

### 1.2 Le commit `50c41df` contient-il les correctifs revendiqués ? — **oui, vérifié fichier par fichier**

Le commit annoncé aux tours précédents existe et son arbre contient :

- les **cinq patches** `docs/security/patches/ci-experience-chantier-{16,17,18,19,20}-job-base-sans-faux-vert.patch` ;
- les **sept scripts durcis** (`scripts/lib/require-throwaway-db.mjs`, `scripts/prisma-generate.mjs`, `scripts/verify_prisma_client.mjs`, `scripts/test_prisma_client_check.mjs`, `scripts/test_workflow_policy.mjs`, `scripts/test_workflow_policy_detection.mjs`, `scripts/test_db_target_guard.mjs`).

Deux contrôles complémentaires, parce que « le fichier est là » ne prouve pas « le contenu est celui annoncé » :

- `git merge-base --is-ancestor bff267b 50c41df` → **vrai** : le commit qui avait rattrapé le patch `chantier-20` oublié est bien un ancêtre. La revendication « cinq patches » du commit `50c41df` est donc exacte ;
- exécution du test de la garde **dans l'arbre de `50c41df`** (copie de travail détachée, `node_modules` partagé) : **35 vérifications passées, 0 échec** — la revendication de ce commit-là, mesurée à ce commit-là ;
- le patch `chantier-20` y est **identique au bit** à celui d'aujourd'hui (sha256 `46bd7ac9…` sur les deux arbres).

Ce qui est venu après `50c41df` (7 commits) n'a modifié **aucun** fichier de code du périmètre 4/5 : uniquement des documents, plus l'outillage de recherche Vercel et `package.json`. La revendication n'est donc pas invalidée par la suite.

### 1.3 Fichiers manquants, commits redondants, corrections présentes sur une seule branche

- **Fichiers manquants : aucun.** Les **111** scripts `package.json` ont été vérifiés : **97** fichiers référencés, **0 manquant**. Les scripts qui échouent aujourd'hui échouent pour une raison d'environnement, pas de fichier absent.
- **Travail annulé : aucun.** Pour chacun des 47 fichiers modifiés, `git diff main..HEAD -- <fichier>` a été testé : **aucun** ne revient au contenu de `main`. Rien n'a été modifié puis annulé.
- **Commits redondants : aucun commit neutre.** Le plus fort *churn* est concentré là où il est attendu pour un durcissement itératif : `docs/incident/TRACEFAB-CHANTIER-5-RAPPORT…` (10 commits), `require-throwaway-db.mjs` (4), `audit_neon_readonly.mjs` / `test_destructive_suite_routing.mjs` / `test_neon_privileges.mjs` / `test_workflow_policy.mjs` / `test_db_target_guard.mjs` / `verify_prisma_client.mjs` (3 chacun). Aucun de ces commits n'est un doublon d'un autre : chacun ajoute une correction ou une mesure.
- **Corrections présentes sur une seule branche** — c'est le point le plus important de cette section, et il est mesuré, pas supposé :

| Élément | `securite/ci-sans-secret-depuis-main` | PR #36 |
|---|---|---|
| retrait des lectures réelles de `secrets.DATABASE_URL` | **oui** (2 supprimées) | **oui** (2 supprimées) |
| base jetable montée par le job | déjà présente sur `main`, conservée | conservée |
| `test:neon:rls` réellement exécuté | oui (hérité de `main`) | oui |
| épinglage des actions par SHA | non | **oui** (9 actions) |
| garde de cible + lanceur gardé | non | **oui** |
| vérification du client Prisma | non | **oui** |
| politique des workflows | non | **oui** |
| audit Neon / privilèges (chantier 4) | non | **oui** |

Les deux branches ne se cumulent pas : appliquer le patch court sur l'arbre de la PR échoue (`error: patch failed: .github/workflows/ci.yml:8`), parce que toutes deux remanient le **même hunk** — la variable `TF_SECRET_PRODUCTION` et l'étape « Scénarios croisés contre la base de production ». **Une seule des deux doit être retenue** (§5).

---

## 2. Revue du correctif Prisma

### 2.1 Le code, tel qu'il est

| Fichier | Rôle | Commit |
|---|---|---|
| `scripts/prisma-generate.mjs` | `postinstall` : localise le CLI local, refuse le contournement en déploiement, génère, **puis exécute lui-même la vérification** (lignes 119-132) | `4545759`, `b0d332f`, `50acb92` |
| `scripts/verify_prisma_client.mjs` | contrôle de comportement : construction, `$transaction`, `$disconnect`, un délégué par modèle déclaré, moteur de requêtes | `4545759`, `2d03cc4`, `50acb92` |
| `scripts/test_prisma_client_check.mjs` | éprouve ce contrôle dans les deux sens (5 états de client, 5 cas de contournement) | `4545759`, `2d03cc4`, `50acb92` |
| `package.json` | `postinstall` ajouté, `verify:prisma-client` en tête de `build`, `@prisma/client` remonté en `dependencies` | `0a7df1b` … `3ba3064` |

**Point de conception que je n'avais pas suffisamment mis en avant :** la vérification est appelée **dans le même processus** que la génération (`prisma-generate.mjs` l'exécute à la fin). Ce n'est pas un détail : le `vercel.json` déployé porte un tableau `builds`, ce qui fait **ignorer les réglages de build du projet** — donc `npm run build`, et la vérification qu'il contient, ne sont pas garantis sur Vercel. L'installation est le seul passage obligé, et c'est là que le contrôle est branché. La protection ne repose donc pas sur une étape que la plateforme pourrait ne pas exécuter.

### 2.2 Ce qui est démontré, par exécution du **vrai** code du dépôt

Montage : copie de travail du dépôt, `node_modules` privé où **tout est lié à l'arbre réel**, sauf deux artefacts que l'environnement rend impossibles à obtenir — le CLI Prisma (qui exige `binaries.prisma.sh`, injoignable : cache local **vide**, vérifié) et le client généré. Aucune autre ligne de code n'est substituée.

| Cas | Montage | Attendu | Obtenu |
|---|---|---|---|
| A | `npm run postinstall`, CLI réel | échec non nul | **1** — « prisma generate a retourne 1 » |
| B | `VERCEL=1 PRISMA_SKIP_POSTINSTALL_GENERATE=true` | refus | **1** — « REFUS … Contexte detecte : VERCEL=1 » |
| C | `VERCEL_ENV=production` + contournement | refus | **1** — « Contexte detecte : production » |
| D | contournement **hors** déploiement | honoré | **0** — avec le rappel que la vérification reste exigée |
| E | `verify:prisma-client` sans client | échec | **1** — `Cannot find module '.prisma/client/default'` |
| F | CLI sort 0, **rien** n'est généré | échec | **1** — « le client genere ne passe pas la verification » |
| G | CLI sort 0, un **stub** est généré | échec | **1** — « le client est le repli factice » |
| I | client complet **sans moteur** | échec | **1** — « aucun moteur de requetes … 3 fichiers » |
| J | client + moteur **sans `$disconnect`** | échec | **1** — « surface de client imitee » |
| **H** | client **conforme** (45 délégués dérivés du schéma + moteur) | succès | **0** — « client Prisma genere et verifie » |

Le cas **H est le témoin négatif** sans lequel les neuf autres ne prouveraient rien : il établit que le contrôle n'échoue pas par construction.

**Le vrai `npm run build`, lui aussi exécuté** — deux fois :

1. avec le CLI réel : `db:generate` échoue → **build en erreur 1**, et les sous-commandes réellement lancées sont `build` puis `db:generate`, **rien d'autre** : `typecheck`, `api:typecheck`, `schema:static` ne sont jamais atteints ;
2. avec le CLI qui sort en 0 mais un client invalide : les sous-commandes lancées sont `build`, `db:generate`, `verify:prisma-client` → **arrêt en 1**, aucune étape ultérieure. C'est la démonstration demandée : *le build ne peut pas être déclaré réussi avec un client Prisma invalide*.

Le test du dépôt sur les états de client (`npm run test:prisma-client`) : **10 vérifications ok, 0 échec** (5 états de client + 5 cas de contournement).

### 2.3 Verdict Prisma

**Prêt pour revue de fusion, avec une réserve tracée.** Tout ce qui est vérifiable ici l'est, y compris le build réel du dépôt ; la réserve est qu'**aucun cycle réel de génération Prisma n'a pu être exécuté dans cet environnement** (réseau des binaires fermé, cache vide). Un premier passage de CI **avec réseau** doit confirmer que le contrôle accepte le client réellement généré — un point que je ne peux pas anticiper, seulement surveiller. La CI du commit de production montre par ailleurs que `npm run db:generate` **réussit** dans l'environnement GitHub, ce qui réduit ce risque sans le supprimer.

---

## 3. Revue de la garde PostgreSQL

### 3.1 Une faille réelle trouvée par cette revue, et fermée

La garde n'est utile que si elle classe **la même cible que le pilote**. Ce n'est pas une opinion : c'est défini par `pg-connection-string`, la bibliothèque que `pg` utilise pour lire une chaîne de connexion. J'ai donc écrit un test **différentiel** qui compare la classification de la garde à l'hôte que le pilote produit réellement.

Il a trouvé ceci, immédiatement :

```
postgresql://u:p@db.interne:5432/base?host=localhost&host=ep-x.eu-central-1.aws.neon.tech
  hôte joint par le pilote : ep-x.eu-central-1.aws.neon.tech   (la DERNIÈRE valeur gagne)
  verdict de la garde      : ACCEPTÉE — « throwaway_local »
```

Cause : `pg-connection-string` fait `config[clé] = valeur` sur chaque entrée de `searchParams`, donc **la dernière écrase les précédentes** ; la garde lisait la **première** avec `searchParams.get('host')`. Une suite destructive passait donc contre un hôte manage — précisément ce que la garde est censée empêcher. **Les 35 vérifications existantes ne couvraient pas ce cas**, et le rapport précédent affirmait « l'hôte réellement joint » : l'affirmation était fausse dans ce cas.

**Correction** (`scripts/lib/require-throwaway-db.mjs`) : `host=` répété avec des valeurs **différentes** ⇒ cible non classable avec certitude ⇒ **refus**, code `ambiguous_host_param`. Valeurs identiques ⇒ pas d'ambiguïté ⇒ acceptation. Choix assumé de refuser plutôt que de suivre le pilote : une configuration légitime ne répète jamais ce paramètre, et une cible qu'on ne peut pas classer ne doit pas produire d'autorisation. Un second défaut, du côté sûr, a été corrigé au passage : `new URL` refuse une autorité vide avec identifiants (`postgresql://u:p@/base?host=/var/run/postgresql`), que le pilote accepte — la garde classait donc « non analysable » une socket Unix légitime. Elle applique désormais la même normalisation que le pilote.

### 3.2 Les 35 vérifications annoncées — et les 8 nouvelles

Le rapport précédent annonçait 20 vérifications, puis 35. Les deux chiffres sont exacts **à des dates différentes** ; l'exécution actuelle donne **43 vérifications, 0 échec** :

- **A** (5) acceptations : `localhost`, `127.0.0.1`, socket Unix, cible distante explicitement autorisée, hôte effectif déclaré par paramètre ;
- **B** (13) refus : contexte de production même en local, hôte managé sans/malgré opt-in, contournement par `?host=`, hôte effectif hors liste blanche, nom de base évoquant la production, valeur absente ou illisible… ;
- **C** (2) non-fuites : aucune valeur sensible dans le message de refus, empreinte corrélable publiée ;
- **D** (15) formes : socket encodée, IPv6, majuscules, point final, valeurs encodées (`%65p…`, `prod%2Dduction`), `mysql://`, URL sans schéma, loopback décimal, hôte vide, espaces ;
- **E** (8, **ajoutées par cette revue**) : `host=` répété (local puis managé) refusé ; `host=` répété (managé puis local) refusé ; `host=` répété à valeurs identiques accepté ; `HOST` en majuscules suivi comme le pilote ; socket Unix avec identifiants reconnue locale ; idem encodée ; autorité vide sans paramètre refusée ; `hostaddr=` seul sans effet sur le verdict.

**Nouveau contrôle permanent** : `scripts/test_db_guard_vs_driver.mjs` (`npm run test:db-guard-driver`), **12 vérifications, 0 échec**, branché dans `npm run build`. Il ne rejoue pas des cas choisis à la main : il **dérive l'attendu de la sortie du pilote** sur une table de 12 URL, et vérifie trois invariants — un hôte managé ne sort jamais accepté ; une cible ambiguë ne sort jamais acceptée ; une cible locale reste utilisable. L'écart assumé au troisième invariant (cible ambiguë dont le pilote joindrait un hôte local) est **vérifié explicitement**, pas contourné en affaiblissant l'invariant.

### 3.3 Où la garde est appelée

| Chemin | Point d'appel | Statut |
|---|---|---|
| 12 entrées npm (`test:neon:security`, `:supplier`, `:product`, `:quality`, `:collection`, `test:supplier-advanced`, `:bulk`, `:wallet`, `:storage`, `test:neon:privileges`, `db:seed-rls`, …) | `scripts/run-db-suite.mjs` → `requireThrowawayDb()` | **gardé** |
| suites exécutées à la main, par un script d'exploitation ou un futur workflow | même lanceur : la garde est dans le chemin d'exécution, pas dans le workflow | **gardé** |
| `npm run test:neon:rls` → `node scripts/test_rls_isolation.mjs` | **appel direct, sans garde** | voir ci-dessous |

Ce dernier point mérite d'être dit clairement, car il nuance une formulation du rapport précédent. Le contrôle `test:workflow-policy` **exclut volontairement** `test:neon:rls` de la règle « suite de base = doit passer par la garde » (`/npm\s+run\s+test:neon(?!:rls)/`), et j'ai vérifié la raison : `scripts/test_rls_isolation.mjs` ne contient **aucune instruction modificatrice** — ni `CREATE`, ni `INSERT`, ni `UPDATE`, ni `DELETE`, ni `GRANT`, ni `REVOKE`, ni `DROP`, ni `SET ROLE`. C'est une suite de **lecture**. Le classer en « destructive » était donc une fausse alerte, et le corriger en garde l'aurait été aussi.

En revanche, deux conséquences factuelles que je ne masque pas :

1. pointée vers un hôte manage, cette suite **ne refuse pas** : elle tente la connexion et échoue brutalement (mesuré : sortie 1, trace `pg` brute). Il n'y a pas de risque de **modification**, mais il y a un risque de **lecture** de données non destinées, et un message d'erreur peu exploitable ;
2. `main` appelle par ailleurs `node scripts/seed_rls_fixture.mjs` **en direct** dans son job de base — ce script, lui, crée un rôle et des données, et n'est donc **pas gardé** sur `main`. La PR #36 corrige ce point (`npm run db:seed-rls`, donc via la garde).

### 3.4 Verdict garde PostgreSQL

**Corrections supplémentaires nécessaires, mais une seule, et elle vient d'être faite.** La faille trouvée par le différentiel est fermée et verrouillée par deux jeux de témoins. Restent deux points ouverts, de moindre gravité : garder (ou non) `test:neon:rls` par sa propre garde en lecture seule — utile si la suite est un jour pointée vers une base réelle — et la classification des cibles ambiguës, qui refuse aussi des cibles locales (choix assumé, documenté, vérifié).

---

## 4. Revue des cinq workflows `experience/*`

Extractions **fraîches** depuis `origin` (pas de copies anciennes), une par branche : `chantier-16-securite-performance`, `-17-ci`, `-18-production`, `-19-commercial`, `-20-coherence`.

### 4.1 Ce que disent les cinq fichiers

| Mesure | 16 | 17 | 18 | 19 | 20 |
|---|---|---|---|---|---|
| `sha256` du `ci.yml` | `7290dae9…` | `72f72f56…` | `7290dae9…` | `7290dae9…` | `7290dae9…` |
| service Postgres jetable | **aucun** | aucun | aucun | aucun | aucun |
| invocations `test:neon:*` | 5 | 5 | 5 | 5 | 5 |
| dont **`test:neon:rls`** | **0** | **0** | **0** | **0** | **0** |
| conditions `steps.secret.outputs.present` | 3 | 3 | 3 | 3 | 3 |
| lectures de `secrets.` | 2 | 2 | 2 | 2 | 2 |
| nom du job de base | « Base — isolation RLS executee » (identique sur les cinq) | | | | |

Le job, verbatim :

```yaml
  base-de-donnees:
    name: Base — isolation RLS executee
    ...
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - name: Verifier la presence du secret
        id: secret
        run: |
          if [ -n "${{ secrets.DATABASE_URL }}" ]; then … present=true
          else … present=false ; echo "::notice::DATABASE_URL absent : les scenarios croises executes sont sautes."
      - name: Installer les dependances
        if: steps.secret.outputs.present == 'true'
      - name: Generer le client Prisma
        if: steps.secret.outputs.present == 'true'
      - name: Scenarios croises executes contre Postgres
        if: steps.secret.outputs.present == 'true'
        env: { DATABASE_URL: "${{ secrets.DATABASE_URL }}" }
        run: npm run test:neon:security … :supplier … :product … :quality … :collection
```

### 4.2 Réponses aux cinq questions posées

1. **`test:neon:rls` est-il appelé ?** **Non, sur aucune des cinq** — 0 occurrence, alors qu'il est appelé une fois sur `main` et une fois sur la PR #36.
2. **Des étapes sont-elles sautées sans `DATABASE_URL` ?** **Oui, toutes celles de base** : trois conditions couvrent l'installation, la génération et les cinq suites. Sans secret, le job se termine **vert sans avoir rien exécuté**.
3. **Les tests requis peuvent-ils être ignorés en laissant le job vert ?** **Oui — c'est le défaut.** Nuance importante : **le nom du job ne correspond pas à ce qui est exécuté**. Il annonce « isolation RLS exécutée » ; le fichier ne contient aucune invocation RLS, et exécute à la place cinq suites croisées. Le mensonge est donc double : le job est vert sans rien faire, et son nom désigne un contrôle absent.
4. **Les noms de jobs correspondent-ils aux contrôles exécutés ?** **Non sur les cinq.** Sur `main` et sur la PR #36, **oui** : le job s'appelle « Base — isolation RLS executee » et exécute réellement `npm run test:neon:rls` après avoir migré la base jetable et créé le rôle `tracefab_app` et deux locataires.
5. **La base jetable est-elle explicitement configurée, et les tests échouent-ils si elle manque ?** **Non sur les cinq** (aucun service Postgres, aucune variable de connexion jetable : la cible vient d'un secret). **Oui sur `main` et la PR #36** : service `postgres:17` avec `health-cmd pg_isready`, `DATABASE_URL` posé sur `localhost:5432/tracefab_test`, et `TF_RLS_APP_URL` sur un rôle sans `BYPASSRLS`.

La suite RLS elle-même **échoue si la base manque** : exécutée sans `DATABASE_URL`/`TF_RLS_APP_URL`, elle sort en **2** avec « NON EXECUTE — un test qui ne tourne pas ne vaut pas un test qui passe ». Elle ne peut donc pas être « verte sans s'exécuter » — le défaut des cinq branches vient du **workflow**, pas de la suite.

### 4.3 Les patches préparés

Ré-application **fraîche** des cinq patches sur les cinq extractions, puis mesure du contrôle de politique :

| Branche | Applicabilité | Alerte I avant | Alerte I après |
|---|---|---|---|
| `experience/chantier-16-securite-performance` | **APPLICABLE** | 1 | **0** |
| `experience/chantier-17-ci` | **APPLICABLE** | 1 | **0** |
| `experience/chantier-18-production` | **APPLICABLE** | 1 | **0** |
| `experience/chantier-19-commercial` | **APPLICABLE** | 1 | **0** |
| `experience/chantier-20-coherence` | **APPLICABLE** | 1 | **0** |

Le patch renomme le job selon ce qu'il exécute (« Base — scenarios croises executes ») et remplace la notice « `present=false` » par un `::error::` suivi de `exit 1` : **le job ne peut plus être vert sans exécuter la suite qu'il annonce**. Les patches restent **non appliqués** sur vos branches : c'est une écriture, elle attend votre accord.

### 4.4 Distinction demandée : contrôle de politique ≠ exécution de la suite RLS

Ce sont deux choses différentes, et elles ne se remplacent pas :

- `test:workflow-policy` (section I) est un **contrôle de texte et de structure** : il lit le YAML, reconnaît les noms affichés des jobs et vérifie qu'un job de base contient au moins une étape de base **non conditionnée**. Il est éprouvé par 11 témoins (`test:workflow-policy-temoins`). Il **n'exécute aucune suite RLS** et ne dit rien de la base ;
- `npm run test:neon:rls` **exécute** réellement l'épreuve d'isolation, contre une base. C'est la seule chose qui prouve l'isolation, et elle exige une base jetable — donc du temps de CI.

Un rapport qui confondrait les deux conclurait « l'isolation est vérifiée » sur la base d'un contrôle de texte. Ce n'est pas ce que je fais ici : sur les cinq branches, **aucune** preuve d'isolation n'existe aujourd'hui, ni par exécution, ni par nom de job.

### 4.5 Verdict workflows CI

**Corrections supplémentaires nécessaires.** Trois raisons, toutes mesurées : les cinq branches restent vertes à vide (patch préparé, non appliqué) ; `main` lit encore deux fois un secret de base ; et surtout, **les cinq branches portent une variante plus ancienne du `ci.yml`** — 244 lignes contre 286 sur `main` — où le job est conditionné au secret, où `test:neon:rls` est absent et où l'étape de production n'existe pas. **Fusionner une de ces branches en l'état régresserait la CI de `main`** (§5).

---

## 5. Comparaison des deux stratégies CI et stratégie unique proposée

### 5.1 Les deux correctifs, côte à côte

| | `securite/ci-sans-secret-depuis-main` (`826bc11`) | PR #36 (`601bde5`) |
|---|---|---|
| Nature | retrait ciblé, 20 lignes | refonte + garde-fous, 47 fichiers |
| Lectures réelles de `secrets.` | **0** (2 supprimées) | **0** (2 supprimées) |
| Étape « Scénarios croisés contre la base de production » | supprimée | supprimée |
| `TF_SECRET_PRODUCTION` | supprimé | supprimé |
| Base jetable | conservée (déjà sur `main`) | conservée |
| Actions épinglées SHA | non | **oui** (9) |
| Garde de cible + lanceur | non | **oui** |
| Vérification du client Prisma | non | **oui** |
| Politique des workflows | non | **oui** |
| Recommandation avant fusion | **aucune** | **aucune** |
| Revue « Test » du propriétaire | requise (fichier de workflow) | non requise (aucun fichier de workflow sous `.github/`) |

Le seul contenu que la branche courte apporte et que la PR n'a pas est **rédactionnel** : deux commentaires mieux tournés. Tout le reste du contenu de sécurité de la branche courte est **inclus** dans la PR #36.

### 5.2 Stratégie unique recommandée

**Retenir la PR #36 comme véhicule unique**, et traiter la branche courte comme un doublon à éteindre.

**À conserver (PR #36) — liste précise :**

1. `.github/workflows/ci.yml` : suppression des **deux** lectures réelles de `secrets.DATABASE_URL` (`TF_SECRET_PRODUCTION` et l'`env:` de l'étape de production) et de l'étape « Scénarios croisés contre la base de production » ;
2. remplacement de `node scripts/seed_rls_fixture.mjs` par `npm run db:seed-rls` (**c'est la seule correction de `main` que la branche courte ne fait pas**) ;
3. épinglage des **9** actions par SHA avec version lisible ;
4. les **5** étapes de contrôle ajoutées au job `socle` (`test:db-guard`, `test:db-routing`, `test:workflow-policy`, `test:prisma-client`, `verify:prisma-client`, `test:router-load`) ;
5. le service Postgres jetable et les variables de connexion jetables du job base (hérités de `main`, conservés) ;
6. `scripts/lib/require-throwaway-db.mjs` + `scripts/run-db-suite.mjs` + les 12 entrées npm gardées ;
7. `scripts/prisma-generate.mjs`, `scripts/verify_prisma_client.mjs`, `scripts/test_prisma_client_check.mjs`, et le `postinstall` + `verify:prisma-client` de `package.json` ;
8. `scripts/test_workflow_policy.mjs`, `scripts/test_workflow_policy_detection.mjs`, le registre `docs/security/workflow-privileged-allowlist.json` ;
9. `scripts/audit_neon_readonly.mjs`, `scripts/test_audit_neon_readonly.mjs`, `scripts/test_neon_privileges.mjs` (chantier 4) — **le code**, pas la migration.

**À éliminer (doublon) :** la branche `securite/ci-sans-secret-depuis-main`, **dont le contenu de sécurité est intégralement repris** au point 1 ci-dessus. Deux options, à votre choix : la **fermer** avec ce motif écrit, ou la **conserver au repos** comme filet court si la PR #36 devait être retardée. Dans les deux cas, **ne pas fusionner les deux** : c'est impossible sans conflit (mesuré).

**Cas particulier du chantier 4 :** la migration `prisma/migrations/20261012120000_close_public_execute_gap` doit **rester séparée de la fusion**. C'est un changement de privilèges en production — niveau D — et il doit être précédé de l'audit en lecture seule qui montrera ce qui dépend de ces privilèges.

### 5.3 Avertissement pour la suite : ne pas fusionner les `experience/*` telles quelles

C'est la conclusion opérationnelle la plus utile de cette revue. Le `ci.yml` des cinq branches est une **variante ancienne** du fichier de `main` (244 lignes contre 286) :

- `main` : pas de conditionnement au secret, base jetable, `test:neon:rls` exécuté, étape de production optionnelle ;
- `experience/*` : conditionnement au secret (3 conditions), **pas de `test:neon:rls`**, pas d'étape de production.

Une fusion de ces branches **reviendrait à réintroduire le job vert à vide** et à retirer l'épreuve d'isolation. Si ces branches doivent un jour rejoindre `main`, la consigne est : **garder le `ci.yml` de `main`**, écarter le leur pour ce fichier, et appliquer le principe « pas de vert sans exécution » par les patches déjà préparés si un de leurs jobs reste.

---

## 6. État de production — quatre catégories, strictement séparées

### 6.1 Le mécanisme, reproduit sur l'arbre déployé (`b0c976f`)

Reproduction exécutée ce jour, sur l'arbre exact du commit déployé, dans trois états :

| État du client Prisma | `/api/health` | `/api/catalog/schemas` | Ligne de journal |
|---|---|---|---|
| **absent** | **500** `{"error":"internal_error","correlationId":"03189fe9-…"}` | **200**, 3 schémas (`material-data-core`, `product-data-core`, `supplier-profile-core`) | 1 ligne, `SyntaxError : The requested module '@prisma/client' does not provide an export named 'PrismaClient'` |
| conforme | **200** `{"ok":true,"service":"tracefab-api"}` | 200, mêmes schémas | **0** ligne |
| base injoignable | **503** `database_unavailable` (message de la route, non JSON) | 200 | 1 ligne `GET /api/health failed Error: P1001` |

Le couple observé en production — 500 avec identifiant **et** catalogue 200 avec trois schémas — **coïncide à l'identique** avec le premier état. C'est une reproduction fidèle, pas un constat.

### 6.2 Les observations de l'utilisateur

- `GET /api/health` → `internal_error` avec l'identifiant `fd30b689-f50f-44f0-a0dd-43e5e1e51f0e` ;
- `GET /api/catalog/schemas` → 200 avec les trois schémas.

Ces deux observations sont la seule information **directe** sur la production dont nous disposons. Elles ne disent pas *quelle* exception a été levée.

### 6.3 Ce qui reste non vérifié

- **Les journaux d'exécution Vercel** : non atteignables depuis cette session (réseau fermé, mesuré trois fois ce jour : `tracefab.vercel.app` et `api.vercel.com` en **HTTP 000**) et, pour le déploiement d'origine, **expirés** — la rétention d'exécution est d'une heure en Hobby et d'un jour en Pro ; le déploiement date du 2026-10-09. **Aucune ligne de journal de production n'a été lue.**
- **Les journaux de build**, eux, sont conservés pour la durée de vie du déploiement et **restent à consulter** par vous : liens directs vers les deux déploiements du commit `b0c976f` au §15.2 du rapport du chantier 5. Une seule recherche, `prisma`, tranche.
- **La cause en production n'est donc pas prouvée.** Elle reste **NON VÉRIFIÉE**, et le mot est choisi : le mécanisme est reproduit à l'identique, la cause n'est pas constatée.

### 6.4 L'état réel du code déployé

- `api/_routes/health.ts` importe `prisma` **au niveau module** (`import { prisma } from '.././_lib/prisma.js'`) : si le module ne se charge pas, le `try/catch` de la route n'est jamais atteint — d'où un 500 venant de la barrière d'erreur et non un 503 de la route ;
- `api/index.ts` entoure le **chargement dynamique** du module et l'appel du gestionnaire : c'est lui qui produit `{error:'internal_error', correlationId}` ;
- **aucune instrumentation `phase: module_load|handler`** n'existe dans le code déployé (le champ est absent du payload de `b0c976f`) — la repro le confirme : `phase=ABSENTE`. L'instrumentation plus riche n'est **pas déployée** ;
- `vercel.json` déployé contient un tableau `builds`, donc **les réglages de build du projet sont ignorés** ;
- `api/_lib/error-reporting.ts` **existe** sur `main` et écrit toujours sur `console.error`, avec un envoi facultatif vers `TRACEFAB_ERROR_WEBHOOK_URL`.

**Aucun déploiement n'a été effectué pour obtenir une preuve manquante**, et aucun ne le sera sans votre ordre.

---

## 7. Tests exécutés ce jour et sorties

Batterie complète, code de sortie lu explicitement (`.cache/harness/batterie.sh`) :

```
test:db-guard                OK      test:neon:privileges         OK
test:db-guard-driver         OK      test:neon:rls                OK
test:db-routing              OK      test:error-reporting         OK
test:workflow-policy         OK      schema:static                OK
test:workflow-policy-temoins OK      test:security:chantier1      OK
test:prisma-client           OK      test:routes                  OK
test:diagnose-incident       OK      test:production-readiness    OK
test:audit-script            OK      test:cross-tenant            OK
----
echecs: 0
```

Mesures unitaires : garde de cible **43 vérifications / 0 échec** ; différentiel garde-pilote **12 / 0** ; client Prisma **10 / 0** ; politique des workflows **0 échec** ; témoins de détection **11 / 0**.

Exécutions réelles du build : `npm run build` **en erreur 1** dans les deux scénarios (génération en échec ; génération « réussie » avec client invalide), avec arrêt à l'étape correspondante et aucune étape ultérieure atteinte.

Hors ligne, sans réseau : `test:diagnose-incident` **20 vérifications / 0 échec** (jeton absent, refus 403, ligne trouvée avec secrets masqués, absence, lecture seule, refus des autres hôtes et des écritures).

**Aucun test destructif n'a été exécuté contre une base réelle ou partagée.** Toutes les vérifications de la garde sont des appels à une **fonction pure de classification** ; les seules connexions tentées l'ont été vers `127.0.0.1:1` (port fermé) ou vers un hôte manage **injoignable**, et se sont soldées par un échec de connexion.

---

## 8. Problèmes corrigés et problèmes restants

**Corrigés dans cette revue** : le contournement de la garde par `host=` répété (faille réelle, fermée et verrouillée) ; le refus d'une socket Unix légitime avec identifiants ; l'ajout d'un contrôle différentiel permanent contre le pilote. **Corrigés aux chantiers précédents et revérifiés ici** : installation verte sans client Prisma ; contournement par `VERCEL=1` ; hôte managé accepté via point final ou `?host=` ; job vert sans exécution (patches prêts) ; lecture d'un secret de base par la CI (deux lectures, supprimées sur la branche).

**Restants, avec leur nature :**

| # | Problème restant | Nature |
|---|---|---|
| 1 | `main` lit encore deux fois `secrets.DATABASE_URL` | correction prête, **décision de fusion** |
| 2 | Les 5 branches `experience/*` : job vert sans exécution, `test:neon:rls` absente, `ci.yml` plus ancien que celui de `main` | patches prêts, **accord requis** |
| 3 | Les workflows **ne s'exécutent plus** : `CI` est `disabled_manually`, dernière exécution du dépôt le 2026-10-10T10:18:56Z, aucun déclenchement sur ma branche | **réglage GitHub**, votre décision |
| 4 | La cause de production n'est pas constatée (journaux d'exécution expirés) | **preuve manquante** |
| 5 | Migration de privilèges SQL non appliquée | **niveau D**, décision explicite ; audit préalable |
| 6 | `test:neon:rls` non gardé (lecture seule) et `seed_rls_fixture.mjs` appelé en direct sur `main` | mineur pour le premier, corrigé par la PR pour le second |
| 7 | Le contrôle du client Prisma n'a jamais vu un client **réellement** généré | **réserve de vérification** |

---

## 9. Contrôles bloqués, et leur raison exacte

| Contrôle bloqué | Raison exacte |
|---|---|
| Lire les journaux d'exécution de production | réseau sortant fermé vers `tracefab.vercel.app` et `api.vercel.com` (**HTTP 000**, trois mesures ce jour) **et** rétention expirée (1 h / 1 j) |
| Chercher `fd30b689-…` | même raison : la ligne n'existe plus. Les journaux de **build**, eux, sont consultables par vous (liens au §15.2 du rapport 5) |
| Lire ou écrire les secrets GitHub | `…/actions/secrets` → **403** en lecture **et** en écriture : je ne peux ni inventer, ni déposer, ni vérifier un secret |
| Vérifier la protection de `main` en détail | `…/branches/main/protection` → **403** |
| Lire les permissions Actions du dépôt | `…/actions/permissions` → **403** |
| Exécuter la CI | `CI` est `disabled_manually` et la dernière exécution date du 2026-10-10 : un workflow neuf poussé sur ma branche n'a **rien** déclenché (4 relevés sur 80 s) |
| Générer réellement le client Prisma | `binaries.prisma.sh` injoignable et cache local **vide** : aucun cycle de génération réel possible ici |
| Audit des privilèges Neon | pas de réseau vers Neon, et aucune chaîne d'accès fournie par un mécanisme sécurisé |

---

## 10. Risques résiduels

1. **Prisma** : le contrôle de conformité n'a jamais validé un client **réellement** produit par `prisma generate` ; un premier passage de CI avec réseau doit le confirmer. Si le contrôle rejetait un client valide, c'est le contrôle qu'il faudra corriger — pas le client.
2. **Garde** : refuser les cibles ambiguës refuse aussi des cibles locales légitimes (choix assumé). Le jeu de formes d'URL testé reste fini : 43 vérifications + une table différentielle de 12 formes ne couvrent pas toutes les syntaxes acceptées par libpq.
3. **CI** : tant que les exécutions sont désactivées, **aucun** des correctifs CI n'est éprouvé en conditions réelles. Ce qui est prouvé ici l'est par tests locaux, et cela ne remplace pas une exécution.
4. **Cinq branches `experience/*`** : fusionner l'une d'elles en l'état **régresserait** la CI de `main` (job conditionné au secret, `test:neon:rls` absente).
5. **RLS / privilèges** : la migration préparée n'a été **ni auditée en production**, **ni appliquée**. La révocation d'`EXECUTE` pour `PUBLIC` peut casser des appelants légitimes : l'audit doit passer avant.
6. **Production** : le correctif Prisma empêche la réapparition du mécanisme ; il ne **prouve** pas que le déploiement en place est dans cet état. Si le client était en réalité présent et l'erreur d'une autre nature, ce serait le §6.1 qui devrait être révisé.
7. **`main` lit toujours un secret de base** : aussi longtemps que c'est le cas, tout workflow déclenché sur un `push` peut y accéder — c'est le mécanisme de l'incident 2C.

---

## 11. Verdicts par domaine, et conclusion

| Domaine | Verdict | Motif, en une ligne |
|---|---|---|
| **Prisma** | **Prêt pour revue de fusion, avec réserve tracée** | le build réel échoue dans les deux scénarios fautifs et réussit sur le témoin conforme ; réserve : aucun client réellement généré n'a été validé (réseau fermé) |
| **Garde PostgreSQL** | **Corrections supplémentaires nécessaires — faites** | une faille réelle trouvée par différentiel et fermée (43 + 12 vérifications) ; restent deux points de conception documentés |
| **Workflows CI** | **Corrections supplémentaires nécessaires** | cinq branches vertes à vide (patchs prêts), `main` lit encore un secret, et le `ci.yml` des `experience/*` est plus ancien : le fusionner régresserait `main` |
| **RLS** | **Corrections supplémentaires nécessaires** | rien n'est fusionné : l'épreuve d'isolation n'est prouvée **par exécution** ni sur les cinq branches (où elle n'est pas câblée) ni en production ; la migration attend un audit |
| **Diagnostic de production** | **Bloqué par des preuves manquantes** | mécanisme reproduit à l'identique, cause **NON VÉRIFIÉE** : journaux d'exécution expirés, aucun accès réseau, rien n'a été déployé pour forcer une preuve |

### Conclusion

**Corrections supplémentaires nécessaires.**

Ce n'est pas un jugement sur la qualité du code — la batterie passe, la faille trouvée ce jour est fermée, et le mécanisme de l'incident est empêché — mais sur l'état de préparation, qui dépend de faits extérieurs au code :

1. **une décision de fusion** : une seule des deux voies CI (§5), l'autre éteinte ;
2. **un réglage GitHub** : sans exécution de workflows, aucun correctif CI n'est éprouvé (§9) ;
3. **une preuve** : les journaux de build du déploiement `b0c976f`, une recherche du mot `prisma` (§6.3) ;
4. **une autorisation de niveau D** pour la migration de privilèges, précédée de l'audit (§10.5) ;
5. **un accord** pour appliquer les cinq patches sur `experience/*`, et la consigne de **ne pas fusionner ces branches telles quelles** (§5.3).

Aucun de ces cinq points n'est un travail que je puisse faire sans vous. En revanche, rien n'empêche d'exécuter les quatre premiers dans l'ordre indiqué dès que vous le décidez — et je les exécute à la première instruction.

---

## 12. Confirmations

- **Aucune fusion** : PR #36 toujours en brouillon, PR #34 et #35 intactes, `main` à `b0c976f`.
- **Aucun déploiement**, **aucune migration** exécutée, **aucun secret** créé, lu, modifié ou supprimé.
- **Aucune réactivation de CI**, **aucun réglage** GitHub, Vercel ou Neon modifié.
- **Aucun test destructif** contre une base réelle ou partagée.
- **Aucun secret dans ce rapport** : aucune valeur, aucune chaîne de connexion, aucun jeton.
- Modifications de cette revue, toutes sur la branche `arena/879cd8db-tracefab`, poussée en `601bde5` : `scripts/lib/require-throwaway-db.mjs` (correction), `scripts/test_db_target_guard.mjs` (section E), `scripts/test_db_guard_vs_driver.mjs` (nouveau), `package.json` (script `test:db-guard-driver`, branché dans `build`).
