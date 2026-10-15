# TRACEFAB — CHANTIER 3 : validation des corrections et audit réel

**Date :** 2026-10-12 · **Branche :** `arena/879cd8db-tracefab`
**Référence de production :** `main` = `b0c976f`, servie par le déploiement `6968252029` (2026-10-09) — **inchangée**
**Dernier commit de la branche :** `62fc3b3`

> **Périmètre.** Aucune fusion, aucun déploiement de production, aucune
> modification de rôle, de privilège ou de donnée sur une base distante. L'accès
> Neon et l'accès aux journaux Vercel ne sont **pas** disponibles dans cet
> environnement ; les étapes qui en dépendent sont déclarées **BLOQUÉES** avec
> la liste exacte de ce qu'il faut.

---

## 1. Commits et fichiers réellement vérifiés

Dépôt `Huberaya/Tracefab`, branche `arena/879cd8db-tracefab`, arbre de travail
propre, HEAD local **égal** au distant. **Dix commits** devancent `main` : les
neuf annoncés, plus le bilan du chantier 1.

| Commit | Objet | Fichiers | Vérification |
|---|---|---|---|
| `b03bdf3` | bilan de récupération (chantier 1) | 1 doc | présent, 423 lignes |
| `64d3157` | garde de cible | 4 ajoutés | tous présents, 656 lignes |
| `4545759` | génération Prisma | 4 ajoutés | tous présents, 497 lignes |
| `3b04bdd` | privilèges `SECURITY DEFINER` | 1 migration + 1 test | présents, 397 lignes |
| `d5406bd` | audit lecture seule | 2 ajoutés | présents, 507 lignes |
| `90eecbd` | politique des workflows | 4 ajoutés | présents, 503 lignes |
| `3ba3064` | câblage CI + `package.json` | 3 modifiés | présents |
| `968e1f9` | documents de durcissement | 2 ajoutés | présents, 581 lignes |
| `243f7d0` | faux positifs du routage | 2 modifiés | présents |
| `3c9ed1f` | rapport d'exécution chantier 2 | 2 modifiés | présent, 310 lignes |

**Contrôle des références** — un vérificateur parcourt chaque commande npm et
chaque étape de workflow, et confirme que le fichier ou le script nommé existe :
**toutes les références résolvent** (106 scripts npm, 141 fichiers dans
`scripts/`, deux fichiers de patch `figer`, une migration corrective).

**Rien n'a été fusionné ni déployé en production**, vérifié par l'API :

* `main` toujours à `b0c976f` ; **28 déploiements Production** au total, le plus
  récent du 2026-10-09, tous attribués à `vercel[bot]` ;
* **aucune pull request** ouverte depuis cette branche ;
* aucune branche supprimée, aucun historique réécrit, aucune force-push.

> **Divulgation nécessaire.** Les poussées sur cette branche déclenchent des
> **déploiements Preview Vercel automatiques** (72 Preview au total). Je l'ai
> découvert à l'étape A : les commits du chantier 2 avaient déjà produit trois
> Preview. Les Preview ne sont pas la production et aucun n'a été promu, mais
> une poussée sur une branche déploie du code sur l'infrastructure Vercel. Ce
> point est exploité à l'étape D comme oracle de test, et doit être connu avant
> toute poussée supplémentaire.

---

## 2. Tests exécutés, résultats, codes de sortie, limites

Environnement : base PostgreSQL 18.4 jetable locale, 36 migrations appliquées,
rôle `tracefab_app` et deux locataires créés par `scripts/seed_rls_fixture.mjs`.

