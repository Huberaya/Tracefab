# Tour 29 — correctif `supplier_portal` préparé hors production

Branche `arena/c27ddaa4-tracefab`. Aucune écriture, aucune connexion de
production, aucun déploiement. `prisma migrate deploy` reste **gelé**.

## 0. Vérification de la CI sur le SHA exact — `8ba7c8b`

Fait, indépendamment du récit du tour précédent :

```
6 check-runs, tous `head_sha = 8ba7c8b66bc7649d6291147d4c825db679e78257`
  (job Base 122838273282 : 49 etapes success, 0 skipped, 0 failure)
  success  Socle — types, compilation, isolation          (job 122828061336)
  success  Base — isolation RLS executee
  success  Parcours — navigateur reel
  success  Verification — suite de tests
  success  Chaîne 34/36/41 sur Postgres 17 jetable
  success  Vercel Preview Comments
```

Et, dans le job *Socle* du même SHA, les quatre étapes ajoutées :

```
success — Reconciliation de l historique de migrations
success — Releve M6 executable et inoffensif
success — Divergences d empreinte — effet reel mesure
success — Reprise des migrations — incidents reproduits puis franchis
```

Le `deployment Vercel` est un statut séparé des check-runs GitHub : il n'est pas
compté ici.

## 1. Revue critique des assertions du tour 28 — deux étaient faibles

En relisant mon propre test, deux assertions ne prouvaient pas ce que leur
libellé annonçait :

| Assertion | Faiblesse | Correction |
|---|---|---|
| « AVEC le rôle, l'effet est IDENTIQUE » | vérifiait seulement que le bloc **passe** (code 0), pas que les privilèges accordés sont les mêmes | comparaison **fonction par fonction** des `EXECUTE` réellement détenus par `tracefab_app` |
| « la production porte la règle la plus stricte » | **dérivée** : reformulait deux assertions déjà présentes | remplacée par une assertion indépendante : le dépôt n'accepte jamais un cas que la production refuse, et la seule différence est une acceptation supplémentaire côté dépôt |

Après correction, la mesure donne : `privileges : production=5, depot=5`, et
`les privileges obtenus sont IDENTIQUES, fonction par fonction`. La conclusion
« absence d'effet » de `public_read_context` repose désormais sur une
comparaison, pas sur une absence d'erreur.

## 2. Migration corrective — `20261028140000`

`prisma/migrations/20261028140000_supplier_invitation_owner_relationship_scope/`

### 2.1 Une erreur que je dois corriger, et qui venait de mon propre test

