# Réconcilier les onze migrations — stratégie, sans réécrire l'historique

**Décision de départ** : la PR #102 **n'est pas fusionnée**, et aucune migration
n'est appliquée en production. Ce document décrit **comment** on y arrivera,
pas ce qui a été fait. **Aucune étape n'a été exécutée.**

---

## 1. Ce que les lectures du 29/10 établissent, et ce qu'elles ne disent pas

| Fait | Niveau | Nature |
|---|---|---|
| `tracefab_runtime_function_registry` **absente** | (b) catalogue | **mesuré** |
| Rôle `tracefab_worker` **absent**, 0 politique sur `current_user` | (b) catalogue | **mesuré** |
| `tracefab_app` peut écrire `documents.status` | (b) catalogue | **mesuré** |
| Le droit est en fait au niveau **TABLE**, pas colonne | (b) catalogue | **mesuré** (plus large que la lecture initiale) |
| `tracefab_app` peut écrire `tracefab_products.version` | (b) catalogue | **mesuré** |
| 4 politiques PLM au lieu de 2 | (b) catalogue | **mesuré** |
| Les cinq migrations de sécurité **sans ligne** d'historique | (a) historique | **mesuré** |
| Les cinq migrations `…06220000`–`…06260000` : 0 étape, tables présentes | (a) et (b) | **mesuré** |

**Ce que ces lectures ne disent pas** : que les effets sont absents *parce que*
l'historique est incomplet. La coïncidence est frappante, mais une migration
absente de l'historique n'implique pas l'absence d'effets — c'est démontré par
`20261017120000_active_tenant_context`, **marquée annulée** et dont les effets
sont **présents** (déduit de ce que `20261021120000`, attestée, échoue sans
elle).

**Corollaire pratique** : avant d'appliquer quoi que ce soit, il faut savoir
pour chaque migration si ses effets sont là **ou non**. Un `deploy` qui suppose
« tout est absent » s'arrête sur la première migration dont l'objet existe déjà.

---

## 2. Pourquoi `migrate deploy` est gelé, en trois faits mesurés

