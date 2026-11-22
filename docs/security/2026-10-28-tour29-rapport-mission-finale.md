# Mission finale pré-fusion — TraceFab P0 / PR #102

Branche `arena/c27ddaa4-tracefab`. Aucune connexion de production, aucune
écriture distante, aucun `prisma migrate deploy`, `migrate resolve`, `GRANT` ni
`REVOKE`. PR #102 **ni fusionnée ni fermée**.

## 1. Périmètre et révisions

| | |
|---|---|
| SHA de départ, relevé sur le distant | `8ba7c8b66bc7649d6291147d4c825db679e78257` — **identique** à la révision annoncée |
| SHA de code et de tests, mesuré | `42a3e3e3e18f8ffeeecfcb40cfc31f11f9c31927` — CI **7/7** |
| Commit de documentation suivant | `e5951a14365fb4d2144a58fce0e9484059a75515` — CI **6/6** |
| PR #102 | `OPEN`, draft, `mergeable=MERGEABLE` |

Les commits postérieurs à `42a3e3e` ne touchent que `docs/` : ils ne modifient
ni test, ni migration, ni workflow. Chacun est vérifié séparément, et les
valeurs ci-dessus sont celles effectivement relevées — pas une extrapolation
d'un commit à l'autre.
| Écart de travail | `/home/user/tf-p0`, 0 fichier modifié au départ |

## 2. CI — vérifiée sur le SHA exact, pas sur un ancêtre

Sur `42a3e3e…` : 7 check-runs, **tous `success`**, tous `head_sha = 42a3e3e…` :

| Check | Job |
|---|---|
| Socle — types, compilation, isolation | [122868117012](https://github.com/Huberaya/Tracefab/actions/runs/40703163272/job/122868117012) — **39 étapes, 0 échec, 0 ignorée** |
| Base — isolation RLS executee | 122869108213 |
| Chaîne 34/36/41 sur Postgres 17 jetable | 122868084956 et 122868117453 (deux déclencheurs) |
| Verification — suite de tests | 122869108277 |
| Parcours — navigateur reel | 122869108230 |
| Vercel Preview Comments | 122868752794 |

Les suites de sécurité et de migrations **tournent réellement** sur base jetable,
pas seulement dans `package.json` : le job *Socle* a exécuté, entre autres,
`Couverture du contexte RLS des routes`, `Reconciliation de l historique`,
`Releve M6 executable et inoffensif`, `Correctif supplier_portal`,
`Divergences d empreinte`, `Migrations hors bande`, `Reprise des migrations` —
toutes `success`. Le job *Base* fournit un service `postgres:17` avec un
`DATABASE_URL` en clair (`localhost:5432/tracefab_test`), **aucun `secrets.*`**
dans les tests ; `test:ci-no-production-access` sort `0`.

Le statut `Vercel` est un statut séparé : il n'est compté nulle part comme preuve.

## 3. Fichiers modifiés

| Fichier | Nature |
|---|---|
| `prisma/migrations/20261028140000_supplier_invitation_owner_relationship_scope/migration.sql` | **durci** : contrôle d'appartenance de la relation + contrôle de statut |
| `scripts/test_supplier_invitation_corrective_pglite.mjs` | réécrit : 3 versions, 7 cas, 2 mutations, 37 vérifications |
| `scripts/test_migrations_hors_bande_pglite.mjs` | **nouveau** : deux chemins, deux bases, 46 vérifications |
| `scripts/test_divergences_migrations_pglite.mjs` | référentiel `plm_erp_gs1` étendu à six dimensions + requête de confrontation imprimée |
| `api/_lib/sql-errors.ts` | trois traductions HTTP pour les nouveaux codes |
| `package.json`, `.github/workflows/ci.yml` | nouveau `test:migrations:hors-bande`, branché dans le job *Socle* |
| `docs/security/2026-10-28-tour29-…md`, `…tour28-divergences-…md` | documentation des mesures |

Aucun fichier hors mission. Aucun secret, aucune URL, aucun identifiant dans le
diff — vérifié par recherche avant commit.

## 4. `supplier_portal` — `PASS` hors production, avec une erreur corrigée au tour 30

> **Section corrigée au tour 30.** Ce qui suit remplace une affirmation fausse :
> j'avais écrit que la règle du dépôt ouvrait deux contournements (élévation
> `admin` → `owner`, réutilisation inter-organisations). La mesure sur la chaîne
> **complète** les réfute. Détail : `2026-10-28-tour30-autorisation-et-correction.md`.