| Commande | Code | Résultat |
|---|---|---|
| `npm run test:db-guard` | 0 | 15 vérifications — la garde accepte ce qui est jetable, refuse le reste |
| `npm run test:db-routing` | 0 | classification vérifiée dans les deux sens + détecteur éprouvé par témoins |
| `npm run test:workflow-policy` | 0 | 8 contrôles sur `ci.yml`, dont l'invariant écriture/execution |
| `npm run test:prisma-client` | 0 | 3 états de client distingués (factice, conforme, incomplet) |
| `npm run test:audit-script` | 0 | lecture seule appliquée par le serveur + non-divulgation + cible déclarée |
| `npm run test:neon:privileges` | 0 | 8 vérifications, dont le refus opposé à un rôle sans droit |
| `npm run test:neon:rls` | 0 | 47 tables, deux locataires disjoints, contexte public confiné |
| `schema:static`, `test:security:chantier1`, `test:assets`, `test:production-readiness`, `test:routes`, `test:cross-tenant`, `test:private-storage`, `test:questionnaires` | 0 | aucune régression |

**Limites, énoncées telles quelles :**

* `npm run verify:prisma-client` et `npm run test:router-load` **échouent
  localement** : les binaires Prisma ne sont pas téléchargeables depuis cet
  environnement (`binaries.prisma.sh` injoignable). Ce n'est pas une régression,
  c'est l'absence de client généré — et le contrôle le dit correctement. Voir §6.
* Les cinq suites `test_neon:*` autres que `rls` et `privileges`
  (`security`, `supplier`, `supplier:advanced`, `product`, `quality`,
  `collection`, `bulk:chantier8`) **ne sont pas exécutées** : elles écrivent, et
  aucune cible jetable ne leur a été fournie. **Aucune n'est comptée comme
  passée.**
* **Aucun de ces contrôles n'a jamais tourné dans la CI réelle.** Le workflow
  `CI` est `disabled_manually` et l'API confirme **0 exécution** sur cette
  branche. Tout ce qui précède a tourné en local.

---

## 3. Audit Neon — **BLOQUÉ**

`scripts/audit_neon_readonly.mjs` existe, fonctionne et a été durci à cette
occasion. **Aucune connexion à Neon n'a été tentée** : l'hôte n'est pas
joignable depuis cet environnement, et rien n'a été contourné.

### 3.1 Ce que la revue a corrigé

| Exigence | État avant | État après |
|---|---|---|
| Requêtes limitées à l'inspection | liste blanche `SELECT/WITH/SHOW/TABLE` vérifiée au démarrage | inchangé |
| Pas de privilège d'écriture nécessaire | session ouverte en `TRANSACTION READ ONLY`, appliquée par le serveur | inchangé, **prouvé** en tentant une écriture refusée |
| Journaux sans donnée d'authentification | chaîne de connexion, `sslmode=`, hôte refusés | inchangé |
| Identifie base et environnement | **ne le faisait pas** | bloc `CIBLE EXAMINEE` : base déclarée, base jointe, rôle, **classe d'hôte**, empreinte SHA-256 tronquée |
| Pas de repli silencieux | **pouvait rapporter sur la mauvaise base** | `--expect-database=<nom>` oblige la cible ; une base jointe différente fait **refuser tout rapport** (sortie 3) |

La classe d'hôte distingue « local », « base managée (Neon / Supabase / RDS) »
et « distant non reconnu ». **L'hôte lui-même n'est jamais imprimé.**

### 3.2 Ce qu'il faut pour lever le blocage

1. une chaîne de connexion **en lecture seule** vers la base de production,
   fournie par un mécanisme sécurisé de la plateforme — jamais dans un chat, un
   commit ou un rapport ;
2. l'exécution, par le propriétaire, de :
   `DATABASE_URL=<lecture seule> node scripts/audit_neon_readonly.mjs --expect-database=neondb`
3. le rapport produit **ne contient aucun secret** : il peut être collé tel quel.

**Ce que l'audit ne fera pas :** aucune écriture, aucune modification de rôle ou
de privilège. Les six constats demandés (identité serveur/base/rôle, `rolsuper`
et `rolbypassrls`, état RLS, migrations appliquées comparées au dépôt, `EXECUTE`
des cinq fonctions, privilèges et propriétaires, écarts avec les hypothèses des
migrations) sont tous couverts par ses requêtes.

---

## 4. État réel des rôles et privilèges

### 4.1 Ce qui est mesuré, sur la réplique isolée

