# P10.7 — l'origine des opérations système est prouvée, pas supposée

**Date des mesures** : 5 et 6 novembre 2026
**Périmètre** : identité runtime PostgreSQL, chaîne HMAC, opérations système
**Environnement mesuré** : PostgreSQL 16.2 jetable, `tracefab_app` sans
`SUPERUSER` ni `BYPASSRLS`, clé provisionnée par le script opérateur
**Ce document ne vaut pas pour la Production** : aucune mesure n'y a été prise
(voir § 7, ce qui reste à faire avant une bascule réelle)

---

## 1. Le défaut, et pourquoi il n'était pas celui qu'on croyait

P10.5 puis P10.6 avaient rendu l'identité **utilisateur** non forgeable :
l'application signe, la base vérifie, et un GUC forgé ne remplace jamais un jeton.
La mesure du 5 novembre a montré que cette chaîne n'était **pas contournée** —
elle était **contournée par le haut**.

Séquence rejouée sur une base dont le propriétaire des objets est un rôle **non
superutilisateur** (la forme de Neon), clé provisionnée, `tracefab_app` sans
`SUPERUSER`, sans `BYPASSRLS`, sans appartenance atteignable :

| # | Action de l'attaquant | Résultat mesuré |
|---|---|---|
| 1 | obtient un jeton **valide** pour sa propre organisation A | accepté — la chaîne HMAC fonctionne |
| 2 | appelle `tracefab_sync_clerk_membership('mem_x', B, lui, 'owner')` | **accepté sans aucun jeton** |
| 3 | — | une adhésion `owner` est écrite chez B |
| 4 | `tracefab_has_org_role(B, 'owner')` | `true` |
| 5 | signe un jeton pour B | accepté, à juste titre : il est membre |
| 6 | lit les produits de B | **2 produits** |

```
sync_clerk_membership -> owner chez B : ACCEPTE {"ecrit":true}
has_org_role(B,'owner') = true        produits de B lus = 2
```

Ce n'est pas une identité falsifiée, c'est une identité **gagnée**. Les treize
opérations système ne lisaient **aucune identité** : elles étaient déclarées au
registre runtime, donc exécutables par le rôle applicatif, sans contrôle
d'origine. Le contrôle manquant porte sur l'**ORIGINE**, pas sur l'identité.

## 2. La correction

### 2.1 Une identité système SIGNÉE

Migration `20261105120000_identite_systeme_signee`.

| Élément | Rôle |
|---|---|
| `tracefab_identite_systeme_jeton_valide(text)` | `SECURITY DEFINER`, essaie **toutes** les clés actives, ne rend qu'un booléen, ne dit jamais pourquoi |
| `tracefab_identite_systeme()` | prédicat `SECURITY INVOKER` : jeton présent → vérifié ; absent + strict → refus ; absent + permissif → accepté (transition) |
| garde d'origine | inlinée en tête du corps des **13** opérations |
| `tracefab_identity_politique.systeme_strict` | `false` à l'installation ; le basculement est un acte d'exploitation |

Corps signé, canonique et non ambigu :

```
v1|tracefab_system|tracefab_worker|<expiration_unix>.<hmac_sha256_hex>
```

- **version** `v1` : un changement de format ne réinterprète pas les anciens jetons ;
- **usage** `tracefab_system`, distinct de `tracefab_identity` (jeton utilisateur) :
  aucun des deux ne peut servir à l'autre sens ;
- **identité désignée** `tracefab_worker`, valeur **fixe** : un nom libre
  ferait du jeton un droit d'endosser n'importe quel rôle ;
- **expiration** : 60 s, vérifiée par l'application *et* par la base sur **son**
  horloge (celle de la base fait foi) ;
- **clé** : la même que le jeton utilisateur, donc la rotation et la révocation
  suivent le même mécanisme (`tracefab_identity_cles`) ;
- **comparaison** : `timingSafeEqual` côté application, égalité de chaînes côté
  base sur une valeur dérivée d'un HMAC.

### 2.2 Où la vérification a lieu, et pourquoi les deux endroits

| Endroit | Ce qui y est vérifié |
|---|---|
| **Frontière HTTP** (`api/_lib/contexte-systeme.ts`) | l'appelant a le secret d'exploitation ; sinon aucune opération système n'est tentée |
| **PostgreSQL** (garde en tête de chaque corps) | le jeton a été signé par une clé **active**, pour **cet** usage, **cette** identité, et n'est pas expiré |

