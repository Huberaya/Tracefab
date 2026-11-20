# §11 — Consolidation des PR Tracefab et validation de la chaîne de migrations

**Mission n°8.** Date d'exécution : 2026-11-12.
Branche de travail : `consolidation/tenant-isolation-migrations-20261120`, créée sur `main`.

---

## 1. SHA

| | SHA | Commentaire |
|---|---|---|
| `main` — SHA initial | `17483e2af43ca41296174719e5dd5115266aa4c1` | état mesuré au départ de la mission |
| `main` — SHA final | `17483e2af43ca41296174719e5dd5115266aa4c1` | **inchangé** : aucune fusion effectuée (voir §4) |
| Branche de consolidation — base | `17483e2af43ca41296174719e5dd5115266aa4c1` | arbre propre au départ |

`main` compte 1236 commits et **100 migrations** à ce SHA. Le clone était
superficiel au début de la mission (`.git/shallow` = `17483e2a`) ; toutes les
mesures de parenté antérieures étaient invalides. `git fetch --unshallow` a été
exécuté avant toute analyse.

---

## 2. Tableau des PR

| PR | État GitHub | Head | Base réelle / merge-base | Avance / retard | Fichiers | Migrations ajoutées | Décision |
|---|---|---|---|---|---|---|---|
| **#113** | OPEN, CONFLICTING | `1a0a2095` | `main` · MB `71855014` | 45 / 334 | 137 | 4 — **0/4 dans `main`** | **Absorber le reliquat** : 3 wrappers `*_in_active_tenant` + migration `worker_clerk_organization_prerequisites`. Fermer la PR ensuite. |
| **#120** | DRAFT, MERGEABLE | `c565843e` | **`arena/0f697b3e-tracefab` (= #113)** | 63 / 334 | 140 | 6 dont 2 propres | **Fermer** : sa base est la branche de #113 ; ses 2 correctifs propres (chemins indirects documentaires) sont **déjà** dans `main` via `20261105235900`. |
| **#112** | DRAFT, CONFLICTING | `da8fa542` | MB `788df220` | 396 / 463 | 185 | 26 — **22/26 dans `main`** | **Fermer** : les 4 migrations « absentes » sont **redondantes ou inférieures** à `main` (voir §3.2). |
| **#109** | OPEN, CONFLICTING | `751004e0` | MB `788df220` | 114 / 463 | 80 | **0** | **Fermer** : entièrement absorbé par la série `active_tenant_*` de `main`. Sur ses 71 fichiers `api/`, `main` en est à **+613 / −832** : `main` contient plus et mieux. |
| **#110** | OPEN, CONFLICTING | `f132c3ab` | MB `788df220` | 517 / 463 | 135 | 24 — **24/24 dans `main`** | **Fermer** : la réconciliation qu'il opère est déjà dans `main`. |
| **#114** | OPEN, CONFLICTING | `06455e9c` | MB `d108e6a8` | 56 / 301 | 28 | 2 — **2/2 dans `main`, identiques au bit près** | **Fermer** : intégralement absorbé. Ses `api/_lib/auth.ts`, `api/_lib/notification-outbox.ts`, `api/_routes/webhooks/clerk.ts` sont **identiques** dans `main`. |

### Réconciliation par branche

- **#110** : 24 migrations présentes dans `main`, **0 absente**.
- **#114** : `20261109170000_p107_expiration_floor` et
  `20261109190000_p107_worker_organizations_update` ont le **même sha256**
  que dans `main`. Seul un workflow (`.github/…/p11-preview-p107-migration.yml`)
  diffère — fichier de CI propre à la branche, sans effet sur le produit.
- **#109** : **aucune** migration. Correctif purement applicatif, remplacé.
- **#113** : 4 migrations, **toutes absentes** de `main` — mais 3 d'entre elles
  sont supplantées (voir §3.1).
- **#120** : 6 migrations, dont les 2 qui lui sont propres réécrivent des
  politiques que `main` a **déjà** durcies par une voie structurellement
  meilleure.

---

## 3. Ce qui serait perdu

### 3.1 PR #113 — reliquat réel

Sur 137 fichiers touchés par #113, le diff #113 → `main` vaut
**`+1302 / −17217`** : `main` a déjà tout réécrit en mieux.

