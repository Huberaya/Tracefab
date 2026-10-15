# TRACEFAB — Plan de résolution : tout ce qui reste, par qui, dans quel ordre

**Date** : 2026-10-12 · **Branche de travail** : `arena/879cd8db-tracefab` (`main` = `b0c976f`) · **Production** : `tracefab.vercel.app`, déploiement `6968252029`

Ce document répond à une seule question : **que faut-il faire, concrètement, pour
que tous les problèmes trouvés soient résolus ?** Il ne rouvre pas les
diagnostics — ils sont dans `TRACEFAB-CHANTIER-5-RAPPORT-2026-10-12.md` — il
liste les actions, leur responsable, leur preuve d'achèvement et leur ordre.

## 0. Comment lire ce plan

Trois statuts, jamais mélangés :

| Statut | Sens |
|---|---|
| **CORRIGÉ-VÉRIFIÉ** | la correction existe, elle est testée, et le test échoue sans elle |
| **PRÉPARÉ** | la correction existe et est testée **sur une copie**, mais n'est pas appliquée à l'endroit définitif |
| **À DÉCIDER** | aucune correction possible avant une décision ou un accès qui n'appartient qu'à vous |

**Deux règles de lecture :** un problème n'est résolu que lorsque la preuve
d'achèvement existe (colonne « Preuve d'achèvement »), et un problème dont la
cause n'est pas vérifiée n'est pas déclaré résolu — au mieux « mitigation
prête ».

## 1. Vue d'ensemble

| # | Problème | Statut | Qui agit | Durée |
|---|---|---|---|---|
| **P1** | L'API de production répond `500 internal_error` | PRÉPARÉ *(cause non vérifiée)* | vous 2 min, puis moi | 30 min |
| **P2** | Les workflows ne s'exécutent plus (`CI` désactivé) | À DÉCIDER | vous | 5 min |
| **P3** | 8 suites de tests écrivent dans une base désignée par un secret | PRÉPARÉ | vous choisissez, moi j'applique | 10 min |
| **P4** | `contents: write` au niveau du workflow visuel + actions non épinglées | PRÉPARÉ | moi, après accord | 15 min |
| **P5** | 5 branches `experience/*` : job « Base — isolation RLS exécutée » vert sans rien exécuter | PRÉPARÉ | moi, après accord | 10 min |
| **P6** | Installation verte sans client Prisma (mécanisme de P1) | CORRIGÉ-VÉRIFIÉ | à fusionner (P9) | — |
| **P7** | La CI de `main` lit encore un secret de base | PRÉPARÉ | même choix que P3 | — |
| **P8** | Privilèges RLS/`public` sur Neon non vérifiés | À DÉCIDER | vous (accès), puis moi | 1 h |
| **P9** | `DATABASE_URL` : existence du secret non vérifiable ici | À DÉCIDER | vous, 1 clic | 2 min |
| **P10** | Hygiène des secrets (jeton collé, rotation) | À FAIRE | vous | 10 min |
| **P11** | 3 PR ouvertes, 0 fusionnée | À DÉCIDER | vous | 10 min |
| **P12** | Je ne peux pas vérifier la production depuis cette session | LIMITE MESURÉE | voir §D | — |

---

## A. Production (P1) — le seul problème qui touche des utilisateurs

### Ce qui est établi

- `/api/health` renvoie `500 {"error":"internal_error","correlationId":"fd30b689-…"}` *(votre observation)* ;
- `/api/catalog/schemas` renvoie 200 avec 3 schémas *(votre observation)* ;
- reproduction exacte sur l'arbre déployé `b0c976f` avec un client Prisma absent : mêmes deux réponses, à l'identique ;
- **la base de données est exclue** : une base injoignable produit `503 database_unavailable` **sans** identifiant de corrélation, ce que le code de `api/_routes/health.ts` impose lui-même ;
- le déploiement est marqué `success` côté Vercel, et la CI de `b0c976f` a bien exécuté « Générer le client Prisma » — mais **c'est le build Vercel qui décide** de ce qui est embarqué, pas la CI.

### Ce qui n'est pas établi

Que le client Prisma soit réellement absent du déploiement. Le journal
d'exécution qui le dirait a expiré (rétention : 1 h en Hobby, 1 jour en Pro).
**Tant que ce n'est pas établi, P1 n'est pas résolu — au mieux mitigé.**

### Les étapes, dans l'ordre

