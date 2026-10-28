# Mission finale — rapport de clôture

**Dépôt** : `Huberaya/Tracefab` · **PR** #102 « DPP marque : lever les cinq
verrous jusqu'au passeport public » · **Branche** `arena/c27ddaa4-tracefab`
(aucun force-push, aucun merge, Draft conservé, aucun déploiement).

Rien n'a été exécuté en production : ni migration, ni `GRANT`, ni `REVOKE`, ni
`resolve`. Les seules actions sur la production sont des **lectures** faites par
l'opérateur les jours précédents, citées comme telles.

---

## A. SHA de départ et SHA final

| | |
|---|---|
| SHA de départ réel | **`4aab56c`** (et non `508caef` : huit commits s'étaient ajoutés) |
| Commits de la session | `9208391` · `978c761` · `5b989b7` · `a5b6189` · `7f03ba9` |
| **SHA final** | **`4b7f06c`** — CI verte, PR `CLEAN` |
| `main` (base de la PR) | `bf55f2ae6534cde84d072d9b975520216c7b6d4e` |

**La tête de branche avait changé.** Huit commits de l'utilisateur, tous lus
avant d'agir, portaient sur le même sujet. Le travail concurrent a été
**conservé**, pas réécrit : c'est sa migration de réconciliation que j'ai
gardée.

---

## B. Corrections réellement appliquées

### B.1 Ce qui bloquait la CI (`9208391`)

La CI était **en échec** sur `4aab56c` (run `40778270995`, job *Socle*, étape
28), sur `test:migrations:horodatages` : **trois migrations** pour un seul
correctif, dont **deux de préfixe identique** `20261028150000`.

| Migration | Décision | Pourquoi |
|---|---|---|
| `20261028150000_plm_erp_policy_convergence` (la mienne) | **retirée** | collision de préfixe ; gardait moins que l'autre |
| `20261028150000_reconcile_plm_erp_sync_job_policies` | **gardée** | gardes *fail-closed* : table + 2 politiques canoniques + conformité du `WITH CHECK`, refus **avant** tout `DROP` |
| `20261028230000_…_policy_deduplication` | **retirée** | redondance **mesurée** (chaîne complète avec/sans → catalogue identique) **et inatteignable** : `reconcile` échoue avant elle |

Deux tests étaient rouges pour une raison qui n'était pas celle qu'ils
annonçaient (`test_plm_sync_job_policy_reconciliation` 9/11 → **12/12**) :
`^BEGIN;` butait sur l'en-tête de commentaires, et le contrôle
« GRANT/REVOKE » matchait la phrase « Aucun GRANT/REVOKE ». Le test analyse
désormais le **code** (commentaires retirés) — le contrôle n'est pas affaibli,
il est rendu exact, et une assertion prouve qu'un commentaire ne le trompe plus.

### B.2 Ce qui manquait (`978c761`)

**1. Le sens des appartenances — et l'intuition était fausse.**
`scripts/test_appartenances_roles.mjs` (16 vérifications) mesure sur PostgreSQL
réel :

- les **attributs** de rôle (`SUPERUSER`, `BYPASSRLS`, `CREATEROLE`, `CREATEDB`)
  **ne s'héritent pas** ; seuls les privilèges sur les objets s'héritent. Être
  membre de `neondb_owner` **ne donne donc pas** `BYPASSRLS` par héritage
  (mesuré : 1 ligne visible, la RLS tient) ;
- mais l'appartenance autorise **`SET ROLE neondb_owner`**, qui endosse le rôle
  **et son attribut** (mesuré : 2 lignes, la RLS tombe) ;
- `inherit_option = false` coupe l'héritage des privilèges **et laisse
  `SET ROLE` ouvert** : ce n'est pas un garde-fou ;
- `pg_has_role(x, y, 'MEMBER')` ignore les options, `'USAGE'` les respecte.

**2. Le SQL de production est joué avant d'être collé.**
`docs/security/2026-10-28-appartenances-roles-production.sql` (lecture seule,
sortie à une colonne) est exécuté par
`scripts/test_appartenances_sql_production.mjs` (20 vérifications) sur une base
jetable, et le test **fait varier le sens de l'appartenance** : trois états,
trois verdicts différents. Deux erreurs du document ont été trouvées ainsi :

- Q1 annonçait « 3 lignes » alors que `pg_auth_members` n'énumère que les arêtes
  **existantes** — 0 ligne est un résultat, pas une lecture incomplète. Une
  attente fausse aurait fait passer un état sain pour une mesure ratée ;
- `format('%s', true)` rend `t`, pas `true` : la sortie n'était pas comparable.

**3. `contributor` refusé — prouvé par écriture, pas par lecture du nom.**
La règle métier vient du **code** : `api/_routes/catalog/import/products.ts`
n'a **aucun contrôle de rôle**, `bulk-importer.ts:223` écrit le job dans un
`try/catch` silencieux à seule fin de piste d'audit. La **RLS est donc la seule
frontière d'autorisation** : un `contributor` qui peut insérer peut lancer un
import de catalogue.

`scripts/test_plm_sync_jobs_acces.mjs` (19 vérifications) mesure quatre états :

| État | Résultat mesuré |
|---|---|
| socle canonique | owner/admin/manager **acceptés** ; contributor et viewer **refusés** (42501) |
| le refus vient bien de la politique | contributor **lit** la table — donc ni le `GRANT` ni le schéma ne l'expliquent |
| dérive de production (4 politiques) | contributor **RÉUSSIT** à insérer — la fuite n'était pas théorique ; les jobs de B deviennent visibles depuis A |
| fichier de réconciliation appliqué | contributor **refusé** ; 2 politiques ; owner et manager fonctionnent toujours ; B invisible depuis A |
| isolation | un uuid d'organisation **fourni par le client** ne permet ni d'écrire ni de lire chez l'autre locataire, dans les deux sens |

**4. La matrice des 65 migrations, recalculée** — voir §E.

**5. Une collision de préfixe réapparue, puis refermée — sans réécrire le travail d'autrui.**

Pendant que la CI tournait sur `978c761`, le commit `963a524` de l'utilisateur a
ajouté `20261028150000_plm_erp_gs1_policy_drift_repair` — **le préfixe que
`9208391` venait de libérer**, en collision avec la réconciliation. L'étape 28
de la CI (*Socle*, `test:migrations:horodatages`) échouait de nouveau.

J'ai renommé cette migration en `20261028230000_…`, **contenu inchangé au
caractère près** (vérifié par `diff`). Ce renommage était licite **parce que la
migration n'avait jamais été appliquée** : poussée moins d'une heure avant,
postérieure à la dernière lecture de production, absente de
`_prisma_migrations`. Renommer une migration **appliquée** aurait été une
falsification, et n'a pas été fait.

**L'utilisateur l'a ensuite supprimée** (`88758ce`, « Remove duplicate unsafe
PLM policy repair migration »). Cette décision est la bonne, et pour une raison
de fond que je n'avais pas mise en avant : cette migration **DROPait puis
RECRÉAIT** les politiques canoniques *sans aucune garde* — sur une base où une
canonique manquerait, elle l'aurait recréée sans le dire, **masquant la dérive
au lieu de la signaler**. La réconciliation, elle, **échoue avant de toucher à
quoi que ce soit**. Il reste donc **une** migration, et c'est la *fail-closed*.

Deux tests ont suivi ces mouvements, sans être affaiblis :

- `test_deploiement_simule.mjs` : la liste des écarts et le nombre de migrations
  bloquées par l'échec injecté sur `…120000` sont revenus à 11 et 5, avec le
  calcul écrit en commentaire (65 − 11 + 2 = 56) plutôt qu'un nombre nu.
- `test_plm_erp_convergence_chaine.mjs` : l'assertion « la réconciliation est la
  dernière migration de la chaîne » était une **photographie du dépôt**, pas une
  propriété de sécurité — elle cassait dès qu'une migration était ajoutée
  après. Remplacée par trois contrôles **plus précis** : aucune autre migration
  ne **crée** les politiques dérivées ; celles qui les nomment ne font que les
  **retirer** ; aucune migration postérieure ne crée de politique permissive sur
  la table. 26 → **27 vérifications**.

**6. Deux défauts du vérificateur de confrontation** — voir §D.

---

## C. Tests : PASS / FAIL / NON EXÉCUTÉ

Environnement : Node **20.20.2** (la version de la CI), PostgreSQL **18.6**
via PGlite.

| Test | Résultat | Ce qu'il prouve réellement |
|---|---|---|
| `test_plm_erp_convergence_chaine.mjs` | **PASS 27/27** | catalogue final = référence (nom, `polcmd`, `USING`, `WITH CHECK`, absence de `contributor`, SELECT borné au tenant) |
| `test_plm_sync_job_policy_reconciliation.mjs` | **PASS 12/12** | la migration échoue *fail-closed* et n'analyse que du code |
| `test_plm_sync_jobs_acces.mjs` | **PASS 19/19** | refus de `contributor` et isolation, par écriture réelle |
| `test_appartenances_roles.mjs` | **PASS 16/16** | sens des appartenances, héritage vs `SET ROLE` |
| `test_appartenances_sql_production.mjs` | **PASS 20/20** | le SQL de prod s'exécute et tranche |
| `matrice_migrations.mjs` | **PASS** | 65 = 54 + 2 + 9 ; aucun 5ᵉ préfixe double |
| `test_verifier_confrontation.mjs` | **PASS 40/40** | 12 falsifications refusées, dont 2 nouvelles |
| `test_sondes_effets_pglite.mjs` | **PASS 17/17** | chaque sonde change quand on retire sa migration |
| `test_deploiement_simule.mjs` | **PASS 11/11** | le point de rupture du déploiement est identifié |
| `test_reconciliation_options.mjs` | **PASS 12/12** | les deux options comparées, sans réécrire l'historique |
| `test_rejeu_migrations.mjs` | **PASS 4/4** | une migration livrée refuse le rejeu |
| `test_controle_migrations.mjs` | **PASS 8/8** | le contrôle d'horodatages est éprouvé **en échec** aussi |
| `verifier-horodatages-migrations.mjs` | **PASS** | aucune duplication nouvelle |
| `test_divergences_migrations_pglite.mjs` | **PASS** | divergences qualifiées par exécution |
| `test_migrations_hors_bande_pglite.mjs` | **PASS** | les deux chemins produisent le même schéma |
| `test_registre_fonctions_runtime.mjs` | **PASS** | registre cohérent, périmètre hérité préservé |
| **`test_privileges_role_app.mjs`** | **NON EXÉCUTÉ** | exige un serveur PostgreSQL ; absent de cet environnement |
| **`test_isolation_lignes_reelles.mjs`** | **NON EXÉCUTÉ** | idem |
| `audit:privileges`, `test:neon:*` (suite DB) | **NON EXÉCUTÉ ici** | exécutés par le job CI à service `postgres:17` |

`test_privileges_role_app.mjs` est désormais **branché dans la CI** (il ne
l'était pas) : c'était un contrôle essentiel — privilèges minimaux du rôle
applicatif, éprouvés par tentative d'écriture — silencieusement hors circuit.
`test_isolation_lignes_reelles.mjs` reste hors CI : le job exécute déjà
`test:neon:rls` (`test_rls_isolation.mjs`) sur lignes réelles après seed. C'est
une **redondance non branchée**, signalée et non corrigée.

---

## D. Confrontation du catalogue

Le vérificateur rejoue les **65 migrations** sur une base jetable pour
construire le référentiel, exécute **la même requête** des deux côtés et
compare sans écrasement de clés (les doublons sont remontés, pas absorbés).

**Référentiel : 85 faits** — 14 tables, 31 politiques, 14 fonctions, 7 lignes
d'historique, 19 faits de rôles et privilèges.

**Deux défauts corrigés dans la lecture elle-même :**

1. La ligne d'appartenance écrivait `herite=` à partir de `rolinherit` du rôle
   **accordé**, et non de `inherit_option` de **l'appartenance**. Les deux
   diffèrent : `GRANT neondb_owner TO tracefab_app WITH INHERIT FALSE` laisse
   `neondb_owner.rolinherit = true` et pose `am.inherit_option = false`. Le
   vérificateur affichait donc « herite=oui » sur une appartenance dont
   l'héritage était **coupé** — précisément le cas que je venais de mesurer
   comme non protecteur.
2. Le sens **inverse** (`neondb_owner` membre de `tracefab_app`) n'était **pas
   lu du tout** : angle mort total.

Les options (`admin`, `inherit`, `set`) sont lues sur la ligne d'appartenance
via `to_jsonb`, pour rester lisible en deçà de PostgreSQL 16 (la sortie dit
alors `n/a`, qui est un état **à qualifier**, jamais un « identique »).

**Preuve par mutation** : 40/40. Une arête d'appartenance ajoutée, une arête
posée dans le **sens inverse**, un changement d'options, un `BYPASSRLS`
accordé, un `SUPERUSER` accordé, une écriture rendue sur `documents` ou sur une
table cible, une politique fantôme, une ligne dupliquée à l'identique, une
ligne dupliquée **avec une valeur différente** (l'écrasement silencieux est
interdit), une ligne mal formée, un genre inconnu, une fonction passée en
`SECURITY INVOKER`, un `EXECUTE` ouvert à `PUBLIC`, un historique remis à zéro :
chacune provoque un échec. Et le rendu conforme, à espaces et casts près, est
**accepté** (sinon l'instrument serait inutilisable).

---

## E. Migrations manquantes ou annulées

**Recalculé, non repris : 65 migrations** = **54 appliquées** (dont **5 hors
bande**) + **2 annulées** (`rolled_back_at`) + **9 absentes**. Arithmétique
fermée par le script, qui échoue sinon.

Détail complet dans `docs/security/2026-10-28-matrice-migrations-etat-final.md`
(généré par `npm run matrice:migrations -- --markdown`).

**Trois points que le décompte seul ne dit pas :**

1. **`applied_steps_count = 0` ≠ SQL jamais exécuté.** Les cinq migrations hors
   bande ont été exécutées par un lanceur du dépôt (`apply_migration_chantier6_passport.mjs`
   et consorts), puis marquées par `resolve --applied`. Les **douze tables
   existent** en production. Ce qui reste non prouvé : l'**équivalence** du
   schéma produit hors Prisma.
2. **`20261028120000` n'est pas rejouable** (`CREATE TABLE` sans
   `IF NOT EXISTS`) et c'est un **prérequis** de `…120100`. Si le déploiement
   s'arrête là, la reprise est `resolve --applied` **sur constat du catalogue**,
   jamais `--rolled-back`. Les cinq migrations aval sont nommées dans la matrice.
3. **57 lignes sur 65 sont `NON PROUVÉ`** en effets observés. Elles ne sont pas
   conformes : elles ne sont **pas lues**.

**Ordre de remédiation** proposé (aucune étape exécutée) : relever le catalogue
→ trancher le sens des appartenances → `…120000` **seule** → `resolve` si et
seulement si l'objet existe → `…120100/120200/130000/140000` → `…150000`
(PLM) → relever et confronter. Le risque le plus élevé est `…120200`, qui
**retire** l'écriture sur `documents` : une route qui écrit encore directement
casse **silencieusement**.

`prisma migrate deploy` global reste **exclu** : il appliquerait les onze d'un
coup, y compris `…140000`, qui est une décision séparée.

---

## F. État des rôles, privilèges et RLS

| Fait | Nature |
|---|---|
| `tracefab_app` : `NOSUPERUSER`, `NOBYPASSRLS`, `INHERIT` | lecture production |
| `neondb_owner`, `neon_service` : `BYPASSRLS` + `CREATEROLE` + `CREATEDB` | lecture production |
| **2 appartenances** `neondb_owner` ↔ `tracefab_app`, options différentes | lecture production |
| **le sens réel n'est PAS établi** | **À OBTENIR** — requête fournie, non exécutée |
| héritage ≠ `SET ROLE` : le danger passe par `SET ROLE` | **mesuré** (base jetable, 16 vérifications) |
| `contributor` ne doit pas insérer ; owner/admin/manager si | **mesuré** (19 vérifications) |
| pas de `REVOKE` préparé à l'aveugle | décision : les appartenances de `neondb_owner` sont **fournisseur**, pas applicatives |

**Ce que la production doit encore répondre** (§G du blocage) :
`docs/security/2026-10-28-appartenances-roles-production.sql`. Q2 rend deux
lignes ; si `tracefab_app_vers_neondb_owner` affiche `membre=true`, alors
`setrole_possible=true` très probablement, et la RLS est **contournable** — ce
serait le constat le plus grave du chantier. **Aucune révocation n'est proposée
avant cette lecture** : révoquer une appartenance fournisseur à l'aveugle peut
casser la connexion de l'application.

---

## G. CI exacte et conflits

| Run | SHA | Résultat |
|---|---|---|
| `40778270995` (Socle) | `4aab56c` — **départ** | **échec**, étape 28 : duplication `20261028150000` |
| `40784257315` | `7f03ba9` | **échec** — une seule suite : `test:sql-errors` |
| `40786338140` (Chaîne 34/36/41) | `4b7f06c` | **succès** |
| **`40786338281`** | **`4b7f06c` — final** | **succès, 5 jobs sur 5** |

```
Socle — types, compilation, isolation        => success
Parcours — navigateur reel                   => success
Base — isolation RLS executee                => success
Verification — suite de tests                => success
Chaîne 34/36/41 sur Postgres 17 jetable      => success
```

**État de la PR #102** : `draft = true`, `mergeable = MERGEABLE`,
`mergeStateStatus = CLEAN`, tête `4b7f06c`. Aucun conflit avec `main`.

**Aucun déploiement déclenché.** Les workflows du dépôt sont `ci.yml`,
`migrations-34-36-41.yml`, `audit-sql-privileges.yml`, `h1-4-postgres.yml`,
`sondage-preview.yml`, `vercel-log-search.yml` : **aucun job de déploiement**.
Les contrôles « Vercel » et « Vercel Preview Comments » sont des **builds de
prévisualisation** attachés à la PR, pas une mise en production. Aucun
`prisma migrate deploy` n'a été lancé nulle part : les seules exécutions de
migrations sont sur PostgreSQL jetable (service CI et PGlite).

**Trois pannes réelles traversées pendant la session**, toutes corrigées et
aucune contournée :

1. **Étape 28, duplication `20261028150000`** — corrigée (`9208391`), puis
   **réapparue** par un commit concurrent, corrigée de nouveau, puis réglée
   définitivement par la suppression de la migration en double côté utilisateur.
2. **`test:sql-errors`** — quatre codes `RAISE EXCEPTION` de la réconciliation
   sans statut HTTP. L'utilisateur les a mappés en `409` (`4b7f06c`). J'avais
   proposé une autre voie (distinguer une garde de bloc `DO` d'une garde de
   fonction) ; **je ne l'ai pas imposée** : la correction de l'utilisateur est
   suffisante et le test passe. Une seule solution, pas deux.
3. **Un `git mv` incomplet** de ma part a laissé le dossier d'origine en place :
   détecté par le contrôle d'horodatages lui-même (`duplications NOUVELLES : 1`),
   corrigé en `a5b6189` avec vérification `diff` du contenu.

## H. Risques résiduels et preuves manquantes

| # | Manque | Nature | Ce qu'il faut pour le lever |
|---|---|---|---|
| 1 | **Sens des appartenances en production** | inconnu | coller `…appartenances-roles-production.sql` (Q1-Q4), branche `Primary` ; Q2 doit rendre 2 lignes |
| 2 | Effets de 57 migrations | non prouvés | `…tour30-A-confrontation-lecture-seule.sql` puis `verifier_confrontation_production.mjs` |
| 3 | Trois empreintes divergentes (tour 28) | non résolues | revue humaine des diffs, pas une migration |
| 4 | `test_privileges_role_app` | non exécuté ici | il tourne en CI (nouveau) |
| 5 | `test_isolation_lignes_reelles` | non branché | redondant avec `test:neon:rls` ; décision à prendre |
| 6 | `…140000` | décision séparée | accord explicite distinct |
| 7 | Équivalence du schéma hors bande | non prouvée | contrôle ciblé, non bloquant |

**Aucun de ces manques n'a été transformé en `PASS`.**

---

## I. Verdict

### **PRÊTE À SOUMETTRE À VALIDATION** — pour le code et la CI.

Ce qui le justifie, et qui est **mesuré sur le SHA `4b7f06c`** :

- CI **verte, 5 jobs sur 5**, sans exclusion ajoutée ni test neutralisé ;
- la règle métier « `contributor` ne crée pas de job de synchro » est **prouvée
  par écriture réelle**, dans les trois états (canonique, dérive, corrigé),
  avec l'isolation entre deux organisations testée y compris par identifiant
  fourni par le client ;
- la correction PLM est **une seule** migration, *fail-closed*, et le catalogue
  final est comparé à la référence sur la chaîne réelle ;
- le vérificateur de confrontation **mord** : 12 falsifications refusées, dont
  deux nouvelles (sens inverse d'appartenance, changement d'options) ;
- le décompte des migrations est **recalculé**, pas recopié : 65 = 54 + 2 + 9.

**Ce que ce verdict ne dit pas.** Il ne dit pas que la production est conforme :
3 preuves de production manquent (§H, lignes 1 à 3) et une décision
(`…140000`) reste à prendre séparément. Ces points **n'empêchent pas** de
soumettre la PR à validation ; ils empêchent de **déployer**. Les confondre
serait l'erreur qui a coûté le plus cher dans ce chantier.

### Ce qu'il reste à faire, dans l'ordre, et par qui

1. **Vous** — coller `docs/security/2026-10-28-appartenances-roles-production.sql`
   (Q1 à Q4) sur `Primary`. Q2 doit rendre **2 lignes**. C'est le seul point
   encore capable de changer la conclusion sécurité.
2. **Vous** — relever le catalogue avec
   `docs/security/2026-10-28-tour30-A-confrontation-lecture-seule.sql`, puis
   `node scripts/verifier_confrontation_production.mjs <sortie>` : 85 faits
   attendus, 0 divergence espérée sur `plm_erp_sync_jobs` **après** application
   du correctif.
3. **Vous** — décider du sort de `20261028140000` (décision séparée, pas de
   `deploy` global).
4. **Personne, tant que 1 à 3 ne sont pas faits** — aucune migration en
   production, aucune révocation d'appartenance, aucun retrait du Draft.

### Ce qui, de mon côté, n'est pas prouvé

`test_privileges_role_app.mjs` et `test_isolation_lignes_reelles.mjs` **n'ont
pas tourné dans cet environnement** (pas de serveur PostgreSQL). Le premier
tourne désormais en CI et **y est vert** ; le second reste hors CI (redondant
avec `test:neon:rls`, qui tourne et est vert). Je ne les compte donc pas comme
preuves — je les nomme.