Les 4 migrations de #113 :

| Migration | Statut dans `main` |
|---|---|
| `20261105160000_p107_hmac_forme_canonique_et_ttl` | **supplantée** par `20261109170000_p107_expiration_floor` |
| `20261106010000_active_tenant_access_guards` | équivalent présent (`20261105235900`) |
| `20261109120000_...` | équivalent présent |
| `20261110120000_worker_clerk_organization_prerequisites` | **absente** — droits INSERT + politiques INSERT/UPDATE pour `tracefab_sync_clerk_organization` |

**Reliquat unique à préserver** : les 3 helpers
`tracefab_{document_accessible,document_visible,product_accessible}_in_active_tenant`
(présents dans 10 fichiers `api/` **de #113 seulement** ; `main` n'en a
**aucun appelant**), et la migration
`20261110120000_worker_clerk_organization_prerequisites`.

**Verdict sur ce reliquat** : ce ne sont **pas** des garanties de sécurité
manquantes. La fermeture du tenant actif est déjà assurée dans `main` par la
RLS et par `tracefab_can_access_document` (§5). Ce sont des **helpers de
commodité applicative** et un **confort d'exploitation** pour le worker Clerk.
Ils ne doivent donc pas être présentés comme une correction de faille.

### 3.2 PR #112 — pourquoi ses 4 migrations « libres » ne doivent pas entrer

Les horodatages `20261105250000` à `20261105280000` sont bien **libres** dans
`main` (qui occupe `20261105240000`, `20261105235900` et `20261106000000`).
Le critère d'unicité d'horodatage **passe**. Ce n'est pas la raison du refus.

La raison est **technique et mesurable** : `20261105250000` réécrit
`tracefab_can_access_document` en enveloppant les prédicats **un par un**.
Or deux branches y restent en `tracefab_is_org_member(...)` **nu** :

```
28:  AND (public.tracefab_is_org_member(req.brand_organization_id)
29:       OR public.tracefab_is_org_member(req.supplier_organization_id))
54:  AND public.tracefab_is_org_member(r.brand_organization_id)
```

`main`, au contraire, construit un `CROSS JOIN active` unique et exige
`a.organization_id IS NOT NULL AND tracefab_is_org_member(a.organization_id)`
**avant** d'évaluer les branches. Toutes les branches sont donc bornées d'un
seul coup, y compris celles ajoutées plus tard. C'est structurellement plus
robuste qu'un remplacement prédicat par prédicat, où il suffit d'oublier une
occurrence pour rouvrir une fuite.

`20261105260000` (garde `tracefab_current_user_email`) et `20261105270000`
(lecture `users` + registre) sont également déjà couverts : la fonction
`tracefab_current_user_email` est **présente 4 fois** dans les migrations de
`main`.

**Conclusion** : fusionner #112 **dégraderait** `main`. Décision : fermer.

### 3.3 PR #120 fusionnée seule — ce qui serait perdu

Rien de fonctionnel, mais **tout serait cassé** : sa `baseRefName` est
`arena/0f697b3e-tracefab`, c'est-à-dire **la branche de #113**. Fusionner #120
seule reviendrait à fusionner #113 implicitement, sans revue, et rendrait le
graphe dépendant d'une branche `arena/*` éphémère. C'est précisément ce que la
mission interdit (« ne pas fusionner mécaniquement »).

Ses protections propres (`test_neon_document_material_tenant_scope.mjs`) sont
conservées comme **référence de scénario**, mais leur objet — borner les
matériaux et documents au tenant actif sur les chemins indirects — est **déjà
couvert** par `main`, et prouvé par exécution en §5.

---

## 4. Corrections réellement effectuées

### 4.1 Ce qui a été fait

1. **Dé-superficialisation du clone** (`git fetch --unshallow`), sans quoi
   aucune conclusion de parenté n'était valable.
2. **Audit par exécution de la chaîne de migrations** : 100 migrations
   appliquées sur PostgreSQL WASM.
3. **Création d'une preuve d'isolation par exécution sur `main`** :
   `scripts/test_preuve_isolation_main_tenant_actif.mjs`, enregistrée sous
   `npm run test:preuve-isolation:main`. **18 scénarios, 18 OK** (§5).
4. **Preuve négative par mutation** de cette même suite (§5.3).

