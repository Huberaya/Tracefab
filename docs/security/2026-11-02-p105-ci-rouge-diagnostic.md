# P10.5 — Les deux contrôles CI rouges : causes, correctifs, preuves

Date : 2 novembre 2026 · Branche : `arena/96848462-tracefab` · PR **#105** (draft, non fusionnée)

Ce document ne raconte pas une intention : il consigne ce qui a été **mesuré**,
ce qui a été **corrigé**, et ce qui **n'a pas pu être vérifié**. Les trois
catégories sont séparées partout.

---

## 0. Points de départ vérifiés (et une surprise)

| Élément | Valeur mesurée le 02/11 |
|---|---|
| tête de la branche au début de l'intervention | `cbdad0e6e61d93a64aaa0e201d908ea11e0e2b62` |
| `main` | `f6d39aa027e4cdea1a2e7a381fe432310cc77fdc` |
| PR #105 | `OPEN`, **draft**, base `main`, non fusionnée |
| **base de fusion entre la branche et `main`** | **aucune** — `git merge-base` ne rend rien |
| `main` contient-elle `5ed2745` (base d'origine de la PR) ? | **non** |

**La surprise** : `main` a été **réécrite** (`f6d39aa` est un commit unique,
« P10 — durcissement sécurité, isolation RLS et tests DB »). L'ancienne base de
la branche a disparu de l'histoire. Comparer la branche à `main` ne donne donc
pas un diff mais **deux arbres sans ancêtre commun** :

```
git diff --stat origin/main HEAD   ->  39 fichiers, +4222 / -148
```

Et cette comparaison n'est pas à sens unique : `main` porte des choses que la
branche n'a pas (par exemple les scénarios B3/B4 ajoutés à
`scripts/test_provisioning_role_app.mjs`). Les deux lignées ont traité le même
sujet séparément.

**Conséquence, à traiter avant toute fusion** : GitHub ne peut pas calculer de
fusion pour une PR sans base commune. Ce n'est pas un défaut de code, c'est un
état de dépôt ; il demande une décision d'exploitation (rebaser la branche sur
`main` réécrite, ou rejouer les correctifs sur une branche neuve partie de
`main`). **Rien n'a été rebasé ni forcé ici** : la branche de la PR n'est pas
réécrite sans accord.

---

## 1. Job « Base — isolation RLS executee » : échec de l'étape 15

### Ce que dit la CI

```
Étape en échec : 15 — « Gardes des ressources jetables, du verrou et de la
reprise (R6/R7/R9) »
Annotation GitHub : « Process completed with exit code 1. »
```

Le journal complet du job n'est **pas téléchargeable depuis la session** :
GitHub le sert depuis `*.blob.core.windows.net`, hors du périmètre réseau
autorisé (`failed to get run log: ... EOF`). Ce qui reste exploitable : les
annotations de check-run, et la **reproduction locale** de la même étape.

### Reproduction locale — la commande exacte de l'étape

```bash
for suite in test_garde_cible_ecriture test_verrou_fail_closed test_verrou_cluster \
             ... test_reprise_ressources_jetables; do
  node scripts/run-db-suite.mjs "scripts/$suite.mjs"
done
```

Résultat avant correctif, sur un cluster PostgreSQL 17 jetable migré (68/68) :

```
ECHEC aucun chemin non classe ne provisionne le role —
      observé : scripts/test_p105_roles_et_migrations.mjs
```

### Cause exacte

`scripts/test_p105_roles_et_migrations.mjs` **provisionne** `tracefab_app` et
`tracefab_migrator` — des objets de **cluster** (`pg_authid`) — **sans prendre
le verrou consultatif** que tous les autres chemins de provisioning prennent.
La détection dynamique de `test_verrou_cluster.mjs` est volontairement large :

```js
const marqueurs = /ensureAppRole\(|execFileSync\(\s*'node'[^\n]*prepare_ci_db_role|bootstrap_app_role\.mjs/;
```

Elle a vu le nouveau script et l'a signalé comme « chemin non classé ». Le
contrôle a donc fait exactement son travail : il a détecté une section critique
non protégée, ajoutée sans être déclarée.

### Correctif (commit `1702a59`)

1. le script **prend le verrou** autour du provisioning, puis le **relâche** ;
2. `scripts/test_verrou_cluster.mjs` classe explicitement les deux chemins
   concernés, **avec leur raison** :
   - `test_p105_roles_et_migrations.mjs` → `DOIVENT_VERROUILLER` ;
   - `provisionner_roles_db.mjs` → `NE_DOIVENT_PAS` (« section critique,
     verrouillée par ses appelants », comme `bootstrap_app_role.mjs`) ;
   - `test_destructive_suite_routing.mjs` → `NE_DOIVENT_PAS` (« test statique,
     ne provisionne rien ») ;
3. la détection inclut désormais `provisionner_roles_db\.mjs` dans ses marqueurs,
   pour que l'oubli ne puisse pas se reproduire en silence.