*(Section réécrite au tour 30. Ce qui suit remplace une affirmation fausse que
j'avais écrite ici.)*

J'avais écrit que la règle du dépôt (`relationship_id IS NULL`) ouvrait **deux
contournements** : un `admin` fabriquant un `owner` dans sa propre organisation,
et la réutilisation d'une relation d'un autre couple. **C'était faux.**

La chaîne pose un **second** déclencheur sur `organization_invitations` —
`invitations_validate_relationship`, migration initiale `20260923130000` — dont
la fonction exige déjà :

```sql
r.id = NEW.relationship_id AND r.supplier_organization_id = NEW.organization_id
```

Il tire **avant** le nôtre (ordre alphabétique) et refuse les deux cas. Mesure
sur la chaîne complète, tous déclencheurs en place :

| Cas | Règle du dépôt |
|---|---|
| owner côté marque | `invitation_relationship_mismatch` |
| relation d'un autre couple | `invitation_relationship_mismatch` |

**D'où venait l'erreur** : mon test montait un schéma écrit à la main — les deux
tables, **une seule** fonction. Ce montage ne contenait pas le second
déclencheur, donc il mesurait un système qui n'existe pas. Un test qui
reconstruit une partie du système ne mesure pas le système. C'est exactement le
reproche que je faisais aux empreintes du dépôt, appliqué à mon propre travail.

### 2.2 Ce qui reste vrai — et c'est plus étroit, donc plus utile

Sur la chaîne complète, l'écart entre production et dépôt tient en **deux
lignes** :

| Cas | production | dépôt |
|---|---|---|
| onboarding : owner + relation fournisseur | **refusé** | accepté |
| relation terminée (`status = 'ended'`) | refusé — mais seulement parce que *tout* `owner` est refusé | **accepté** ← le seul trou réel |

Rien, dans aucun des deux déclencheurs, ne regarde le **statut** de la relation.
Une relation terminée porte encore une invitation de propriétaire. C'est le seul
défaut que la règle du dépôt introduit vraiment, et c'est celui que la migration
corrige.

Le contrôle d'appartenance ajouté devient une **redondance assumée** avec
`tracefab_validate_invitation_relationship`. Elle est mesurée dans les deux sens :
retirée sur la chaîne complète, rien ne change ; l'autre déclencheur retiré, elle
est la seule barrière. Deux verrous sur la même porte ne sont pas un défaut — à
condition de dire lequel porte, et de le prouver.

### 2.3 La règle retenue

Celle du parcours réel, et rien de plus. `tracefab_invite_supplier` crée une
relation (marque → fournisseur) puis insère l'invitation avec
`organization_id = supplier_organization_id` et `target_role = 'owner'` :

| Cas | Décision |
|---|---|
| `owner` sans relation | **REFUS** — `owner_role_not_invitable` (inchangé) |
| relation inexistante | **REFUS** — `invitation_relationship_not_found` |
| relation dont le fournisseur n'est pas l'organisation invitée | **REFUS** — `invitation_relationship_organization_mismatch` |
| relation terminée (`status = 'ended'`) | **REFUS** — `invitation_relationship_ended` |
| relation `invited` / `active` / `suspended`, côté fournisseur | **ACCEPT** — l'onboarding |

`invited` et `suspended` restent acceptés délibérément : le premier est l'état
de l'onboarding, le second ne retire pas le rôle. Seul `ended` ferme.

### 2.4 Ce que la migration ne fait pas

- elle ne réécrit **aucune** migration livrée — et ce n'est pas une réécriture
  d'historique : `20261028140000` n'a **jamais été appliquée à aucune base**
  (elle figure parmi les migrations non attestées en production) ; la compléter
  avant sa première application est la corriger, pas la falsifier ;
- elle n'écrit **pas** dans `_prisma_migrations` ;
- elle ne pose **aucun `GRANT`/`REVOKE`** (assertion : aucun mot hors commentaire) ;
  la fonction n'est pas appelée par `tracefab_app`, seul le déclencheur l'est ;
- elle ne touche **aucune politique RLS** ;
- elle **repose le déclencheur** (`DROP … IF EXISTS` puis `CREATE`) avec
  **exactement** la portée historique `BEFORE INSERT OR UPDATE … FOR EACH ROW` —
  vérifié par `tgtype = 23`. Reposer un déclencheur est un point où l'on peut
  élargir sans le voir ; c'est donc mesuré, pas supposé.

## 3. Preuve, dans l'ordre demandé

`npm run test:supplier-invitation-corrective` — **40 vérifications**, exécutées
sur PostgreSQL 18.6 jetable (PGlite), sur la **chaîne complète** des 64
migrations (moins la corrective), avec quatre organisations, un utilisateur et
trois relations.

*(Section réécrite au tour 30 : la version précédente annonçait 37 vérifications
sur un schéma écrit à la main, et un tableau faux.)*

Les trois versions ne diffèrent que par le corps de la fonction de rôle : c'est
exactement ce que les migrations changent. Tout le reste — les deux déclencheurs,
les contraintes, les politiques — est le schéma réel.

| Cas | production | dépôt (avant) | correctif (après) |
|---|---|---|---|
| `onboarding` — owner + relation fournisseur | **refusé** | accepté | **accepté** |
| `ownerSansRelation` | refusé | refusé | **refusé** |
| `ownerCoteMarque` | refusé | **refusé** (`mismatch`, autre déclencheur) | **refusé** |
| `relationAutreOrg` | refusé | **refusé** (`mismatch`, autre déclencheur) | **refusé** |
| `relationTerminee` — relation `ended` | refusé | **accepté** ← le trou | **refusé** (`ended`) |
| `adminAvecRelation` | accepté | accepté | **accepté** |
| `viewerSansRelation` | accepté | accepté | **accepté** |

Trois lectures, chacune avec son assertion :

1. **le défaut de production est reproduit** — l'onboarding échoue avant ;
2. **l'écart réel du dépôt tient en une ligne utile** — la relation terminée. Les
   deux autres acceptations que j'avais annoncées n'existent pas ; elles étaient
   un artefact de mon montage ;
3. **le correctif rend au parcours ce que la production lui refuse sans
   rouvrir ce que le dépôt ferme** — la seule décision qui change par rapport au
   dépôt est `relationTerminee`, et elle va dans le sens de la fermeture.

**Attribution, pas supposition.** Le test retire
`invitations_validate_relationship` et rejoue : la règle du dépôt **laisse alors
passer** `ownerCoteMarque` et `relationAutreOrg`, et le correctif, seul, les
refuse encore. C'est la preuve que le contrôle d'appartenance est une redondance
sur la chaîne complète **et** une barrière réelle si l'autre déclencheur
disparaissait.

**Contrôles négatifs** (le test doit mordre) :

| Mutation | Résultat mesuré |
|---|---|
| retrait du contrôle de statut | `relationTerminee` redevient **accepté** — l'assertion dépend bien de ce contrôle |
| retrait du contrôle d'appartenance, chaîne complète | **aucun changement** — la redondance est mesurée, pas supposée |
| retrait du contrôle d'appartenance **et** de l'autre déclencheur | `ownerCoteMarque` et `relationAutreOrg` **passent** — le trou serait réel |

**Idempotence et intégrité** : rejeu sans erreur, déclencheur unique pointant sur
la fonction corrigée et gardant **exactement** sa portée historique (`tgtype = 23`),
fonction toujours `SECURITY DEFINER` avec `search_path` fixé, aucun `GRANT`/`REVOKE`,
aucune politique RLS touchée. **Chaîne** : les **64** migrations s'appliquent sur
une base vierge, la corrective en dernière position, aucune renumérotation.

La migration est jouée **en entier**, pas seulement le corps de fonction.

## 4. Effets de bord traités

Ajouter une 64ᵉ migration casse deux instruments qui comptaient :

- `test:chantiers` refusait un registre annonçant 63 → registre mis à jour
  (« Dépôt : 64 migrations » + description de la 64ᵉ) ;
- `test:reprise-migrations` portait `slice(0, 58)` et l'assertion « 5
  manquantes » → rendu indépendant du nombre total : `58` est le nombre de
  lignes de l'historique **de production**, pas une propriété du dépôt.

Troisième effet de bord, trouvé par la suite de tests du dépôt elle-même :
`test:sql-errors` a **refusé** ma migration. Les trois codes d'exception que
j'ajoutais (`invitation_relationship_not_found`, `…_organization_mismatch`,
`…_ended`) n'avaient pas de traduction HTTP — un code SQL métier sans mapping sûr
est un 500 en puissance. Ils sont désormais déclarés dans `api/_lib/sql-errors.ts` :
`400` pour une référence inexistante (requête mal formée), `403` pour une relation
d'une autre organisation (refus d'autorisation), `409` pour une relation terminée
(conflit d'état). L'audit passe de 197 à **200** garde-fous PostgreSQL traduits.

C'est le bon sens de circulation : je n'ai pas assoupli le contrôle, j'ai
satisfait son exigence.

Conséquence attendue et non corrigée : le réconciliateur signale désormais
**8** migrations non attestées (les 7 précédentes + la corrective). C'est
l'état réel, et il changera au déploiement.

## 5. État de la chaîne P0

| Point | État |
|---|---|
| `plm_erp_gs1` | **`BLOCKED`** — confrontation production non exécutée (autorisation de connexion absente) |
| `supplier_portal` | **correctif prouvé sur base jetable** (37 vérifications, 2 mutations) — **non appliqué** en production |
| `public_read_context` | **clos sous réserve** — voir §6 |
| Migrations hors bande (5, à 0 étape) | **`PASS` hors production** — deux chemins équivalents objet par objet ; état du catalogue de production **non lu** |
| M6 | **`NOT RUN`** — aucune autorisation de lecture pendant ce tour |
| `deploy` | **gelé** |

## 6. `public_read_context` — ce que « absence d'effet » couvre exactement

La conclusion vaut pour **le rôle et les conditions réellement testés** :

- rôle `tracefab_app` **existant** — le cas de la production ;
- sur les **cinq** fonctions concernées ;
- comparaison des `EXECUTE` réellement détenus, pas seulement du succès du bloc.

Elle ne dit rien de : un autre rôle, une base où `tracefab_app` serait absent,
ou l'état des privilèges **par défaut** du schéma. Ces cas ne sont pas couverts
et ne sont donc pas affirmés.

## 7. Mission §4 — `plm_erp_gs1` : `BLOCKED`, et ce qui manque exactement

Le contenu de production de `20261006210000_plm_erp_gs1_interoperability` n'a
**jamais été retrouvé** — ni dans le dépôt, ni dans les objets Git (vérifié, y
compris les objets non atteignables depuis une branche). Il est donc **inconnu**,
et non « probablement identique ».

Ce qui est établi, en revanche, est le **référentiel du dépôt**, calculé sur une
base jetable construite jusqu'à cette migration (24 migrations). `test:divergences-migrations`
produit désormais les six dimensions que la mission exige, et non plus une seule
empreinte :

| Dimension | Valeur de référence (dépôt) |
|---|---|
| `plm_erp_integrations` | `rls=true`, `force_rls=true` |
| `plm_erp_sync_jobs` | `rls=true`, `force_rls=true` |
| `plm_integrations_mutate_brand` | `ALL`, rôle `public`, `USING` = `WITH CHECK` = `tracefab_has_org_role(organization_id, {owner,admin,manager})` |
| `plm_integrations_select_org` | `SELECT`, rôle `public`, `USING` = `tracefab_is_org_member(organization_id)`, pas de `WITH CHECK` |
| `plm_sync_jobs_insert_brand` | `INSERT`, `WITH CHECK` = `tracefab_has_org_role(brand_organization_id, {owner,admin,manager})`, pas de `USING` |
| `plm_sync_jobs_select_org` | `SELECT`, `USING` = `tracefab_is_org_member(brand_organization_id)` |
| fonction `tracefab_ingest_plm_erp_payload(uuid,text,jsonb,uuid)` | `SECURITY DEFINER`, propriétaire `postgres`, `search_path=public`, `EXECUTE` à **PUBLIC** et à `tracefab_app`, `acl = ~X/postgres, postgres=X/postgres` |

**Une constatation qui mérite d'être dite** : la fonction est `SECURITY DEFINER`,
exécutable par `PUBLIC`, et ne fixe que `search_path=public`. C'est un état
**existant**, que je ne modifie pas (gel du 28 bis), mais ce n'est pas une
propriété anodine : tout rôle connecté peut l'appeler, et elle s'exécute avec les
droits de son propriétaire. Le `search_path` étant fixé, le détournement par
schéma antérieur est fermé ; l'exécution par `PUBLIC` reste ouverte.

**Pourquoi `BLOCKED` et non `PASS`** : ces valeurs sont celles **du dépôt**. La
production a exécuté un fichier dont l'empreinte diffère (`c944ce0c…` contre
`330b6689…`). Tant que son catalogue n'a pas été lu, on ne sait pas si ces
politiques, ce `EXECUTE`, ce propriétaire et ce `search_path` y sont — ni même si
la fonction y porte le même corps. La preuve manquante est **une lecture du
catalogue de production**, et la requête qui la produirait est désormais
imprimée par le test lui-même (section « REQUETE DE CONFRONTATION »), en lecture
seule, sans appel de fonction applicative.