L'application signe parce que c'est elle qui détient la clé — la base ne doit pas
la connaître (`SELECT` sur `tracefab_identity_cles` par `tracefab_app` : **42501**,
mesuré). La base vérifie parce que c'est elle qui autorise.

### 2.3 Ce que la correction ne fait **pas**, et qui est écrit pour ne pas être découvert plus tard

- elle ne transfère aucune propriété, ne révoque aucun `EXECUTE` des treize
  opérations : le runtime les appelle toujours, il les appelle désormais **avec
  une origine prouvée** ;
- elle n'ajoute **aucun** droit au runtime : la seule fonction accordée est la
  **vérification** (`tracefab_identite_systeme_jeton_valide`), et le prédicat
  reste hors de son périmètre parce qu'il n'est appelé que depuis des corps
  `SECURITY DEFINER` ;
- elle ne bascule pas le mode : voir § 3.

## 3. Le basculement est un acte d'exploitation, pas une migration

Une première version posait `systeme_strict = true` **dans** une migration, en
refusant de s'appliquer sans clé active. Le raisonnement était juste, la forme
était fausse, et la mesure l'a montré deux fois le même jour :

| suite | ce qui est tombé |
|---|---|
| `test:neon:privileges-role-app` | `P0001 P10.7 : aucune cle d'identite active` sur sa base éphémère |
| toute base migrée à neuf | même refus : une base neuve n'a **aucune** clé, et ne peut pas en avoir sans une écriture d'opérateur |

Une clé est un **secret**. Une chaîne de migrations qui exige un secret pour
s'appliquer n'est plus une chaîne de migrations : c'est un déploiement qui prend
le nom d'une migration, et il casse tous les environnements qui n'ont pas ce
secret. Le dépôt appliquait déjà la règle inverse pour `strict` (identité
utilisateur) : « `strict` reste `false` ; le basculement est une décision
d'exploitation » (`20261102120000`). Le mode système suit la même règle.

**Le basculement est donc l'outil `scripts/activer_identite_systeme_stricte.mjs`**,
et le refus vit là où il agit :

| Prérequis, lu en base avant toute écriture | Refus si non tenu |
|---|---|
| au moins une clé `actif` | code **3**, aucune écriture |
| zéro opération système non gardée (sonde) | code **3**, aucune écriture |
| le runtime ne lit pas les clés | code **3**, aucune écriture |
| cible classée **jetable** (classifieur commun) | code **3**, aucune connexion |
| `TF_ALLOW_WRITE=oui` | code **3**, aucune connexion |

Postconditions relues **dans la même transaction** : colonne `systeme_strict`,
puis la sonde. Un échec annule tout : pas d'état à moitié basculé.

## 4. Résultats mesurés

### 4.1 Avant / après, même forme de base

| | avant | après |
|---|---|---|
| `sync_clerk_membership` sans jeton | **ACCEPTÉ** `{"ecrit":true}` | **REFUSÉ `42501 authentication_required`** |
| `has_org_role(B,'owner')` | `true` | `false` |
| produits de B lus | **2** | **0** |
| adhésions créées | 1 | **0** |

### 4.2 Le chemin légitime reste intact

Avec un jeton système signé : `sync_clerk_membership`, `notification_outbox_health`
(`{pending:0,…}`), `clerk_organization_uuid` (`null`), `claim_notification_outbox`
(`0`) s'exécutent.

### 4.3 Falsifications, toutes refusées (`42501`)

MAC faux · jeton expiré · jeton utilisateur rejoué comme système · identité
désignée `postgres` · jeton vide · pas de MAC · deux points · suffixe après le
MAC · MAC en majuscules · autre clé · version de protocole inconnue · autre
identité système.

### 4.4 Rotation et révocation

Deux clés actives : ancienne et nouvelle acceptées (chevauchement). Après
`actif = false` sur l'ancienne : ancien jeton **refusé**, nouveau jeton accepté.

### 4.5 Sonde d'exploitation

```
13 gardées | 0 non gardée | strict=t | app n'endosse pas le worker | worker non connectable | app ne lit pas les clés
```

### 4.6 Forme de production — propriétaire des objets NON superutilisateur

Toutes les mesures ci-dessus ont été rejouées sur une base dont le propriétaire
des objets est un rôle **ordinaire** (forme Neon) : `NOSUPERUSER`,
`BYPASSRLS` comme `neondb_owner`, propriétaire du schéma `public`, chaîne
complète appliquée par lui (70 migrations), `tracefab_app` sans aucun privilège.

