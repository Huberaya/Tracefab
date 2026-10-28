# Tour 24 — les trois constats de production : ce qui les explique, ce qui les débloque

Branche `arena/c27ddaa4-tracefab`, PR #102. Aucune fusion, aucun déploiement,
**aucune connexion à la production**, aucune écriture distante, aucun secret
manipulé, aucun force-push. Ce document ne prétend rien mesurer en production :
il distingue systématiquement ce qui est **mesuré ici**, ce qui est **rapporté**
par l'utilisateur, et ce qui reste **`BLOCKED`**.

## 0. Statut des trois constats

| Constat | Origine | Statut dans ce tour |
|---|---|---|
| `neondb_owner` a `rolbypassrls = true`, `rolsuper = false` | **rapporté**, non mesuré ici | cohérent avec M3 ; **ne pas corriger** tant que la chaîne n'est pas réparée |
| `_prisma_migrations` : 58 entrées, 2 non terminées, 2 annulées | **rapporté**, non mesuré ici | diagnostic hors ligne + procédure |
| `tracefab_runtime_function_registry` absente en production | **rapporté**, non mesuré ici | expliqué par le point 2 ; vérifiable hors ligne |

Le troisième constat **découle** des deux premiers. C'est le résultat principal
de ce tour, et il se démontre sans connexion.

## 1. Pourquoi le registre manque : l'ordre des migrations le dit

Les 63 migrations du dépôt, numérotées dans l'ordre où Prisma les applique :

| # | Migration |
|---|---|
| 47 | `20261017120000_active_tenant_context` |
| 48 | `20261017120000_harden_dpp_table_privileges` |
| … | … |
| 59 | `20261027130000_dpp_review_preservation_and_publication_coherence` |
| **60** | **`20261028120000_runtime_function_registry`** |
| 61 | `20261028120100_worker_identity_not_forgeable` |
| 62 | `20261028120200_document_reserved_fields_internal_only` |
| 63 | `20261028130000_product_computed_fields_column_scoped` |