1. **`20261028120000` n'est pas rejouable.** Elle fait `CREATE TABLE
   tracefab_runtime_function_registry` sans `IF NOT EXISTS`. Or la table est
   absente en production : elle passerait — **une fois**. Si le déploiement
   s'arrête plus loin et qu'on relance, elle échoue et **bloque tout le reste**.
2. **Elle est un prérequis** de `20261028120100`. L'échec n'est donc pas local.
3. **L'échec emporte tout ce qui suit.** Mesuré sur base jetable
   (`test:deploiement-simule`, 11 vérifications) : l'échec injecté sur
   `…120000` bloque **les cinq migrations suivantes**.

Un `deploy` global appliquerait par ailleurs les **onze** d'un coup, y compris
`20261028140000`, qui est une **décision séparée** et ne doit pas partir dans le
même mouvement.

---

## 3. La stratégie retenue : cinq lots, chacun réversible

Le principe : **un lot = un effet qu'on sait mesurer avant et après**. Aucun lot
ne dépend d'un `deploy` global.

### Lot 0 — Validation de la chaîne, sur base jetable (aucun accès production)

| Étape | Commande | Ce que ça prouve |
|---|---|---|
| 0.1 | `npm run test:etat-production-correction` | l'état lu est **reproduit** sur base jetable, puis les 5 correctifs le changent (31 vérifications) |
| 0.2 | `npm run test:deploiement-simule` | point de rupture du déploiement identifié (11) |
| 0.3 | `npm run test:reconciliation-options` | comparaison des deux options de reprise (12) |
| 0.4 | `npm run test:rejeu-migrations` | une migration livrée refuse le rejeu (4) |

**Fait.** Ces quatre suites sont vertes sur la branche.

### Lot 1 — Branche Neon de validation (pas `Primary`)

Créer une **branche enfant** de `production`, y rejouer `deploy` **là seulement**.
Neon : une branche enfant a les **mêmes rôles et mots de passe** que le parent,
et un échec y est sans conséquence.

```
neonctl branches create --name validation-<sha> --parent production
```

Ce que le lot doit produire : soit `deploy` passe **entièrement**, soit il
s'arrête à un endroit **nommé**, et l'état du catalogue à cet endroit est relevé.
Les deux issues sont utiles ; aucune n'est un échec de procédure.

**Bloqué en attente de** : votre accord pour créer la branche, et votre accès
`neonctl` (je n'ai aucun accès à Neon).

### Lot 2 — `20261028120000` seule, sur `Primary`, si et seulement si…

Prérequis cumulatifs :

- le lot 1 a montré que le `deploy` complet passe sur la branche de validation ;
- le catalogue de production a été relevé **juste avant** (script
  `…tour30-A…`), pour comparer avant/après sur les 85 mêmes faits ;
- la table `tracefab_runtime_function_registry` est **absente** au moment du
  relevé (sinon, ne rien faire : la migration échouerait) ;
- accord explicite **distinct** — ce n'est pas couvert par « tu peux corriger ».

Instruction de reprise **si et seulement si** l'objet existe déjà et que
l'historique ne le sait pas :

```sql
-- NE PAS EXÉCUTER SANS CONSTAT PRÉALABLE DE L'OBJET
-- prisma migrate resolve --applied 20261028120000_runtime_function_registry
```

`resolve --rolled-back` est **exclu** : il ferait rejouer un fichier non
rejouable.

### Lot 3 — Les quatre correctifs suivants, dans l'ordre

`…120100` → `…120200` → `…130000` → `…140000`.

**Le risque le plus élevé de toute la séquence est `…120200`** : elle **retire**
`INSERT/UPDATE/DELETE` sur `documents`. Une route applicative qui écrit encore
directement dans `documents` casse **silencieusement**. Le catalogue dit ce que
le rôle *peut* ; il ne dit pas ce que l'application *fait*. Seuls les tests
d'intégration et le parcours navigateur couvrent ce point — et ils tournent sur
base jetable, pas sur les données réelles.

**Contrôle avant** : `…2026-10-29-etendue-champs-reserves…sql` (Q2 : 53 colonnes
écrivables dans l'état lu).
**Contrôle après attendu** : Q3 = `documents_status=non|products_version=non`,
Q4 = `role=present|registre=present|fonctions=6|politiques_current_user=11`.

### Lot 4 — `20261028150000_reconcile_plm_erp_sync_job_policies`

Indépendante des correctifs de sécurité. Elle est *fail-closed* : elle **refuse**
de détruire si la base ne ressemble pas à celle attendue. Sur un état à
4 politiques, elle passe et laisse 2 — mesuré (27 vérifications).
Provenance des 2 surnuméraires : **hors dépôt**, aucun déploiement ne les
recrée (12 vérifications).

---

## 4. Ce qu'on ne fera pas

| Interdit | Pourquoi |
|---|---|
| Modifier une migration déjà appliquée | falsifie l'historique et laisse les bases divergentes |
| `UPDATE`/`DELETE` sur `_prisma_migrations` | même raison, en pire : plus aucune preuve |
| `resolve --rolled-back` sur `…120000` | ferait rejouer un fichier non rejouable |
| `prisma migrate deploy` global sur `Primary` en une fois | applique les onze, dont une décision séparée, et s'arrête au milieu sans reprise possible |
| Révocation d'appartenance à l'aveugle | deux octrois existent (grantors différents) ; une révocation partielle ne retire rien et **affiche « révoqué »** |
| Retirer `BYPASSRLS` à `neondb_owner` | c'est le compte fournisseur, pas un rôle applicatif |

---

## 5. Ce qui doit être relu avant chaque lot

Sur `Primary`, **en transaction explicitement en lecture seule** — la série du
29/10 a rendu `transaction_read_only = off`, ce qui n'a rien écrit mais
n'empêchait rien :

```sql
BEGIN READ ONLY;
SELECT current_setting('transaction_read_only') AS ligne;   -- doit rendre « on »
-- … les requêtes de relevé …
COMMIT;
```

Trois scripts, dans cet ordre :

1. `docs/security/2026-10-29-etendue-champs-reserves-lecture-seule.sql`
   (Q0 vérifie le mode, Q1-Q5 l'étendue et l'identité worker) ;
2. `docs/security/2026-10-28-privileges-effectifs-production.sql`
   (Q2 : un rôle `BYPASSRLS` est-il atteignable par `SET ROLE` ?) ;
3. `docs/security/2026-10-28-tour30-A-confrontation-lecture-seule.sql`
   (85 faits, comparables automatiquement).

Chacun est **joué** par un test avant d'être collé : ils ne sont pas relus à
l'œil, ils sont exécutés sur base jetable, y compris dans un état dégradé.

---

## 6. État exact de la décision

| Question | Réponse |
|---|---|
| La PR est-elle techniquement prête ? | **Oui** pour le code : CI verte, 5 jobs, aucun test neutralisé |
| Les écarts P0/P1 sont-ils corrigés ? | **Oui dans le dépôt**, **non en production** |
| Peut-on fusionner maintenant ? | **Non** — votre lecture le dit, et je la suis |
| Peut-on déployer maintenant ? | **Non** — lots 1 à 4 non exécutés |
| Qu'est-ce qui débloque la fusion ? | une exécution réussie du lot 1 (branche de validation) |
| Qu'est-ce qui débloque le déploiement ? | lots 1 à 4, avec accord explicite par lot |