## 8. Mission §5 — les cinq migrations hors bande : `PASS`, avec un fait nouveau

Nouveau test : `npm run test:migrations:hors-bande` (46 vérifications).

### 8.1 Le fait que je n'avais pas vu

**La chaîne privée des cinq migrations ne s'applique pas.** Rejouée en sautant
les cinq sur une base vierge, elle s'arrête à la 30ᵉ avec :

```
20261009180000_public_read_context
42P01  relation "product_pef_assessments" does not exist
```

29 migrations passent, puis une migration ultérieure exige une table que seule
`20261006220000_esg_pef_footprint_engine` crée. Conséquence : `applied_steps_count = 0`
**ne peut pas** signifier « SQL jamais exécuté » — le reste de l'historique en
dépend, et il est attesté appliqué. « Marqué appliqué sans exécution » reste
exclu ; « exécuté hors bande » est la seule lecture compatible.

### 8.2 Equivalence des deux chemins, objet par objet

Deux bases jetables, même préfixe de 24 migrations, puis les cinq :
chemin « Prisma » (une transaction par fichier) et chemin « lanceur »
(instruction par instruction, autocommit, avec le découpeur **copié** du
lanceur). Comparaison des catalogues complets :

| Dimension comparée | Résultat |
|---|---|
| colonnes, types, `NOT NULL`, défauts | identiques |
| contraintes, index | identiques |
| politiques RLS : rôle, commande, `USING`, `WITH CHECK` | identiques |
| déclencheurs : table, fonction, portée, activation | identiques |
| fonctions : `SECURITY DEFINER`, `search_path`, propriétaire, `EXECUTE` de `tracefab_app` et de `PUBLIC`, ACL | identiques |
| `relrowsecurity` / `relforcerowsecurity`, propriétaires d'objets | identiques |