La production annonce **58** entrées pour **63** migrations : il en manque
**cinq**, et ce sont précisément les cinq dernières — dont le registre (#60).
`prisma migrate deploy` s'arrête à la première migration en échec et refuse de
poursuivre tant qu'elle n'est pas résolue. Une migration non terminée en
position 47 **explique à elle seule** que #59 à #63 n'aient jamais été
appliquées, donc que `tracefab_runtime_function_registry` soit absente.

Le registre absent n'est donc **pas une divergence indépendante** : c'est la
conséquence mécanique d'un historique bloqué. Corriger le registre sans débloquer
l'historique serait traiter le symptôme.

### Une incohérence à vérifier, pas à contourner

58 entrées avec un échec en position 47 ne colle pas avec un historique Prisma
linéaire : un arrêt en 47 laisserait environ 47 entrées, pas 58. Deux
explications possibles, et **le relevé doit trancher** :

1. des migrations ont été appliquées hors bande (le dépôt contient un lanceur
   personnalisé, `scripts/run-db-suite.mjs` et `db-deploy-throwaway.mjs`, qui
   **n'est pas** `prisma migrate deploy` et n'écrit pas le même historique) ;
2. des échecs ont été « résolus » par un `migrate resolve` antérieur, laissant
   des lignes dans un état intermédiaire.

Je ne tranche pas à leur place : c'est exactement ce que mesure le bloc 6 du
relevé, et le réconciliateur hors ligne ci-dessous.

## 2. Ce que j'ai construit pour rendre ces constats exploitables sans production

### 2.1 Réconciliation hors ligne — `scripts/reconcilier-historique-migrations.mjs`

Prisma calcule le `checksum` d'une migration comme le **SHA-256 hexadécimal du
contenu de son `migration.sql`** (vérifié dans le paquet installé,
`node_modules/prisma/build/index.js`). Le script recalcule donc les 63 empreintes
du dépôt et les compare à un export de `_prisma_migrations`.

```bash
node scripts/reconcilier-historique-migrations.mjs --sans-export   # empreintes attendues
node scripts/reconcilier-historique-migrations.mjs <export.csv>    # comparaison
```

Il détecte cinq situations, chacune nommée : migrations **non attestées**,
**empreinte divergente**, **non terminées**, **annulées**, **orphelines**. Il ne
se connecte à rien, ne lit aucune variable d'environnement, ne manipule que des
noms de migration et des empreintes — rien de sensible.

**Pourquoi la divergence d'empreinte est le point décisif.** L'échec de
`20261010120000_publication_explicite` est l'incident **P3018 du 15 octobre
2026** (renommage `p_org` → `p_organization_id` rejeté par PostgreSQL 18),
documenté dans `docs/security/h1-4-MODE-OPERATOIRE.md`. Le dépôt contient
**depuis** la version corrigée (bloc `DO $pubbrand$` qui reconstruit la fonction
avec le nom de paramètre existant). Autrement dit : **la production a exécuté un
contenu différent de celui du dépôt, sous le même nom de migration.** Rejouer
naïvement cette migration ne remplacerait pas ce qui a été joué, et
`migrate deploy` ne compare pas les empreintes des migrations déjà enregistrées.
C'est la raison pour laquelle le réconciliateur doit tourner **avant** toute
tentative de déblocage.

Éprouvé dans les deux sens (`npm run test:reconciliation-historique`, 27
vérifications) : export conforme → exit 0 ; migration absente, empreinte
divergente, non terminée, annulée, orpheline → exit 1 avec le nom exact ;
export vide → exit 2 ; export sans en-tête → **ne conclut pas** à la cohérence.
Contrôle négatif exécuté : outil rendu « toujours cohérent » → le test échoue ;
détection des divergences neutralisée → le test échoue.

### 2.2 Relevé M6 étendu — bloc « qui peut appliquer des migrations »

Le refus de privilèges sur le schéma `public` s'explique par PostgreSQL 15+ :
`public` appartient à `pg_database_owner` et `CREATE` a été retiré à `PUBLIC`.
Un rôle qui n'est pas propriétaire de la base **ne peut plus y créer d'objet** —
d'où un `42501` sur une migration par ailleurs correcte. Le bloc 5 bis du relevé
mesure, sans rien modifier : propriétaire de la base et du schéma, ACL du schéma,
et `has_schema_privilege(...,'CREATE')` pour `neondb_owner`, `tracefab_app`,
`tracefab_worker`.

**Conséquence de lecture** : si `peut_creer_dans_public` est faux pour le rôle de
migration, le défaut est dans **le rôle employé**, pas dans la migration. On
corrige le rôle ; on ne réécrit jamais une migration livrée pour contourner un
manque de privilège.

### 2.3 Le relevé est exécutable — `npm run test:diagnostic-m6`

Un script de diagnostic jamais exécuté n'est pas un diagnostic. Les 63 migrations
sont appliquées dans un PostgreSQL 18 WASM (PGlite), un historique **synthétique**
reproduisant exactement deux non-terminées et une annulée est fabriqué, puis le
fichier de relevé est exécuté **en entier** : il passe, chaque bloc rend un
résultat, l'historique est inchangé après coup, et une tentative d'écriture dans
la même transaction `READ ONLY` est **refusée par le serveur**. Contrôle négatif :
une colonne de catalogue volontairement mal nommée fait échouer le test.

Ce que cela ne prouve pas : ce que la production répondra. PGlite n'est pas Neon.

## 3. Le point 1 — ne rien changer, et pourquoi ce n'est pas de la prudence molle

`neondb_owner` avec `rolbypassrls = true` et `rolsuper = false` contourne la RLS
en tant que propriétaire des tables : c'est exactement le blocage M3 déjà
mesuré, et le constat rapporté le confirme.

**Retirer l'attribut aujourd'hui casserait la chaîne de migrations**, mesuré au
tour 23 sur cluster neuf :

| Propriétaire | Résultat |
|---|---|
| superutilisateur | 63/63 |
| `NOSUPERUSER NOBYPASSRLS` | échec `20261006160000` — `42501` RLS FORCE sur `dpp_requirement_profiles` |
| `NOSUPERUSER BYPASSRLS` (+`CREATEROLE`, +`ADMIN`) | échec `20261028120100` — `ALTER ROLE … NOSUPERUSER` réservé au superutilisateur |

Et l'état actuel de la production aggrave le risque : **son historique est déjà
bloqué et cinq migrations ne sont pas appliquées**. Retirer `BYPASSRLS` sur une
base dont la chaîne est incomplète, sans pouvoir la rejouer, rendrait toute
reconstruction future impossible.

**Ordre correct, et il est strict :**

1. relever (bloc 5 bis + bloc 6) et réconcilier hors ligne ;
2. résoudre les deux entrées en échec — opération **d'écriture** sur
   `_prisma_migrations`, donc **jamais** par un `UPDATE` manuel, uniquement par
   `prisma migrate resolve` et **avec votre autorisation explicite** ;
3. appliquer les cinq migrations manquantes, dont le registre ;
4. vérifier que le registre est peuplé et que `tracefab_worker` existe ;
5. **alors seulement**, M6 devient mesurable, et M3 peut être tranché.

Tant que 1 à 4 ne sont pas faits, l'attribut reste. Ce n'est pas une posture
sûre — c'est la seule qui ne dégrade pas davantage.

## 4. Ce que je n'ai pas fait, et pourquoi

| Action | Pourquoi non |
|---|---|
| Se connecter à la production | Aucune connexion explicitement autorisée ; une erreur d'identité serait irréversible |
| `prisma migrate resolve` | Écrit dans `_prisma_migrations` — écriture distante, exige votre autorisation |
| `prisma migrate deploy` | Écriture distante, et **prématuré** tant que l'historique n'est pas réconcilié |
| `UPDATE _prisma_migrations` | Interdit sans exception ; corrompt l'historique |
| Retirer `BYPASSRLS` | Casserait la chaîne (mesuré), et M6 n'est pas établi |
| Modifier les migrations livrées | L'historique ne se réécrit pas ; le correctif P3018 est déjà dans un contenu non appliqué |
| Recréer la table du registre à la main | Traiterait le symptôme et masquerait un historique bloqué |

## 5. Ce qu'il vous reste à autoriser

Trois décisions, dans cet ordre :

1. **Fournir un accès en lecture seule** à la production (rôle de diagnostic
   nommé, jamais la chaîne), pour exécuter le relevé M6 et exporter
   `migration_name, checksum, finished_at, rolled_back_at, applied_steps_count`.
   Sans cela, les trois constats restent des déclarations non mesurées.
2. **Autoriser la résolution de l'historique** une fois la réconciliation faite :
   `prisma migrate resolve --rolled-back` sur les deux migrations en échec, puis
   `migrate deploy`. C'est une écriture sur la production ; je ne l'exécuterai
   qu'avec un accord explicite, et pas avant d'avoir la réconciliation.
3. **Autoriser, séparément, la question de `BYPASSRLS`** — et seulement après
   que la chaîne soit réparée et rejouable.

## 6. Livré dans ce tour

| Fichier | Nature |
|---|---|
| `scripts/reconcilier-historique-migrations.mjs` | réconciliation hors ligne, aucune connexion |
| `scripts/test_reconcilier_historique_migrations.mjs` | 27 vérifications, éprouvé par mutation |
| `scripts/test_diagnostic_m6_executable.mjs` | exécute le relevé sur 63 migrations (PGlite) |
| `docs/security/2026-10-28-m6-lecture-seule.sql` | bloc 5 bis : qui peut migrer, et pourquoi |
| `.github/workflows/ci.yml`, `package.json` | les deux tests câblés dans le job *Socle* |

Aucun changement de posture, aucune migration nouvelle, aucune modification de
migration existante.
