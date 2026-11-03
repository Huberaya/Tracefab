# P10.8 — Revue finale de la PR #105 et décision de fusion

**Date** : 2026-11-03 · **Branche** : `arena/96848462-tracefab` · **PR** : [#105](https://github.com/Huberaya/Tracefab/pull/105)
**`main` au moment de la revue** : `f6d39aa027e4cdea1a2e7a381fe432310cc77fdc`
**Fusion** : **non effectuée**, et volontairement : elle attend une autorisation explicite.

Ce document traite deux questions distinctes, et ne les mélange pas :

1. **la fusion** du code dans `main` (qualité, sûreté du diff, preuves de test) ;
2. **la mise en production** (état réel de Neon, des secrets, de `strict`).

Un GO sur la première n'est pas un GO sur la seconde. La section 8 le dit
explicitement.

---

## 1. SHA contrôlé et état GitHub réel

| Élément | Valeur mesurée |
|---|---|
| Tête de PR (avant cette revue) | `5fb216f3b081d2b91ed4e7496fb4eb422ec6a52b` |
| Base `main` | `f6d39aa027e4cdea1a2e7a381fe432310cc77fdc` |
| État | `OPEN`, **brouillon**, `merged: false` |
| Mergeabilité | `MERGEABLE`, `mergeStateStatus: CLEAN`, **aucun conflit**, `rebaseable: false` (rien à rebaser) |
| Commits dans la PR | 36 · 62 fichiers · +9 492 / −90 |
| Revues | **0** |
| Commentaires de revue | **0** · 1 commentaire d'issue : le bot Vercel (déploiement de prévisualisation) — **aucun commentaire non résolu** |
| Commits postérieurs aux runs annoncés | **aucun** : `5fb216f` était bien la tête au moment de la vérification |

Vérification de la correspondance SHA ↔ runs : les runs ont été listés par
branche puis filtrés sur `head_sha`. Les runs d'une tête antérieure
(`c19ae6b`, `6f020f2`, `87d956d`, `b0896bb`, `cc8e312`) sont **périmés** et ne
valent pas preuve pour la tête courante.

---

## 2. Workflows et jobs sur la tête

| Workflow | Run | Jobs | Conclusion |
|---|---|---|---|
| `CI` | [41550325782](https://github.com/Huberaya/Tracefab/actions/runs/41550325782) | Socle (64 étapes) · Base (71) · Parcours (15) · Verification (14) | **succès** |
| `Intégration migrations 34/36/41` | [41550325771](https://github.com/Huberaya/Tracefab/actions/runs/41550325771) | Chaîne 34/36/41 sur Postgres 17 jetable (13) | **succès** |
| Vercel | — | déploiement de prévisualisation | pass |

`head_sha` de ces deux runs = `5fb216f3b081d2b91ed4e7496fb4eb422ec6a52b`, soit
la tête exacte. Aucune étape, dans aucun job, n'est en `continue-on-error` —
vérifié par balayage du dépôt : les quatre occurrences du mot sont des
commentaires qui l'interdisent, et `test:workflow-policy` le contrôle à chaque
exécution.

**Réserve de méthode** : la CI tourne sur un PostgreSQL 17 jetable construit par
le workflow. Elle prouve que le code fait ce qu'il annonce ; elle ne prouve rien
sur Neon (§ 8).

---

## 3. Revue du diff — par domaine

### 3.1 Migrations et ordre d'application

Deux migrations ajoutées, **aucune migration historique modifiée** (mesuré :
`git diff --name-status origin/main...HEAD -- prisma/migrations` ne rend que
deux `A`, zéro `M`) :

- `20261031120000_identite_hmac_liee_au_contexte` (rang 68)
- `20261102120000_identite_stricte_email_et_rotation` (rang 69)

Elles ne créent aucune clé (une clé dans un fichier de migration serait
publique : le provisionnement est un script opérateur), ne modifient aucune
donnée métier, n'accordent ni `SUPERUSER`, ni `BYPASSRLS`, ni appartenance.

### 3.2 `tracefab_current_user_id()` — le point de passage unique

Remplacée par `CREATE OR REPLACE`, elle devient le seul endroit où l'identité se
décide : jeton présent ⇒ **toujours vérifié** (même en mode permissif) ;
invalide ⇒ `NULL`, **jamais** de repli sur `tracefab.user_id` ; mode strict sans
jeton ⇒ `NULL` ; mode permissif sans jeton ⇒ comportement historique. Une seule
observation : la branche permissive finale est le dernier endroit où le GUC brut
subsiste, et c'est assumé — c'est ce qui permet de déployer la vérification
avant que l'application n'émette des jetons.

### 3.3 Fonctions `SECURITY DEFINER`, propriétaires, ACL

- Vérification du jeton : `SECURITY DEFINER`, `search_path = pg_catalog, public`
  épinglé, tous les appels de catalogue qualifiés, `REVOKE ALL … FROM PUBLIC`,
  `EXECUTE` accordé au runtime **via le registre** (aucun `GRANT` direct : la
  migration refuse de contourner `tracefab_apply_runtime_function_grants()` et
  vérifie après coup que le droit existe — sinon elle lève).
- Elle **ne rend jamais de MAC**, ne signe rien, et ne distingue pas les causes
  d'échec : pas d'oracle.
- Table des clés : possédée par le propriétaire des objets, `FORCE ROW LEVEL
  SECURITY`, politique bornée à `current_user = propriétaire réel` lu au
  catalogue, **aucun privilège** pour `tracefab_app`. Limite écrite dans la
  migration : un détenteur des identifiants du rôle de migration lit la clé —
  mais ce rôle possède déjà toutes les tables.
- Les trois fonctions d'attestation (`register_transaction_certificate`,
  `allocate_tc_quantity`, `reconcile_mass_balance`) sont reprises à l'identique
  avec une seule ligne changée (GUC brut → `tracefab_current_user_id()`),
  `CREATE OR REPLACE` préservant OID, propriétaire et ACL.
- **Post-conditions dans la migration elle-même** : plus aucune fonction ne lit
  `tracefab.user_id` (sauf le point de passage), plus aucune politique ne
  compare à `tracefab.user_email`, les trois fonctions d'attestation appellent
  bien le point de passage, le runtime ne lit pas les clés, et peut toujours
  vérifier un jeton. Une migration qui échoue à prouver ce qu'elle a laissé
  échoue.

### 3.4 Validation HMAC et rotation

- Format `v1|<user_id>|<org_id>|tracefab_identity|<exp>.<HMAC-SHA256 hex>`.
- Expiration lue sur l'horloge de la **base** (`pg_catalog.now()`), jamais celle
  du client.
- Organisation signée comparée à `tracefab.active_organization_id` : un jeton
  émis pour A ne vaut pas pour B.
- Rotation : **toute clé `actif` est essayée sans sortie anticipée** (le nombre
  de clés essayées ne dépend pas du rang de celle qui a signé), puis l'ancienne
  est désactivée. Aucune information sur la clé n'est divulguée par le format.
- Validation de la clé côté application : hexadécimal, longueur paire, ≥ 64
  caractères — une clé mal saisie aurait sinon produit un HMAC sur une clé
  **vide**, vérifiable par quiconque.

### 3.5 Comportement sans jeton, et mode strict

`tracefab_identity_politique.strict` reste `false` dans la migration. Le
drapeau est protégé en écriture par l'ACL (le runtime n'a que `SELECT`) et par
l'absence de politique `UPDATE` — **mesuré par tentative d'écriture réelle**
dans `test:neon:rls`, pas seulement lu au catalogue.

### 3.6 Politiques RLS et accès PLM/ERP

`passport_access_select` est recréée pour comparer à
`tracefab_current_user_email()`, qui lit l'adresse de l'identité **signée** en
mode strict. Le contrôle de convergence PLM/ERP a été rendu exact : il portait
sur toutes les politiques créées après une cible, il porte désormais sur celles
créées **sur `plm_erp_sync_jobs`** — avec deux témoins qui prouvent qu'il voit
toujours une politique permissive sur cette table, et qu'il ne confond plus une
autre table avec elle.

### 3.7 Scripts de provisioning

`ensureAppRole` **compare et n'écrit plus** quand le rôle est déjà conforme (PG
16+ exige `SUPERUSER` pour changer l'attribut `SUPERUSER` : l'ancien `ALTER ROLE`
systématique faisait dépendre le démarrage d'un privilège d'administration). Un
rôle divergent est **refusé**, jamais rafistolé ; une course perdue sur `CREATE`
relit l'état réel et applique la même règle fail-closed au lieu d'écraser le mot
de passe d'un tiers.