Puis les 34 migrations suivantes sont appliquées aux deux bases : les empreintes
**convergent encore**. Aucun écart.

### 8.3 La différence réelle : l'atomicité

« Même fichier » ne couvre pas l'atomicité, et c'est mesuré plutôt qu'affirmé.
Une instruction en échec est ajoutée à la **fin d'une copie** d'une des cinq (la
migration versionnée n'est pas touchée) :

| Chemin | Après l'échec |
|---|---|
| transaction par fichier | `0` table créée — tout est annulé |
| instruction par instruction | la table **existe déjà** — état partiel |

C'est cela, et cela seulement, que le chemin hors bande n'a pas garanti. Sur ces
cinq-là, tout a réussi : il n'y a pas d'état partiel. Mais si une instruction
avait échoué en milieu de fichier, `applied_steps_count = 0` aurait coexisté
avec un schéma à moitié construit, sans que rien ne le signale.

### 8.4 Ce que les cinq apportent — et ce qu'elles ne touchent pas

| Mesure | Valeur |
|---|---|
| objets ajoutés | **186 colonnes, 239 contraintes, 43 index, 25 politiques RLS, 13 fonctions, 12 tables** |
| objets retirés | **aucun** |
| objets existants modifiés par les cinq | **aucun** |

La migration **intercalée** par l'ordre de tri (`20261006220000_production_hardening`,
qui n'est pas l'une des cinq) est comptée séparément, car elle **modifie** quatre
propriétés d'objets existants : `audit_logs` perd l'écriture de `PUBLIC`
(`arw` → `ar`), `tracefab_schema_catalog` et `tracefab_schema_bindings` passent
en `FORCE ROW LEVEL SECURITY`, `tracefab_notification_outbox` gagne la lecture
`PUBLIC`. C'est elle, pas les cinq, et elle est appliquée dans la bande.