| Fait | Mesure |
|---|---|
| Fonctions `SECURITY DEFINER` | **107** |
| Exécutables par `PUBLIC` — *avant* correction | **5** |
| Exécutables par `PUBLIC` — *après* correction | **0** |
| Fonctions appelées par une politique RLS, exécutables par `tracefab_app` | **12 / 12** |
| Rôle sans aucun droit face aux 5 fonctions corrigées | **refusé sur les 5** |
| `PUBLIC` sur le schéma `public` | **`USAGE` seulement, pas `CREATE`** |
| Propriétaire des 107 fonctions | **le propriétaire unique de la base** |

Le point sur `CREATE` est important et répond à une question de l'étape C : les
droits de **création** et le privilège **effectif** de `PUBLIC` sont deux choses
distinctes. `PUBLIC` ne peut pas créer de fonction dans `public` (défaut
PostgreSQL 15+), et le seul créateur est le propriétaire — exactement le rôle
couvert par la forme globale. La portée de la correction est donc **complète
pour ce schéma**, et cela a été mesuré, pas supposé.

### 4.2 Ce qui reste inconnu

L'état de la production sur ces six points **n'est pas connu** : le tableau
ci-dessus décrit la réplique, pas Neon. En particulier, la production se
connecte très probablement sous `neondb_owner`, qui porte `BYPASSRLS` : pour ce
rôle, les politiques RLS ne sont **jamais** évaluées. Tant que l'audit n'a pas
tourné, l'isolation multi-locataire en production reste **non démontrée**.

---

## 5. Validation de la migration corrective

`prisma/migrations/20261012120000_close_public_execute_gap/migration.sql`

| Question de l'étape C | Réponse | Preuve |
|---|---|---|
| Portée PostgreSQL correcte ? | **oui** — forme globale, sans `IN SCHEMA` | mesuré : la forme par schéma laisse `pg_default_acl` vide et une fonction nouvelle reste exécutable par `PUBLIC` |
| Création et privilège de `PUBLIC` traités distinctement ? | **oui** — `PUBLIC` n'a pas `CREATE` sur `public`, le créateur unique est couvert | mesure du catalogue |
| Droits minimaux par fonction ? | `EXECUTE` retiré à `PUBLIC`, accordé au **rôle applicatif** | 12/12 fonctions de politique accessibles, 5/5 refusées à un rôle sans droit |
| Fonctions des politiques RLS toujours exécutables ? | **oui** | `test:neon:rls` vert après application, 47 tables sans erreur de politique |
| Idempotente ? | **oui** pour les blocs conditionnels ; **les 36 migrations s'appliquent sur une base neuve** | base vierge : 36/36, et les 3 dernières rejouables |
| Compatible avec l'historique ? | ajout en fin de chaîne, aucun fichier de migration modifié | `_prisma_migrations` non touchée |
| Ne supprime pas un accès public **nécessaire** ? | vérifié : les routes publiques (DPP, passeport, wallet) passent par le rôle applicatif unique | une seule chaîne de connexion dans le code applicatif |

### 5.1 La migration vérifie désormais son propre effet

C'est le défaut qu'elle corrige qui l'a imposé : le durcissement
`20261007100000` a posé une instruction sans effet et s'est terminé **en vert**.
La migration crée donc une fonction sonde, mesure si `PUBLIC` peut l'exécuter,
la supprime, et **échoue** si l'invariant est faux.

**Contrôle négatif exécuté** — fermeture du défaut retirée du fichier, puis
application de la chaîne complète sur une base neuve :

```
la migration a ECHOUE comme attendu :
  Migration sans effet : une fonction creee par postgres est encore executable
  par PUBLIC. La forme utile est globale, sans IN SCHEMA : ALTER DEFAULT
  PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
  code SQLSTATE = 42501
```

Sans ce contrôle, « la migration passe » ne distinguait pas « elle agit » de
« elle ne fait rien ».

### 5.2 Un déclencheur d'événement a été écarté, volontairement