### 3.8 Workflows CI

Diff présenté en séance avant commit (règle permanente). Aucune étape en
`continue-on-error`. La boucle de suites du job `Verification` a remplacé
`set -e` par une accumulation qui nomme les suites en échec **et sort en 1** :
un échec reste un échec, et il devient lisible (le journal du job n'est pas
accessible depuis l'API).

### 3.9 Secrets et données sensibles dans les journaux

- Aucune valeur de clé n'est imprimée : `provisionner_cle_identite.mjs` publie
  version, état, **longueur** ; la readiness publie `configured` / `mode`.
- `scripts/sonde_p107_hmac.ts` est établie par un test qui refuse toute fenêtre
  de huit caractères de la clé dans la sortie, **chemin d'erreur compris**.
- Balayage du diff à la recherche de motifs de secrets (64 hexadécimaux,
  `sk_live`, `BEGIN PRIVATE KEY`, mots de passe en dur) : **aucun**.

### 3.10 Changements de comportement par rapport à `main`

À déployer, ce code change trois choses — et c'est là que se joue le risque
d'exploitation, pas le risque de fusion :

| Changement | Effet si la configuration est saine | Effet si elle ne l'est pas |
|---|---|---|
| l'application signe un jeton par transaction | aucun changement visible | clé **absente** ⇒ rien n'est posé, mode permissif, comportement d'avant |
| `cleIdentite()` **lève** sur clé présente mais malformée | — | **toutes les routes authentifiées répondent 500** : c'est le choix fail-closed de P10.6, à vérifier avant déploiement |
| `ensureAppRole` n'émet plus d'`ALTER ROLE` | démarrage possible sans privilège d'administration | rôle divergent ⇒ refus explicite au lieu d'une correction silencieuse |

---

## 4. Cohérence des preuves — ce qui est mesuré, et comment

La distinction demandée est appliquée : **contrôle structurel ≠ preuve
d'exécution**.

| Affirmation | Type de preuve | Statut |
|---|---|---|
| un jeton valide donne l'identité | exécution (base jetable, rôle applicatif réel) | **prouvé** |
| sans jeton en mode strict : `null`, 0 ligne | exécution | **prouvé** |
| MAC faux ⇒ aucune identité | exécution | **prouvé** |
| GUC forgé ⇒ aucune identité, aucune adresse | exécution (N1 strict) | **prouvé** |
| **aucun repli sur le GUC si le jeton est invalide, même en permissif** | exécution (N3 : MAC faux **+ GUC valide de B** ⇒ `null`) | **prouvé** |
| organisation incohérente ⇒ refus | exécution (N3b/D5 : corps modifié, MAC d'un autre corps) | **prouvé** |
| jeton expiré ⇒ refus, horloge de la base | exécution (N6, S5) | **prouvé** |
| rotation à deux clés actives, puis révocation | exécution (D6/D7) | **prouvé** |
| aucune fuite entre organisations | exécution : RLS `A=2 · B visible=0`, jeton de A refusé en session B | **prouvé** |
| refus effectif de `contributor` en écriture | exécution **par écriture réelle** (`plm-sync-jobs-acces`, 19) | **prouvé** |
| rejouabilité sur deux bases du même cluster | exécution (R6 : base neuve dans un cluster déjà migré, 25 assertions) | **prouvé** |
| préflight D6 **avant toute écriture** | **ajouté en P10.8** — exécution sur l'état de forme production (18 assertions) | **prouvé** (l'était seulement par unité + mesure ad hoc) |
| absence de régression RLS et PLM/ERP | exécution : 12 suites, 51 tables sous RLS, 43 + 33 + 31 + 22 + 19 … | **prouvé** |
| le runtime de production est `tracefab_app` | **rien** | **non mesuré** |
| `identityTokens.configured` en Production | **rien** | **non mesuré** |
| les propriétaires de fonctions en production | **rien** | **non mesuré** |

### Le trou de preuve trouvé en revue, et bouché

`préflight D6 avant toute écriture` n'était prouvé **que** par la fonction de
catalogue (R8) et par une mesure manuelle antérieure. Un contrôle unitaire dit
« la fonction détecte » ; il ne dit pas « la chaîne s'arrête avant d'écrire ».
La différence, en exploitation, est une base intacte contre une ligne d'échec
dans `_prisma_migrations` au milieu d'une fenêtre.

Nouvelle suite permanente `test:p106:preflight-avant-ecriture` (18 assertions,
exécution réelle) : base jetable amenée à l'**état de la production** (tout
appliqué sauf les deux migrations, fonctions détenues par le propriétaire),
puis chaîne rejouée par `tracefab_migrator` ⇒ **code 3**, refus nommé citant la
migration et le propriétaire, `_prisma_migrations` **inchangé**, ni
`tracefab_identity_cles` ni la fonction de vérification créées, aucune élévation
demandée ni résiduelle. Contrôle positif dans la même suite : jouée par le
propriétaire, la chaîne s'applique — le préflight ne refuse pas à tort.