| Étape | Qui | Action exacte | Preuve d'achèvement |
|---|---|---|---|
| **A1** | vous — 2 min | ouvrir les journaux de **build** d'un déploiement de `b0c976f` : `vercel.com/baya-ibraimmayoanouedu-8164s-projects/tracefab/A7R5Ez84oc5xqehUpQFpYoztRH7T` puis chercher `prisma` | capture ou copie des lignes trouvées |
| **A2** | moi | conclure selon le résultat (arbre de décision §A.1) | paragraphe daté dans le rapport |
| **A3** | moi | appliquer le correctif correspondant | commit + test |
| **A4** | vous — 5 min | **déployer en Preview** (jamais en production d'abord) la branche corrigée | URL de préversion |
| **A5** | vous | ouvrir `<url-de-preview>/api/health` | `200 {"ok":true}` ou le message d'erreur |
| **A6** | vous + moi | si A5 est vert : fusionner et déployer en production ; sinon retour en A3 | capture `200` sur `tracefab.vercel.app/api/health` |

**Si l'application est inutilisable dès maintenant** (aucune donnée ne s'affiche
dans les écrans qui lisent la base), la mitigation immédiate est un **retour
arrière** : Vercel → Deployments → choisir un déploiement antérieur sain →
*Promote to Production*. C'est une action de votre niveau C, réversible, et elle
n'exige aucune correction de code. Elle ne dispense pas de A1 à A6.

### A.1 Arbre de décision à partir des journaux de build

| Ce que montrent les journaux | Cause | Correctif |
|---|---|---|
| aucun `prisma`, aucun `Generated Prisma Client` | la génération n'a jamais tourné : le tableau `builds` de `vercel.json` fait ignorer la commande de build du projet | le `postinstall` strict de la branche (déjà écrit) doit être celui qui génère, **et** il faut vérifier qu'il tourne dans le build Vercel — sinon retirer `builds` au profit de `functions` |
| `Generated Prisma Client` présent, mais l'erreur persiste | le client est généré mais son **moteur** ou son empaquetage manque | correctif côté moteur/traçage de fichiers — je le prépare alors, avec un test qui échoue sans lui |
| `did not initialize yet` | un paquet factice a été déployé | `postinstall` strict + `verify:prisma-client` (déjà écrit) |

Dans les trois cas, la branche contient déjà `verify:prisma-client` en tête de
`build` : une génération ratée **fait échouer le build** au lieu de produire un
paquet factice. La chaîne est prouvée sur cinq états simulés (§10.1 du rapport),
et c'est ce qui empêche P1 de se reproduire.

---

## B. Chaîne CI/CD (P2, P3, P4, P5, P6, P7)

### P2 — Les workflows ne s'exécutent plus

| Fait mesuré | Valeur |
|---|---|
| état du workflow `CI` | `disabled_manually` |
| dernière exécution du dépôt, toutes branches | `2026-10-10T10:18:56Z` |
| mon push du `2026-10-12T10:19:55Z`, workflow neuf inclus | **aucune exécution** |
| vérifications attachées à mon commit | aucune vérification d'Actions |

**Ce qu'il faut faire (vous, 5 min)** : dépôt → *Settings* → *Actions* →
*General*, vérifier que **« Allow all actions and reusable workflows »** est
sélectionné ; puis onglet *Actions* → workflow `CI` → *Enable workflow* si vous
choisissez de le réactiver. Si les exécutions restent absentes, vérifier
*Settings → Billing* (limite de minutes ou de dépenses atteinte).

**Attention à l'ordre** : réactiver `CI` **avant** P3/P7 reviendrait à relancer
des workflows qui lisent un secret de base sur un `push` de n'importe quelle
branche. C'est l'ordre inverse qui est sûr.

### P3 + P7 — La CI et le secret de base : il faut choisir une voie

Les deux corrections existent déjà et **ne se cumulent pas** (vérifié :
`git apply --check` échoue, même section `base-de-donnees`) :

| Voie | Contenu | Effort | Ce qu'elle règle |
|---|---|---|---|
| **Voie 1 — branche courte** `securite/ci-sans-secret-depuis-main` (`826bc11`, 1 commit, 20 lignes) | retire la lecture de `secrets.DATABASE_URL` | 2 min | P3, P7 |
| **Voie 2 — PR #36** (`arena/879cd8db-tracefab`, 45 fichiers) | garde de cible + Postgres jetable + client Prisma strict + politique de workflows + migration RLS | 1 revue | **P3, P5, P6, P7** et le filet qui empêche P1 de revenir |

