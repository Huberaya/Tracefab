# Clôture du chantier P0 — état, reste à faire, et comment on termine

**Date** : 28 octobre 2026
**Périmètre** : PR #102, dérive `plm_erp_gs1`, cinq migrations hors bande,
remise à niveau de la production.
**Décision à ce jour** : **P0 OUVERT**, mais pour **une seule raison** — la
production n'a pas reçu onze migrations du dépôt. Tout le reste est fait, testé
et prouvé.

---

## 1. En six lignes

1. Le dépôt contient **65 migrations** ; la production en a réellement appliqué
   **54**.
2. **Onze** manquent : deux marquées *annulées* dans l'historique, neuf
   *absentes*.
3. La dérive `plm_erp_sync_jobs` (4 politiques au lieu de 2) est **mesurée en
   production**, et le correctif existe dans le dépôt.
4. **64 faits sur 66** du catalogue de production concordent avec le dépôt —
   sur un référentiel qui vient de passer à **85 faits** avec l'ajout des
   privilèges et de l'héritage des droits (§10 du tour 30).
5. La PR #102 est **fusionnable** (`mergeable=MERGEABLE`, CI verte) — mais elle
   ne corrige pas la production, elle ne fait que la décrire.
6. Terminer demande **deux gestes** : une sonde de lecture, puis une
   application ordonnée. Rien d'autre.

---

## 2. Ce qui est terminé et prouvé

| Contrôle | Preuve | État |
|---|---|---|
| Dérive PLM identifiée en production | confrontation automatique, `FAIL` nommé | **fait** |
| Correctif PLM vérifié sur la chaîne réelle | `test:plm-erp-convergence:chaine`, 19 vérifications | **fait** |
| Correctif `supplier_portal` vérifié | 42 vérifications | **fait** |
| Équivalence des deux chemins d'application (5 migrations hors bande) | 46 vérifications | **fait** |
| Catalogue de production : 14 tables, 33 politiques, 14 fonctions | lecture `Primary`, 68 lignes | **fait** |
| Vérificateur de confrontation étalonné | 25 vérifications, refuse les falsifications | **fait** |
| Sonde d'effet étalonnée | `test:sondes-effets`, 17 vérifications | **fait** |
| Rejouabilité des onze migrations | `test:rejeu-migrations`, 4 vérifications | **fait** |
| CI sur le SHA exact | 4/4 jobs verts | **fait** |

---

## 3. Ce qui reste — et ce n'est pas du travail, c'est une décision et un geste

### 3.1 La sonde d'effet (lecture, aucune écriture)

`docs/security/2026-10-28-tour30-C-sondes-effets.sql` — onze sondes qui
interrogent le catalogue de la production, pas son historique.

**Ce qu'elle tranche** : pour chacune des onze migrations, l'effet est-il
présent ou non. C'est indispensable pour les deux « annulées » : un
`resolve --rolled-back` corrige l'historique, jamais les objets.

### 3.2 L'application — et un piège mesuré

`test:rejeu-migrations` a mesuré, sur la chaîne réelle, ce que produit un second
passage :

| Résultat | Migrations |
|---|---|
| **rejouables** (10/11) | toutes sauf une |
| **casse** (1/11) | `20261028120000_runtime_function_registry` — `CREATE TABLE` sans `IF NOT EXISTS` |

**Conséquence opérationnelle, et c'est le point que personne n'aurait vu
autrement :** si la table `tracefab_runtime_function_registry` existe déjà en
production alors que son historique l'ignore, `migrate deploy` **s'arrête
dessus**, et les **cinq migrations qui viennent après** ne passent pas —
y compris les deux correctifs.

C'est exactement l'état que décrit notre mesure : le dépôt croit cette
migration non appliquée, la production peut très bien la porter.

---

## 4. Le plan de sortie — quatre étapes, dans cet ordre

### Étape 1 — Lire (aucune écriture)

**Deux lectures**, toutes deux en lecture seule, sur `Primary` :

