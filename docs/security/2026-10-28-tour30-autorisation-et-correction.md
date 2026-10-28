# Tour 30 — autorisation accordée, accès absent, et une erreur du tour 29 corrigée

Branche `arena/c27ddaa4-tracefab`. Aucune connexion de production, aucune
écriture distante : **l'autorisation ne crée pas l'accès**, et l'accès manque.
La correction du dossier, en revanche, ne dépendait d'aucun accès — elle est
faite, et elle change une conclusion.

## 1. Les deux autorisations, et ce qu'elles butent

Le propriétaire du dépôt a autorisé les deux opérations qui manquaient :
**(1)** la lecture du catalogue de production, **(2)** l'application de
`20261028140000` en production.

Mesure de l'accès disponible dans l'environnement d'exécution :

| Élément | État |
|---|---|
| `DATABASE_URL`, `DIRECT_URL`, `POSTGRES_URL`, `PGUSER`, `PGPASSWORD` | **absents** |
| fichier `.env` | absent (seul `.env.example`) |
| `psql` | absent |
| sortie réseau vers `ep-*.neon.tech:443` | **bloquée** (`000`, pas de poignée de main TLS) |
| sortie réseau autorisée | `github.com`, `codeload`, `api.github.com`, `registry.npmjs.org`, `pypi.org` |

Je ne peux donc exécuter ni l'une ni l'autre. Le dire est la seule option
honnête : un rapport qui annoncerait « confronté » ou « appliqué » sans l'avoir
fait serait pire qu'un `BLOCKED`.

**Ce que l'autorisation change quand même** : la cause du blocage n'est plus
« autorisation absente » mais « moyen d'accès absent ». Les deux opérations sont
prêtes à être lancées par la personne qui a la chaîne de connexion, et la
comparaison n'est plus confiée à la lecture humaine.

## 2. Une erreur du tour 29, trouvée en écrivant le runbook

### 2.1 Ce que j'avais écrit

Que la règle du dépôt `NEW.target_role = 'owner' AND NEW.relationship_id IS NULL`
ouvrait **deux contournements réels** : un `admin` fabriquant un `owner` dans sa
propre organisation (élévation de privilèges), et la réutilisation d'une relation
appartenant à un autre couple d'organisations.

### 2.2 Ce que la mesure dit

La chaîne pose **deux** déclencheurs sur `organization_invitations` :

| Déclencheur | Fonction | Vérifie |
|---|---|---|
| `invitations_validate_relationship` (initiale `20260923130000`, **tire en premier**) | `tracefab_validate_invitation_relationship` | `r.id = NEW.relationship_id AND r.supplier_organization_id = NEW.organization_id` |
| `organization_invitations_validate_role` | `tracefab_validate_member_invitation_role` | le rôle visé |

Sur la chaîne complète, `owner` côté marque et relation d'un autre couple sont
**déjà refusés** — par le premier, avec `invitation_relationship_mismatch`. Mes
deux « contournements » n'existaient pas.

### 2.3 D'où venait l'erreur

De **mon propre test**. Il montait un schéma écrit à la main : deux tables, une
seule fonction. Sans le second déclencheur, donc sans le contrôle qu'il porte.
Le test mesurait un système qui n'existe pas.

C'est exactement le reproche que je faisais aux empreintes du dépôt — « le nom
n'est pas la preuve » — appliqué à mon propre montage. Un test qui reconstruit
une partie du système ne mesure pas le système ; il mesure sa reconstruction.

### 2.4 Ce qui reste vrai, et qui est plus étroit

L'écart réel production / dépôt tient en deux lignes :