### 4.2 Ce qui n'a délibérément pas été fait

- **Aucune fusion de PR.** Aucune des six PR n'apporte, en l'état, une
  garantie que `main` ne possède déjà. Fusionner aurait ajouté du risque sans
  valeur. Les fermetures restent à prononcer (voir §9).
- **Aucun `prisma migrate deploy`**, aucun `migrate resolve`, aucune écriture
  dans `_prisma_migrations`, aucune modification de schéma ou de données Neon.
- **Aucune migration supprimée, renommée ou réécrite.**
- **Aucune règle RLS affaiblie**, aucun test supprimé, aucune vérification
  neutralisée pour verdir la CI.

### 4.3 Rejet explicite de trois fausses preuves négatives

Les suites d'isolation de #113/#120 ont d'abord été exécutées **telles quelles**
contre `main`. Elles ont produit des « échecs » qu'il aurait été malhonnête de
présenter comme des failles :

| Suite | Résultat brut | Cause réelle |
|---|---|---|
| `test_isolation_globale_pglite.mjs` | 1 échec | **exige** la migration `20261106010000_active_tenant_access_guards`, absente de `main` |
| `test_active_tenant_routes.mjs` | 81 échecs | référence `documentAccessibleFromTenant`, **absent de `main` (0 occurrence)** : mesure une absence de code, pas une fuite |
| `test_route_tenant_matrix.mjs` | 103 échecs | matrice de documentation périmée + 39 routes déjà contrôlées |

Ces trois suites ne sont donc **pas** des preuves de régression de `main`. Elles
ont été écartées et remplacées par une preuve construite sur le schéma réel de
`main` (§5). Aucun résultat n'a été converti en `PASS` : ils sont déclarés
**non applicables à `main`**, avec leur cause.

---

## 5. Preuves PostgreSQL / RLS

### 5.1 Commande exacte et environnement

```
npm run test:preuve-isolation:main
# = node scripts/test_preuve_isolation_main_tenant_actif.mjs
```

- **SHA testé** : `17483e2af43ca41296174719e5dd5115266aa4c1` (= `main`, =
  base de la branche de consolidation). **SHA testé = SHA soumis.**
- **Environnement** : PostgreSQL 16 en WASM via `@electric-sql/pglite`, base
  **jetable** créée en mémoire à chaque exécution. **Pas de Neon.**
- **Rôle** : `tracefab_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`,
  provisionné avant la chaîne, exactement comme le runner le fait.
- **GUC** : `tracefab.user_id` et `tracefab.active_organization_id` posés avec
  `set_config(..., is_local = true)` **dans une transaction**, comme
  `api/_lib/context.ts`.
- **Durée** : 4 s (mesurée, à froid).

### 5.2 Résultat — 18/18

```
base jetable : 100 migrations appliquees, role tracefab_app (NOBYPASSRLS)

ok  fixtures : 3 organisations, 1 compte membre actif des TROIS, 2 produits, 2 matieres
ok  A. sans tenant actif : 0 produit visible, malgre une adhesion active a A et B
ok  A. sans tenant actif : 0 matiere visible
ok  B. tenant A arme : seul le produit de A est visible (mesure 1)
ok  C. tenant A arme : le produit de B est INVISIBLE malgre une adhesion active a B
ok  C. tenant A arme : la matiere de B est INVISIBLE
ok  C. tenant B arme : la matiere de B REDEVIENT visible (meme ligne, autre tenant)
ok  E. tenant A arme : ecrire une matiere dans B est REFUSE (WITH CHECK)
ok  E. tenant A arme : ecrire une matiere dans A est ACCEPTE (positif)
ok  F. tenant A arme : tracefab_in_active_tenant(A) = VRAI
ok  F. sans tenant arme : tracefab_in_active_tenant(A) = FAUX (fail-closed)
ok  F. entree NULL : FAUX, jamais NULL (booleen TOTAL)
ok  F. sans tenant arme : tracefab_active_organization_id() = NULL
ok  G. le role applicatif N A PAS le droit d ecrire dans tracefab_products
ok  D. controle negatif (proprietaire, sans RLS, sans tenant) : 2 produits visibles
ok  D. controle negatif : 3 organisations visibles
ok  D. l isolement vient bien de la POLITIQUE RLS, pas du filtre de la requete

Preuve isolation tenant actif : OK
```

