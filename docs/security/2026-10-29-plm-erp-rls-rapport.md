# PLM/ERP — politiques RLS de `plm_erp_sync_jobs` : rapport de remise

Périmètre strict : **uniquement** les politiques RLS de `plm_erp_sync_jobs`.
Migrations (au-delà de ce correctif), autres contrôles de sécurité, décision de
fusion : **chef de chantier**. Aucun accès en écriture à la production n'a été
effectué. Aucun `prisma migrate deploy`. `_prisma_migrations` non touchée.

## A. SHA

| Élément | Valeur |
|---|---|
| SHA de départ de cette sous-mission | `bc61dc7` |
| SHA final (ce rapport, avant ce commit) | `3b83138d3de052a9c56fb773c45c840841fd810c` |
| Branche | `arena/c27ddaa4-tracefab` (PR #102, **Draft maintenu**) |
| `main` | `bf55f2ae6534cde84d072d9b975520216c7b6d4e` (inchangé) |

## B. Constat majeur — le correctif demandé existait déjà

`prisma/migrations/20261028150000_reconcile_plm_erp_sync_job_policies/migration.sql`
est **présente dans `bc61dc7`** et fait exactement ce qui était demandé :

- `BEGIN` … `COMMIT` (atomique) ;
- gardes **fail-closed** exécutées **avant tout DROP** : table absente,
  politiques canoniques absentes, `WITH CHECK` canonique contenant
  `contributor` ⇒ `RAISE EXCEPTION` ;
- exactement **deux** `DROP POLICY IF EXISTS` :
  `plm_erp_sync_jobs_insert_brand` et `plm_erp_sync_jobs_select_brand` ;
- aucune migration historique modifiée ; migration **additive**.

**Aucune nouvelle migration n'a donc été écrite.** La valeur ajoutée de ce
tour est la **preuve exécutable**, pas un second correctif.

## C. Ce qui a été produit

| Fichier | Nature |
|---|---|
| `scripts/test_plm_rls_isolation_prouvee.mjs` | nouveau — **43 vérifications**, PGlite, chaîne complète des migrations |
| `package.json` | ajout `test:plm-rls-isolation` |
| `.github/workflows/ci.yml` | ajout d'une étape dédiée (job « Socle ») |
| ce rapport | livrable |

### Ce que le test prouve, par exécution

1. **La politique partielle est insuffisante** — état A (4 politiques) / B
   (insert retirée seule) / C (correctif complet). En B, l'écriture est bien
   fermée **mais** `contributor` lit toujours les jobs de l'autre organisation :
   la combinaison **OR** est confirmée par mesure, pas par raisonnement.
2. **Après correctif, exactement deux politiques subsistent** :
   `plm_sync_jobs_insert_brand`, `plm_sync_jobs_select_org` — obtenu par un
   **balayage exhaustif** de `pg_policies` (predicat `tracefab_is_org_member` /
   `tracefab_has_org_role`), pas par une liste écrite à la main.
3. **Refus** : `contributor` ne peut pas insérer (erreur `42501` sur le
   `WITH CHECK`).
4. **Acceptation** : owner / admin / manager insèrent.
5. **Isolation entre deux organisations** : aucune ligne de l'organisation B
   n'est visible depuis A, et réciproquement.
6. **Aucun accès induit par une politique permissive résiduelle** : aucun
   prédicat orphelin ne subsiste.
7. **Idempotence** : migration rejouée **3 fois** de suite sur la même base.
8. **Gardes fail-closed** : base neuve sans les canoniques, canonique absente,
   table absente ⇒ la migration **refuse** au lieu de supprimer à l'aveugle.
9. **Privilèges effectifs** de `tracefab_app` : SELECT/INSERT/UPDATE/DELETE =
   **true** (DELETE est bien accordé par `20261019160000`), TRUNCATE /
   REFERENCES / TRIGGER = false, `PUBLIC` = false partout.
   `relrowsecurity = true` **et** `relforcerowsecurity = true`.

### Point de méthode corrigé (important pour la revue)

L'assertion portant sur DELETE a d'abord échoué, et l'échec était **instructif** :

- **`USING` filtre, il ne rejette pas.** Un DELETE sans politique ne lève
  **aucune erreur** : il supprime 0 ligne. Attendre `42501` était faux.
- L'anomalie « `avant=0 apres=1` » venait d'un **comptage sous deux rôles
  différents** (le `avant` était mesuré sous le rôle applicatif, donc filtré
  par la RLS). Elle est levée : les deux comptages sont désormais faits **sous
  le même rôle**, et l'assertion porte sur l'**effet** (aucune ligne ne
  disparaît), pas sur un code d'erreur.
- L'assertion n'a **pas** été affaiblie : elle est devenue **vraie**, et le test
  vérifie en plus qu'aucune politique `polcmd='d'` **ni** `polcmd='*'`
  (FOR ALL) ne couvre DELETE.

## D. Tests et CI au SHA exact

- Suite nouvelle : **43/43**.
- Suites PLM voisines, rejouées : `test_plm_sync_jobs_acces` 19/19,
  `test_plm_erp_convergence_chaine` 27/27,
  `test_plm_sync_job_policy_reconciliation` 12/12,
  `test_provenance_politiques_plm` 12/12,
  `test_plm_erp_policy_convergence` PASS.
- Batterie autonome (PGlite / statique) : **18/19** — le seul code non nul est
  `verifier_confrontation_production`, un **outil** qui exige un fichier `psql`
  en argument, pas un test.
- **CI `40869768422` sur `3b83138`, 4/4 jobs verts**, étape
  « PLM — politique partielle vs complete, idempotence, privileGES effectifs »
  effectivement **exécutée** (`success`).

## E. Non exécuté (à ne pas lire comme réussi)

- `prisma migrate deploy` : **gelé** par consigne, non exécuté.
- Application réelle sur la branche `production` : **non exécutée**, aucun
  accès en écriture.
- Lots 1 à 4 de la stratégie de réconciliation : non exécutés.
- Plusieurs suites `test:neon:*` : sortie 2 « NON EXÉCUTÉ — `DATABASE_URL`
  absent ». Elles ne comptent pas comme vertes.

## F. Risques résiduels

1. La preuve est établie en **PGlite**, pas sur la base Neon réelle. Elle
   démontre la sémantique SQL et le comportement des politiques, pas l'état de
   production de `plm_erp_sync_jobs`.
2. La migration est **idempotente et fail-closed**, mais elle **supprime** :
   si la production ne correspond pas aux canoniques attendues, elle **refuse**
   — comportement voulu, mais qui nécessitera une décision du chef de chantier.
3. Les 11 écarts de la matrice de migrations et les autres P0 (identité worker,
   champs sensibles) sont **hors périmètre** de ce correctif et restent ouverts.

## G. Verdict

**PASS** — pour le périmètre « politiques RLS de `plm_erp_sync_jobs` », sur
`3b83138` : correctif présent et vérifié, preuve exécutable complète, CI verte
sur le SHA exact.

Ce verdict **ne vaut pas** autorisation de fusion. La PR #102 reste en **Draft** ;
la décision de fusion et le sort des migrations relèvent du chef de chantier
après revue indépendante.

---

# Suite du 29/10 — contrôles sur `6f09cc8`, gardes, et plan de réconciliation

## A bis. CI sur le dernier SHA

| Run | SHA | Résultat |
|---|---|---|
| `40872223854` (CI) | `6f09cc8` | **4/4 jobs verts**, étape PLM **exécutée** |
| `40872223952` (Intégration migrations) | `6f09cc8` | vert |
| **`40876085411` (CI)** | **`5ea5fad`** | **4/4 jobs verts**, les 3 nouvelles étapes **exécutées** (`success` chacune) |

## B bis. Correction de l'énoncé précédent — une donnée n'était pas mesurée

**Ce rapport affirmait plus haut que « retirer la seule insertion ne suffit
pas »**. C'est vrai **sous une hypothèse**, et cette hypothèse n'a jamais été
mesurée : le **prédicat exact** de `plm_erp_sync_jobs_select_brand` n'est
consigné dans aucun artefact. Les lectures de production n'ont conservé que son
**nom** (`P|plm_erp_sync_jobs.plm_erp_sync_jobs_select_brand`).

Or la gravité en dépend :

| Hypothèse | Conséquence |
|---|---|
| **Doublon** du prédicat canonique (ce que dit le commentaire de la migration) | elle **n'élargit rien** ; retirer la seule insertion **suffit** ; la retirer reste une mise au net |
| **`USING (true)`** (pire cas, ce que mon test précédent simulait) | la lecture inter-organisations est ouverte ; la retirer **est** la correction |

Les deux variantes sont désormais mesurées côte à côte
(`test:plm-confrontation`, sections 2 et 3). Dans les deux cas **le correctif
est le même** — retirer les deux — donc la décision ne change pas ; ce qui
change, c'est **ce qu'on peut affirmer** sur la gravité. Le test précédent a été
renommé pour dire « reconstruction au pire cas » au lieu de « telle que lue ».

## C bis. Confrontation : 4 observées → 2 canoniques

| Politique | Provenance | Commande | Verdict |
|---|---|---|---|
| `plm_sync_jobs_select_org` | créée par `20261006210000` | SELECT | **canonique attendue** |
| `plm_sync_jobs_insert_brand` | créée par `20261006210000` | INSERT | **canonique attendue** |
| `plm_erp_sync_jobs_insert_brand` | **aucune** migration du dépôt | INSERT | **surnuméraire** — admet `contributor` |
| `plm_erp_sync_jobs_select_brand` | **aucune** migration du dépôt | SELECT | **surnuméraire** — prédicat non relevé |

`4 = 2 + 2`, sans reste. Aucune migration du dépôt ne **crée** les deux
surnuméraires (balayage de tout le dossier `prisma/migrations`) : leur
provenance est **hors dépôt**, donc un `DROP` est durable.

## D bis. Les gardes acceptent l'état réel — et refusent le reste

`npm run test:plm-confrontation` — **56 vérifications**.

| Scénario | Attendu | Mesuré |
|---|---|---|
| état à 4 politiques (pire cas et doublon) | accepte, laisse 2 | **accepte** |
| canoniques non réécrites | définitions identiques avant/après | **identiques** |
| table absente | refuse `plm_erp_sync_jobs_absente` | refuse, **rien supprimé** |
| canonique INSERT absente | refuse | refuse, **surnuméraires intactes** |
| canonique SELECT absente | refuse | refuse, **surnuméraires intactes** |
| canonique INSERT rouverte à `contributor` | refuse | refuse, **intactes** |
| canonique INSERT sans `manager` | refuse | refuse, **intactes** |
| canonique INSERT sans `WITH CHECK` | refuse | refuse, **intactes** |
| politique **inattendue** présente | passe et la **préserve** | préservée, définition identique |

**Limite mesurée, à trancher par le chef de chantier** : les gardes vérifient la
**présence** des canoniques et la **forme** de la canonique INSERT ; elles ne
**comptent pas** les politiques. Avec une 5ᵉ politique inattendue, la migration
passe et laisse **3** politiques au lieu de 2. Mesuré, pas supposé. Un garde
supplémentaire est possible (compter les politiques restantes) ; il n'a pas été
ajouté — c'est une modification de migration, hors de mon périmètre.

## E bis. Le relevé qui ferme la donnée manquante

`docs/security/2026-10-29-plm-politiques-lecture-seule.sql` — **strictement
lecture seule** (`BEGIN READ ONLY`, aucun DDL/DML, 5 questions Q0–Q5). Il rend
le prédicat exact des quatre politiques, la classification
canonique/surnuméraire, le compte et l'écart, les conditions que la migration
exigera, et les privilèges effectifs.

Il a été **joué avant d'être livré** (`npm run test:plm-lecture-seule`,
**33 vérifications**) sur trois états : production reconstruite, base saine,
base **sans la table**. Il ne casse dans aucun des trois.

