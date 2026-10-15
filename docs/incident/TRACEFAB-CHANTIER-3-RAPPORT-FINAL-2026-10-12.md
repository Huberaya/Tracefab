# TRACEFAB — Chantier 3 : rapport final

**Date** : 2026-10-12 (Europe/Paris)
**Dépôt** : `Huberaya/Tracefab` — branche de travail `arena/879cd8db-tracefab`
**HEAD vérifié** : `1a3d7a7` — 18 commits d'avance sur `main`
**Livraison** : PR **#36**, ouverte en **brouillon** (non fusionnée, non fusionnable sans décision)
**Branche de référence** : `main` = `origin/main` = `b0c976f`, inchangée
**Aucune fusion, aucun déploiement de production, aucune modification de la base Neon.**

Les cinq statuts employés sont ceux de la mission :
`CORRIGÉ ET PROUVÉ` · `CORRIGÉ EN ENVIRONNEMENT ISOLÉ` · `PRÉPARÉ NON APPLIQUÉ` · `BLOQUÉ` · `NON VÉRIFIÉ`.

---

## 1. Dépôt, branche et HEAD vérifiés

```
branche active      : arena/879cd8db-tracefab
HEAD                : 2d03cc4
arbre de travail    : propre avant ce rapport
main / origin/main  : b0c976f  (aucun commit de ce chantier)
commits d'avance    : 18
fichiers changés    : 27 (5 805 insertions, 82 suppressions)
PR de la branche    : #36, brouillon, ouverte — aucune PR fusionnée
```

`git status --porcelain` est vide hors les fichiers de ce rapport : les travaux
antérieurs non commités ont été préservés, aucun `reset`, aucun `force push`,
aucune branche supprimée (`git branch -r` : 20 branches distantes, intactes).

## 2. Commits examinés

La mission annonçait neuf commits ; la branche en compte **dix-sept**, les huit
derniers ayant été produits par l'exécution elle-même. Tous ont été relus par
`git show --stat` et leurs références (scripts, tests, migration, documents)
vérifiées une à une comme existantes.

| Commit | Objet | Effet en une ligne |
|---|---|---|
| `b03bdf3` | bilan de récupération | état des lieux, cause probable, régression de privilège décrite |
| `64d3157` | garde de cible | refus par défaut avant toute suite destructive |
| `4545759` | génération Prisma | générer ou échouer, au lieu de déployer sans client |
| `3b04bdd` | privilèges SQL | fermer l'exécution publique des fonctions SECURITY DEFINER |
| `d5406bd` | audit Neon | lecture seule garantie par le serveur |
| `90eecbd` | politique des workflows | déclarer plutôt que subir |
| `3ba3064` | routage CI | retirer le test destructif contre la production, brancher les gardes |
| `968e1f9` | réglages | protections GitHub/Vercel et état des privilèges |
| `243f7d0` | faux positifs | deux faux positifs du contrôle de routage corrigés sans l'affaiblir |
| `3c9ed1f` | rapport chantier 2 | exécution documentée |
| `537409e` | sans repli silencieux | cible déclarée, migration auto-vérifiée, refus prouvé |
| `6a0e659` | classification | classer les suites selon leur contenu, pas leur nom |
| `b0d332f` | vérification du client | la vérification s'exécute dans l'installation, pas seulement dans `build` |
| `21f9340` | contrôle négatif | commit temporaire, **volontairement** en échec, reverté au suivant |
| `62fc3b3` | revert | retrait du contrôle négatif temporaire |
| `9a126ee` | rapport de clôture | validation, exécution, limites |
| `2d03cc4` | client sans moteur | refuser un client qui se construit mais ne peut pas interroger |
| `1a3d7a7` | témoins de détection | huit workflows fautifs passés à la politique de production ; rapport final |