**Preuve positive** : le tenant A voit ses lignes (B, B, E-accepté, F-vrai).
**Preuve négative** : le tenant A ne voit pas B, et l'écriture dans B est
refusée (A, C, C, E-refusé).

### 5.3 Sensibilité de la preuve — mutation

Un test qui ne peut pas échouer ne prouve rien. La RLS a été **volontairement
désactivée** (`ALTER TABLE … DISABLE ROW LEVEL SECURITY`) sur
`tracefab_products` et `materials`, puis la suite a été rejouée :

```
ECHEC  A. sans tenant actif : 0 produit visible
ECHEC  A. sans tenant actif : 0 matiere visible
ECHEC  B. tenant A arme : seul le produit de A est visible (mesure 2)
ECHEC  C. tenant A arme : le produit de B est INVISIBLE
ECHEC  C. tenant A arme : la matiere de B est INVISIBLE
ECHEC  E. tenant A arme : ecrire une matiere dans B est REFUSE
ECHEC  D. l isolement vient bien de la POLITIQUE RLS
Preuve isolation tenant actif : 7 echec(s).
```

La suite **détecte** la perte d'isolation. La mutation a ensuite été retirée
et la suite est revenue à 18/18.

### 5.4 Mécanisme d'isolation, lu dans le catalogue

`20261105235900_active_tenant_policy_and_worker_closure` réécrit **toutes** les
politiques de `public` sauf huit tables, en remplaçant chaque
`tracefab_is_org_member(X)` par
`(tracefab_in_active_tenant(X) AND tracefab_is_org_member(X))`, et **lève une
exception** (`active_tenant_policy_using_not_fully_wrapped`) si un prédicat
n'a pas été enveloppé. Les huit tables **volontairement exclues** sont
`organizations`, `organization_memberships`, `organization_invitations`,
`rate_limit_counters`, `tracefab_schema_catalog`, `dpp_requirement_profiles`,
`green_claims_rules`, `pef_emission_factors`.

`data_requests` **n'est pas exclue** : son union d'adhésions applicative
(`accessibleRequest`) est donc neutralisée par la RLS, qui ne laisse passer
que le tenant actif. C'est ce que mesure le scénario A.

`organizations` **est exclue** : voir toutes ses organisations est le
**sélecteur de tenant**, comportement voulu. Toute assertion qui exigerait
« 1 seule organisation visible » serait donc fausse — c'est une erreur qui a
été commise puis corrigée pendant l'audit.

### 5.5 Défense en profondeur au-delà de la RLS

Le rôle applicatif **n'a pas** le droit d'écrire dans `tracefab_products` ni
dans les tables documentaires : ces écritures passent par des fonctions
`SECURITY DEFINER` au registre contrôlé. Un test qui conclurait « insertion
refusée » sur `tracefab_products` prouverait l'absence de `GRANT`, **pas** la
RLS. C'est pourquoi le scénario d'écriture (E) utilise `materials`, réellement
inscriptible, et le scénario G vérifie explicitement l'absence de privilège.

---

## 6. Chaîne de migrations — état réel

| Contrôle | Commande | Résultat | SHA |
|---|---|---|---|
| Rejeu intégral | `npm run test:dpp:migrations` | **100 migrations appliquées, OK** | `17483e2a` |
| Cohérence du contrôle | `npm run test:migrations:controle` | **8/8** | `17483e2a` |
| Horodatages | `npm run test:migrations:horodatages` | aucune duplication nouvelle | `17483e2a` |
| Historique | `npm run test:migration-history` | **7/7** | `17483e2a` |
| Reprise | `npm run test:reprise-migrations` | OK | `17483e2a` |
| Multi-tenant applicatif | `npm run test:cross-tenant` | rc=0 | `17483e2a` |
| Couverture contexte de route | `npm run test:route-context-coverage` | **25/25** | `17483e2a` |
| Isolation prouvée | `npm run test:preuve-isolation:main` | **18/18** | `17483e2a` |

### Contrôles de structure vérifiés

- **Doublons d'horodatage** : aucun.
- **PDF/SQL désynchronisés** : non applicables (Prisma + SQL manuel assumé).
- **RLS `ENABLE` + `FORCE`** : `data_requests`, `tracefab_products`,
  `materials`, `documents` sont `ENABLE` **et** `FORCE` (`20261006100000`).
