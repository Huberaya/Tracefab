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

### 4.3 Le contrôle qui manquait avant `deploy` : combien de migrations sont en attente ?

`migrate deploy` applique **toutes** les migrations du dépôt absentes de
`_prisma_migrations` — pas seulement celle qu'on a en tête. Les lectures du
28/10 prouvent que les sept lignes surveillées sont dans l'état réconcilié ;
elles **ne prouvent pas** que les cinquante-huit autres migrations du dépôt y
sont aussi. Si une seule manquait, `deploy` l'appliquerait à la même occasion.

Ce n'est pas une hypothèse à écarter d'un revers de main : c'est un `SELECT` de
plus, en lecture seule, à coller avant toute écriture.

```sql
SELECT count(*) FILTER (WHERE finished_at IS NOT NULL) AS appliquees,
       count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS en_cours,
       count(*) FILTER (WHERE rolled_back_at IS NOT NULL) AS annulees,
       max(migration_name) AS derniere
  FROM _prisma_migrations;
```

**Ce que je ferai de la réponse :**

| `appliquees` | Lecture | Suite |
|---|---|---|
| **63** | les 65 du dépôt moins les deux correctives : rien d'autre n'est en attente | `deploy` n'appliquera **que** les deux correctifs → feu vert pour le runbook |
| **< 63** | d'autres migrations sont en attente en production | **arrêt** : `deploy` appliquerait plus que ce qui a été autorisé. Il faudra une autorisation distincte, et la liste nommée d'abord |

## 5. La confrontation a eu lieu — verdict : `FAIL`, une divergence, nommée

**Ce n'est pas moi qui l'ai exécutée.** Le propriétaire du dépôt a lancé les
deux lectures dans le SQL Editor de Neon, branche `Primary` (production), et m'a
transmis les lignes produites : **41** d'abord (périmètre PLM), **68** ensuite
(périmètre complet). Je les ai transcrites, **recontrôlées** — une faute de
transcription, un `:` au lieu d'un `=`, suffirait à fabriquer une fausse
divergence — puis soumises au vérificateur.

### 5.1 Le verdict, sur le périmètre complet

```
66 faits attendus, 68 faits mesures.

A QUALIFIER  2 faits en production, absents du referentiel :
  P|plm_erp_sync_jobs.plm_erp_sync_jobs_insert_brand
  P|plm_erp_sync_jobs.plm_erp_sync_jobs_select_brand
ECHEC  T|plm_erp_sync_jobs  politiques : attendu « 2 », obtenu « 4 »
FAIL  1 divergence(s) franche(s), 2 a qualifier.
```

**64 faits sur 66 concordent.** Les deux « à qualifier » ne sont pas une
inconnue : ce sont **exactement** les deux politiques que
`20261028150000_plm_erp_policy_convergence` retire, et dont
`test:plm-erp-convergence:chaine` a mesuré l'effet. La qualification est faite,
dans le sens défavorable : **la production est plus permissive que le dépôt**,
et le correctif existe mais **n'est pas appliqué**.

Un contrôle de cohérence interne a été ajouté avant de conclure : le nombre de
politiques annoncé par chaque ligne `T` (33 au total) est exactement celui des
lignes `P` lues, table par table. Une faute de recopie sur un nom de table ou
sur une ligne aurait fait échouer ce contrôle.

### 5.2 Ce que la production porte — et qui est enfin lu

| Objet | Mesure | Verdict |
|---|---|---|
| **14 tables** | toutes existent, `rls=true`, `force=true`, `politiques` = ce qui est lu, propriétaire `neondb_owner` | conforme |
| **14 fonctions** | `secdef=true`, `search_path=search_path=public`, `exec_public=false`, `exec_app=true`, propriétaire `neondb_owner` | conforme |
| **31 politiques** des douze tables hors PLM | lues une par une : `USING`, `WITH CHECK`, rôles, commande | **conformes au dépôt** |
| `plm_erp_integrations` | 2 politiques, les deux canoniques | conforme |
| `plm_erp_sync_jobs` | **4 politiques** — 2 canoniques + 2 surnuméraires | **divergent** |
| Historique Prisma | 5 hors bande `present=1|steps=0|termine=true` | conforme à la réconciliation |
| `20261028140000` | **`present=0`** | correctif **non appliqué** |
| `20261028150000` | **`present=0`** | correctif **non appliqué** |