Aucune branche n'a été fusionnée, aucun commit n'a été réécrit. `21f9340` reste
dans l'historique **et doit y rester** : c'est la trace datée du contrôle
négatif qui prouve qu'un échec de génération fait échouer le build.

## 3. Fichiers modifiés par ce chantier, et pourquoi

| Fichier | Nature | Raison |
|---|---|---|
| `scripts/lib/require-throwaway-db.mjs` | ajout | garde de cible : refuse par défaut, exige une base jetable reconnue |
| `scripts/run-db-suite.mjs` | ajout | unique passage des suites de base, sous la garde |
| `scripts/test_db_target_guard.mjs` | ajout | prouve le refus dans les quatre situations dangereuses |
| `scripts/test_destructive_suite_routing.mjs` | ajout | prouve que **toutes** les suites qui écrivent passent par la garde |
| `scripts/test_workflow_policy.mjs` | ajout | politique A–H des workflows, YAML analysé, pas par expression régulière |
| `scripts/test_workflow_policy_detection.mjs` | ajout | **témoins de détection** : huit workflows fautifs fabriqués en `/tmp` |
| `scripts/prisma-generate.mjs` | ajout | génération obligatoire + vérification du client dans la même passe |
| `scripts/verify_prisma_client.mjs` | ajout | comportement + moteur : import, construction, délégués, moteur présent |
| `scripts/test_prisma_client_check.mjs` | ajout | quatre états de client, dans les deux sens |
| `scripts/test_router_module_load.mjs` | ajout | charge les 125 modules de route et exige zéro échec |
| `scripts/audit_neon_readonly.mjs` | ajout | audit en lecture seule, cible déclarée, aucune divulgation |
| `scripts/test_audit_neon_readonly.mjs` | ajout | prouve la lecture seule et le refus de repli |
| `scripts/test_neon_privileges.mjs` | ajout | privilèges mesurés, y compris un contrôle négatif qui rouvre la porte |
| `prisma/migrations/20261012120000_close_public_execute_gap/` | ajout | migration corrective, auto-vérifiée, avec son rollback écrit |
| `.github/workflows/ci.yml` | modification | pinning SHA, suppression du secret de production, gardes branchées |
| `package.json`, `package-lock.json` | modification | routage des suites, `@prisma/client` en dépendance de production, `postinstall`, scripts |
| `docs/security/PHASE-1-PIPELINE-GITHUB.md`, `PHASE-3-PRIVILEGES-NEON.md`, `workflow-privileged-allowlist.json` | ajout | réglages, matrice mesurée, plan d'application et de retour arrière |
| `docs/security/patches/figer-reference-visuelle.*` | ajout | durcissement du workflow visuel, sous forme de patch isolé |
| `docs/incident/TRACEFAB-*.md` | ajout | bilans et rapports |

## 4. Tests exécutés

Chaque ligne est une exécution réelle. « Isolé » = PostgreSQL local jetable
(18.4, `127.0.0.1:55432`, base `tracefab_test`, détruite avec le processus).