- **`SECURITY DEFINER`** : `tracefab_can_access_document` et
  `tracefab_current_user_email` en `SECURITY DEFINER` avec
  `SET search_path = pg_catalog, public`.
- **Réversibilité** : non applicable — aucune migration descendante n'est
  fournie par le dépôt (convention assumée).

### CI de `main`

Dernier run sur le SHA exact : **`44769421435`**, sha `17483e2a`, **success**.
Les quatre jobs sont verts, dont :

- `Base — isolation RLS executee` : *Isolation RLS prouvée par exécution*,
  *Contrôle négatif — l'isolement vient bien de la RLS*, *Isolation RLS sur
  lignes existantes — deux organisations*, *Sécurité multi-tenant — isolation
  et refus de rôle*, *P10.7 — la sonde de contexte tenant est EXERCÉE sur la
  vraie base*.
- `Socle — types, compilation, isolation`, `Parcours — navigateur réel`,
  `Vérification — suite de tests`.

---

## 7. Tests — ce qui est vérifié et ce qui ne l'est pas

| Test | Environnement | SHA | Résultat | Durée |
|---|---|---|---|---|
| `test:dpp:migrations` | PGlite (WASM) | `17483e2a` | PASS — 100 migrations | 4 s |
| `test:migrations:controle` | Node | `17483e2a` | PASS 8/8 | < 1 s |
| `test:migrations:horodatages` | Node | `17483e2a` | PASS | < 1 s |
| `test:migration-history` | Node | `17483e2a` | PASS 7/7 | < 1 s |
| `test:reprise-migrations` | PGlite | `17483e2a` | PASS | ≈ 12 s |
| `test:cross-tenant` | Node | `17483e2a` | PASS rc=0 | < 1 s |
| `test:route-context-coverage` | Node | `17483e2a` | PASS 25/25 | < 1 s |
| `test:preuve-isolation:main` | PGlite + `SET ROLE` | `17483e2a` | PASS 18/18 | 4 s |
| `test:preuve-isolation:main` (**muté**) | idem, RLS désactivée | `17483e2a` | **FAIL 7 — attendu** | 4 s |

### Tests explicitement NON vérifiés dans cet environnement

| Suite | Cause | Statut |
|---|---|---|
| `test:neon:rls`, `test:neon:cross-tenant`, `test:neon:active-tenant`, `test:neon:isolation-lignes`, `verify:routes:isolation`, `test:plm-rls-isolation`, `test:jetables:harnais-rls` | exigent un **vrai** PostgreSQL avec `PG*` — pas de serveur PostgreSQL ni de Docker dans cet environnement | **NON VÉRIFIÉ ici** ; couvert par le job CI `Base — isolation RLS executee`, vert sur `17483e2a` |
| Suites d'isolation de #113/#120 | exigent du code absent de `main` | **NON APPLICABLES** (voir §4.3) |

Aucun `INDETERMINATE` n'a été converti en `PASS`. Aucun échec n'a été masqué.

---

## 8. Réconciliation des migrations par environnement

| Environnement | État | Méthode | Résultat |
|---|---|---|---|
| **Base jetable (PGlite)** | 100 migrations appliquées | rejeu intégral, ordre lexicographique | **OK** |
| **CI GitHub (PostgreSQL)** | job `Base` vert | `run 44769421435` | **OK** |
| **Preview Vercel** | non sollicitée pendant cette mission | — | **non modifiée** |
| **Neon (production)** | **non touchée** | lecture du dépôt uniquement | **aucune écriture** |
| **Préproduction** | non sollicitée | — | **non modifiée** |

**Plan d'application (sans exécution)** : aucune migration nouvelle n'étant
retenue par cette mission, **il n'y a rien à appliquer**. Si le reliquat de
#113 devait être retenu plus tard (§3.1), il faudrait d'abord vérifier que
`20261110120000_worker_clerk_organization_prerequisites` est bien **postérieure**
à toutes les migrations Neon déjà appliquées, puis l'appliquer en préprod avant
toute production.

---

## 9. Écarts ouverts