La lacune du tour 29 — « les douze tables n'ont jamais été lues » — est
**comblée**, et de deux façons : par les 14 lignes `T` (existence, RLS, `FORCE`,
propriétaire, nombre) puis par les 33 lignes `P` (chaque règle, en entier).

Le résultat mérite d'être dit explicitement, parce qu'il n'était pas acquis :
**aucune des douze tables ne porte de politique qui ne soit dans le dépôt**.
La dérive est unique, et elle porte un nom.

### 5.3 Deux défauts de mon propre outil, trouvés par la première lecture réelle

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

Les deux sont corrigés, et **le test couvre les deux cas** : un compteur de
politiques qui bouge sur une table hors PLM, et un historique remis à zéro. Le
test est passé de 20 à **25 vérifications**. Il accepte aussi
`--perimetre-plm`, qui restreint le **périmètre comparé** (pour la première
lecture, limitée aux deux tables PLM) sans relâcher aucun contrôle sur ce qui a
été lu.

### 5.4 Ce que cela n'établit pas

- **M6** : toujours `NOT RUN` — aucune exécution de bout en bout sur la
  production n'a eu lieu, et ce n'est pas ce que ces lectures mesurent ;
- que la production a été **modifiée** : les deux correctifs sont dans le
  dépôt, `present=0` prouve qu'aucun n'est appliqué ;
- que la dérive PLM est **sans effet aujourd'hui** : elle élargit une règle
  d'insertion à `contributor`. Aucun incident n'est constaté — ce n'est pas la
  même chose qu'une absence de risque, et je ne prétends pas l'un pour l'autre.

## 6. État après ce tour

| Point | Avant (tour 29) | Après |
|---|---|---|
| Autorisation des deux opérations | absente | **accordée** |
| Accès à la production | absent | **absent** — identifiants et sortie réseau |
| Confrontation `plm_erp_gs1` | outil inexistant | **exécutée en production** ; verdict automatique : **`FAIL`**, 1 divergence nommée + 2 politiques surnuméraires |
| Cinq migrations hors bande — les 14 tables en production | non lues | **lues** : 14/14, RLS + `FORCE`, propriétaire unique, nombre de politiques |
| Politiques des 12 tables hors PLM, une par une | non lues | **lues** : 31 politiques, toutes conformes au dépôt |
| Confrontation complète | — | **`FAIL` sur 1 fait** : `plm_erp_sync_jobs` porte 4 politiques au lieu de 2 |
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
3. **maintenant** : la lecture est faite **sur le périmètre complet** — 66
   faits, 31 politiques lues une par une — et le motif n'est plus un doute mais
   un **fait mesuré** : **la production porte encore la dérive, et aucun des
   deux correctifs n'y est appliqué** (`present=0` pour `20261028140000` comme
   pour `20261028150000`).

   64 faits sur 66 concordent. Ce n'est pas « presque bon » : c'est **une**
    divergence, et elle est dans le sens qui autorise une action que le dépôt
    interdit.

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

Ce qui reste, et qui tient désormais en **une seule opération** :

**appliquer** `20261028150000` puis `20261028140000`, par le runbook éprouvé
(cinq sondes avant, cinq après). C'est l'autorisation déjà accordée pour
`20261028140000` ; `20261028150000` s'y ajoute comme préalable, puisqu'elle
ferme la dérive mesurée.

Fusionner ne déploie pas : même après l'application, `deploy` reste gelé
jusqu'à ce que l'historique Prisma porte les deux correctifs — et il les portera
par l'application elle-même, pas par une écriture à la main dans
`_prisma_migrations`.

## 8. Le comptage est revenu : `56` au lieu de `63` — arrêt avant écriture

Résultat de la requête du §4.3, en lecture seule, sur `Primary` :

```
appliquees = 56    en_cours = 0    annulees = 2
derniere   = 20261023120000_revoke_app_default_dml
```

**Le critère d'arrêt est atteint.** Le dépôt compte 65 migrations ; si les deux
correctives seules étaient en attente, le comptage aurait rendu `63`. Il en
manque donc **au moins sept**, et la dernière migration enregistrée en
production est datée du **23 octobre** — cinq jours avant le dernier lot du
dépôt.

### 8.1 Ce que ce chiffre ne dit pas encore, et pourquoi je ne le comble pas

Mon comptage n'était pas exclusif : `finished_at IS NOT NULL` inclut les lignes
**annulées** (`rolled_back_at` renseigné). `56` est donc une **borne haute** :
le nombre réellement appliqué est `54` ou `56`. C'est une imprécision de ma
requête, pas de la production — et elle suffit à interdire de conclure au doigt
mouillé sur *combien* manquent et *lesquelles*.