Deux faux positifs de mes propres contrôles ont été corrigés en corrigeant le
**détecteur**, pas le SQL : `'TRUNCATE'` dans un `ARRAY` de noms de privilèges
n'est pas une écriture, et `current_setting('transaction_read_only')` est un
littéral.

## F bis. Plan de réconciliation des migrations — généré et vérifié

`npm run plan:reconciliation` — liste **recalculée** depuis
`scripts/lib/ecarts_migrations.mjs` (faits mesurés, extraits de
`matrice_migrations.mjs` sans changer un chiffre : 65 = 49 + 5 + 2 + 9).

| Catégorie | Nombre | Action |
|---|---|---|
| **Annulées** `20261010120000`, `20261017120000` | 2 | sonde ; `resolve --applied` **sur preuve** si effets présents |
| **Absentes**, effets **mesurés** `20261028120000`, `20261028150000` | 2 | appliquer **seules**, dans cet ordre |
| **Absentes**, effets **non prouvés** | 7 | sonde → `applied` si présents, sinon appliquer **une fois** |
| **Déjà matérialisées** (hors bande, `applied_steps_count = 0`) | 5 | **ne rien rejouer** |

Le générateur **refuse** et sort en code 1 si le plan contient un `UPDATE`/`DELETE`
sur `_prisma_migrations`, un `resolve --rolled-back`, un `deploy` global, un
`resolve --applied` sans preuve nommée, un ordre violant la dépendance
registre → `…120100`, ou une migration hors de toute catégorie.