---

## 5. Défauts résiduels, classés

| # | Gravité | Défaut | État |
|---|---|---|---|
| R1 | **Élevé (exploitation)** | `strict` reste `false` : un appel **sans jeton** garde le comportement antérieur. Non bloquant pour la fusion (c'était déjà le cas dans `main`), bloquant pour la production. | ouvert, assumé |
| R2 | **Élevé (exploitation)** | identité du runtime Neon non mesurée : la RLS n'est pas démontrée opposable en production. | ouvert |
| R3 | **Élevé (exploitation)** | les deux migrations ne sont appliquées à **aucune** base réelle. | ouvert |
| R4 | Moyen | une clé `TRACEFAB_IDENTITY_KEY` **présente mais malformée** en Production ferait échouer **toutes** les routes authentifiées (500), là où l'ancien code retombait silencieusement sur l'identité non signée. Fail-closed voulu, mais c'est un mode de panne à vérifier **avant** déploiement : `identityTokens.mode = cle_invalide` sur la readiness. | documenté |
| R5 | Moyen | jeton à durée de vie 60 s comparée à l'horloge **de la base** : un décalage > 60 s entre l'application et Neon rejette tous les jetons en mode strict. | documenté, non mesuré |
| R6 | Moyen | propriétaires de fonctions en production inconnus : le préflight refusera (fail-closed), donc arrêt en fenêtre plutôt que corruption — mais l'arrêt n'est pas préparé sur une copie. | ouvert |
| R7 | Faible | `_prisma_migrations` en production non relu (empreintes, `applied_steps_count`). | ouvert |
| R8 | Faible | la CI ne teste pas le pooler Neon ; le mode mesuré (`session_ou_direct`) l'a été sur un cluster local. | ouvert |
| R9 | Faible | 0 revue humaine sur la PR : les 36 commits sont relus ici, mais par le même agent qui les a produits. | ouvert |
| R10 | Faible | un test modifié exclut `tracefab_identity_politique` du balayage « deux locataires » — justifié (réglage global, une ligne, aucune colonne de locataire) **et compensé** par cinq assertions plus fortes, dont une tentative d'écriture réelle. | clos, documenté |

### Deux corrections faites en revue

| # | Ce qui a été trouvé | Correction |
|---|---|---|
| C1 | `test_registre_fonctions_runtime.mjs` avait **élargi sans justification écrite** la liste des propriétaires de confiance à `tracefab_migrator`. Mesure : zéro fonction de `public` appartient à ce rôle sur le cluster — l'élargissement était inerte, mais il aurait laissé passer une fonction `SECURITY DEFINER` possédée par le rôle de migration, donc exécutée **avec ses droits** (`BYPASSRLS`). | liste stricte rétablie (exécutant + `tracefab_worker`) ; suite verte. |
| C2 | `lire-disponibilite-role-app.mjs` annonçait « le script vérifie qu'elles sont bien fermées (voir § 6) » — **la section 6 n'existait pas**. Un contrôle décrit et non écrit se lit comme fait. | section 6 écrite : quatre privilèges mesurés table par table, distinction `SELECT` explicite pour le registre (lisible par conception), échec si une table censée être fermée est ouverte. |

Aucun test n'a été supprimé ni affaibli pour obtenir un résultat vert. Les deux
corrections vont dans le sens du **renforcement**.

---

## 6. `main` est intacte — preuve

| Vérification | Résultat |
|---|---|
| `git rev-parse origin/main` au début et à la fin de la revue | `f6d39aa027e4cdea1a2e7a381fe432310cc77fdc` — inchangé |
| `gh api refs/heads/main` | même SHA |
| Commits de la branche présents sur `main` | **aucun** (`origin/main..HEAD` ne contient que les commits de la branche) |
| Fusion effectuée | **non** : `merged: false`, `mergedAt: null` |
| Écriture sur Neon, migration sur base réelle, secret touché | **aucune** |

Toutes les écritures de cette phase ont eu lieu dans des bases `tf_*` créées
puis détruites sur le cluster jetable local, et dans le cluster de service de la
CI.

---

## 7. Décision de fusion

### GO conditionnel — fusion autorisable, sous trois conditions vérifiables

Le diff est **sain** : deux migrations additives, aucune migration historique
touchée, un point de passage unique pour l'identité, des post-conditions dans
les migrations elles-mêmes, des tests négatifs permanents qui échouent quand ils
devraient, et un préflight de propriété qui refuse **avant** d'écrire
(désormais prouvé par exécution). Aucune régression de comportement n'est
introduite sur `main` en configuration saine.

Il reste trois défauts **de preuve ou d'outillage**, dont deux ont été corrigés
ici et un ajouté (C1, C2, et la suite D6). Le quatrième point n'est pas un
défaut de code :

**Conditions de la fusion** (toutes vérifiables, aucune ne demande un accès
privilégié) :

1. **CI verte sur le SHA exact de la tête finale** — `ff9d126` : 4/4 jobs plus
   l'intégration migrations, `head_sha` égal au SHA annoncé. Sans cela, rien
   n'est validé (les runs d'une tête antérieure ne comptent pas). **Satisfaite.**
