# Tour 25 — incidents reproduits, procédure de reprise prouvée, production intacte

> **CORRECTION (tour 26, 28/10/2026).** Ce document contient une hypothèse qui
> s'est révélée **fausse** : il affirme que le registre absent est la
> « conséquence mécanique d'un historique bloqué » et qu'« une migration non
> terminée empêche `migrate deploy` de poursuivre ». L'export réel de
> `_prisma_migrations` montre l'inverse : **aucune entrée n'est bloquante**, les
> deux entrées « non terminées » sont les deux entrées *annulées* (mêmes
> lignes), et les deux ont été rejouées avec succès. Le registre est absent
> parce que **sept migrations n'ont jamais été déployées**, pas parce que
> l'historique est bloqué. Voir `2026-10-28-tour26-reconciliation-production.md`.
> Le reste du document — reproduction des deux incidents, exigence d'idempotence
> avant `resolve`, plan de reprise — reste valide et a servi à établir le plan
> corrigé.

Branche `arena/c27ddaa4-tracefab`, commit `709f834` + ce tour. Aucune connexion à
la production, aucune écriture distante, aucun secret demandé ni manipulé,
aucune fusion, aucun déploiement.

## 0. État réel de l'ordre de travail

| Étape | État | Motif |
|---|---|---|
| 1 — export de `_prisma_migrations` (lecture seule) | **`BLOCKED`** | Aucun accès de production n'existe dans cet environnement |
| 2 — exécuter le réconciliateur sur l'export | **`BLOCKED`** | Dépend de l'étape 1 |
| 3 — identifier non attestées / divergentes / non terminées | **`BLOCKED`** | Dépend de l'étape 1 |
| 4 — reproduire chaque incident, corriger la procédure, rejouer | **`PASS`** | 27 vérifications, incidents reproduits puis franchis |
| 5 — demander l'autorisation avec un plan de reprise | **préparé** (§5) | Le plan est prouvé ; l'autorisation reste à donner |

Vérification de l'absence d'accès, sans afficher aucune valeur : `DATABASE_URL`,
`TF_RLS_APP_URL`, `PGURL`, `PROD_DATABASE_URL`, `NEON_DATABASE_URL`,
`TF_PRODUCTION_URL` — **toutes absentes** ; aucun `~/.pgpass`, aucun
`~/.pg_service.conf`, aucun `.env`. Je n'ai rien cherché ailleurs : reconstituer
une connexion depuis un nom de branche ou une variable oubliée serait exactement
ce que le mandat interdit.

## 1. Étape 1 — la commande exacte à exécuter, et rien de plus

Trois garanties sont empilées : la transaction est `READ ONLY` (le serveur
refuse toute écriture), la requête ne lit qu'une table d'historique, et elle
n'expose aucun secret.

```sql
BEGIN READ ONLY;
COPY (
  SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count
    FROM public._prisma_migrations
   ORDER BY started_at
) TO STDOUT WITH (FORMAT csv, HEADER true);
ROLLBACK;
```

Variante sans `COPY` (si le client ne le permet pas) :

```sql
BEGIN READ ONLY;
SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count
  FROM public._prisma_migrations
 ORDER BY started_at;
ROLLBACK;
```

Le fichier produit se passe ensuite tel quel à l'outil :

```bash
node scripts/reconcilier-historique-migrations.mjs <export.csv>
```

L'outil **imprime le commit** dont il recalcule les empreintes, et **avertit si
l'arbre de travail est modifié** (les empreintes ne seraient alors pas
reproductibles depuis le commit seul). C'est ce qui rend l'étape 2 — « sur cet
export **et le commit exact** » — vérifiable au lieu d'affirmé.

Ce que l'outil distingue, et qui répond à l'étape 3 : migrations **non
attestées**, **empreintes divergentes** (même nom, contenu différent — le cas
P3018), **non terminées**, **annulées**, **orphelines**.