`npm run plan:reconciliation:autotest` — **7 témoins sur 7 détectés**. Sans eux,
« aucune violation » ne prouverait rien : un contrôle cassé rend le même silence
qu'un plan correct.

## G bis. Tests, sur `6f09cc8` + ce tour

| Suite | Vérifications |
|---|---|
| `test:plm-rls-isolation` | 43/43 |
| `test:plm-confrontation` | **56/56** |
| `test:plm-lecture-seule` | **33/33** |
| `plan:reconciliation` + autotest | exit 0, 7/7 témoins |
| Batterie autonome complète | **26/26 suites vertes** |
| **CI `40876085411` sur `5ea5fad`** | **4/4 jobs verts**, 9 étapes PLM/migrations exécutées |

## H bis. Risques résiduels (mis à jour)

1. Le prédicat de `select_brand` reste **non mesuré** tant que Q1 n'a pas été
   exécuté en production. Le relevé est prêt et testé.
2. Les gardes ne comptent pas les politiques : une 5ᵉ inattendue survivrait.
3. Rien n'a été appliqué : lots 1 à 4 non exécutés, `deploy` gelé.
4. `20261028120000` reste **non rejouable** ; elle doit passer **en premier** ou
   être résolue sur preuve, jamais rejouée après un échec.

## I bis. Verdict