2. **Aucun test affaibli** : le diff de tests entre `main` et la tête ne contient
   que des ajouts ou des renforcements, et `test:workflow-policy` +
   `test:destructive-suite-routing` restent verts.
3. **`main` non modifiée** au moment de la fusion (`f6d39aa…`), et fusion
   **sans écraser** les commits de la branche ; aucun `--force`.

Conditions 1 et 2 sont **satisfaites** sur `ff9d126` (voir § 10) ; la 3 se
vérifie au moment de l'acte, et `main` n'a pas bougé de toute la revue.

### Ce que cette décision n'est pas

Ce n'est **pas** une autorisation de déploiement, ni un feu vert sur la sûreté de
la production. Fusionner apporte à `main` du code qui **n'active rien** :
`strict` reste `false`, aucune migration n'est appliquée aux bases réelles, aucun
secret n'est lu ni modifié.

---

## 8. Conditions de mise en production — liste séparée

À exécuter **après** fusion, sur un environnement autorisé, dans cet ordre, avec
arrêt exigé à la première étape non verte. Aucune de ces étapes n'est réalisable
depuis la CI.

1. **Sonde de catalogue** (lecture seule) sur la base cible : historique de
   `_prisma_migrations`, migrations 68/69 **en attente**, propriétaires des six
   fonctions visées par `20261102120000`, `search_path` des `SECURITY DEFINER`.