**Pourquoi le verrou est pris puis relâché** : `migrer_fidelement.mjs`, lancé
ensuite par la suite, prend **le même verrou dans sa propre session**. Un verrou
consultatif n'étant pas réentrant d'une session à l'autre, le garder pendant
l'enfant bloque indéfiniment. Mesuré deux fois (deux blocages à 300 s avant
correction).

### Preuve après correctif

```
test_verrou_cluster               OK   31/31
test_verrou_fail_closed           OK
test_concurrence_suites           OK
test_ressources_fixes_garde       OK
test_migration_atomicite_plm_dedup OK
test_base_ephemere_garde          OK
test_role_ephemere_garde          OK
test_ensure_app_role_garde        OK
test_provisioning_role_app        OK
test_destruction_verrouillee      OK
test_reprise_ressources_jetables  OK
test_garde_cible_ecriture         OK   80/80
```

---

## 2. Job « Verification — suite de tests » : échec de l'étape 10

### Ce que dit la CI (annotation, texte intégral)

```
suites en echec : test:p105:roles-et-migrations test:p105:hmac
                  test:p105:ingestion test:p105:jeton test:p105:sonde
                  test:p105:hierarchie
  NON EXECUTE — DATABASE_URL absent(s).
  scripts/verifier_hierarchie_roles.mjs : aucune cible fournie, donc aucune execution.
  Un test qui ne tourne pas ne vaut pas un test qui passe : sortie 2.
  NON EXECUTE — DATABASE_URL est requise.
```

### Cause exacte

`ci.yml` exécute, dans le job `verification`, **toutes** les entrées `test:*`
de `package.json` sauf une liste d'exclusions (neon, staging, p2, regression,
audit-script, `dpp:*`, `garde-fous:neon`, `jetables:*`). Les six suites
`test:p105:*` ajoutées par P10.5 n'y figuraient pas : elles étaient donc
lancées **dans le seul job qui n'a pas de base de données**. Leur garde de
cible est fail-closed et sort en **2** (« non exécuté ») ; la boucle lit ce 2
comme un échec, à raison.

Deux défauts distincts, tous deux réels :

1. **mauvais étage** : ces suites mesurent des rôles, des migrations et une clé
   HMAC ; elles exigent le Postgres jetable du job `Base`, qui les câble déjà
   une par une ;
2. **sortie illisible** : l'étape `Base` qui les exécute était en `set -e`, donc
   une suite en échec ne laissait que « exit code 1 » — et le journal du job
   n'étant pas accessible depuis la session, il fallait tout reproduire pour
   savoir laquelle.

### Correctifs

- `65c942d` : exclusion de `test:p105*` de la boucle sans base (même raison que
  `test:jetables:*`, écrite dans le commentaire), et l'étape « Gardes des
  ressources jetables » **accumule** les échecs puis imprime
  `::error::suites en echec : <liste>` avant de sortir en 1. **Aucun échec
  n'est masqué** : la sortie en erreur est conservée, elle est seulement nommée.
- `cbdad0e` : `scripts/verifier_hierarchie_roles.mjs` **n'existait pas**, alors
  qu'il était déjà câblé dans `ci.yml` et `package.json` (`test:p105:hierarchie`).
  Le job `Base` serait tombé en `MODULE_NOT_FOUND` dès que l'étape aurait été
  atteinte. Le script est écrit et mesure B4 par exécution (voir § 3).

### Preuve après correctif — ordre exact de la CI, base jetable

```
test:p105:roles-et-migrations  OK  19 assertions
test:p105:jeton                OK  19
test:p105:hmac                 OK  21
test:p105:ingestion            OK  10
test:p105:hierarchie           OK  19 lignes / 21 assertions
test:p105:sonde                OK  6
connexion applicative après la série : app OK (tracefab_app)
```

La dernière ligne est un contrôle explicite : ces suites provisionnent des
**rôles de cluster**, donc changent les mots de passe pour tout le serveur.
La suite restaure les vérifieurs SCRAM relevés avant, et la connexion
applicative est rejouée après coup.

---

## 3. R-A1 — le mode strict est maintenant éprouvé sur le CHEMIN D'ÉCRITURE

Le scénario S3 existant prouvait qu'une identité forgée **ne rend pas
d'identité** et **ne voit aucune ligne**. Il ne prouvait pas qu'une **opération**
est refusée : une fonction qui ne consulte pas l'identité, ou une politique
permissive, aurait encore pu laisser passer une écriture.

Mesures ajoutées (`scripts/test_p105_hmac_identite.mjs`, section « S3 bis »),
sur `product_materials` — table dont la politique d'insertion repose sur
`tracefab_has_org_role(...)`, donc sur l'identité. L'écriture est annulée par
`ROLLBACK`, la politique d'identité et la matière éphémère sont restaurées.

| Contexte | Attendu | Mesuré |
|---|---|---|
| strict, aucune identité | refus | `42501` (RLS) |
| strict, GUC forgé — **membre réel** du locataire visé | refus | `42501` |
| strict, jeton **valide** pour le locataire visé | accepté (contrôle positif) | `ACCEPTEE` |
| permissif, aucune identité | refus | `42501` |
| **permissif, GUC forgé** | **résidu M3** | `ACCEPTEE` — affiché comme **NON conforme** |