| Cas | production | dépôt | correctif |
|---|---|---|---|
| onboarding : `owner` + relation fournisseur | **refusé** | accepté | accepté |
| relation **terminée** (`status = 'ended'`) | refusé (parce que *tout* `owner` l'est) | **accepté** | **refusé** |

**Un seul trou réel** : aucun des deux déclencheurs ne regarde le **statut** de la
relation. Une relation terminée porte encore une invitation de propriétaire.
C'est ce que la migration ferme — et c'est ce qu'elle ferme *en plus* de rendre
l'onboarding possible.

Le contrôle d'appartenance que j'avais ajouté devient une **redondance
assumée**. Mesurée dans les deux sens :

- sur la chaîne complète, le retirer **ne change rien** ;
- l'autre déclencheur retiré, il est **la seule barrière** (les deux cas
  repassent à `accepté` sans lui, et restent refusés avec lui).

Deux verrous sur la même porte ne sont pas un défaut — à condition de dire lequel
porte, et de le prouver. Les deux affirmations sont maintenant dans le test
(`test:supplier-invitation-corrective`, **40 vérifications**, jouées sur la
chaîne complète et non sur un schéma d'emprunt).

### 2.5 Ce qui n'a pas changé

La migration reste juste : elle rend l'onboarding possible **et** ferme la
relation terminée, sans rien élargir. Son en-tête a été réécrit pour dire cela,
et pour nommer l'erreur au lieu de la laisser dans l'historique.

## 3. Opération (1) — la confrontation, prête et vérifiée

### 3.1 Le script de lecture

`docs/security/2026-10-28-tour30-A-confrontation-lecture-seule.sql` — catalogue
système uniquement, aucune table métier, aucun appel de fonction applicative. Il
produit 66 faits en lignes plates :

| Genre | Contenu |
|---|---|
| `T` | les 14 tables : existence, `rls`, `force_rls`, nombre de politiques, propriétaire |
| `P` | **les 31 politiques** des quatorze tables : rôle, commande, `permissive`, `USING`, `WITH CHECK` |
| `F` | les 14 fonctions : `SECURITY DEFINER`, `search_path`, `EXECUTE` de `PUBLIC` et de `tracefab_app`, propriétaire |
| `H` | l'historique Prisma des 5 hors bande et des deux correctives |

```bash
psql "$DIRECT_URL" -A -t -v ON_ERROR_STOP=1 \
     -f docs/security/2026-10-28-tour30-A-confrontation-lecture-seule.sql \
     > /tmp/etat-production.txt
```

### 3.2 Le vérificateur — la comparaison n'est plus humaine

`scripts/verifier_confrontation_production.mjs` rejoue la **même** requête sur
une base jetable construite depuis le dépôt, puis compare les deux sorties fait
par fait. Référentiel et mesure sortent du même instrument : ils ne peuvent pas
diverger.

Il distingue trois issues, et refuse de les confondre :

| Issue | Sens |
|---|---|
| `PASS` (0) | les 66 faits concordent |
| `FAIL` (1) | la **règle** diffère : mauvais rôle, mauvais prédicat, `RLS` absente, `EXECUTE` ouvert, `SECURITY INVOKER` |
| `À QUALIFIER` (3) | mêmes fonctions, mêmes jetons, **rendu** différent (cast réécrit entre PG 17 et 18) |

La distinction est le point délicat : un comparateur qui rend « à qualifier » sur
un prédicat remplacé par `true` est complaisant ; un comparateur qui rend « échec »
sur un cast rendu autrement est inutilisable. Le test soumet les deux cas au
même instrument.

```bash
node scripts/verifier_confrontation_production.mjs /tmp/etat-production.txt
```

Le vérificateur accepte aussi l'**export CSV** du SQL Editor de Neon (qui ne
connaît pas `-A -t`) : ligne d'en-tête retirée, guillemets et `""` dépliés. Un
export falsifié échoue quand même — le format ne masque pas le fond, et
`test:confrontation-production` (20 vérifications) le prouve dans les deux
formats.

### 3.3 Le vérificateur a été vu échouer

`test:confrontation-production` — **18 vérifications**. Neuf états soumis :