2. **Sonde de runtime** sur le déploiement réel : `IDENTITE_CONFORME` exigé
   (`tracefab_app`, sans `SUPERUSER`, sans `BYPASSRLS`, **aucune appartenance
   privilégiée atteignable**). Un `ARRET` ici interdit la suite.
3. **Sonde HMAC** : `identityTokens.configured: true` et `mode: "signe"` **sur
   l'environnement qui sert** ; vérifier aussi que `mode` n'est pas
   `cle_invalide` (mode de panne R4).
4. **Appliquer les migrations** en suivant le plan P10.7, avec le préflight D6
   actif — s'il refuse, **on s'arrête** : la propriété des fonctions est une
   décision d'administrateur, pas un contournement.
5. **Rotation préparée** : deux clés actives, jetons en vol acceptés, puis
   désactivation de l'ancienne après la durée de vie.
6. **Activer `strict` en préproduction d'abord** (plan E1–E8), avec parcours
   métier, contrôle RLS et ingestion PLM/ERP.
7. **Retour arrière** exercé une fois pour de vrai : `UPDATE
   tracefab_identity_politique SET strict=false` par le propriétaire.
8. **Cohérence Preview ↔ Production** de la configuration HMAC : non mesurable
   sans accès au fournisseur ; à défaut, la considérer comme **non vérifiée** et
   non comme acquise.