Mon premier découpage comptait 24 + 5 + 34 = 63 pour 64 migrations : une
migration intercalée échappait à la partition. Le test le vérifie maintenant
explicitement (`préfixe + intervalle + reste = chaîne entière`), et un écart
d'une seule migration le fait rougir.

### 8.5 Ce qui reste hors de portée

L'état du **catalogue de production** pour ces douze tables et leurs politiques.
L'équivalence est prouvée entre deux chemins appliqués depuis le dépôt ; elle ne
prouve pas que la production, elle, a bien exécuté ces fichiers. Les cinq
lanceurs ne sont pas tracés (`_prisma_migrations` non écrit), donc la seule
preuve possible reste une lecture du catalogue — la même requête que pour
`plm_erp_gs1`, étendue aux douze tables.

## 9. Mission §6 — M6 : `NOT RUN`

Le relevé M6 demande un accès en lecture seule à la base, et la mission le
conditionne à une autorisation explicite. **Aucune autorisation n'a été donnée
pendant ce tour**, et je n'ai pas ouvert de connexion. Le script
`docs/security/2026-10-28-m6-lecture-seule.sql` reste prêt ; son exécutabilité
est vérifiée hors ligne (`test:diagnostic-m6` : `PASS`), ce qui est un autre
contrôle — il prouve que le relevé s'exécute sans rien modifier, pas qu'il ait
été fait sur la production.

Statut exact : `NOT RUN` (autorisation absente), et non `PASS`.

## 10. Ce qui reste à autoriser

1. la **requête de confrontation** de `plm_erp_gs1` (lecture seule) — valeurs de
   référence déjà calculées et imprimées par `test:divergences-migrations` ;
2. l'**application** de `20261028140000` en production — écriture, donc hors de
   portée sans accord explicite ;
3. la confrontation des **cinq migrations hors bande** à leur état de schéma.

Rien de tout cela n'est engagé. Le correctif est préparé, pas appliqué.