| État soumis | Issue attendue | Obtenue |
|---|---|---|
| état conforme | `PASS` | `PASS` |
| `rls=false` sur une table | `FAIL` | `FAIL` |
| politique supprimée | `FAIL` | `FAIL` |
| prédicat remplacé par `true` | `FAIL` | `FAIL` |
| mauvais `organization_id` | `FAIL` | `FAIL` |
| fonction en `SECURITY INVOKER` | `FAIL` | `FAIL` |
| `EXECUTE` ouvert à `PUBLIC` | `FAIL` | `FAIL` |
| corrective déjà en historique | `FAIL` | `FAIL` |
| différence de cast seule | `À QUALIFIER` | `À QUALIFIER` |

Et une sortie vide, ou trois faits sur soixante-six, sont des échecs — jamais un
silence.

## 4. Opération (2) — l'application, prête et vérifiée

`docs/security/2026-10-28-tour30-B-application-correctif.sql` est un runbook, pas
un script à lancer d'un bloc : identité de la cible, état **avant**, application
en **une transaction**, sondes, état **après**.

```bash
psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -1 \
     -f prisma/migrations/20261028140000_supplier_invitation_owner_relationship_scope/migration.sql
```

`-1` = une seule transaction : c'est la garantie que les lanceurs hors bande
n'offraient pas (tour 29, §8.3).

Cinq sondes, jouées puis **annulées** (aucune ligne écrite) : `owner` sans
relation, relation inexistante, relation d'une autre organisation, `admin` +
relation (non-régression), et **relation terminée** — la seule dont le résultat
doit changer.

`test:runbook-application` — **10 vérifications** — rejoue le bloc **tel qu'il est
écrit dans le document**, sur la chaîne complète, sans puis avec le correctif :

| | Sans correctif | Avec correctif |
|---|---|---|
| invitations qui passent dans la transaction | **2** (`admin`, relation terminée) | **1** (`admin`) |
| après `ROLLBACK` | 0 | 0 |

Les sondes distinguent donc les deux états. Un runbook dont les sondes passent
partout ne prouverait rien ; celui-ci a été vu discriminant **avant** d'être
donné à exécuter.

### 4.1 La conséquence à regarder en face

Le runbook **n'écrit pas** dans `_prisma_migrations` — c'est une règle du dépôt,
et elle n'est pas contournée. Conséquence : aux yeux de Prisma, la migration
restera non appliquée, et le prochain `migrate deploy` la rejouera.

C'est sans danger **parce qu'elle est idempotente** (`CREATE OR REPLACE`,
`DROP TRIGGER IF EXISTS` puis `CREATE`), et c'est vérifié. Mais c'est une raison
de plus de ne pas rouvrir `deploy` avant que les huit migrations non attestées
soient qualifiées.

### 4.2 Une erreur attrapée par la CI, pas par moi

Le premier passage de la CI sur ce tour a **échoué** : `matchAll(...).map(...)`
n'existe qu'à partir de Node 22, et la CI tourne en **Node 20**. Le code passait
sur mon poste et tombait là-bas.

C'est la CI qui a fait son travail, et c'est la bonne façon de le dire : je
n'avais pas mesuré sur la version cible. Corrigé (`[...matchAll()]`), puis
revérifié en Node 20 sur les quatre nouveaux tests et sur les six tests de
migrations — tous verts.

## 5. La confrontation a eu lieu — verdict : `FAIL`, une divergence, nommée

**Ce n'est pas moi qui l'ai exécutée.** Le propriétaire du dépôt a lancé la
lecture dans le SQL Editor de Neon, sur la branche `Primary` (production), et
m'a transmis les **41 lignes** produites. Je les ai transcrites, **recontrôlées
ligne à ligne** (une faute de transcription — `search_path:public` pour
`search_path=public` — aurait suffi à fabriquer une fausse divergence), puis
soumises au vérificateur.