La question « et une fonction créée plus tard par un autre rôle ? » appelle
naturellement un déclencheur `CREATE FUNCTION`. Il n'a **pas** été ajouté, pour
trois raisons mesurées : `PUBLIC` n'a pas `CREATE` sur le schéma (donc pas
d'autre créateur), la création d'un déclencheur d'événement exige des droits de
superutilisateur que `neondb_owner` n'a pas sur Neon — la migration échouerait —
et un mécanisme qui échoue à s'installer est pire que pas de mécanisme. La
portée globale plus l'auto-contrôle couvrent le cas.

### 5.3 Plan d'application et de retour arrière

**Préalable obligatoire :** l'audit du §3. Appliquer un retrait de privilège sur
une base dont l'état réel n'est pas constaté, c'est risquer de casser une lecture
légitime sans le savoir.

1. **Constat** — audit en lecture seule, rapport conservé.
2. **Décision** — comparer les 5 fonctions réellement exécutables par `PUBLIC`
   en production avec les 5 attendues.
3. **Autorisation** — niveau D (changement de privilège en production).
4. **Application** — `prisma migrate deploy`, hors pointe de trafic.
5. **Preuve datée** — `npm run test:neon:privileges` contre la production en
   lecture seule (le test ne fait que lire le catalogue et annule sa sonde).