| mesure | résultat |
|---|---|
| chaîne complète par un propriétaire non superutilisateur | **70 migrations** |
| `test:p107:identite-systeme` (54 assertions) | **54/54** |
| `test:neon:rls` | vert (51 tables) |
| `test:neon:registre-fonctions` | vert |
| `test:neon:ecarts-privileges` | 13/13 |
| `test:neon:app-readiness` | 14 assertions |
| `activer_identite_systeme_stricte.mjs --verifier` | `13 gardées · 0 non gardée · 1 clé active` |

La sonde `tracefab_sec_probe_identite_systeme()` **se comporte à l'identique**
dans les deux formes : elle mesure, elle ne suppose pas la propriété.

### 4.7 Les suites

| suite | avant P10.7 | après |
|---|---|---|
| `test:p107:identite-systeme` | — | **54/54** (arme le mode strict par l'outil, le **restaure** en sortie — y compris si la suite s'arrête en cours de route, vérifié) |
| `test:p107:activation-stricte` | — | **23/23** |
| `test:p107:identite-systeme-module` | — | **44/44** |
| `test:neon:privileges-role-app` | 3 échecs | **42/42** |
| `test:neon:registre-fonctions` | 4 échecs | **vert** |
| `test:neon:ecarts-privileges` | 4 échecs | **13/13** |
| `test:neon:rls` | — | vert (51 tables sous RLS) |
| `test:neon:bypass-control` | — | vert (contraste établi) |
| `test:p106:identite-negative` | — | 37 assertions |
| `test:p106:rejouabilite-chaine` | — | 25 assertions |
| `test:p105:hmac` | — | 29 assertions |
| `test:p107:demonstration` | — | 19 assertions |

### 4.8 Contrôles négatifs — sans eux, aucun des chiffres ci-dessus ne vaut

| contrôle | résultat |
|---|---|
| mode permissif rétabli | **16 échecs** : les 13 opérations acceptent sans jeton, l'adhésion est écrite. Le test est **bidirectionnel** |
| garde retirée d'une seule fonction | la sonde voit `1` non gardée, l'activation **refuse** (code 3) |
| aucune clé active | l'activation **refuse** (code 3), le mode **reste** `false` |
| quatre mutations du module de signature (expiration, usage, identité, comparaison) | chacune fait échouer **le cas qui la nomme** |

## 5. Les droits du runtime sont dérivés du code, plus d'une liste

Le défaut P10.7 s'est logé dans des **listes**. Les treize opérations étaient
présentes au registre — donc personne ne regardait ce qu'elles faisaient. Trois
règles nouvelles, dans `scripts/lib/derivation_droits_runtime.mjs`, refusent la
situation inverse :

| règle | ce qu'elle exige |
|---|---|
| **R4** | la sonde d'exploitation n'est **jamais** un droit du runtime |
| **R5** | la vérification système est accordée **parce que** `api/` l'appelle |
| **R6** | le prédicat n'est **jamais** cité par `api/` : il ne vit que dans les corps `SECURITY DEFINER` |

Deux corrections en découlent, chacune refusée par une suite au départ :

1. la sonde avait été **accordée au runtime et inscrite au registre**. Une sonde
   d'exploitation n'est pas un appel applicatif : son `EXECUTE` est retiré, et
   elle n'entre pas au registre ;
2. le prédicat avait été **inscrit au registre** alors qu'il n'est appelé que
   depuis les corps. Il en sort, et le `GRANT` au worker (nécessaire, mesuré :
   sans lui, `42501` sur `tracefab_identite_systeme` puis `25P02` en cascade)
   reste.

Corriger a aussi révélé une **règle trop large** dans `test:neon:registre-fonctions` :
elle refusait *tout* `GRANT EXECUTE` postérieur au registre, y compris celui d'une
fonction **déclarée** au registre. Cette règle poussait à retirer un droit dont
l'application a besoin — c'est-à-dire à faire passer un test en cassant le
produit. Elle exige désormais une **égalité** : tout `GRANT` direct est déclaré
au registre, et tout écart est nommé.

## 5 bis. Une découverte hors périmètre, et pourquoi elle n'est pas corrigée ici