### 5.1 Le verdict

```
39 faits attendus, 41 faits mesures.
A QUALIFIER  2 faits en production, absents du referentiel :
  P|plm_erp_sync_jobs.plm_erp_sync_jobs_insert_brand
  P|plm_erp_sync_jobs.plm_erp_sync_jobs_select_brand
ECHEC  T|plm_erp_sync_jobs  politiques : attendu « 2 », obtenu « 4 »
FAIL  1 divergence(s) franche(s), 2 a qualifier.
```

Les deux faits « à qualifier » ne sont pas une inconnue : ce sont **exactement**
les deux politiques que `20261028150000_plm_erp_policy_convergence` retire, et
dont `test:plm-erp-convergence:chaine` a mesuré l'effet. La qualification est
donc faite, dans le sens défavorable : **la production est plus permissive que
le dépôt**, et le correctif existe mais **n'est pas appliqué**.

### 5.2 Ce que la production porte — et qui est enfin lu

| Objet | Mesure | Verdict |
|---|---|---|
| **14 tables** | toutes existent, `rls=true`, `force=true`, 1 à 3 politiques, propriétaire `neondb_owner` | conforme |
| **14 fonctions** | `secdef=true`, `search_path=search_path=public`, `exec_public=false`, `exec_app=true`, propriétaire `neondb_owner` | conforme |
| `plm_erp_integrations` | 2 politiques, les deux canoniques | conforme |
| `plm_erp_sync_jobs` | **4 politiques** — 2 canoniques + 2 surnuméraires | **divergent** |
| Historique Prisma | 5 hors bande `present=1|steps=0|termine=true` | conforme à la réconciliation |
| `20261028140000` | **`present=0`** | correctif **non appliqué** |
| `20261028150000` | **`present=0`** | correctif **non appliqué** |

La lacune du tour 29 — « les douze tables n'ont jamais été lues » — est donc
**comblée** : 14 tables sur 14, avec RLS, `FORCE`, nombre de politiques,
propriétaire.

### 5.3 Deux défauts de mon propre outil, trouvés par ce premier passage réel

Un vérificateur jamais confronté à une vraie sortie n'est pas un contrôle.

1. **Le nombre de politiques d'une table n'était pas comparé.** `politiques`
   manquait dans la liste des champs durs. La dérive a été trouvée par les
   lignes `P`, soit, mais le compteur — le fait le plus simple — ne la
   signalait pas.
2. **L'historique était comparé à celui d'une base neuve.** La base de
   référence est construite par application des migrations : son
   `_prisma_migrations` est vide, donc toutes ses lignes `H` disent
   `present=0`. Comparée à cela, la production produisait **quinze « échecs »**
   qui ne disaient rien d'elle — et qui masquaient la seule divergence réelle.
   L'état attendu de l'historique est désormais **écrit dans le vérificateur**,
   d'après la réconciliation, et non déduit d'une base qui n'a jamais vu
   `prisma migrate`.

Les deux sont corrigés, et **le test couvre maintenant les deux cas** : un
compteur de politiques qui bouge sur une table hors PLM, et un historique remis
à zéro. Le test est passé de 20 à **25 vérifications**.

### 5.4 Ce que cela n'établit pas — et pourquoi une seconde lecture est nécessaire

La requête exécutée n'a rendu que **six lignes `P`** : les politiques des deux
tables PLM. Les politiques des **douze autres tables** n'ont donc **pas** été
lues une par une — seul leur nombre l'a été.

J'ai élargi la requête pour lire **les 31 politiques** des quatorze tables
(66 faits au lieu de 39). Le vérificateur accepte un drapeau
`--perimetre-plm` pour comparer honnêtement la sortie partielle déjà en main
— sans jamais relâcher les contrôles sur ce qui a été lu — mais **la lecture
complète reste à faire**, et c'est elle que la décision attend.