La seule lecture qui tranche est une comparaison nommée des 65 migrations du
dépôt à l'historique. Elle est fournie au §8.3 ; sa sortie est courte (une
ligne par écart) et ne demande aucune écriture.

### 8.2 Ce que cela change dans le diagnostic — et c'est grave

Si les écarts sont ceux que la date suggère, la production n'a **jamais**
reçu le lot du 27-28 octobre :

| Migration | Ce qu'elle ferme |
|---|---|
| `20261027100000_dpp_quality_gate_requires_assessment` | un passage de porte DPP sans évaluation |
| `20261027130000_dpp_review_preservation_and_publication_coherence` | cohérence revue / publication |
| `20261028120000_runtime_function_registry` | registre des fonctions d'exécution |
| `20261028120100_worker_identity_not_forgeable` | identité de worker forgeable |
| `20261028120200_document_reserved_fields_internal_only` | champs réservés de document |
| `20261028130000_product_computed_fields_column_scoped` | portée par colonne des champs calculés |

Ce ne sont pas des migrations de confort : ce sont des **fermetures de
contrôles**. Le `BLOCKED` du tour 29 les visait déjà sous le nom de
« réconciliation de l'historique » ; on sait maintenant qu'il ne s'agissait pas
d'une formalité de registre.

**Conséquence directe sur `migrate deploy`** : il appliquerait ces six
migrations **et** les deux correctives, en une seule fois, sans que personne
les ait autorisées nommément dans ce tour. Le gel de `deploy` n'était donc pas
une précaution de principe — il évitait exactement cela.

### 8.3 La lecture qui tranche

```sql
-- LECTURE SEULE. Compare les 65 migrations du depot a l'historique de
-- production, et ne rend QUE les ecarts.
WITH depot(nom) AS (
  VALUES
    ('20260923130000_tracefab_neon_initial'),
    ('20260923140000_tracefab_clerk_context'),
    ('20260923150000_fix_invitation_acceptance'),
    ('20260923160000_tracefab_product_api_functions'),
    ('20260923170000_fix_data_collection_workflow_context'),
    ('20260923180000_fix_data_response_progress_guard'),
    ('20260923190000_tracefab_notification_outbox'),
    ('20260923200000_tracefab_collection_reminders'),
    ('20261005090000_supplier_portal_advanced_hardening'),
    ('20261005100000_supplier_invitation_compatibility'),
    ('20261006100000_security_force_rls_and_document_access'),
    ('20261006110000_quality_center_shared_access'),
    ('20261006113000_clerk_directory_membership_sync'),
    ('20261006120000_data_collection_bridge_and_quality_automation'),
    ('20261006120000_external_schema_bindings'),
    ('20261006123000_clerk_sync_security_functions'),
    ('20261006130000_tracefab_manual_data_request_reminders'),
    ('20261006140000_supply_chain_traceability_api'),
    ('20261006160000_dpp_readiness_exposure'),
    ('20261006180000_supplier_self_onboarding'),
    ('20261006190000_catalog_import_export'),
    ('20261006200000_catalog_import_kind'),
    ('20261006200000_document_ai_automated_verification'),
    ('20261006210000_plm_erp_gs1_interoperability'),
    ('20261006220000_esg_pef_footprint_engine'),
    ('20261006220000_production_hardening'),
    ('20261006230000_green_claims_anti_greenwashing_engine'),
    ('20261006240000_quality_corrective_action_plans_cap'),
    ('20261006250000_universal_supplier_passport'),
    ('20261006260000_mass_balance_anti_fraud_engine'),
    ('20261007100000_security_definer_execute_hardening'),
    ('20261007120000_force_rls_schema_bindings'),
    ('20261008100000_rate_limit_counters'),
    ('20261009120000_fix_materials_policy_recursion'),
    ('20261009180000_public_read_context'),
    ('20261010120000_publication_explicite'),
    ('20261012120000_close_public_execute_gap'),
    ('20261014100000_revoke_material_visible_public'),
    ('20261014110000_revoke_dpp_functions_public'),
    ('20261014120000_close_global_default_function_execute'),
    ('20261014130000_revoke_public_schema_privileges'),
    ('20261014140000_remove_public_supplier_passport_share_token'),
    ('20261016130000_dynamic_dpp_lifecycle'),
    ('20261016150000_dpp_claim_evidence_chain'),
    ('20261016170000_dpp_resolvable_identity'),
    ('20261017100000_fix_document_lifecycle_access'),
    ('20261017120000_active_tenant_context'),
    ('20261017120000_harden_dpp_table_privileges'),
    ('20261017150000_harden_finalize_ops_gate'),
    ('20261019120000_restreindre_dml_role_applicatif'),
    ('20261019140000_restreindre_suppression_compteurs_debit'),
    ('20261019160000_retablir_dml_tables_ecrites_directement'),
    ('20261020120000_structured_supply_chain_graph_membership'),
    ('20261021120000_limit_app_function_execute'),
    ('20261021130000_reconcile_runtime_dml_and_migration_history'),
    ('20261021170000_dpp_readiness_truthful_gates'),
    ('20261023120000_revoke_app_default_dml'),
    ('20261027100000_dpp_quality_gate_requires_assessment'),
    ('20261027130000_dpp_review_preservation_and_publication_coherence'),
    ('20261028120000_runtime_function_registry'),
    ('20261028120100_worker_identity_not_forgeable'),
    ('20261028120200_document_reserved_fields_internal_only'),
    ('20261028130000_product_computed_fields_column_scoped'),
    ('20261028140000_supplier_invitation_owner_relationship_scope'),
    ('20261028150000_plm_erp_policy_convergence')
)
SELECT d.nom,
       CASE WHEN m.migration_name IS NULL THEN 'ABSENTE de l historique'
            WHEN m.rolled_back_at IS NOT NULL THEN 'ANNULEE (rolled back)'
            WHEN m.finished_at IS NULL THEN 'COMMENCEE, jamais terminee'
            ELSE 'appliquee' END AS etat
  FROM depot d
  LEFT JOIN _prisma_migrations m ON m.migration_name = d.nom
 WHERE m.migration_name IS NULL
    OR m.rolled_back_at IS NOT NULL
    OR m.finished_at IS NULL
 ORDER BY d.nom;
```