## 2. Étape 4 — les deux incidents, reproduits puis franchis

Banc : PostgreSQL **18.6** (PGlite 0.5.12), même majeure que Neon. Tout est dans
`scripts/test_reprise_migrations_pglite.mjs` — `npm run test:reprise-migrations`,
27 vérifications, exécuté en CI.

### 2.1 Incident A — refus de privilèges sur le schéma `public`

`20261017120000_active_tenant_context`, jouée par un rôle qui n'a pas `CREATE`
sur `public` :

```
INCIDENT REPRODUIT : 42501  permission denied for schema public
```

C'est **exactement** le message rapporté. Depuis PostgreSQL 15, le schéma
`public` appartient à `pg_database_owner` et `CREATE` a été retiré à `PUBLIC` :
le défaut est dans **le rôle employé**, pas dans la migration.

Mesuré aussi : **la migration refusée n'a rien laissé derrière elle** (aucune
des trois fonctions créée) — le rejeu part donc d'un état propre. Avec le
privilège accordé au rôle, la migration passe, puis se rejoue sans erreur.

### 2.2 Incident B — conflit de signature (P3018 du 15/10/2026)

`20261010120000_publication_explicite`, sur une base où la fonction existe déjà
avec son paramètre `p_org` :

```
INCIDENT REPRODUIT : 42P13  cannot change name of input parameter "p_org"
```

La forme naïve du correctif — `CREATE OR REPLACE` en renommant le paramètre —
est **refusée par PostgreSQL 18** : c'est l'incident d'origine. Le **contenu
actuel du dépôt**, lui, franchit cet état (bloc `DO $pubbrand$` qui relit
`proargnames`), **préserve** le nom de paramètre existant sans `DROP`
destructeur, et se rejoue sans erreur.

Contrôle négatif exécuté : le fichier remis dans sa forme naïve fait échouer le
test (`ECHEC CONTENU DU DEPOT…cannot change name of input parameter`). Le test
mord.

### 2.3 Le point qui décide de la sûreté du plan

`prisma migrate resolve --rolled-back` **ne défait rien**. Il pose
`rolled_back_at` et laisse la base dans l'état où l'échec l'a laissée. Prisma
**ré-exécute ensuite la migration** au déploiement suivant. Si elle n'est pas
rejouable sur son propre résultat partiel, la reprise aggrave l'incident.

C'est pourquoi les deux migrations ont été testées **rejouables** : c'est la
condition de sûreté, pas un confort. La partie 3 le vérifie de bout en bout.

### 2.4 Reprise complète simulée

58 migrations appliquées, cinq manquantes, deux entrées non terminées et deux
annulées — le constat 2 reproduit tel quel (60 entrées, 2 + 2). Le registre
runtime et le rôle worker sont **absents**, constat 3 reproduit.

1. `deploy` est bloqué tant qu'une entrée non terminée subsiste — vérifié ;
2. `resolve --rolled-back` sur les deux entrées — plus aucune entrée bloquante ;
3. `deploy` **ré-exécute** les deux migrations (sans erreur) ;
4. `deploy` applique les cinq manquantes ;
5. postconditions : **table du registre présente, rôle `tracefab_worker`
   présent, registre peuplé, 63 migrations distinctes attestées terminées.**

Un premier passage de ce test a d'ailleurs échoué à 61/63 — parce que j'avais
omis le rejeu des deux migrations abandonnées. C'est le test qui a corrigé le
plan, et c'est précisément le genre d'oubli qui, en production, laisse un
historique à demi réparé.

## 3. Ce que cette reproduction **ne** prouve pas

Elle valide une **procédure**, pas l'état de la production. Elle ne dit pas :

- lesquelles des 63 migrations sont réellement attestées en production ;
- si les empreintes de la production correspondent à ce commit ;
- pourquoi **58** entrées cohabitent avec des échecs aux positions 36 et 47.