**PASS sur le périmètre PLM/ERP** — correctif présent, preuves exécutables,
gardes qualifiées, relevé de production prêt et testé, plan de réconciliation
généré et auto-vérifié.

**Toujours pas de fusion.** Deux points appartiennent au chef de chantier :
ajouter ou non un garde sur le **nombre** de politiques, et exécuter Q1 pour
convertir une hypothèse en mesure.

---

# Tour du 29/10 (suite) — la branche a avancé sans moi

## A ter. Ce que j'ai trouvé en arrivant

Le `worktree` avait encore disparu ; la branche, elle, avait **avancé de 5
commits que je n'ai pas écrits** — le chef de chantier a implémenté le garde sur
le **nombre** de politiques que je lui avais signalé hors périmètre :

| Commit | Apport |
|---|---|
| `82e7ec8` | garde `nombre_ou_identite_politiques_inattendu` dans `20261028150000` |
| `ded2f06`, `450b4c8` | test de ce garde, puis correction d'une assertion |
| `08e850f` | **nouvelle** migration `20261029150000_plm_sync_jobs_policy_alignment` |
| `83cb442` | mise à jour du compte de migrations |

**Je n'ai rien écrasé.** J'ai repris sur `83cb442`.

## B ter. Deux migrations pour le même `DROP` — à trancher

`20261028150000` (gardes **avant**) et `20261029150000` (vérification **après**,
dans la même transaction) retirent **les deux mêmes** politiques. Ce n'est pas
dangereux — mesuré — mais c'est **deux sources de vérité** pour un seul
correctif.

`npm run test:plm-migrations-jumelles` — **38 vérifications**. Ce qui est établi :

| Point | Résultat |
|---|---|
| Les deux corrigent l'état réel (4 → 2), variantes « doublon » et `USING (true)` | **oui, pour les deux** |
| Les canoniques sont **inchangées** (définitions identiques avant/après) | **oui, pour les deux** |
| Idempotence (deux exécutions de chacune) | **oui** |
| Chaînées dans les deux ordres | **aucun dommage**, la seconde est un no-op |
| Canonique absente | les deux **refusent**, surnuméraires intactes |
| **5ᵉ politique inattendue** | **`20261028150000` refuse** · **`20261029150000` passe et laisse 3 politiques** |

Sur le dernier point, la `20261029150000` ne contrôle que la présence des deux
canoniques et la disparition des deux nommées : elle **ne compte pas** les
politiques. C'est exactement la limite que j'avais mesurée, et le garde du chef
de chantier la ferme — mais **dans l'autre migration**. Si les deux restent, la
protection dépend de l'ordre ; si l'une doit partir, c'est `20261029150000` qui
est redondante. **Décision au chef de chantier**, pas à moi.