### 4.1 La règle réellement en place

Deux déclencheurs gardent `organization_invitations` :

| Déclencheur | Vérifie |
|---|---|
| `invitations_validate_relationship` (initiale, **tire en premier**) | `r.id = NEW.relationship_id AND r.supplier_organization_id = NEW.organization_id` |
| `organization_invitations_validate_role` | le rôle visé |

### 4.2 Ce que le dépôt change vraiment

| Cas | production | dépôt | correctif |
|---|---|---|---|
| onboarding : `owner` + relation fournisseur | **refusé** | accepté | accepté |
| relation **terminée** (`status = 'ended'`) | refusé (tout `owner` l'est) | **accepté** | **refusé** |

**Un seul trou réel** : aucun déclencheur ne regarde le statut de la relation.
Le correctif le ferme, et rend l'onboarding possible.

### 4.3 Mesure — 40 vérifications sur la chaîne complète

Trois versions du **seul corps de fonction** que les migrations changent, tout le
reste étant le schéma réel. Le test retire aussi
`invitations_validate_relationship` pour **attribuer** chaque refus au
déclencheur qui le porte :

- sans lui, la règle du dépôt **laisse passer** `ownerCoteMarque` et
  `relationAutreOrg` ; le correctif les refuse encore ;
- sur la chaîne complète, retirer le contrôle d'appartenance du correctif **ne
  change rien** — c'est une redondance, mesurée et non supposée.

**Contrôles négatifs** : retirer le contrôle de statut fait réaccepter la relation
terminée ; retirer le contrôle d'appartenance **et** l'autre déclencheur rouvre
les deux cas.

**Intégrité** : idempotence, déclencheur unique gardant `tgtype = 23`, fonction
`SECURITY DEFINER` avec `search_path` fixé, aucun `GRANT`/`REVOKE`, aucune
politique touchée, **64/64** migrations, corrective en dernière position.

## 5. `plm_erp_gs1` — `BLOCKED`

Le contenu de production n'a **jamais été retrouvé** (ni dépôt, ni objets Git).
Il est **inconnu**, pas « probablement identique ». Le référentiel du dépôt est
désormais complet — rôles des politiques, `USING`, `WITH CHECK`, propriétaire,
`search_path`, `EXECUTE` de `PUBLIC` et de `tracefab_app`, `rls`/`force_rls` —
et le test **imprime la requête de confrontation** qui fera foi, en lecture
seule, sans appel de fonction applicative.

Constat à ne pas laisser filer : `tracefab_ingest_plm_erp_payload` est
`SECURITY DEFINER`, exécutable par `PUBLIC`, avec `search_path=public`. État
**existant**, non modifié (gel), mais ce n'est pas anodin.

**Preuve manquante, précisément** : une lecture du catalogue de production
politique par politique et fonction par fonction. Sans elle, l'écart
`c944ce0c…` / `330b6689…` reste non qualifié.

## 6. Les cinq migrations hors bande — `PASS` hors production

### 6.1 Fait nouveau

**La chaîne privée des cinq ne s'applique pas.** Rejouée en les sautant : 29
migrations passent, puis

```
20261009180000_public_read_context
42P01  relation "product_pef_assessments" does not exist
```

Une migration ultérieure exige une table que seule `20261006220000_esg_pef_footprint_engine`
crée. Donc `applied_steps_count = 0` **ne peut pas** dire « SQL jamais exécuté » :
« exécuté hors bande » est la seule lecture compatible avec le reste de
l'historique, qui est attesté appliqué.

### 6.2 Équivalence des deux chemins — mesurée, objet par objet

Deux bases jetables, même préfixe de 24 migrations, puis les cinq : chemin
« Prisma » (une transaction par fichier) contre chemin « lanceur » (instruction
par instruction, autocommit, découpeur copié du lanceur). Comparés : colonnes et
types, contraintes, index, politiques RLS (rôle, commande, `USING`, `WITH
CHECK`), déclencheurs, fonctions (`SECURITY DEFINER`, `search_path`,
propriétaire, `EXECUTE` de `tracefab_app` et de `PUBLIC`, ACL), `rls` et
`force_rls`, propriétaires d'objets. **Aucun écart.** Puis les 34 migrations
suivantes, appliquées aux deux : **elles convergent encore**.

### 6.3 La différence réelle

Une instruction en échec ajoutée à la fin d'une **copie** (la migration
versionnée n'est pas touchée) :

| Chemin | Après l'échec |
|---|---|
| transaction par fichier | `0` table créée — tout annulé |
| instruction par instruction | la table **existe déjà** — état partiel |

C'est la seule chose que le chemin hors bande ne garantissait pas. Sur ces
cinq-là, tout a réussi : pas d'état partiel.

### 6.4 Ce qu'elles apportent

186 colonnes, 239 contraintes, 43 index, 25 politiques, 13 fonctions, 12
tables — **aucun objet retiré, aucun objet existant modifié**. Les quatre
modifications d'objets existants viennent de `20261006220000_production_hardening`,
**intercalée** par l'ordre de tri et appliquée dans la bande : `audit_logs` perd
l'écriture de `PUBLIC`, deux tables du catalogue passent en `FORCE RLS`,
`tracefab_notification_outbox` gagne la lecture `PUBLIC`.

Mon premier découpage comptait 24 + 5 + 34 = 63 pour 64 migrations : une
migration intercalée échappait à la partition. Le test vérifie désormais que
`préfixe + intervalle + reste = chaîne entière`.

**Reste hors de portée** : l'état du catalogue de production pour ces douze
tables. L'équivalence prouve que les deux chemins produisent le même schéma
**depuis le dépôt** ; elle ne prouve pas que la production a bien exécuté ces
fichiers.

## 7. `public_read_context` — clos sous réserve

« Absence d'effet » vaut pour le rôle `tracefab_app` **existant**, sur les cinq
fonctions, avec comparaison des `EXECUTE` réellement détenus — 5 = 5, fonction
par fonction. Cela ne dit rien d'un autre rôle, ni des privilèges par défaut.

## 8. M6 — `NOT RUN`

Le relevé exige un accès en lecture seule et une autorisation explicite. Aucune
n'a été donnée pendant ce tour : **aucune connexion ouverte**. Le script est
prêt et son exécutabilité hors ligne est vérifiée
(`test:diagnostic-m6` : `PASS`) — ce qui prouve qu'il ne modifie rien, pas qu'il
ait été fait sur la production.

## 9. Contrôles finaux

| Contrôle | Résultat |
|---|---|
| Rejeu complet de la chaîne (64 migrations, base reconstruite) | **`PASS`** |
| `test:supplier-invitation-corrective` | **`PASS`** — 40 (chaîne complète, tour 30) |
| `test:confrontation-production` | **`PASS`** — 18 (tour 30) |
| `test:runbook-application` | **`PASS`** — 10 (tour 30) |
| `test:migrations:hors-bande` | **`PASS`** — 46 |
| `test:divergences-migrations` | **`PASS`** — 33 |
| `test:reprise-migrations` | **`PASS`** — 28 |
| `test:reconciliation-historique` | **`PASS`** — 48 |
| `test:diagnostic-m6` | **`PASS`** |
| `test:sql-errors` | **`PASS`** — 200 garde-fous traduits (197 avant) |
| `test:chantiers`, `test:dossier`, `test:workflow-policy`, `test:db-guard`, `test:db-throwaway`, `test:tables-ecriture-directe`, `test:objets-sql:comparaison`, `test:routes`, `test:dpp:migrations` | **`PASS`** |
| 111 scripts `test:*` hors base/navigateur, passés en revue | 18 échecs, **tous environnementaux** (voir ci-dessous) |
| `api:typecheck`, `npm test`, `npm run build` | **`NOT RUN`** — `prisma generate` impossible hors ligne |
| `test:route-auth-coverage` | **`NOT RUN`** — 113 échecs, **identiques** avec `git stash -u` sur l'arbre non modifié : cause = client Prisma non généré |
| Suites navigateur (`test:copy`, `test:console-css`, `test:mission-ui`, `test:coherence`, …) | **`NOT RUN`** — Chromium absent / `libnspr4.so` manquante |
| `test:dpp:review-publication`, `test:dpp:role-applicatif`, `test:dpp:branche`, `test:garde-fous:neon` | **`NOT RUN`** — cible base obligatoire, sortie 2 assumée par le dépôt et déjà exclue de la CI |
| CI complète sur `42a3e3e` (code + tests) | **`PASS`** — 7/7 |
| CI complète sur les commits de documentation suivants | **`PASS`** — 6/6 chacun |

Les 18 échecs locaux ont été instruits un par un : aucun ne provient d'un
changement de ce tour.

## 10. Risques résiduels

1. **`plm_erp_gs1` inconnu en production.** Une politique plus permissive ou un
   `EXECUTE` plus large y passerait inaperçu. C'est le risque principal, et il
   n'est pas résolu.
2. **Le correctif `supplier_portal` n'est pas appliqué.** Tant qu'il ne l'est
   pas, la production refuse l'onboarding fournisseur (`owner_role_not_invitable`).
   L'appliquer est une écriture : hors de portée sans accord explicite.
3. **L'état du catalogue de production pour les cinq hors bande** n'est pas lu.
4. **`EXECUTE` à `PUBLIC`** sur la fonction d'ingestion `SECURITY DEFINER` :
   état existant, non modifié, à instruire séparément.
5. **M6 non relevé** : l'écart entre privilèges attendus et réels n'est pas
   mesuré.

## 11. Absence d'écriture de production — confirmé

Aucune connexion à la production de ce tour. Aucun `migrate deploy`, aucun
`migrate resolve`, aucun `GRANT`/`REVOKE`, aucun changement de rôle, aucun
déploiement, aucune modification de `_prisma_migrations`. `deploy` reste
**gelé**. PR #102 **non fusionnée, non fermée**.

## 11 bis. Tour 30 — autorisation accordée, accès absent

Le propriétaire a autorisé les deux opérations manquantes (lecture du catalogue
de production, application de `20261028140000`). L'environnement d'exécution n'a
ni identifiants ni sortie réseau vers Neon : les deux restent **`NOT RUN`**, avec
des outils désormais prêts et **éprouvés** (`tour30-autorisation-et-correction.md`).

Correction importante apportée dans le même tour : l'affirmation de deux
contournements `supplier_portal` était **fausse** — un second déclencheur, de la
migration initiale, les refuse. Un seul trou réel subsiste (relation terminée) ;
la migration le ferme.

## 12. Décision

> **Mis à jour au tour 30** : `plm_erp_gs1` a été confronté depuis (par le
> propriétaire du dépôt) — la production portait deux politiques supplémentaires
> élargissant l'insertion à `contributor`. Une migration corrective
> (`20261028150000`) est dans le dépôt et vérifiée sur la chaîne réelle. Le motif
> du refus s'est déplacé sur l'état des **douze tables hors bande**, non lu en
> production. Voir `2026-10-28-tour30-autorisation-et-correction.md` §7.

### **NON PRÊTE À FUSIONNER**

Motif initial (tour 29) : **`plm_erp_gs1` reste `BLOCKED`**. La production a
exécuté un contenu qui n'est plus celui du dépôt, et ce contenu n'a jamais été
retrouvé. Rien dans ce tour ne permet de dire si les politiques RLS, le
propriétaire, le `search_path` ou l'`EXECUTE` y diffèrent. Une divergence
d'empreinte **non qualifiée sur une règle d'autorisation** est un contrôle
bloquant : la mission interdit de la convertir en `PASS` au motif que tout le
reste est vert.

Ce qui est acquis et ne dépend d'aucun accès : le correctif `supplier_portal` est
prouvé sur base jetable, y compris contre ses propres mutations ; les cinq
migrations hors bande produisent le même schéma par les deux chemins, et `0 step`
s'explique désormais par une dépendance mesurée au lieu d'une hypothèse ;
`public_read_context` est clos sous réserve ; la CI est verte **sur le SHA
final exact**, 7/7.

Ce qui reste à faire tenir pour pouvoir prononcer **PRÊTE À FUSIONNER** :

1. **une lecture du catalogue de production** (la requête est imprimée par
   `test:divergences-migrations`), sur `plm_erp_gs1` et, dans la même passe, sur
   les douze tables des cinq migrations hors bande ;
2. l'**application** de `20261028140000` en production — décision distincte, et
   seulement après la qualification ci-dessus.

Ni l'une ni l'autre n'est engagée. Le correctif est prêt ; il n'est pas appliqué.