Sa sortie nomme les écarts. **Aucune écriture n'est autorisée avant de l'avoir
lue** : l'autorisation du tour 30 portait sur `20261028140000` et sur la
lecture, pas sur six fermetures de contrôles appliquées à la faveur d'un
`deploy`.

### 8.4 Ce que cela fait de la PR #102

Rien de bon, et il faut le dire sans détour : **la PR n'est pas le problème, et
la fusionner ne le réglerait pas**. Elle contient les deux correctifs ; la
production, elle, attend six autres migrations plus anciennes. `PRÊTE À
FUSIONNER` et `production à jour` sont deux questions distinctes, et la seconde
vient d'être tranchée : **non**.

## 9. La lecture nommée est revenue : onze écarts, dont deux « annulés »

Sortie de la requête du §8.3, sur `Primary` :

| Migration | État dans l'historique |
|---|---|
| `20261010120000_publication_explicite` | **ANNULEE** (`rolled_back`) |
| `20261017120000_active_tenant_context` | **ANNULEE** (`rolled_back`) |
| `20261021170000_dpp_readiness_truthful_gates` | ABSENTE |
| `20261027100000_dpp_quality_gate_requires_assessment` | ABSENTE |
| `20261027130000_dpp_review_preservation_and_publication_coherence` | ABSENTE |
| `20261028120000_runtime_function_registry` | ABSENTE |
| `20261028120100_worker_identity_not_forgeable` | ABSENTE |
| `20261028120200_document_reserved_fields_internal_only` | ABSENTE |
| `20261028130000_product_computed_fields_column_scoped` | ABSENTE |
| `20261028140000_supplier_invitation_owner_relationship_scope` | ABSENTE |
| `20261028150000_plm_erp_policy_convergence` | ABSENTE |

**Onze, pas sept.** Le comptage `56` se réconcilie : `56` lignes avec
`finished_at`, dont **deux** sont aussi `rolled_back_at` — donc **54**
migrations réellement appliquées sur 65.

Le §8.2 annonçait six fermetures récentes ; la mesure en donne **sept**, la
septième étant `20261021170000_dpp_readiness_truthful_gates`, datée du
**21 octobre**. L'hypothèse fondée sur la date était donc incomplète : c'est
précisément pourquoi il fallait la lecture nommée et pas une déduction.

### 9.1 Ce que « ANNULEE » veut dire — et ce que cela ne dit pas