Deux précautions qui font la valeur du test :

- **la cible est le locataire B, et l'identité forgée est un membre réel de B.**
  Mesure intermédiaire : forger un utilisateur qui n'appartient pas au
  locataire visé fait refuser la RLS pour une autre raison (non-membre) ; le
  test passerait alors sans rien prouver de la vérification.
- **le contrôle positif** (jeton valide → accepté) empêche de confondre « la
  vérification refuse » avec « la table refuse tout le monde ».

**Ce que cela ne change pas** : tant que `strict = false`, le GUC reste
forgeable. Le test **mesure et affiche** ce résidu au lieu de le taire ; il ne
le présente pas comme une protection.

---

## 4. R-A2 / R-A3 — rôles, migrations, inter-organisations, ingestion

Mesuré sur la même base jetable (68 migrations, rôles séparés), suites vertes :

| Risque | Suite | Résultat |
|---|---|---|
| rôles provisionnés, attributs, chaîne sous le rôle de migration | `test:p105:roles-et-migrations` | 19/19 |
| hiérarchie réelle : `SET ROLE` essayé vers **chaque** rôle du cluster | `test:p105:hierarchie` | 21/21 |
| isolation inter-organisations (RLS exécutée) | `test:neon:rls`, `test:neon:isolation-lignes` | OK |
| politique d'écriture réelle (`WITH CHECK`) | `test:neon:write-policies` | OK |
| contrôle négatif du contournement RLS | `test:neon:bypass-control` | OK |
| ingestion PLM/ERP sous le rôle applicatif (permissif **et** strict) | `test:p105:ingestion` | 10/10 |
| registre runtime : aucune fonction hors registre | `test:neon:registre-fonctions` | OK |
| privilèges minimaux du rôle applicatif | `test:neon:privileges`, `test:neon:privileges-role-app` | OK (42/42 sur la seconde) |

Le contrôle de hiérarchie inclut un **témoin non vacuant** : une appartenance
est accordée à `tracefab_app`, on prouve que `SET ROLE` devient réellement
possible (`current_user` change), puis on la retire et on prouve que le refus
est revenu. Sans ce témoin, un refus dû à une autre cause passerait pour une
preuve.

---

## 5. Ce qui N'A PAS PU ÊTRE FAIT — la CI ne démarre plus

**Constat mesuré, pas une hypothèse** :

```
gh api ".../actions/runs?created=>2026-11-02T09:00:00Z"   ->  total_count: 0
gh api ".../commits/100e5bc/check-runs"                   ->  Vercel uniquement
gh api ".../commits/cbdad0e/check-runs"                   ->  Vercel uniquement
gh workflow run ci.yml --ref arena/96848462-tracefab      ->  HTTP 403
```

- les poussées `65c942d`, `cbdad0e` et `100e5bc` sont **bien arrivées** sur le
  dépôt (`git ls-remote` → `100e5bc`), mais **aucun run de workflow n'a été
  créé**, ni sur cette branche, ni ailleurs : **zéro run dans tout le dépôt
  depuis 08:22 UTC** (dernier run : `CI` sur `main`, `workflow_dispatch`);
- le déclenchement manuel est refusé : l'intégration GitHub de cette session
  n'a pas la permission `actions: write` (`HTTP 403 Resource not accessible by
  integration`) ;
- le journal complet des jobs n'est pas téléchargeable depuis la session
  (`*.blob.core.windows.net` hors périmètre réseau).

**Donc** : il n'existe à cette heure **aucun run CI sur le SHA livré**. Je ne
peux ni le produire, ni le consulter. Ce n'est pas un test « réussi » : c'est
un test **non exécuté**, et il est déclaré comme tel.

Ce qu'il faut faire côté dépôt, dans cet ordre :

1. vérifier l'état d'Actions du dépôt (facturation/limite de minutes, Actions
   désactivées, ou incident plateforme) — c'est la cause la plus probable d'un
   arrêt net de **tous** les runs ;
2. une fois Actions disponible, pousser un commit (ou « Re-run all jobs » sur un
   run de la branche) et lire les deux jobs `Base` et `Verification` ;
3. si un job reste rouge, m'envoyer la liste `::error::` : l'étape « jetables »
   la nomme désormais explicitement, précisément pour ce cas.

---

## 6. Ce qui reste ouvert

| Point | État |
|---|---|
| `main` réécrite, aucune base de fusion avec la PR | **ouvert** — décision d'exploitation requise, rien n'a été rebasé |
| run CI sur le SHA livré | **impossible à produire depuis la session** (§ 5) |
| résidu M3 (mode `strict = false`) | **ouvert par conception** : mesuré, affiché, non masqué |
| identité réelle du runtime en production, appartenances Neon, `DATABASE_URL`/clé côté Vercel, état de `_prisma_migrations`, version PG de production, fenêtre PITR | **non vérifiés** — demandent un opérateur autorisé |
| les suites qui échouent localement faute d'environnement (navigateur Playwright, client Prisma non généré hors ligne) | **non exécutées ici** ; elles tournent en CI (qui les a déjà vues vertes), et ne sont pas comptées comme preuves |