**Ma recommandation : la voie 2**, parce qu'elle règle quatre problèmes au lieu
d'un et qu'elle porte les tests qui empêchent la réapparition de P1. La voie 1
reste valable comme correctif immédiat si vous voulez sécuriser `main`
aujourd'hui et fusionner la suite plus tard — dans ce cas, dites-le, je réécris
la branche courte en tenant compte de la branche longue pour qu'elles se
cumulent au lieu de se recouvrir.

### P4 — Le workflow visuel

| Problème | Preuve | Correctif prêt |
|---|---|---|
| `contents: write` au niveau du workflow (et non du seul job qui pousse) | `figer-reference-visuelle.yml` sur la branche de la PR #34 ; alertes D et H du contrôle | `docs/security/patches/figer-reference-visuelle.durci.yml` : deux jobs séparés, `generer` (lecture) et `pousser` (écriture, rattaché à un environnement) |
| actions non épinglées par SHA | alerte C du contrôle | épinglage `# vX.Y.Z` (le contrôle exige un numéro de version complet) |

**Action** : appliquer la version durcie sur la branche qui détient le fichier —
**après votre accord** (écriture sur une branche de la PR #34).

### P5 — Les cinq branches `experience/*`

| Problème | Preuve | Correctif prêt |
|---|---|---|
| le job « Base — isolation RLS exécutée » peut être **vert sans avoir rien exécuté** (toutes ses étapes sont conditionnées au secret) | `if: steps.secret.outputs.present == 'true'` sur les 4 étapes, dont l'installation | 5 patches, vérifiés **applicables**, alerte I de **1 → 0** |
| `test:neon:rls` n'est **câblé nulle part** sur ces branches (0 invocation, contre 1 sur `main`) | `grep` sur les 5 `ci.yml` | le renommage du job dit désormais ce qu'il fait ; le câblage de `test:neon:rls` reste à décider |

**Action** : m'autoriser à appliquer les 5 patches sur vos branches (niveau C,
10 min), ou les appliquer vous-même.

### P6 — Déjà corrigé, à fusionner

`postinstall` strict + `verify:prisma-client` en tête de `build` + refus du
contournement par `VERCEL=1`. Cinq états prouvés, dont le témoin négatif conforme
qui sort en 0. **Devient effectif au moment de la fusion (P11).**

---

## C. Base de données (P8, P9)

### P8 — RLS et privilèges sur Neon

| Élément | État |
|---|---|
| Audit en lecture seule | script prêt (`scripts/audit_neon_readonly.mjs`), prouvé non écrivant par tests statiques **et** par refus serveur |
| Ce qui manque | une chaîne de connexion **en lecture seule**, fournie par un mécanisme sécurisé — ou l'exécution du script par vous |
| Migration préparée | `prisma/migrations/20261012120000_close_public_execute_gap` (révocation d'`EXECUTE` pour `PUBLIC` sur les fonctions) |
| Pourquoi elle n'est pas appliquée | c'est un **changement de privilèges en production** : niveau D, il exige votre validation explicite, et il doit être précédé de l'audit qui montre ce qui dépend de ces privilèges |

**Action** : (1) audit — vous exécutez le script, ou vous fournissez une chaîne
lecture seule par un mécanisme sécurisé ; (2) je produis la liste des
dépendances légitimes ; (3) vous validez ; (4) migration appliquée et vérifiée.

### P9 — Le secret `DATABASE_URL`

Mon accès ne permet ni de lire ni d'écrire les secrets (`403` sur
`.../actions/secrets`). **Action (vous, 2 min)** : dépôt → *Settings* → *Secrets
and variables* → confirmer si `DATABASE_URL` existe, et s'il existe, dire si le
retirer est acceptable. C'est ce qui fige P3/P7 : sans ce secret, les 8 alertes
de classe A deviennent inexploitables par construction.

---

## D. Ce que je ne peux pas faire depuis cette session (P12), et le contournement

| Blocage | Mesure | Contournement |
|---|---|---|
| réseau vers Vercel | `api.vercel.com` et `tracefab.vercel.app` → **HTTP 000** | vous rapportez une observation (§A), ou on active le relais GitHub |
| dépôt de secret GitHub | `.../actions/secrets` → **403** en lecture et en écriture | les secrets sont créés par vous ; je ne les vois jamais |
| exécution des workflows | aucune exécution depuis le 2026-10-10 | P2 résolu, puis un déclenchement par commit **depuis l'interface web** (un push par intégration n'a rien déclenché — mesuré) |
| audit Neon | pas de réseau | script exécuté par vous, ou chaîne lecture seule via mécanisme sécurisé |