**Tant que 1 à 3 ne sont pas vertes sur l'environnement réel, la production
reste NO-GO, quelle que soit la couleur de la CI.**

---

## 9. Deux défauts trouvés par la CI pendant cette revue

Les deux ont été corrigés, jamais contournés — et les deux méritent d'être
consignés, parce qu'ils disent ce que la CI apporte que la mesure locale ne
donnait pas.

| # | Ce que la CI a signalé | Ce que c'était | Correction |
|---|---|---|---|
| CI-1 | job `Base`, étape des gardes jetables : **échec** | la nouvelle suite D6 provisionne le rôle applicatif et crée une base, mais n'était pas déclarée dans le registre des chemins qui **doivent** prendre le verrou de cluster. La garde de découverte a fait exactement son travail. | suite ajoutée au registre (`test_verrou_cluster` : 36/36, assertion **ajoutée**, pas retirée) |
| CI-2 | job `Base`, étape P10.8 : **échec** | la suite accordait des privilèges à `tracefab_migrator` **avant** de vérifier que ce rôle existe ; en CI il n'est pas provisionné, le `GRANT` échouait, et toutes les assertions du refus tombaient pour une raison étrangère au préflight. | exécutant résolu à l'exécution : rôle réel s'il est joignable, sinon rôle jetable `tf_d6_*` créé sous verrou et détruit ensuite, avec assertion qu'il ne reste ni base ni rôle. Les deux modes sont verts en local (19 et 20 assertions) |

Les journaux de job ne sont pas accessibles depuis l'API GitHub (mesure
antérieure) : les deux échecs ont été reproduits **en local** avant correction,
puis reverifiés, et non devinés.

## 10. Traçabilité de cette revue

| Élément | Valeur |
|---|---|
| Tête contrôlée en Phase A | `5fb216f3b081d2b91ed4e7496fb4eb422ec6a52b` |
| Corrections apportées en revue | `f724354` (suite D6), `2d394d2` (C1 + C2), `6f87731` (CI-1), `ff9d126` (CI-2) |
| **Tête vérifiée** | **`ff9d126`** |
| CI sur ce SHA exact | [41559697162](https://github.com/Huberaya/Tracefab/actions/runs/41559697162) — 4/4 jobs (Socle 3m48, Base 2m23, Parcours 1m38, Verification 12m54) |
| Intégration migrations | [41559697208](https://github.com/Huberaya/Tracefab/actions/runs/41559697208) — succès (1m23) |
| `main` pendant toute la revue | `f6d39aa027e4cdea1a2e7a381fe432310cc77fdc`, inchangé |
| Rapport de mission P10.7 | `docs/security/2026-11-02-p107-rapport.md` |
| Plan d'activation stricte | `docs/security/2026-11-02-p107-plan-activation-stricte.md` |
| Rapport P10.6 | `docs/security/2026-11-02-p106-identite-stricte.md` |

Les commits de revue modifient le SHA de tête : **la CI est vérifiée sur le SHA
final**, et c'est cette vérification qui fait foi — pas celle de `5fb216f`.

Runs périmés, conservés pour la traçabilité (chacun a servi à trouver un
défaut) : `41554352211` (échec Base, CI-1), `41556872612` (échec Base, CI-2).