1. **la confrontation étendue** (`2026-10-28-tour30-A-...sql`, 85 faits) — elle
   couvre désormais les privilèges et l'héritage des droits, ce que la
   précédente lecture ne mesurait pas ;
2. **la sonde d'effet** (`2026-10-28-tour30-C-sondes-effets.sql`, 11 sondes) —
   elle dit, pour chacune des onze migrations en écart, si l'effet est présent
   dans les objets.

**Durée** : un `SELECT`. **Risque** : nul.

### Étape 2 — Décider, selon ce que la sonde dit

| Constat de la sonde | Application possible |
|---|---|
| **les onze effets absents** | `migrate deploy` applique les onze dans l'ordre du dépôt. Aucun blocage. |
| **`20261028120000` déjà présent, les autres absents** | `deploy` **échouera** sur cette migration. Il faut d'abord la déclarer appliquée — `resolve --applied`, **avec la sonde comme preuve** — puis `deploy` pour les dix autres. |
| **d'autres effets déjà présents** | même logique, migration par migration : on ne rejoue pas un effet présent sur une migration non rejouable. |
| **les onze présents** | l'historique est faux, la base est à jour. La remise à niveau se réduit à **régulariser l'historique**, sans appliquer de SQL. |

C'est la seule étape qui demande une **autorisation distincte** : jusqu'ici, la
seule écriture autorisée portait sur `20261028140000`.

### Étape 3 — Appliquer, migration par migration, avec vérification après chacune

Le runbook `docs/security/2026-10-28-tour30-B-application-correctif.sql` fournit
le modèle : cinq sondes avant, application, cinq sondes après. Il est écrit pour
`20261028140000` ; il s'applique par répétition aux autres.

**Ordre imposé** : celui des noms, qui est celui des dépendances. `20261027130000`
redéfinit une fonction que `20261027100000` définit — les inverser casserait.

### Étape 4 — Constater

Rejouer les deux lectures déjà faites (confrontation, écarts d'historique) et
exiger :

- `verifier_confrontation_production.mjs` → **`PASS`, 66/66** ;
- la requête du §8.3 → **aucun écart**.

Alors, et alors seulement, la production est à niveau.

---

## 5. La question qui reste, et qui n'est pas technique

La PR #102 est fusionnable. Elle contient :

- deux migrations correctives justes (`20261028140000`, `20261028150000`) ;
- leurs tests, étalonnés et branchés dans la CI ;
- la documentation de tout ce qui précède.

**Mais fusionner ne déploie pas.** Après fusion, la production serait dans
l'état mesuré aujourd'hui : 54/65, dérive PLM active.

Deux façons de clore, également défendables :

| Option | Ce que cela veut dire | Conséquence |
|---|---|---|
| **A — séparer les deux chantiers** | fusionner #102 (elle est correcte et testée), et ouvrir un chantier « remise à niveau production » avec les onze migrations, son plan, son suivi | le code est intégré ; la production reste à faire, mais c'est **tracé et daté** |
| **B — ne rien fusionner avant** | garder #102 ouverte jusqu'à ce que la production soit à niveau | un seul chantier, aucune ambiguïté — mais la PR reste ouverte indéfiniment et son contenu n'est pas intégré |

Mon avis, et je le donne pour ce qu'il vaut : **l'option A est la bonne**, à une
condition non négociable — que le chantier de production soit ouvert **le même
jour**, avec les onze migrations nommées et l'étape 1 comme premier point. Une
fusion qui ferait croire que le P0 est réglé serait pire que l'attente.

---

## 6. Critères de clôture du chantier

Le P0 se ferme quand les quatre sont vrais :

1. la sonde C a été exécutée et ses onze lignes sont consignées ;
2. chaque écart a reçu un sort explicite — appliqué, ou régularisé avec preuve ;
3. la confrontation complète rend **`PASS` 66/66** ;
4. l'historique ne porte plus aucun écart avec le dépôt.

Tant que 1 n'est pas fait, 2, 3 et 4 sont hors d'atteinte — et aucune décision
de fusion ne les rapproche.