Restent également, sans changement : **M6** (`NOT RUN`) et l'application des
deux correctifs, dont la migration `20261028140000` pour `supplier_portal`.

## 6. État après ce tour

| Point | Avant (tour 29) | Après |
|---|---|---|
| Autorisation des deux opérations | absente | **accordée** |
| Accès à la production | absent | **absent** — identifiants et sortie réseau |
| Confrontation `plm_erp_gs1` | outil inexistant | **exécutée en production** ; verdict automatique : **`FAIL`**, 1 divergence nommée + 2 politiques surnuméraires |
| Cinq migrations hors bande — les 14 tables en production | non lues | **lues** : 14/14, RLS + `FORCE`, propriétaire unique, nombre de politiques |
| Politiques des 12 tables hors PLM, une par une | non lues | **non lues** — requête élargie prête (31 politiques, 66 faits) |
| Correctifs en production | inconnu | **mesuré absent** : `20261028140000` et `20261028150000` `present=0` |
| Version de Node des nouveaux tests | — | vérifiés en **Node 20** (la version de la CI) |
| Application du correctif | procédure non écrite | **runbook prêt et éprouvé** ; application **`NOT RUN`** |
| `supplier_portal` | « deux contournements fermés » | **une erreur corrigée** : un seul trou réel, la relation terminée ; redondance mesurée |
| `public_read_context` | clos sous réserve | inchangé |
| 5 migrations hors bande | `PASS` hors production | inchangé |
| M6 | `NOT RUN` | `NOT RUN` |

## 7. Décision — le motif a changé trois fois

**NON PRÊTE À FUSIONNER.**

Le motif a changé de nature trois fois, et il faut le dire dans cet ordre :

1. **tour 29** : « divergence `plm_erp_gs1` non qualifiée » ;
2. **ce tour, avant la lecture** : « autorisation absente, donc accès absent » ;
3. **maintenant** : la lecture est faite, et le motif n'est plus un doute mais
   un **fait mesuré** — **la production porte encore la dérive, et aucun des
   deux correctifs n'y est appliqué** (`present=0` pour `20261028140000` comme
   pour `20261028150000`).

Le troisième motif est le plus solide des trois : il ne dépend d'aucune
interprétation. La production autorise aujourd'hui `contributor` à insérer dans
`plm_erp_sync_jobs`, alors que le dépôt réserve cette action à
`owner`/`admin`/`manager`.

Ce qui est acquis, et ne dépend plus d'aucun accès :

| Contrôle | État |
|---|---|
| `plm_erp_gs1` — dérive **mesurée en production** | **fait** — 4 politiques au lieu de 2, verdict automatique `FAIL` |
| `plm_erp_gs1` — correctif vérifié sur la chaîne réelle | **fait** — 19 vérifications, canoniques intactes, rejeu sans erreur |
| `supplier_portal` — correctif vérifié sur la chaîne réelle | **fait** — 42 vérifications, un seul trou réel fermé |
| Cinq migrations hors bande — équivalence des deux chemins | **fait** — 46 vérifications |
| 14 tables — état RLS en production | **fait** — conforme |
| 14 fonctions — `SECURITY DEFINER`, `search_path`, `EXECUTE` | **fait** — conforme |
| CI complète sur le SHA exact | **fait** |

Ce qui reste, et qui tient en **deux opérations autorisées** :

1. **une seconde lecture**, avec la requête élargie — les 31 politiques, une par
   une, pour couvrir les douze tables que la première n'a lues qu'en nombre ;
2. **l'application** de `20261028150000` puis `20261028140000`, par le runbook
   éprouvé.

`PASS` sur la seconde lecture **ne vaudra pas** `PRÊTE À FUSIONNER` à lui seul :
la fusion laisserait la production dans l'état mesuré ci-dessus. Fusionner ne
déploie pas — `deploy` doit rester gelé, et le rester jusqu'à ce que
l'historique Prisma porte les deux correctifs.