1. **Fermetures de PR non prononcées.** Les six PR sont encore ouvertes.
   Décision technique arrêtée (§2) : #109, #110, #112, #114, #120 → **fermer** ;
   #113 → **absorber le reliquat puis fermer**. Aucune fermeture n'a été
   exécutée dans cette passe.
2. **Reliquat #113 non porté.** Les 3 wrappers `*_in_active_tenant` et
   `20261110120000_worker_clerk_organization_prerequisites` ne sont **pas**
   dans `main`. Ce ne sont pas des garanties de sécurité manquantes (§3.1),
   mais leur absence reste un écart assumé, à trancher explicitement.
3. **Suites d'isolation #113/#120 non portées.** Elles mesurent du code qui
   n'existe que dans ces branches ; les porter demanderait de porter le code.
4. **Suites PostgreSQL réelles non exécutées localement** (absence de serveur
   PG). Elles sont vertes en CI sur le même SHA, ce qui n'est pas la même
   chose qu'une exécution locale — c'est déclaré comme tel.
5. **`organizations` hors périmètre de la réécriture** : comportement voulu
   (sélecteur de tenant), mais aucune assertion automatisée ne verrouille
   aujourd'hui cette exclusion. Un futur changement pourrait l'élargir sans
   être vu.

---

## 10. Non-modification de la Production et de Neon

**Confirmation explicite.**

- Aucun `prisma migrate deploy`. Aucun `prisma migrate resolve`.
- Aucune écriture dans `_prisma_migrations`.
- Aucune modification de schéma ni de données sur Neon.
- Aucune migration supprimée, renommée ou réécrite.
- Aucun secret ni variable Vercel modifié.
- Aucun déploiement Production.
- Aucune base Neon contactée : tous les rejeux ont eu lieu sur des bases
  **jetables en mémoire** (PGlite).

La Production a été observée **en lecture seule uniquement**, et uniquement à
travers le dépôt Git et les résultats de CI.

---

## 11. Verdict

### **CLOS SOUS RÉSERVE**

**Ce qui est clos, avec preuve par exécution sur `17483e2a`**

- La chaîne de migrations de `main` s'applique intégralement (100/100) sur base
  jetable, dans l'ordre, sans erreur.
- Les contrôles de structure de la chaîne passent : 8/8, 7/7, horodatages
  uniques, couverture de contexte de route 25/25.
- **L'isolation du tenant actif est prouvée par exécution, dans les deux sens**,
  sous un rôle `NOBYPASSRLS` : 18/18 scénarios, dont le contrôle négatif et la
  preuve par mutation (7 échecs attendus quand l'isolation est cassée).
- Les six PR sont **cartographiées par différence de code réelle**, pas par
  titre : aucune n'apporte de garantie absente de `main`. #114 est identique au
  bit près, #110 est intégralement présent, #109 n'a aucune migration, #112 est
  redondant ou inférieur, #120 dépend de #113 et ses correctifs propres sont
  déjà dans `main`.
- La Production et Neon n'ont **pas** été modifiées.

**Ce qui reste ouvert et justifie la réserve**

1. Les **six fermetures de PR** ne sont pas prononcées : c'est une action
   irréversible sur le dépôt distant, que la mission réserve à un accord
   explicite (« ne rien supprimer sur le dépôt distant sans accord explicite »).
2. Le **reliquat de #113** (3 wrappers + 1 migration worker Clerk) n'est pas
   tranché : le porter ou l'abandonner est une décision produit, pas une
   décision d'audit.
3. Les **suites PostgreSQL réelles** n'ont pas tourné localement (pas de
   serveur PG) ; elles sont vertes en CI sur le même SHA, ce qui est déclaré
   comme une preuve de CI et non comme une preuve locale.

**Pourquoi ni `CLOS` ni `BLOQUÉ`** : aucune faille ouverte, aucune chaîne
cassée, aucune régression — donc pas `BLOQUÉ`. Mais trois décisions
irréversibles restent à autoriser, donc pas `CLOS`.

---

## Annexe — artefact produit par cette mission

`scripts/test_preuve_isolation_main_tenant_actif.mjs` (exécutable :
`npm run test:preuve-isolation:main`), 18 scénarios, 100 migrations rejouées,
`SET ROLE tracefab_app` `NOBYPASSRLS`, GUC en transaction, preuve par mutation.