## C ter. Dette des migrations : ce que « une par une » donne

`npm run test:application-une-par-une` — **20 vérifications**, sur une base
reconstituée à l'état de production (**56 migrations jouées** = 49 attestées +
5 hors bande + 2 annulées, les 10 autres non jouées).

| Mesure | Résultat |
|---|---|
| Les 10 manquantes, **une par une dans l'ordre** | **toutes passent**, sans rupture |
| État d'arrivée | **2 politiques**, registre présent |
| `20261028120000` **rejouée** | **échoue** (`CREATE TABLE` sans `IF NOT EXISTS`) |
| `20261028120100` **sans** le registre | **échoue** — dépendance réelle, mesurée |
| Les 5 suivantes, une par une | passent : **elles ne bloquent pas par elles-mêmes** |
| Les 2 migrations **annulées**, rejouées | **passent** — donc elles ne sont pas le danger |

**Correction d'une affirmation antérieure** : le risque d'un `deploy` global
n'est pas qu'il reprenne les deux annulées (elles sont rejouables, mesuré). Il
est double, et les deux sont démontrés :

1. au **premier** essai il passerait (le registre est absent) ;
2. au **second** essai — après un échec plus loin — il retombe sur
   `20261028120000`, **casse**, et n'essaie **jamais** les cinq suivantes, dont
   les deux correctifs.

C'est ce qui justifie l'application **une par une**, un lot = un effet mesurable,
et jamais un `deploy` global sur `Primary`.

## D ter. Générateurs réparés (ils mentaient après l'ajout de la migration)

| Fichier | Ce qui était faux | Correction |
|---|---|---|
| `matrice_migrations.mjs` | la nouvelle migration était classée **APPLIQUÉE** (faux) et le total bloquait à 65 | catégorie `NOUVELLE (jamais deployee)`, statut `NON DEPLOYEE`, total **66**, arithmétique `54 + 2 + 9 + 1 = 66` |
| idem | `effets NON PROUVES` comptait la migration neuve | compte sur les **65** concernées par le relevé |
| `plan_reconciliation_migrations.mjs` | même erreur, et la nouvelle comptait comme « attestée » | catégorie propre, action « appliquer seule (jamais déployée) » |
| `test_deploiement_simule.mjs` | `=== 56` en dur | compte **dérivé** + la nouvelle migration simulée après les onze |

Les onze **écarts de dérive** restent **onze** : une migration neuve n'est pas
une dérive, et les confondre était précisément le défaut à corriger.

## E ter. Deux contrôles corrigés — parce qu'ils étaient faux, pas parce qu'ils étaient verts

1. **`test_plm_erp_convergence_chaine`** exigeait que *chaque ligne* citant un
   nom de politique soit un `DROP`. Or la `20261029150000` cite ces noms dans un
   `WHERE policyname IN (...)` de vérification : le contrôle condamnait une
   lecture de catalogue légitime et poussait à ne plus rien vérifier. Remplacé
   par : aucune instruction citante ne peut **créer, altérer, accorder ou
   révoquer** — **3 témoins** injectés (dont un `CREATE POLICY` dans un bloc
   `DO`) sont détectés, et une lecture de catalogue ne l'est pas.
2. **`test_plm_erp_confrontation_politiques`** : sa section 6 affirmait « la
   politique inattendue survit ». C'était vrai, et c'est devenu **faux** avec le
   garde du chef de chantier. L'assertion dit désormais le **nouveau contrat** :
   refus motivé, **rien n'est supprimé**, les 5 politiques sont encore là, la
   surnuméraire est intacte. **57 vérifications.**

Aucune assertion n'a été affaiblie : elles décrivent le contrat tel qu'il est
aujourd'hui, et elles échouent si ce contrat change sans être vu.

## F ter. Tests et CI

| Élément | Valeur |
|---|---|
| Batterie autonome | **28/28 suites vertes** |
| `test:plm-rls-isolation` | 43 |
| `test:plm-confrontation` | 57 |
| `test:plm-lecture-seule` | 33 |
| `test:plm-migrations-jumelles` | **38** |
| `test:application-une-par-une` | **20** |
| `matrice:migrations` | 66 = 54 + 2 + 9 + 1 |
| `plan:reconciliation` + autotest | exit 0, 7/7 témoins |