Mesurée le 6 novembre sur la forme de production ci-dessus, et **indépendante de
P10.7** : les **37 fonctions de l'extension `pgcrypto`** (`hmac`, `digest`,
`gen_random_uuid`…) sont exécutables par `tracefab_app` sur une base dont le
propriétaire des objets est un rôle ordinaire. L'ACL vient de `CREATE
EXTENSION`, qui accorde `EXECUTE` à `PUBLIC` par défaut et laisse à
l'installateur le soin de resserrer ; le dépôt ne l'a jamais accordée, et ne
peut pas la retirer sans `DROP EXTENSION`, qui détruirait les données chiffrées.

Trois conséquences pour cette mission :

1. **ce n'est pas un élargissement introduit par P10.7** : la mesure est la même
   sur une base arrêtée avant la migration P10.7 ;
2. **ce n'est pas un droit exploitable par le chemin d'escalade** : `hmac` sert à
   *vérifier*, pas à *signer sans clé* — la clé reste illisible (`42501`), et
   c'est elle qui borne le droit d'émettre ;
3. **le contrôle qui la signalait ne la distinguait pas d'un vrai écart** :
   `test:neon:registre-fonctions` comptait ces 37 fonctions comme « du dépôt hors
   registre ». Il isole désormais les fonctions d'extension par
   `pg_depend.deptype = 'e'`, les **compte et les nomme** séparément, et reste
   strict sur les fonctions du dépôt — vérifié par contrôle négatif : une
   fonction du dépôt accordée hors registre fait toujours échouer la suite.

Corriger l'ACL de `pgcrypto` demande `DROP EXTENSION`/`CREATE EXTENSION
... FROM pgcrypto` sur un environnement qui sert, donc une décision
d'exploitation distincte, hors de cette mission.

## 5 ter. Deux défauts trouvés par mes propres tests, et corrigés

### 5 ter.1 Une clé absente retombait sur la variable d'environnement

`etatCleSysteme(brute = process.env.TRACEFAB_IDENTITY_KEY)` confondait deux
appels de sens opposé :

| appel | sens voulu | comportement mesuré |
|---|---|---|
| `etatCleSysteme()` | « lis la variable » | correct |
| `etatCleSysteme(undefined)` | « la clé que je te donne est absente » | lisait la variable, la déclarait **valide**, puis déréférençait `undefined` → **`TypeError`** |

Conséquence réelle : `signerIdentiteSysteme({ cle: undefined })` — le chemin de
repli fermé, censé rendre `null` — levait une exception dès que la variable
d'environnement était posée. Un `TypeError` dans le chemin de signature ne
ressemble pas à « pas de clé » : il ressemble à une panne.

**Trois écritures ont été essayées, deux étaient fausses**, et c'est instructif :
une valeur par défaut classique ne corrige rien, car JavaScript l'applique aussi
sur un `undefined` **explicite**. Seul `arguments.length` distingue « aucun
argument » de « un argument valant `undefined` ». La règle est désormais mesurée
dans les deux environnements (variable posée / absente) : **47 assertions**.

Ce défaut n'aurait pas été vu par un test qui ne pose pas la variable
d'environnement — c'est-à-dire par la CI, où elle est absente. Il a été trouvé
parce que la suite a été lancée **les deux fois**.

### 5 ter.2 Une lecture avant déclaration dans la route de readiness

En ajoutant `identitySysteme`, la route lisait `req.query.identity` **avant** la
ligne qui déclarait `wantIdentity`. En JavaScript, une `const` lue avant sa
déclaration lève une `ReferenceError` : la route aurait échoué à **chaque**
appel.

Le `typecheck` ne pouvait pas le voir : dans cet environnement, `@prisma/client`
n'est pas généré, donc `api:typecheck` échoue sur l'import du client avant
d'atteindre ce fichier. La correction est un déplacement de deux lignes, et la
leçon est écrite ici : **« le typecheck passe » n'est pas la même chose que
« le typecheck a regardé ce fichier »**.

## 6. Risques résiduels

| # | Risque | Portée réelle | Atténuation / décision |
|---|---|---|---|
| **R1** | un détenteur de `TRACEFAB_IDENTITY_KEY` peut émettre un jeton système | inhérent à toute authentification par secret partagé ; **même modèle** que `TRACEFAB_NOTIFICATION_WORKER_SECRET` | la clé vit **hors de la base** : un détenteur des seuls identifiants PostgreSQL ne peut plus rien (c'était le défaut avant : aucun secret n'était requis). Rotation = nouvelle version dans `tracefab_identity_cles`, sans coupure |
| **R2** | la clé est partagée entre jeton utilisateur et jeton système | une compromission de clé touche les deux usages | les **usages** sont séparés dans le corps signé : un jeton volé ne change pas d'usage. Une séparation par clé distincte serait un durcissement possible, non nécessaire aujourd'hui |
| **R3** | mode permissif : une opération sans jeton reste acceptée | c'est l'état d'une base neuve, et il est **mesuré** par la sonde | la bascule est un acte d'exploitation documenté (§ 3) ; le retour arrière est une ligne |
| **R4** | fenêtre d'un jeton intercepté | 60 s, usage unique par appel | durée courte volontaire ; pas de `nonce` — un jeton système est émis juste avant l'appel, dans la même transaction |
| **R5** | bascule en `strict` sans redéploiement applicatif | le webhook Clerk et l'outbox échouent **fermé** | ordre de déploiement écrit dans l'en-tête de la migration et rappelé par la readiness (`identitySysteme.verifiee_par_la_base`) |
| **R6** | aucune mesure sur un environnement qui sert | Production **non mesurée** | voir § 7 : la bascule réelle demande une autorisation humaine explicite |
| **R7** | `pgcrypto` exécutable par `tracefab_app` (forme propriétaire non superutilisateur) | **pré-existant**, 37 fonctions, aucune ne permet de signer sans clé | ACL posée par `CREATE EXTENSION`, non retirable sans le détruire ; contrôle rendu distinctif (§ 5 bis), correction = décision d'exploitation séparée |

## 7. Ce qui n'est PAS prouvé ici

- **Aucune mesure en Production.** Aucune n'a été tentée : la Production est en
  lecture seule pour cette mission.
- **Aucune mesure sur Neon.** Le classifieur de cible refuse les hôtes managés ;
  la forme a été reproduite (propriétaire non superutilisateur), pas l'hôte.
- **Aucun déploiement Vercel** de la révision applicative : la sonde
  `identitySysteme` est écrite et testée hors ligne, elle n'a pas encore servi
  sur un environnement déployé.
- **Les empreintes de migration Prisma** (divergence PLM) restent hors périmètre,
  comme convenu.

### Ce qu'il faut faire, dans cet ordre, pour activer sur un environnement réel

1. déployer la révision qui contient `api/_lib/contexte-systeme.ts` (signature du
   contexte worker) ;
2. provisionner `TRACEFAB_IDENTITY_KEY` dans l'environnement (CSPRNG, ≥ 32 octets
   hexadécimaux), **sans jamais l'afficher** ;
3. mesurer `GET /api/internal/p2-readiness?identity=1` :
   `identitySysteme.mode = "signe"` **et** `verifiee_par_la_base = true` ;
4. rejouer un webhook Clerk : `200` ;
5. faire vider l'outbox de notifications ;
6. **seulement alors** poser `systeme_strict = true` avec l'outil de déploiement
   de l'environnement (une ligne, réversible) ;
7. rejouer 3 à 5, puis vérifier que l'absence de jeton est refusée en `42501`.

## 8. Rollback

```sql
-- une ligne, immédiat, sans migration défaite
UPDATE public.tracefab_identity_politique SET systeme_strict = false WHERE singleton;
```

ou, sur une cible jetable :

```bash
node scripts/activer_identite_systeme_stricte.mjs --desactiver
```

La révocation d'une clé compromise est indépendante : `UPDATE
public.tracefab_identity_cles SET actif = false WHERE version = …` — tous les
jetons signés par cette clé cessent d'être acceptés à l'instruction suivante.

## 9. Références

| objet | chemin |
|---|---|
| migration (gardes, prédicat, vérification, sonde) | `prisma/migrations/20261105120000_identite_systeme_signee/migration.sql` |
| signature et vérification applicatives | `api/_lib/identite-systeme.ts` |
| contexte worker (signature) | `api/_lib/contexte-systeme.ts` |
| activation / retour arrière | `scripts/activer_identite_systeme_stricte.mjs` |
| suite en base (A–G, 54 assertions) | `scripts/test_p107_identite_systeme_signee.mjs` |
| suite d'activation (23 assertions) | `scripts/test_p107_activation_mode_systeme.mjs` |
| suite de module (44 assertions) | `scripts/test_p107_identite_systeme_module.mjs` |
| dérivation des droits runtime | `scripts/lib/derivation_droits_runtime.mjs` |
| readiness (état exposé) | `api/_routes/internal/p2-readiness.ts` |
| variables d'environnement | `docs/operations/variables-environnement.md` |