| Commande | Code | Résultat observé | Environnement |
|---|---|---|---|
| `npm run test:db-guard` | 0 | 15/15 : refus local absent, refus base gérée, refus `VERCEL_ENV=production`, refus nom de production | statique + isolé |
| `npm run test:db-routing` | 0 | 8 suites destructives + 2 suites de lecture passent par la garde ; détecteurs témoins dans les deux sens | statique |
| `npm run test:workflow-policy` | 0 | A–H vertes sur l'arbre réel ; YAML analysé | statique |
| `node scripts/test_workflow_policy_detection.mjs` | 0 | **8 témoins** : secrets, suite non gardée, action flottante, écriture+exécution, écriture au niveau workflow, `pull_request_target`, environnement, et un témoin propre accepté | statique |
| `npm run test:prisma-client` | 0 | 4 états : factice refusé, conforme accepté, incomplet refusé, **sans moteur refusé** | statique |
| `npm run test:audit-script` | 0 | lecture seule prouvée par un `CREATE TABLE` refusé ; rapport relu, aucune divulgation | isolé |
| `npm run test:neon:privileges` | 0 | A–G : 107 fonctions SECURITY DEFINER, 0 exécutable par PUBLIC ; rôle sans droit refusé sur les 5 fonctions ; porte rouverte exprès → vue immédiatement, puis refermée | isolé |
| `npm run test:neon:rls` | 0 | 47 tables inventoriées ; sans contexte, aucune ligne ; deux locataires voient des lignes différentes | isolé |
| `npm run typecheck` | 0 | aucune erreur de type | statique |
| `npm run api:typecheck` | **2** | échec : `@prisma/client` n'expose pas `membership_role`, `organization_type`, `Prisma` — le client n'est pas généré **dans cet environnement** (téléchargement du moteur impossible) | **limite locale, voir §8** |
| `npm run schema:static` | 0 | schéma déclaratif cohérent | statique |
| `node scripts/audit_neon_readonly.mjs --expect-database=tracefab_test` | 0 | rapport complet : rôle, rôles et attributs, RLS, fonctions, défauts, migrations, propriétaires | isolé |
| `node scripts/audit_neon_readonly.mjs --expect-database=base_de_production` | **3** | refus : la base jointe ne correspond pas à la base déclarée ; aucun rapport produit | isolé |
| `env -u DATABASE_URL node scripts/audit_neon_readonly.mjs` | **2** | refus : aucune cible fournie, aucun repli | statique |
| `node .cache/harness/fonctions_report.mjs` | 0 | 5 fonctions : propriétaire `postgres`, SECURITY DEFINER, `search_path=public`, ACL sans PUBLIC ; **0 des 107** fonctions SECURITY DEFINER sans `search_path` épinglé | isolé |
| `node .cache/harness/probe_adp_matrix.mjs` | 0 | matrice de 10 combinaisons de privilèges par défaut (§7) | isolé |
| `.cache/harness/batterie.sh` (15 suites) | 0 | 15/15, zéro échec | statique + isolé |

**Tests non exécutés, donc non réussis** : aucune suite de navigateur
(Playwright), aucune suite contre la base Neon, aucun contrôle en CI (le
workflow `CI` est `disabled_manually` : **0 exécution** sur cette branche).

## 5. État réel de Neon : BLOQUÉ

Aucune connexion n'a été tentée. La raison est matérielle et unique : **cet
environnement n'a aucun accès réseau à Neon ni aucune chaîne de connexion**, et
la mission interdit d'en réclamer une par le chat. Aucun constat n'est donc
présenté sur l'état de la production : les chiffres du §6 sont ceux de la base
**jetable locale**, pas ceux de Neon.

Le script d'audit est prêt et a été exécuté sur une cible réelle (jetable) :

- **cible déclarée d'avance** (`--expect-database=<nom>`) : sans elle, sortie 2 ;
  si la base jointe diffère, sortie 3 et aucun rapport ;
- **aucun repli silencieux** : le script ne lit que `DATABASE_URL`, n'a aucune
  valeur par défaut, n'essaie pas une autre base ;
- **lecture seule garantie par le serveur** : liste blanche de requêtes
  (SELECT/WITH/SHOW/TABLE) vérifiée au démarrage, puis
  `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` ; une écriture est
  refusée par PostgreSQL, pas par le script ;
- **aucune divulgation** : le rapport est relu avant affichage ; ni hôte, ni
  chaîne de connexion, ni identifiant. Seuls la classe d'hôte (« base gérée
  (Neon) ») et une empreinte SHA-256 tronquée à 12 caractères sont imprimées,
  pour corréler un journal sans rien exposer ;
- **avertissement explicite** si le rôle effectif est `neondb_owner` :
  `BYPASSRLS` rend les politiques inopérantes pour lui, donc tout constat de
  RLS mesurerait l'audit et non l'application.