**Le contournement le moins coûteux reste l'observation humaine** : les journaux
de build (§A1) et une URL de préversion (§A5) suffisent à trancher. Le relais
GitHub n'a de valeur que si vous voulez que je lise moi-même les journaux.

---

## E. Secrets et hygiène (P10, et ce qui vient de se passer)

1. **Révoquer l'identifiant collé dans la conversation le 2026-10-12.** Preuve
   attendue, sans publier la valeur : la liste des jetons du compte (et de
   l'équipe) ne le mentionne plus, et un appel fait avec lui répond `401`/`403`.
2. **Vérifier les consommateurs avant toute révocation** : CI, scripts locaux,
   intégrations — un jeton de diagnostic n'en a normalement aucun.
3. **Tout nouvel identifiant destiné à un workflow va dans un secret
   d'environnement** avec relecteurs obligatoires (le fichier préparé le fait),
   jamais dans un secret de dépôt, jamais dans un message.
4. **Ce qui a déjà circulé reste exposé** : tout jeton ayant transité par un
   chat ou un ticket doit être révoqué, même s'il n'a jamais servi.

---

## F. Ordre d'exécution recommandé

### Aujourd'hui — 30 minutes de votre temps

| Ordre | Action | Durée |
|---|---|---|
| 1 | **Journaux de build** (§A1) et transmission du résultat | 2 min |
| 2 | **Révoquer** l'identifiant collé (§E.1) | 2 min |
| 3 | **Settings → Actions** : rétablir les exécutions (§P2) | 5 min |
| 4 | **Choisir la voie CI** (§P3) — recommandé : PR #36 | 2 min |
| 5 | **M'autoriser** à appliquer les 5 patches `experience/*` et le durcissement du workflow visuel (§P4, §P5) | 1 min |
| 6 | **Ouvrir un déploiement Preview** de la branche corrigée (§A4) | 5 min |

### Ensuite, dans l'ordre

1. **Moi** : conclusion sur P1 (§A2), puis correctif adapté si A1 contredit le §5.5.
2. **Vous** : vérifier `/api/health` sur la préversion (§A5).
3. **Fusion** de la PR retenue (§P11), puis **déploiement production** — les deux
   sont vos décisions, je ne fusionne ni ne déploie sans ordre explicite.
4. **Neon** : audit (§P8.1), dépendances, validation, migration.
5. **Contrôles de sortie** : relancer la batterie complète et vérifier que la CI
   rejoue vert sur la branche fusionnée.

## G. Critères de sortie, problème par problème

| # | Résolu quand… |
|---|---|
| P1 | les journaux de build sont lus, la cause consignée, et `/api/health` renvoie `200 {"ok":true}` **en préversion d'abord**, puis en production |
| P2 | une exécution se déclenche sur un push et se termine, avec un lien de run consultable |
| P3 | aucun workflow ne désigne sa cible de test par un secret, **et** le run correspondant passe |
| P4 | le contrôle de politique ne signale plus ni écriture au niveau du workflow, ni action non épinglée |
| P5 | les 5 branches portent le patch, et le contrôle y retourne `0` alerte I |
| P6 | fusionné, et un build avec génération ratée échoue (test de non-régression conservé) |
| P7 | `main` ne lit plus `secrets.DATABASE_URL` |
| P8 | l'audit a produit sa liste, la migration est validée, appliquée et vérifiée après coup |
| P9 | l'existence du secret est connue, et sa suppression décidée |
| P10 | révocation prouvée par la liste des jetons, et par un appel qui répond 401/403 |
| P11 | chaque PR est soit fusionnée, soit fermée avec un motif écrit — aucune ne reste en suspens |

## H. Ce que ce plan ne promet pas

- Il ne promet pas que le correctif de P1 soit celui que j'attends : A1 peut le
  contredire, et alors c'est le §5.5 du rapport que je réécris.
- Il ne promet aucun délai sur Neon (P8) tant que l'accès en lecture seule n'est
  pas disponible.
- Il ne promet pas que la CI redevienne verte : une CI verte n'a jamais été une
  preuve de sécurité, c'est écrit dans le rapport et cela reste vrai.