---

# Tour du 29/10 (fin) — la branche a encore avancé, et une CI a été annulée

## G ter. Deux commits de plus, et une CI `cancelled`

Pendant mon run CI, deux commits ont été poussés (`48acde2`, `7e98148`). La CI
`40887385904` sur `a5a0e46` a été **annulée par concurrence**, pas échouée : un
run plus récent a pris la main. **Je ne compte pas une annulation comme un
succès** — elle ne prouve rien.

## H ter. Trois migrations pour un seul correctif

| Migration | Gardes | Comportement mesuré sur un état dégradé |
|---|---|---|
| `20261028150000_reconcile_plm_erp_sync_job_policies` | **avant** + comptage des politiques | **refuse** et ne supprime rien |
| `20261029150000_plm_sync_jobs_policy_alignment` | vérification **après**, transactionnelle | refuse (les DROP sont annulés), mais **ne compte pas** |
| `20261029160000_plm_erp_sync_jobs_policy_drift` | **aucun** | **passe quand une canonique manque** et laisse 1 politique |

`npm run test:plm-migrations-jumelles` — **54 vérifications** sur les trois :

- les trois corrigent bien l'état réel (4 → 2), dans les deux variantes de la
  surnuméraire, et **laissent les canoniques intactes** (définitions identiques) ;
- les trois sont idempotentes et s'enchaînent sans dommage (les suivantes sont
  des no-ops) ;
- avec une **5ᵉ politique inattendue** : seule la `20261028150000` refuse ; les
  deux autres passent et laissent 3 politiques ;
- avec une **canonique absente** : les deux premières refusent, la
  `20261029160000` **réussit** et laisse la table avec une seule politique.

Ce n'est pas un jugement de valeur sur le travail du chef de chantier : c'est ce
que la mesure dit. **Trois fichiers pour un `DROP`, et la garantie dépend de
celui qui s'exécute.** Un seul devrait rester — le plus gardé est le plus sûr —
mais le choix ne m'appartient pas.

## I ter. Un test rouge que personne ne voyait

`scripts/test_plm_sync_policy_drift.mjs` existe dans le dépôt mais n'était
**câblé ni dans `package.json` ni dans `ci.yml`** : il ne s'exécutait jamais. Et
il était **rouge sur sa propre migration**, parce que son détecteur
`\b(GRANT|REVOKE)\b` lisait aussi les commentaires — le commentaire de la
migration dit « Aucun GRANT/REVOKE ».

Corrigé en neutralisant les commentaires **pour les seuls contrôles d'absence**
(les contrôles de présence gardent le texte entier), avec **deux témoins** qui
vérifient que le détecteur voit encore un vrai `GRANT` et ignore une mention en
commentaire. Puis **câblé** dans `package.json` et dans la CI.

## J ter. Générateurs : le total ne se fige plus

Le total figé (65, puis 66) cassait à chaque migration ajoutée — un contrôle qui
signale une livraison normale finit par être ignoré. Le total est désormais
**dérivé**, et ce qui reste figé, ce sont les **faits de production** : 11 écarts,
5 hors bande, 2 annulées. La catégorie « nouvelle » est elle aussi **dérivée**
(toute migration postérieure au relevé, hors écarts) au lieu d'être recopiée.

État courant : **67 migrations = 49 attestées + 5 hors bande + 2 annulées + 9
absentes + 2 nouvelles**.

## K ter. Tests, après les deux commits du chef de chantier

| Suite | Vérifications |
|---|---|
| Batterie autonome | **29/29 suites vertes** |
| `test:plm-migrations-jumelles` | **54** |
| `test:plm-sync-policy-drift` | **10** (câblé pour la première fois) |
| `test:application-une-par-une` | 20 |
| `test:plm-confrontation` | 57 |
| `test:plm-rls-isolation` | 43 |
| `test:plm-lecture-seule` | 33 |
| `matrice:migrations` | 67 = 54 + 2 + 9 + 2 |

## L ter. Ce qui reste à décider (chef de chantier)

1. **Une seule** des trois migrations jumelles, ou la plus faible dotée des mêmes
   gardes.
2. Exécuter le relevé `2026-10-29-plm-politiques-lecture-seule.sql` : il donne le
   prédicat exact de `select_brand`, seule donnée encore supposée.
3. Le plan de réconciliation : application **une par une**, jamais un `deploy`
   global.