Ce dernier point reste une **incohérence ouverte**. Deux lectures possibles, que
seul l'export tranche : application hors bande par un lanceur non-Prisma (le
dépôt en contient), ou résolutions antérieures ayant laissé des lignes
intermédiaires. Je ne construis pas de plan définitif sur une hypothèse.

## 4. Le constat 1 reste inchangé, et c'est délibéré

`neondb_owner` avec `rolbypassrls = true` continue de contourner la RLS en tant
que propriétaire. **Je n'y touche pas**, pour la raison déjà mesurée : sans
`BYPASSRLS`, `20261006160000` se fait refuser par la RLS `FORCE` qu'elle active ;
la réparation exige même une autorité de superutilisateur pour
`ALTER ROLE … NOSUPERUSER`. Sur une base dont l'historique est déjà bloqué,
retirer l'attribut rendrait toute reconstruction impossible.

## 5. Plan de reprise — ce pour quoi l'autorisation sera demandée

**Précondition absolue** : l'export de l'étape 1 réconcilié, empreintes incluses.
Sans lui, aucune des étapes suivantes n'est déclenchée.

| # | Action | Écriture ? | Réversible ? |
|---|---|---|---|
| 0 | Export lecture seule + réconciliation hors ligne | non | — |
| 1 | `prisma migrate resolve --rolled-back` sur les migrations non terminées | **oui**, `_prisma_migrations` | oui : la ligne est horodatée, pas supprimée |
| 2 | `prisma migrate deploy` (ré-exécute les résolues, applique les 5) | **oui**, schéma | partiellement — voir ci-dessous |
| 3 | Vérifier les postconditions (§2.4) | non | — |
| 4 | Ré-exporter, réconcilier à nouveau : attendu 63 attestées, 0 écart | non | — |
| 5 | **Alors seulement** : M6 mesurable, puis M3 tranchable | non | — |

**Risques résiduels du plan, nommés :**

- **Ré-exécution des deux migrations résolues.** Prouvée idempotente sur PG18,
  mais non prouvée sur l'état exact de la production, qui peut être *partiel*
  d'une façon que seul l'export révélera. C'est pourquoi l'étape 0 est
  obligatoire : une empreinte divergente changerait la nature du rejeu.
- **`deploy` applique cinq migrations d'un coup**, dont le registre runtime et
  le durcissement worker — les plus structurantes du dépôt. Elles ont été
  validées sur base reconstruite depuis zéro (tour 23, 63/63) mais **jamais sur
  une base à l'historique partiel**.
- **Aucun retour arrière automatique.** Prisma n'en fournit pas ; les cinq
  migrations n'ont pas de script `down`. Le retour arrière serait une
  reconstruction. C'est acceptable **parce que** la branche de production est
  sauvegardable avant l'opération — à faire, et à vérifier, avant l'étape 1.

**Ce que je demanderai, dans cet ordre, et séparément :**

1. l'autorisation d'**exécuter l'export** (lecture seule) — sans écriture ;
2. après réconciliation, l'autorisation des **étapes 1 à 2** (écriture), avec la
   sauvegarde de branche faite et vérifiée ;
3. **plus tard et séparément**, la question de `BYPASSRLS` — jamais dans la même
   opération.

Aucune de ces trois demandes ne peut être formulée utilement avant l'étape 0 :
demander à modifier la production sans savoir ce qu'elle contient serait
exactement ce que l'ordre de travail interdit.

## 6. Livré dans ce tour

| Fichier | Nature |
|---|---|
| `scripts/test_reprise_migrations_pglite.mjs` | 27 vérifications : incidents reproduits, contenu du dépôt validé, reprise sûre |
| `scripts/reconcilier-historique-migrations.mjs` | + provenance : commit exact, avertissement si arbre modifié |
| `.github/workflows/ci.yml`, `package.json` | `test:reprise-migrations` câblé dans le job *Socle* |

Aucune migration créée ni modifiée, aucun changement de posture.