`rolled_back_at` renseigné signifie qu'un `prisma migrate resolve --rolled-back`
a été exécuté : l'historique a été **corrigé**, pas la base. Ces deux
migrations peuvent donc être :

- **appliquées sans trace** — leurs effets sont là, l'historique ment ;
- **partiellement appliquées** — un `resolve` est souvent posé après un échec
  en cours de route ;
- **absentes** — et alors `deploy` les rejouerait.

Les trois hypothèses sont incompatibles et aucune ne se déduit de
l'historique. C'est la définition d'un `BLOCKED`, et c'est pour cela que la
sonde du §9.2 ne demande rien à `_prisma_migrations`.

### 9.2 La sonde d'effet, étalonnée avant d'être envoyée

Onze sondes, une par migration, qui interrogent le **catalogue** (et deux
tables de référentiel) au lieu de l'historique :
`docs/security/2026-10-28-tour30-C-sondes-effets.sql`.

**Une sonde non étalonnée ne vaut rien.** Trois d'entre elles étaient fausses
au premier jet, et le test les a arrêtées :

| Sonde | Défaut trouvé | Correction |
|---|---|---|
| `20261027100000` | cherchait `assessment` dans le corps de la fonction : le mot n'y est pas | cherche le marqueur réel, la lecture des scores **par produit** |
| `20261027100000` (2ᵉ essai) | cherchait `data_quality_scores` : la version **précédente** le contient déjà | idem — c'est la lecture par produit qui distingue |
| `20261028140000` | cherchait `invitation_relationship_mismatch` : le message exact est `invitation_relationship_organization_mismatch` | message exact |
| `20261028120100` | comptait les politiques contenant `tracefab_worker` : 9 dans les **deux** états | compte celles qui nomment `current_user` : **11** / 1 |
| `20261028150000` | ne peut rien distinguer sur une base neuve — il n'y a rien à y retirer | muette **par construction**, et justifiée |

`test:sondes-effets` construit **une base par migration retirée seule** — et
non une base où les onze manquent, qui laissait passer une coïncidence entre
deux versions successives d'une même fonction. Il exige que chaque sonde change
quand sa migration disparaît : **17 vérifications**, dont dix qui distinguent et
une muette justifiée.

C'est la deuxième fois dans ce tour qu'un contrôle écrit par moi mesurait autre
chose que ce que je croyais. Les deux fois, c'est un test qui l'a dit.

### 9.3 Ce que la sonde établira, et ce qu'elle n'établira pas

Elle dira, pour chacune des onze, si la production porte **l'effet** — pas la
ligne d'historique. Elle ne dira pas :

- si un état intermédiaire a existé ;
- si les données ont été transformées (les `UPDATE` de `publication_explicite`
  et de `dpp_readiness_truthful_gates` touchent des lignes, pas des objets) —
  la sonde lit des objets et deux libellés ;
- si les effets manquants sont **exploitables** par un attaquant : elle mesure
  la présence d'un contrôle, pas la faisabilité d'une attaque.

### 9.4 Portée des mesures — confirmée par l'exécutant

Le 28/10, le propriétaire du dépôt a précisé que **toutes** les requêtes de ce
tour ont été exécutées sur la branche **`Primary`**, c'est-à-dire sur la
production elle-même — et non sur une branche enfant de Neon.

La distinction n'est pas décorative. Une branche enfant de Neon herite du
schema de son parent **au moment de sa creation** : elle peut ensuite diverger,
et une lecture faite dessus ne decrirait qu'une copie. Ce que je rapporte est
donc l'etat de la production, et rien d'autre.

Ce que cela etablit, sans reserve :

| Mesure | Portee |
|---|---|
| 14 tables, `rls=true`, `force=true`, proprietaire unique | **production** |
| 33 politiques, lues une par une | **production** |
| 14 fonctions, `secdef`, `search_path`, `EXECUTE` | **production** |
| Les deux correctives `present=0` | **production** |
| Les 11 ecarts d'historique (dont 2 annulees) | **production** |

Ce que cela ne change pas : **les onze effets restent inconnus**. Le §9.1 tient
entier — un `resolve --rolled-back` corrige l'historique, pas les objets. C'est
la sonde du §9.2, et elle seule, qui dira ce que la production exécute
reellement.

Une lecture faite sur la production n'est pas une lecture de l'effet : elle dit
ce que le catalogue porte, pas ce que le registre raconte. Les deux niveaux
restent distincts, et c'est precisement l'ecart entre eux qui fait le `BLOCKED`.