**Ce qu'il faut, précisément** : une chaîne de connexion **en lecture seule**
(fournie par un mécanisme sécurisé, jamais par le chat), puis

```bash
DATABASE_URL=... node scripts/audit_neon_readonly.mjs --expect-database=<nom exact>
```

## 6. Rôles et privilèges observés — sur la base jetable, pas sur Neon

Relevé du 2026-10-12 sur `tracefab_test` (PostgreSQL 18.4, migrations du dépôt
appliquées) :

- schéma `public` : propriétaire `pg_database_owner`, ACL
  `{pg_database_owner=UC, =U, tracefab_app=U}` → **`PUBLIC` n'a que `USAGE`, pas
  `CREATE`** ; un rôle non propriétaire se voit refuser la création de fonction
  (`42501`), mesuré avant de lui accorder le droit explicitement ;
- **152 fonctions** dans `public`, dont **107 `SECURITY DEFINER`** ; **0** est
  exécutable par `PUBLIC` après la migration corrective ; **0** des 107 n'a de
  `search_path` épinglé (toutes portent `search_path=public`) ;
- les cinq fonctions visées (`tracefab_material_is_public`,
  `tracefab_material_visible_via_product`, `tracefab_product_is_public`,
  `tracefab_public_brand`, `tracefab_supplier_site_is_public`) : propriétaire
  `postgres`, `SECURITY DEFINER`, `search_path=public`, ACL
  `{postgres=X/postgres, tracefab_app=X/postgres}` — **ni PUBLIC ni un rôle sans
  droit ne peut les exécuter**, et le rôle applicatif le peut ;
- **12 fonctions** appelées par le corps des politiques RLS sont exécutables par
  `tracefab_app` — la lecture légitime n'est pas fermée par le durcissement ;
- rôle applicatif `tracefab_app` : `rolsuper=false`, `rolbypassrls=false` ;
- défauts pour les fonctions à venir : règle globale `{postgres=X/postgres}`
  (PUBLIC exclu) + règle de schéma `{tracefab_app=X/postgres}`.

**Inconnus côté production** : rôle réellement utilisé par l'application,
`rolbypassrls`, migrations appliquées, état des cinq fonctions, présence de
règles `pg_default_acl`. Tous se lisent en une exécution du script d'audit.

## 7. Validation de la migration corrective en environnement isolé

**CORRIGÉ EN ENVIRONNEMENT ISOLÉ.** Migration
`20261012120000_close_public_execute_gap`, empreinte
`00c11a307ca0ae0a94a1a08e7910369a65112d7931064282afd37d317f96e7f2`.

1. **Base neuve** : 36/36 migrations appliquées dans l'ordre ; les trois
   dernières sont rejouables.
2. **Contrôle négatif** : en retirant la fermeture globale, la migration
   **échoue** — SQLSTATE `42501`, message nommant la forme utile. Autrement dit,
   elle ne peut pas réussir sans avoir produit son effet.