**Retour arrière** — écrit noir sur blanc dans le fichier de migration :

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE <proprietaire> GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_material_visible_via_product(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_product_is_public(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_material_is_public(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_supplier_site_is_public(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_public_brand(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION tracefab_public_context() TO PUBLIC;
```

Un droit retiré sans sa réciproque documentée est un droit qu'on ne saura pas
rendre.

**La migration n'a pas été appliquée à Neon.**

---

## 6. Preuve du build Prisma — **CORRIGÉ ET PROUVÉ sur la plateforme réelle**

### 6.1 Comment une preuve a été obtenue sans accès à Vercel

L'API GitHub expose les déploiements créés par l'intégration Vercel et leur
**état**. C'est un oracle booléen, mais un oracle sur l'infrastructure réelle.
Quatre déploiements Preview, tous sur des commits de cette branche :

| Commit | `postinstall` | Déploiement Vercel |
|---|---|---|
| `3c9ed1f` | génération seule | **succès** |
| `b0d332f` | génération **puis vérification** | **succès** |
| `21f9340` | **contrôle négatif** : génération d'un schéma absent | **ÉCHEC** — `dpl_4zTo55HqF1CoYBcZWdKUJRmwDnfG` |
| `62fc3b3` | génération + vérification, restaurée | **succès** |

**Ce que cela établit :**

1. **Vercel exécute bien le `postinstall`.** Un `postinstall` jamais lancé aurait
   donné un déploiement vert. C'est l'inverse qui a été observé : un
   `postinstall` qui échoue fait échouer le déploiement.
2. **Un échec de génération fait échouer le build.** Il ne produit pas un paquet
   vert sans client.
3. Donc, dans le déploiement réussi de `b0d332f`, `prisma generate` a **réellement
   tourné** dans l'environnement de build, et la vérification du client qui le
   suit a **passé**.
4. Corollaire : la variable `PRISMA_SKIP_POSTINSTALL_GENERATE` **n'est pas
   définie** dans l'environnement Vercel. Si elle l'était, le `postinstall`
   refuserait de s'exécuter en contexte de déploiement et le build échouerait —
   ce qui n'est pas le cas. C'est un fait sur l'environnement cible, déduit d'une
   observation, pas d'une supposition.
5. Le script `prisma-generate.mjs` **exige** `node_modules/prisma` et sort en
   code 1 s'il est absent. Le déploiement `b0d332f` ayant réussi, le CLI Prisma
   est bien présent à l'installation sur Vercel.

Le déploiement en échec reste consultable par le propriétaire, avec la commande
que Vercel a lui-même fournie dans le statut :

```bash
npx vercel inspect dpl_4zTo55HqF1CoYBcZWdKUJRmwDnfG --logs
```

### 6.2 Les deux modes de défaillance, mesurés localement

Le répertoire du client Prisma n'existe pas dans cet environnement (dernier
`npm ci` lancé avec le contournement documenté, qui supprime aussi le repli
factice). Cela a permis de mesurer **deux** modes distincts, tous deux
reproduisant exactement le symptôme de production :

| État du client | Message | Modules de route qui ne se chargent pas |
|---|---|---|
| répertoire **absent** | `Cannot find module '.prisma/client/default'` | **119 / 125** |
| repli **factice** présent | `@prisma/client did not initialize yet` | **119 / 125** |
| client **conforme** fourni | — | **0 / 125** |

Un module de route qui ne se charge pas est précisément ce qui déclenche la
barrière d'erreur de `api/index.ts` et produit
`{"error":"internal_error","correlationId":"…"}`.

### 6.3 La vérification est dans le chemin d'installation, pas dans `npm run build`

Correction apportée à cette étape, et elle compte : sur Vercel, `vercel.json`
porte un tableau `builds`, donc les réglages de build du projet sont ignorés et
`npm run build` **n'est pas exécuté**. Une vérification placée dans
`npm run build` protège la CI et le poste de développement, **pas le
déploiement**. La vérification est donc désormais enchaînée à la génération,
dans le même processus d'installation — c'est le seul passage obligé.

### 6.4 Versions

| Élément | Valeur | Cohérence |
|---|---|---|
| CLI Prisma (lockfile) | `6.19.3` | — |
| `@prisma/client` (lockfile) | `6.19.3` | **identique au CLI** |
| `@prisma/client` déclaré en | `dependencies` | correct : importé au chargement des routes |
| `prisma` (CLI) déclaré en | `devDependencies` | outil de build — présent à l'installation sur Vercel, prouvé §6.1 |
| `engines.node` | `>=20.0.0` | — |
| Node exigé par `@prisma/client` | `>=18.18` | compatible |
| Node de la CI | `20` | compatible |
| Node local | `22.22.3` | compatible |

### 6.5 Ce qui reste **non vérifié**

Je n'ai **pas** pu interroger l'application déployée : `*.vercel.app` n'est pas
joignable depuis cet environnement (HTTP 000, y compris pour la production).
Donc :

* `/api/health` et les routes de diagnostic **n'ont pas été testées sur la
  Preview** ;
* la cause de l'erreur de production n'est **pas confirmée** (étape F).

Le build est prouvé ; le **service en exécution** ne l'est pas.

---

## 7. Protections GitHub Actions

### 7.1 Posture de **tous** les workflows, sur **toutes** les branches

`scripts/audit_workflows_all_refs.mjs` lit chaque workflow de chaque référence
distante sans rien extraire ni exécuter. Résultat sur 12 fichiers, 21 références :

| Référence | Fichier | Posture |
|---|---|---|
| `arena/879cd8db-tracefab` | `ci.yml` | **ok** |
| `main`, `experience/chantier-16…20`, `correctifs/chantier-1a`, `arena/e72cecf4` | `ci.yml` | **CRITIQUE** — lit `secrets.DATABASE_URL`, 9 actions non épinglées, écriture en base sans la garde |
| `security/incident-3b-remove-production-db-from-ci` (PR #35) | `ci.yml` | **CRITIQUE** — 9 actions non épinglées, appel direct à `seed_rls_fixture.mjs` sans la garde |
| `arena/91844ee9-tracefab` (PR #34) | `ci.yml` | **CRITIQUE** — garde absente ; suites `test:neon:dpp-provenance`, `deploiement-publication`, `auth-provisioning` |
| `arena/91844ee9-tracefab` | `figer-reference-visuelle.yml` | **CRITIQUE** — `contents: write` au niveau du workflow |

**Constat le plus important de cette étape :** dix branches portent encore le
workflow dangereux. La correction vit sur **une seule branche**. Toute fusion
d'une de ces branches vers `main` réintroduirait la lecture du secret de
production et l'exécution de suites destructives sans garde.

Deux suites destructives **inédites** apparaissent sur `arena/91844ee9-tracefab`
et `correctifs/chantier-1a` (`dpp-provenance`, `deploiement-publication`,
`auth-provisioning`, `rls:auth`, `dpp-ambigu`). Elles n'existent pas dans mon
arbre : si ces branches fusionnent, elles arrivent sans garde. Le contrôle
`test:db-routing` les refusera **après** fusion, en faisant échouer la CI — mais
il faut que quelqu'un lise l'échec.

### 7.2 La protection est structurelle, pas une étape supprimée

| Mécanisme | Portée | Éprouvé comment |
|---|---|---|
| Garde de cible | **toute** exécution, quel que soit le chemin | refus observé sur cible Neon, en contexte de production, et sans cible |
| Classement par contenu | chaque suite, dans les deux sens | section A2 : une suite mal classée fait échouer la CI |
| Politique des workflows | `secrets`, épinglage, `contents: write`, déclencheurs, environnements | contrôle négatif : réintroduction de `secrets.DATABASE_URL` → 3 échecs |
| Invariant écriture/execution | **tous** les workflows de l'arbre, présents et futurs | la version d'origine de `figer` échoue, la version durcie passe |

Le job `pousser` de la version durcie de `figer` détient `contents: write` et
n'exécute **aucun** code du dépôt ; son contrôle est vérifié par échec sur la
version active.

### 7.3 Plan distinct — protections `main` et Vercel

Aucune modification n'a été faite. État constaté, à comparer au plan :

* `main` : **`protected: false`**, protection désactivée — **aucune branche du
  dépôt n'est protégée** ;
* rulesets : **0** ;
* environnements : `Preview` et `Production` existent, **0 règle de protection**
  chacun ;
* workflow `CI` : **`disabled_manually`**, et **0 exécution** sur cette branche.

Le plan détaillé (cases à cocher, valeurs, chemins d'interface) est dans
`docs/security/PHASE-1-PIPELINE-GITHUB.md` §5. Trois points qui conditionnent sa
réussite :

1. **Réactiver `CI` avant de rendre un check obligatoire.** Un check attendu et
   jamais produit n'est jamais vert : toute fusion serait bloquée.
2. **Un seul collaborateur** ne peut pas satisfaire « relecture indépendante » ;
   il faut choisir entre validation par *code owner* et absence de relecture.
3. **Les protections GitHub ne bloquent pas les déploiements Vercel.** La
   production est produite par l'intégration Vercel ; protéger `main` filtre les
   commits, pas les déploiements.

---

## 8. Origine de `internal_error` — **NON VÉRIFIÉ**

Identifiant transmis : `c3696f22-41d0-4981-8d99-4e6a177021a3`.

**Il n'est pas récupérable côté application.** `api/index.ts` engendre un
`randomUUID()` par erreur, le place dans la réponse et le transmet à
`reportError` — sans jamais le persister. Le seul endroit où il existe encore
est le **journal d'exécution Vercel**.

**Journaux non accessibles** depuis cet environnement (API Vercel injoignable,
console injoignable, `log_url` des déploiements = URL de Preview elle-même, non
joignable). Je ne fabrique pas de résultat.

### 8.1 Ce qui est établi, et ce qui ne l'est pas

| Affirmation | Statut |
|---|---|
| La forme de la réponse désigne la barrière d'erreur de `api/index.ts` (seul émetteur de `correlationId`) | **établi par lecture du code** |
| Un client Prisma absent **ou** factice produit exactement cette forme, via l'échec du chargement du module de route | **reproduit, deux modes distincts, 119/125** |
| `/api/health` ne répondait pas `database_unavailable`, ce qui exclut un échec *dans* le `try/catch` | **établi par forme de réponse** |
| Le client Prisma était absent dans le paquet déployé le 2026-10-12 | **non vérifié** |
| La production de `b0c976f` est corrigée | **non vérifié** — le correctif vit sur une branche non fusionnée |

**L'affirmation « c'était bien le client Prisma » n'est pas portée ici.** Le
mécanisme est reproduit ; l'occurrence n'est pas prouvée.

### 8.2 Ce qu'il faut, précisément

Deux voies, la seconde ne demandant aucun accès :

**Voie 1 — le propriétaire lit le journal.** Vercel → projet → Deployments →
déploiement de production `6968252029` (réf. `b0c976f`, 2026-10-09) → onglet
*Logs* (ou *Functions*), filtrer sur `c3696f22-41d0-4981-8d99-4e6a177021a3`.
La trace attendue est `@prisma/client did not initialize yet` ou
`Cannot find module '.prisma/client/default'` au chargement du module. Coller
la ligne d'erreur suffit — **aucun secret n'y figure**.

**Voie 2 — le test discriminant, sans aucun accès.** Depuis un navigateur :

| Réponse observée | Conclusion |
|---|---|
| `500` + `internal_error` + nouvel identifiant, **et** `/api/catalog/schemas` en `200` | client Prisma non généré dans le paquet — cause confirmée |
| `503` `database_unavailable` | la base n'est pas joignable, pas le client |
| `200` sur les deux | le symptôme a disparu ; le déploiement `b0c976f` est sain et la question devient historique |

Cette voie est décisive et ne demande que deux requêtes HTTP.

---

## 9. État de chaque problème

| # | Problème | Statut | Base de la qualification |
|---|---|---|---|
| **P0-4** | Suite destructive ciblant la production depuis la CI | **PRÉPARÉ NON APPLIQUÉ** — neutralisé sur la branche, toujours actif sur `main` et 9 autres branches | `main` lue comme porteuse de `secrets.DATABASE_URL` ; ma branche est la seule classée `ok` |
| **P0-5** | Privilège `EXECUTE` de `PUBLIC` sur 5 fonctions `SECURITY DEFINER` ; durcissement inefficace | **CORRIGÉ EN ENVIRONNEMENT ISOLÉ** | 5 → 0 sur la réplique ; auto-contrôle éprouvé par contrôle négatif ; non appliqué à Neon |
| **P0-6** | Client Prisma non généré dans le paquet déployé | **CORRIGÉ ET PROUVÉ** (build) / **NON VÉRIFIÉ** (occurrence en production) | déploiement en échec observé sur Vercel pour un `postinstall` défaillant, puis succès avec génération + vérification — §6 |
| **P1-10** | `GRANT … TO PUBLIC` explicite dans `20261009120000` | **CORRIGÉ EN ENVIRONNEMENT ISOLÉ** | inclus dans P0-5 |
| **P1-11** | `p0-neon-reconciliation.md` contredit le code | **NON VÉRIFIÉ** — non corrigé | le document affirme toujours qu'aucune fonction n'est exécutable par `PUBLIC` |
| **P1-12** | Cause racine de `ALTER DEFAULT PRIVILEGES` mal comprise dans le dépôt | **CORRIGÉ ET PROUVÉ** | mesuré sur PostgreSQL 18.4, et documenté dans la migration et le document de phase |
| **P1-13** | RLS non démontrée en production (`neondb_owner` porte `BYPASSRLS`) | **BLOQUÉ** | nécessite l'audit ; l'isolation est **prouvée** sur la réplique, pas en production |
| **P2-14** | `main` non protégée, aucune branche protégée, rulesets vides | **PRÉPARÉ NON APPLIQUÉ** | plan avec chemins et valeurs ; accès en écriture absent |
| **P2-15** | Workflow `CI` désactivé — aucun contrôle ne tourne | **BLOQUÉ** | 0 exécution sur cette branche |
| **P2-16** | `figer-reference-visuelle` : `contents: write` au niveau du workflow | **PRÉPARÉ NON APPLIQUÉ** | patch éprouvé dans les deux sens ; vit sur une branche non fusionnée |
| **P2-17** | 9 actions non épinglées sur `main` et 9 autres branches | **PRÉPARÉ NON APPLIQUÉ** | épinglage fait sur ma branche uniquement |
| **P2-18** | Dix branches portent encore le workflow dangereux | **NON VÉRIFIÉ** — constaté, non traité | audit multi-références §7.1 |
| **P2-19** | Suites destructives inédites sur d'autres branches | **NON VÉRIFIÉ** | `dpp-provenance`, `deploiement-publication`, `auth-provisioning`, `rls:auth`, `dpp-ambigu` |
| **P2-20** | `TRACEFAB_RATE_LIMIT_SALT` non posé ; repli sur `CLERK_SECRET_KEY` puis `DATABASE_URL` | **NON VÉRIFIÉ** | à poser **avant** toute rotation de `DATABASE_URL` |
| **—** | Secrets EXP-01/02/03, CL-11, DEC-36 | **BLOQUÉ** | introuvables dans le dépôt et son historique ; ni résolus ni inventés |

Deux corrections d'erreurs du rapport précédent, à porter au crédit de cette revue :

* j'avais écrit que la branche de la PR #35 épinglait les actions par SHA —
  **c'est faux** : elle utilise `@v4` flottants. Vérifié en lisant le fichier.
* j'avais classé `test_neon_wallet_chantier9.ts` et
  `test_neon_chantier10_storage.ts` comme destructrices — **c'est faux** : elles
  ne font que lire. Corrigé, et la vérification bidirectionnelle qui a révélé
  l'erreur est désormais permanente.

---

## 10. Modifications restant à intégrer

**Sur la branche de travail (10 → 13 commits) :** rien n'est fusionné.

1. `62fc3b3` et les commits du chantier 3 — garde, politique, migration
   corrective, auto-contrôle, audit durci, analyseur multi-références.
2. Le patch `figer-reference-visuelle.permissions.patch`, **à appliquer sur la
   branche qui détient le fichier** (branche de la PR #34), pas ici : l'ajouter
   créerait un conflit *add/add* à la fusion.
3. La réactivation du workflow `CI`, puis les protections de `main`.

**Décisions qui appartiennent au propriétaire :** fusion de la PR #34, fusion de
la PR #35 (son retrait est correct mais **insuffisant** : ni garde, ni épinglage),
et surtout : **ne fusionner aucune des dix branches portant le workflow
dangereux sans y reporter la correction**.

---

## 11. Ce que seul le propriétaire peut fournir

| # | Accès ou action | Débloque |
|---|---|---|
| 1 | Chaîne de connexion Neon **en lecture seule** (mécanisme sécurisé) | tout le §3, P1-13 |
| 2 | Réactivation du workflow `CI` | P2-15 ; rend les nouveaux contrôles opérants |
| 3 | Écriture sur la configuration du dépôt | P2-14, protections de `main` |
| 4 | Journal Vercel du déploiement `6968252029`, filtré sur `c3696f22-…` **ou** le test discriminant à deux requêtes (§8.2) | P0-6 côté occurrence |
| 5 | Console Vercel : branche de production, *Ignored Build Step*, protection des Previews | plan Vercel |
| 6 | Autorisation d'appliquer la migration corrective à Neon | P0-5 en production |
| 7 | `TRACEFAB_RATE_LIMIT_SALT` posé dans Vercel **avant** toute rotation de `DATABASE_URL` | P2-20 |

---

## 12. La prochaine action unique la plus utile

**Collez la ligne d'erreur du journal Vercel du déploiement de production
correspondant à `c3696f22-41d0-4981-8d99-4e6a177021a3` — ou faites les deux
requêtes du §8.2 depuis un navigateur.**

C'est la seule qui change une conclusion en preuve, elle ne demande aucun accès
particulier dans sa seconde forme, elle coûte deux minutes, et elle ferme le
seul problème dont l'occurrence reste non vérifiée alors que **le correctif est
déjà prouvé sur la plateforme de déploiement**.

Tout le reste attend une autorisation ou un accès ; celui-ci n'attend rien.

---

## 13. Critère de réussite — où en est-on

| Exigence | État |
|---|---|
| Corrections avec preuves reproductibles | **atteint** pour P0-6 (build), P1-12, et les garde-fous |
| Inconnues critiques levées ou explicitement documentées | **atteint** : six inconnues nommées, chacune avec l'accès qui la lève |
| Opérations restantes sur la production identifiées | **atteint** : §10 et §11, avec plans et retours arrière |
| Le chantier n'est pas terminé parce que les tests locaux passent | **respecté** : aucun contrôle n'a tourné en CI, aucun n'a tourné en production, et rien ne le prétend |