3. **Matrice des privilèges par défaut** (10 combinaisons mesurées, §8 du
   document de phase) : seule la forme **globale** ferme le défaut ; la forme
   `IN SCHEMA` n'écrit **aucune** règle ; un `IN SCHEMA … GRANT EXECUTE TO
   PUBLIC` rouvre la porte et laisse `proacl` à `NULL` — d'où la règle de
   vérification : mesurer `has_function_privilege`, jamais lire `proacl`.
4. **Effet mesuré** : fonction témoin créée après la migration → ACL
   `{postgres=X/postgres, tracefab_app=X/postgres}`, PUBLIC exclu.
5. **Non-régression** : le rôle applicatif exécute les 12 fonctions des
   politiques ; l'isolation RLS reste verte après application.
6. **Propriété et escalade** : toutes les fonctions appartiennent au
   propriétaire de la base ; `search_path` épinglé sur les 107 ; aucun rôle non
   privilégié ne peut créer de fonction dans `public`.
7. **Plan d'application et de retour arrière** écrit (§9 du même document),
   avec la séquence `audit → constat → décision → autorisation → application →
   preuve datée` et le rollback exact (rendre `EXECUTE` à `PUBLIC`), volontairement
   hors de `prisma/migrations/` pour ne pas être rejoué comme une régression.

**Non appliquée en production** : `PRÉPARÉ NON APPLIQUÉ`.

## 8. Preuves de génération Prisma et de build

Le point décisif était de ne pas confondre « la génération est configurée » et
« la génération a lieu dans le build réellement utilisé ». Preuve obtenue sans
accès à la console Vercel, en utilisant **l'état des déploiements comme oracle**
(chaque poussée sur la branche crée un déploiement Preview, dont l'état est
lisible par `gh api`) :

| Commit poussé | `postinstall` | Déploiement Preview |
|---|---|---|
| `b0d332f` | génération + vérification du client | succès (`7010084399`) |
| `21f9340` | génération d'un schéma **absent** (contrôle négatif) | **échec** (`7010111138`) |
| `62fc3b3` | restauration | succès (`7010151109`) |
| `2d03cc4` | + contrôle du **moteur** | succès (`7010442465`) |
| `1a3d7a7` | + témoins de la politique (rapport final) | succès (`7010526262`) |

Conclusion **prouvée** : l'installation exécute réellement la génération dans
l'environnement de build, un échec de génération **fait échouer le
déploiement**, la vérification passe avec un client réellement généré sur
Linux, et `PRISMA_SKIP_POSTINSTALL_GENERATE` n'y est pas positionné.

Les quatre états de client sont couverts dans les deux sens par
`test:prisma-client` : factice refusé, conforme accepté, incomplet refusé,
**complet en apparence mais sans moteur refusé**. Le contrôle du moteur est
**structurel et volontairement** : il n'ouvre aucune connexion — l'installation
de ce dépôt ne doit joindre aucune base. Un client sans moteur se construit,
expose ses délégués, et échoue à la première requête : c'est le vert qui précède
la panne, exactement la forme de l'incident.

Deux limites, dites telles quelles :

- **`npm run api:typecheck` échoue dans cet environnement** (code 2) : le client
  n'est pas généré ici, la commande `prisma generate` exigeant
  `binaries.prisma.sh`, inaccessible depuis ce sandbox. Cette commande n'est
  donc **pas vérifiée** ; elle s'exécute en CI (actuellement désactivée) et
  échouerait bruyamment si le client manquait, ce qui est le comportement
  souhaité.
- **L'inclusion du client dans le paquet de fonctions déployé n'est pas
  prouvée** : la vérification s'exécute à l'installation, avant l'empaquetage.
  Le seul contrôle concluant est le test discriminant à deux requêtes du §9.

## 9. Diagnostic de l'erreur `internal_error` : NON VÉRIFIÉ

```
{"error":"internal_error","correlationId":"c3696f22-41d0-4981-8d99-4e6a177021a3"}
```

Le **mécanisme** est reproduit : `api/index.ts` est le seul émetteur de
`correlationId`, et cet identifiant est un `randomUUID()` **jamais persisté** —
sans le journal Vercel, il n'existe plus. Localement, l'absence de client
généré fait échouer le chargement de **119 des 125 modules de route**, ce qui
produit exactement cette réponse d'erreur.

L'**occurrence** n'est pas constatée, et je ne la présente pas comme telle : le
déploiement de production `6968252029` sert `b0c976f`, et je n'ai pas accès aux
journaux. Deux voies, au choix du propriétaire :

1. extraire du journal Vercel la ligne portant l'identifiant
   `c3696f22-41d0-4981-8d99-4e6a177021a3` (déploiement `6968252029`) ;
2. exécuter depuis un navigateur, sans aucun identifiant :
   `GET /api/health` puis `GET /api/catalog/schemas`. `500` + `correlationId`
   et catalogue `200` ⇒ client Prisma non généré à l'exécution ; `503`
   `database_unavailable` ⇒ connectivité base ; les deux `200` ⇒ symptôme
   disparu.

Tant que l'un des deux n'est pas fait, l'origine reste `NON VÉRIFIÉ`.

## 10. État des protections GitHub Actions

**Posture constatée sur toutes les branches** (`npm run audit:workflows`, qui
lit chaque workflow de chaque référence distante **sans les extraire ni les
exécuter**) : 12 fichiers de workflow répartis sur 21 références. **Onze alertes
critiques**, une seule référence classée propre : cette branche de travail.

Portent encore le workflow qui lit `secrets.DATABASE_URL` et lance des suites
destructives sans garde : `main`, les cinq `experience/chantier-16…20`,
`correctifs/chantier-1a`, `arena/e72cecf4-tracefab`, et la branche de la PR #34.
Deux suites destructives **absentes de mon arbre** y apparaissent
(`test:neon:dpp-provenance`, `test:neon:deploiement-publication`,
`test:neon:auth-provisioning`, `test:neon:rls:auth`, `test:neon:dpp-ambigu`) :
une fusion de l'une de ces branches réintroduirait le sujet.

**Politique et témoins** : `test:workflow-policy` vérifie A) aucune lecture de
`secrets` non déclarée, B) aucune connexion de base alimentée par un secret,
C) épinglage par SHA **avec version lisible**, D) `contents: write` déclaré,
E) aucun déclencheur privilégié non déclaré, F) environnements, G) aucune suite
de base hors garde, H) **aucun jeton d'écriture détenu par un job qui exécute du
code du dépôt**. Les huit témoins du §4 prouvent que ces détecteurs détectent :
chaque faute fabriquée est refusée, et le témoin propre passe sans un échec.

**`Figer la reference visuelle`** : déclenché par `push` sur le marqueur
`tests/regression/reference/.figer` **et par `workflow_dispatch`**, avec
`permissions: contents: write` **au niveau du workflow** (donc hérité par tous
les jobs) et sans `pull_request`. Le durcissement préparé
(`docs/security/patches/`) a été **vérifié applicable** ce jour sur sa branche
(`git apply --check`, worktree temporaire détruit ensuite). Le conflit est
documenté : le fichier n'existe que sur `arena/91844ee9-tracefab`, donc un
add/add si on l'applique ailleurs. **PRÉPARÉ NON APPLIQUÉ.**

**Protections de `main`** : constat inchangé — `protected: false`, **aucune**
branche protégée, **0** ruleset, environnements Preview et Production sans règle
de protection, workflow `CI` en `disabled_manually` (**0 exécution**). Les
valeurs exactes à saisir, avec leur chemin dans l'interface, sont dans
`docs/security/PHASE-1-PIPELINE-GITHUB.md`. Rappel : ces protections ne
bloquent pas les déploiements créés par l'intégration Vercel — cela se règle
côté Vercel. **PRÉPARÉ NON APPLIQUÉ.**

## 11. Problèmes ouverts et statuts

| # | Problème | Statut | Preuve |
|---|---|---|---|
| P0-4 | scénario destructif pouvant viser la production | **CORRIGÉ EN ENVIRONNEMENT ISOLÉ** | 15/15 garde, 10 suites routées, 8 témoins de politique, suites non gardées absentes de l'arbre |
| P0-6 | client Prisma absent à l'exécution | **CORRIGÉ ET PROUVÉ** (build) / **NON VÉRIFIÉ** (occurrence en production) | oracle des déploiements §8 ; discriminant §9 non exécuté |
| P1-10 | 5 fonctions `SECURITY DEFINER` exécutables par `PUBLIC` | **CORRIGÉ ENVIRONNEMENT ISOLÉ** ; production **PRÉPARÉ NON APPLIQUÉ** | §7, migration auto-vérifiée + contrôle négatif |
| P1-11 | rôle applicatif possiblement `BYPASSRLS` | **BLOQUÉ** | nécessite l'audit read-only (§5) |
| P1-12 | migrations réellement appliquées en production | **BLOQUÉ** | idem |
| P1-13 | `main` sans protection, `CI` désactivée | **PRÉPARÉ NON APPLIQUÉ** | valeurs et chemins écrits ; activation = action propriétaire |
| P1-14 | workflow visuel écrivable depuis une poussée | **PRÉPARÉ NON APPLIQUÉ** | patch vérifié applicable le 2026-10-12 |
| P1-15 | `api:typecheck` non vérifiable sans client généré | **NON VÉRIFIÉ** | échec local documenté (§8) |
| P2-16 | actions flottantes sur les branches non fusionnées | **PRÉPARÉ NON APPLIQUÉ** | 9 références non épinglées relevées par l'analyseur |
| P2-17 | documents EXP-01/02/03, CL-11, DEC-36 introuvables | **BLOQUÉ** | absents du dépôt et de son historique |
| P2-18 | rotation de secrets | **BLOQUÉ** | interdite sans qualification préalable ; chemin décrit au chantier 2 |
| P2-19 | suite de navigateur non exécutée | **NON VÉRIFIÉ** | Playwright non exécuté dans ce sandbox |
| P2-20 | inclusion du client Prisma dans le paquet déployé | **NON VÉRIFIÉ** | discriminant §9 |

## 12. Actions nécessitant une autorisation du propriétaire

1. **Audit Neon en lecture seule** — fournir une chaîne de connexion en lecture
   seule par un mécanisme sécurisé, ou exécuter le script soi-même (§5).
2. **Journaux Vercel** — extraire la ligne de l'identifiant de corrélation, ou
   exécuter le test discriminant à deux requêtes (§9).
3. **Application de la migration corrective en production** — après l'audit,
   par `npx prisma migrate deploy`, avec l'empreinte consignée (§7).
4. **Réglages GitHub** — protection de `main`, réactivation du workflow `CI`,
   application du patch `figer` sur sa branche (§10).
5. **Réglages Vercel** — variables d'environnement, rôle de connexion
   applicatif, et décision sur la commande de build du projet (aujourd'hui
   inatteignable à cause du tableau `builds`).
6. **Fusion** de la branche de travail ou ouverture d'une PR, le cas échéant :
   je n'ai rien fusionné ni déployé en production.

## 13. Prochaine action prioritaire

**Un test discriminant à deux requêtes, exécutable depuis n'importe quel
navigateur, sans aucun identifiant** :

```
GET https://tracefab.vercel.app/api/health
GET https://tracefab.vercel.app/api/catalog/schemas
```

- `500` + `correlationId` sur la santé **et** catalogue `200` ⇒ la cause
  « client Prisma non généré » est **confirmée en production** ;
- `503` `database_unavailable` ⇒ le défaut est la connectivité base, pas
  l'empaquetage ;
- les deux `200` ⇒ le symptôme a disparu et P0-6 passe à « NON REPRODUIT ».

C'est la seule action qui transforme une hypothèse en constat, et elle ne
demande ni accès, ni secret, ni autorisation particulière.

## 14. Ce que ce rapport ne prouve pas

- Qu'aucune route ne fonctionne en production : je n'ai pas exécuté le
  discriminant, et je n'ai pas accès au réseau de l'application.
- Que la base Neon soit dans l'état supposé : aucun constat, aucun accès.
- Que la CI protège : elle est désactivée, **zéro exécution**.
- Que la migration doive être appliquée : cela dépend de l'audit préalable.
- Que `npm run api:typecheck` passe : non exécutable ici, faute de client
  généré localement.

Aucun test local n'est présenté comme une preuve de fonctionnement en
production. Aucun problème n'est déclaré résolu sans vérification datée.
