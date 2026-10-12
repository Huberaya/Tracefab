# Tracefab — Validation finale des corrections CI et SQL avant fusion

**Date** : 2026-10-12 (Europe/Paris) · **Branche** : `arena/879cd8db-tracefab` · **Pull request** : #36 (brouillon, `OPEN`, non fusionnée)
**SHA annoncé en début de mission** : `61ae908b852634f4cbd912eb93de6acf8b3b62df`
**SHA réellement contrôlé (tête de PR avant ce rapport)** : `7145bb94c53d282c183017a4fdfd01c45d821783` (`7145bb9`)
**SHA de la branche à l'issue de ce rapport** : `5d32e799c8459b4435a70de5dd1a916312556047` (`5d32e79`)
**SHA produit par ce rapport** : `5d32e799c8459b4435a70de5dd1a916312556047` (`5d32e79`) — commit des deux correctifs candidats, poussé sur la branche de la PR #36 (`7145bb9..5d32e79`, avance rapide). La PR **reste en brouillon et non fusionnée**.

**Périmètre des tests** : une instance PostgreSQL **jetable** créée localement (`embedded-postgres`, PostgreSQL 18.4, `127.0.0.1:55432`), bases `val_*` recréées à volonté, dans un **worktree détaché** (`/tmp/val61`) sur `7145bb9`. **Aucune connexion à une base Neon**, aucune migration distante, aucun merge, aucun déploiement de production, aucun changement de secret, de variable ou de configuration distante. GitHub Actions n'a pas été réactivé ; aucun check-run n'existe sur `61ae908`, `0b6f90e` ni `7145bb9`, ce qui est attendu (Actions désactivé).

---

## A. État d'avancement (statuts par contrôle)

| # | Contrôle | Statut | Preuve |
|---|----------|--------|--------|
| 1 | Branche et HEAD figés, différences relevées avant de poursuivre | **RÉUSSI** | `origin/…` = `7145bb9`, 2 commits de plus que le SHA annoncé (`0b6f90e`, `7145bb9`) ; migration et test de privilèges **inchangés** entre les deux (blob `cfbc655e…`) |
| 2.1 | Les six fonctions existent dans `public` | **RÉUSSI** | 6/6 sur base reconstruite par la chaîne du dépôt |
| 2.2 | `SECURITY DEFINER` + propriétaire = rôle migrateur | **ÉCHEC sur la chaîne fidèle**, **RÉUSSI après correctif candidat** | sur `7145bb9` : `SQLSTATE 42P17`, migration **refusée par sa propre précondition** (§C). Après correctif : 5 prédicats SECDEF + exemption documentée ; propriétaire = `postgres` pour 6/6 |
| 2.3 | Aucune `EXECUTE` à `PUBLIC` | **RÉUSSI** (après correctif) | 0/6 ouvertes à `PUBLIC` (6/6 avant, cf. §7 défaut n°1) |
| 2.4 | Le rôle applicatif conserve ses droits | **RÉUSSI** | `tracefab_app` exécute 6/6 ; tolérance vérifiée branche « rôle absent » |
| 2.5 | Fonction témoin créée après la migration non exécutable par `PUBLIC` | **RÉUSSI** | `PUBLIC peut exécuter = false` |
| 2.6 | Fonction obligatoire absente ⇒ échec, jamais succès silencieux | **RÉUSSI** | `42883`, migration non enregistrée (deux variantes : §C-6 et §D-6) |
| 2.7 | Échec volontaire ⇒ annulation de toutes les modifications | **RÉUSSI** | 5 vérifications (a→e) toutes `ok`, cf. §6 |
| 3 | `test:neon:privileges` détecte réellement et ne laisse aucun résidu | **RÉUSSI** | exit 1 avec la fonction nommée, exit 0 après refermeture, 0 résidu, 152 fonctions stables |
| 4 | `test:workflow-policy` + témoins | **RÉUSSI** | exit 0 (19 `ok`) et exit 0 (13 témoins `ok`, 11 diagnostics négatifs) |
| 5 | Preview lié au SHA final | **RÉUSSI** (réserve de portée en §G.2) | Preview `success` pour `7145bb9`, `ref` = le SHA contrôlé, créé 15:03:54Z ; idem pour la tête de PR actuelle (`5d32e79`, `2550d19`) |
| 5 | Journaux des deux Preview d'ancêtres en échec | **BLOQUÉ** | `api.vercel.com` injoignable, aucun jeton exploitable ; cause non établie (§G.4) |
| 5 | Diff restant et modifications sans rapport | **RÉUSSI** | 57 fichiers, 11 475 +/126 −, catégorisé ci-dessous |

---

## B. Actions réellement exécutées (environnement, commande, résultat)

Environnement : worktree détaché `/tmp/val61` sur `7145bb9` ; PostgreSQL jetable 18.4 sur `127.0.0.1:55432` (superviseur en tâche de fond) ; bases d'essai `val_*` (`val_complet`, `val_exemption`, …) ; aucune cible distante.

Les commandes ci-dessous sont reproduites **exactement** ; la chaîne de connexion locale est écrite sous forme de gabarit (`<base_jetable>`) pour ne recopier aucune valeur de connexion dans un document.

1. **Gel de l'état** — `git fetch origin --prune` ; `git log 46fbcc9..7145bb9 --oneline` ; `git rev-parse 7145bb9:<migration>` ; `gh pr view 36 --json headRefOid,isDraft,state`.
   Résultat : tête = `7145bb9`, `OPEN`, **brouillon**, `mergeable=MERGEABLE` ; deux commits nouveaux depuis le SHA annoncé (`0b6f90e` : exclusion de `test:audit-script` dans la boucle CI ; `7145bb9` : documentation).
2. **Chaîne complète sur base jetable** — application des 35 migrations antérieures puis de la cible ;
   `node .cache/harness/S1_complet.mjs` → **exit 1**, `SQLSTATE 42P17`,
   « Migration refusée : `public.tracefab_public_context()` n'est pas SECURITY DEFINER ».
   Mesure de l'état réel : les **6/6** fonctions sont **exécutables par `PUBLIC`** et la migration n'est **pas enregistrée** dans `_prisma_migrations`. Le correctif de sécurité **ne s'applique donc pas**.
3. **Correctif candidat n°1** (défaut bloquant §7) appliqué au seul worktree, puis rejoué : `node .cache/harness/S1_complet.mjs` → **exit 0**, `0 échec`.
4. **Contrôles négatifs de l'exemption** — `node .cache/harness/S6_exemption_etroite.mjs` → **exit 0** :
   un prédicat privé de `SECURITY DEFINER` fait **toujours** refuser (`42P17`, non enregistrée) ; la fonction exemptée **absente** (renommée pour contourner la dépendance des 10 politiques) fait **toujours** refuser (`42883`, non enregistrée).
5. **Batterie de scénarios** — `S2_post`, `S3_absente`, `S4_proprietaire`, `S5_rollback` → **exit 0** chacun (détail §C et §6).
6. **Test de privilèges** — `db:seed-rls` puis `test:neon:privileges` contre la base jetable : exit 1 (état non conforme) → exit 0 (état conforme) → exit 1 (porte rouverte) → exit 0 (refermée) → exit 1 (porte sur fonction non SECDEF, détectée par le contrôle F) → exit 0.
7. **Analyse statique des suites destructives** — `npm run test:db-routing` : **exit 1 sur `7145bb9` brut** (« suites destructives non déclarées : `scripts/test_routes_tenant_isolation.mjs` »), **exit 0** après correctif candidat n°2 (§7).
8. **Politique de workflows** — `npm run test:workflow-policy` exit 0 (19 `ok`) ; `npm run test:workflow-policy-temoins` exit 0 (13 témoins `ok`, 11 diagnostics négatifs).
9. **Preview** — `gh api repos/Huberaya/Tracefab/deployments?per_page=100 --paginate`, puis relevé des statuts de chaque déploiement et `git merge-base --is-ancestor` pour situer chaque SHA déployé par rapport à la tête. Deux relevés espacés (14:47Z puis 15:08Z) : Vercel a traité un arriéré entre-temps, ce qui a fait apparaître les Preview des commits récents.
10. **Écriture distante, périmètre identifié** — `git push origin HEAD:refs/heads/arena/879cd8db-tracefab` : `7145bb9..5d32e79` (avance rapide, correctifs) puis `5d32e79..2550d19` (ce rapport). Seule la référence de branche de la PR #36 — en brouillon — a été mise à jour. Aucun merge, aucun tag, aucun réglage, aucun secret, aucune protection de branche ; aucun workflow déclenché (Actions désactivé) ; aucune autre référence distante touchée.

---

## C. Contrôles détaillés du §2 (base jetable)

### Sur la chaîne fidèle, sans aucun dispositif (état réel de `7145bb9`)

Mesure reproduite à l'identique après restauration du fichier de la branche (blob `cfbc655e4adc43909ee6b8b42e22240d3b5e2eef`), `node .cache/harness/S1_complet.mjs` :

```
ECHEC la migration cible a ete REFUSEE :
      SQLSTATE = 42P17
      message  = Migration refusée : public.tracefab_public_context() n'est pas SECURITY DEFINER
--- etat des six fonctions (diagnostic) ---
  tracefab_material_is_public            SECURITY DEFINER=true   proprietaire=postgres  PUBLIC peut executer=true
  tracefab_material_visible_via_product  SECURITY DEFINER=true   proprietaire=postgres  PUBLIC peut executer=true
  tracefab_product_is_public             SECURITY DEFINER=true   proprietaire=postgres  PUBLIC peut executer=true
  tracefab_public_brand                  SECURITY DEFINER=true   proprietaire=postgres  PUBLIC peut executer=true
  tracefab_public_context                SECURITY DEFINER=false  proprietaire=postgres  PUBLIC peut executer=true
  tracefab_supplier_site_is_public       SECURITY DEFINER=true   proprietaire=postgres  PUBLIC peut executer=true
  total : 6/6 fonctions presentes
ok    1. les six fonctions existent dans public
ECHEC 3. fonctions encore ouvertes a PUBLIC : 6/6 (la migration n a pas pu les fermer)
ok    suivi Prisma : 0 enregistrement(s), attendu 0 (echec)
scenario 1 : migration refusee (defaut bloquant)          [exit 1]
```

État mesuré après la tentative :

```
tracefab_material_is_public           SECURITY DEFINER=true   PUBLIC peut executer=true
tracefab_material_visible_via_product SECURITY DEFINER=true   PUBLIC peut executer=true
tracefab_product_is_public            SECURITY DEFINER=true   PUBLIC peut executer=true
tracefab_public_brand                 SECURITY DEFINER=true   PUBLIC peut executer=true
tracefab_public_context               SECURITY DEFINER=false  PUBLIC peut executer=true
tracefab_supplier_site_is_public      SECURITY DEFINER=true   PUBLIC peut executer=true
```

⇒ **contrôle 2.2 : ÉCHEC** ; **2.3 : ÉCHEC** ; les six fonctions restent ouvertes à `PUBLIC`. **Le correctif de sécurité est inopérant sur la branche actuelle.**

### Après le correctif candidat n°1 (migration appliquée pour de vrai)

```
ok    1. les six fonctions existent dans public
ok    2. SECURITY DEFINER : cinq predicats, exemption connue pour tracefab_public_context — non conformes : aucune
ok    2b. proprietaire = role migrateur pour les six — ecarts : aucun
ok    3. fonctions ouvertes a PUBLIC : 0/6
ok    4. tracefab_app peut executer les six : 6/6
ok    5. fonction creee apres -> PUBLIC peut executer = false
ok    suivi Prisma : 1 enregistrement(s), attendu 1 (succes)
scenario 1 : 0 echec(s)      [exit 0]
```

- **2.1** RÉUSSI (6/6) · **2.2** RÉUSSI (5 SECDEF + exemption documentée ; propriétaire `postgres` pour 6/6) · **2.3** RÉUSSI (0/6) · **2.4** RÉUSSI (6/6 pour `tracefab_app`) · **2.5** RÉUSSI (`false`).
- **2.6** RÉUSSI — fonction obligatoire absente :
  `42883` « Migration refusée : fonction obligatoire absente : `public.tracefab_product_is_public(uuid)` », **non enregistrée**.
  Deuxième variante (exemption) : `42883` « … `public.tracefab_public_context()` », **non enregistrée**. Aucun succès silencieux.
- Exemption étroite démontrée : prédicat sans `SECURITY DEFINER` ⇒ `42P17` « … `public.tracefab_product_is_public(uuid)` n'est pas SECURITY DEFINER », non enregistrée.
- Propriétaire différent du migrateur ⇒ `42501` « … appartient à `tracefab_autre_proprietaire`, mais le migrateur est `postgres` ».

---

## D. Étape 3 — `npm run test:neon:privileges` (base jetable uniquement)

Séquence mesurée sur `val_complet` (chaîne complète + migration candidate + `db:seed-rls`) :

| Situation | Code de sortie | Diagnostic |
|---|---|---|
| Base conforme | **0** | `ok A…G`, « Privileges des fonctions : OK. » |
| `GRANT EXECUTE … TO PUBLIC` sur un prédicat SECDEF | **1** | `ECHEC A. 1 fonction(s) SECURITY DEFINER executable(s) par PUBLIC sur 107` |
| Porte refermée (vérifiée : `PUBLIC peut executer = false`) | **0** | conforme |
| `GRANT EXECUTE … TO PUBLIC` sur `tracefab_public_context` (non SECDEF) | **1** | `ECHEC F. 1 fonction(s) restent executables par un role sans droit` |
| Base non corrigée (faille d'origine) | **1** | `ECHEC A`, `B (5 fonctions)`, `C`, `D`, `F` |

Sondes transactionnelles : `ok D. la fonction temoin a bien ete annulee par ROLLBACK`, `ok F. le role sonde a bien ete annule par ROLLBACK`, `ok G. la porte rouverte a ete refermee par ROLLBACK`.
**Résidus : aucun.** `152` fonctions dans `public` avant/après, aucune fonction/tâche/table de sonde, aucun rôle de sonde, `pg_default_acl` inchangé.

---

## E. Étape 4 — politique des workflows et témoins

- `npm run test:workflow-policy` → **exit 0** : 19 `ok`, « Politique des workflows : OK. » (permissions explicites, actions épinglées, aucune lecture de secret non déclarée, `persist-credentials: false`, déclencheur `push` retiré du workflow d'exploitation).
- `npm run test:workflow-policy-temoins` → **exit 0** : 13 témoins `ok` ; les 11 diagnostics négatifs sont bien produits, dont
  `permissions-absentes.yml` → `ECHEC J. permissions explicites absentes au niveau du workflow` et
  `checkout-credentials.yml` → `ECHEC J. checkout sans persist-credentials: false`.
  Un témoin propre qui passerait et un témoin défectueux qui ne serait pas détecté sont tous deux des échecs de ce test : les deux sens sont éprouvés.

---

## F. Test de rollback (§2.7) — résultat

Échec provoqué **après** les modifications, par un déclencheur d'événement qui rouvre une porte, afin que la migration échoue sur **son propre** contrôle :

```
ok    la migration a echoue sur son propre controle (« Migration sans effet »)
      SQLSTATE = 42501
      message  = Migration sans effet : une fonction creee par postgres reste executable par PUBLIC
ok    a) aucune fonction temoin residuelle (oid=null)
ok    b) etat PUBLIC identique a l avant sur les six fonctions (6/6)
ok    c) defauts par defaut inchanges (0 -> 0)
ok    d) aucune fonction sonde residuelle (aucune)
ok    e) migration non enregistree dans le suivi Prisma (0)
scenario 5 : 0 echec(s)      [exit 0]
```

⇒ **Annulation totale prouvée** : aucune écriture partielle ne survit à un échec.

---

## G. Étape 5 — Preview et diff

### Preview rattaché au SHA final : **RÉUSSI**, avec une réserve de portée mesurée

Relevé `gh api repos/Huberaya/Tracefab/deployments?per_page=100 --paginate`, croisé avec l'ascendance de la tête de PR.
Vercel a traité un **arriéré** de déploiements pour cette branche entre 14:50Z et 15:07Z (aucun déploiement n'existait pour les commits récents lors du premier relevé à 14:47Z). État final, du plus ancien au plus récent :

| Commit | Date du commit | Déploiement Preview | État |
|---|---|---|---|
| `dcc8c10` | 11:01 | oui | success |
| `44d49121c`, `e0e175b98` | 13:14 / 13:15 | oui | success |
| `46fbcc9` | 11:55 | oui | **failure** |
| `e069883` … `137d65b`, `961a0d8` | 16:33 → 16:35 | oui | *inactive* (remplacés) |
| `911f53a` | 16:33 | oui | **failure** |
| `b02c2d7` | 16:36 | oui | success |
| `239e6e3`, `cd94221`, `b47445d`, `025b82d`, `8a9711e` | 16:37 → 16:39 | oui | *inactive* (remplacés) |
| `61ae908` | 16:40 | oui (créé 14:58:04Z) | success |
| `0b6f90e` | 16:45 | oui (créé 15:03:00Z) | success |
| **`7145bb9` (SHA contrôlé)** | 16:46 | **oui** (créé 15:03:54Z) | **success** |
| `5d32e79` (correctifs) | 16:57 | oui (créé 15:07:06Z) | success |
| `2550d19` (tête de PR) | 16:59 | oui (créé 15:07:21Z) | success |

Conclusions factuelles :

1. **Le SHA contrôlé dispose bien d'un Preview en succès, rattaché à ce SHA précis** : `sha`/`ref` = `7145bb94c53d282c183017a4fdfd01c45d821783`, état `success`, « Deployment has completed », créé à 15:03:54Z. Le contrôle « relever l'état du Preview lié au SHA final et vérifier qu'il correspond au HEAD contrôlé » est donc **RÉUSSI**. Les commits de correctifs et la tête de PR actuelle ont également un Preview `success` : la tête n'est pas cassée côté déploiement.
2. **Réserve de portée, mesurée** — un Preview vert **ne prouve pas la conformité de la CI**. Le commit `61ae908` obtient un Preview `success` alors que, sur son propre arbre, `node scripts/test_destructive_suite_routing.mjs` sort en **exit 1** (« suites destructives non declarees : scripts/test_routes_tenant_isolation.mjs » ; mesuré dans un worktree détaché sur ce commit, dépendances partagées). Ce contrôle est pourtant exécuté par `npm run build`. Le Preview n'exerce donc pas les contrôles de scripts de la CI : **build réussi ≠ tests réussis ≠ base de production validée**.
3. Les états *inactive* ne sont pas des échecs : Vercel marque obsolètes les Preview remplacés par un plus récent.
4. Deux Preview d'ancêtres restent en **échec** (`46fbcc9`, `911f53a`). Leur cause **n'est pas établie** : `api.vercel.com` est injoignable depuis cet environnement (HTTP 000) et aucun jeton exploitable n'existe — celui communiqué par le propriétaire est traité comme exposé (§I.8). Aucune conclusion n'en est tirée.
5. **Aucun check-run GitHub** n'existe sur ces SHA : GitHub Actions reste désactivé. Les seuls artefacts CI/CD disponibles sont donc les Preview ci-dessus, dont la portée est limitée comme dit au point 2.

### Diff restant (`main` → `7145bb9`) : 57 fichiers, 11 475 +/126 −

| Catégorie | Fichiers | Nature |
|---|---|---|
| `prisma/` | 1 | la migration `20261012120000_close_public_execute_gap` (177 l.) — **objet de la mission** |
| `.github/` | 2 | `ci.yml` (permissions minimales, garde de cible, exclusion de boucle), `vercel-log-search.yml` |
| `scripts/` | 21 | harnais de sécurité et de CI (dont `test_neon_privileges.mjs`, `test_workflow_policy*.mjs`, `test_destructive_suite_routing.mjs`, `run-db-suite.mjs`, `require-throwaway-db.mjs`) |
| `api/` | 6 | 94 +/37 − : `_lib/error-reporting.ts`, `_routes/{documents/[documentId]/verify-ai, integrations, integrations/ingest, integrations/jobs}.ts`, `index.ts` — **sans rapport direct avec la présente mission** (remediation d'incident, chantiers antérieurs) ; couverts par `test:error-reporting` **non exécuté ici** (client Prisma indisponible) |
| `docs/` | 25 | rapports de chantiers, plan de résolution, revues indépendantes, patches préparés — **sans rapport** avec l'objet ci-dessus |
| racine | 2 | `package.json`, `package-lock.json` (scripts) |

Modifications **sans rapport avec la présente mission** à signaler au propriétaire : les 6 fichiers `api/**` et les 25 documents `docs/**`. Ils ne sont **pas** validés par ce rapport.

---

## H. Les deux défauts bloquants trouvés, et les correctifs candidats

### Défaut n°1 — la migration refuse de s'appliquer (bloquant)

- **Problème** : `prisma/migrations/20261012120000_close_public_execute_gap/migration.sql` exige `SECURITY DEFINER` sur **les six** fonctions visées, alors que `public.tracefab_public_context()` est **délibérément non SECDEF** depuis la migration `20261009180000` (elle ne lit qu'un réglage de session, aucune table). La précondition s'exécute **avant toute écriture** : `42P17`, migration jamais enregistrée.
- **Preuve** : §C (exécution sur base reconstruite par la chaîne du dépôt, aucun dispositif).
- **Cause racine** : exigence uniforme appliquée à deux familles de fonctions (cinq prédicats de politiques — `SECURITY DEFINER` **nécessaire** pour éviter la récursion `materials ↔ product_materials` — et une fonction d'aide sans accès aux tables).
- **Correctif candidat** (fichier `docs/security/patches/20261012120000-preflight-exemption-secdef.patch`) : exemption **nommée et documentée** pour cette seule fonction, commentaire expliquant le « pourquoi », et **conservation intégrale** des autres contrôles (existence, propriétaire, `EXECUTE`, contrôle final « migration sans effet »). C'est la variante la plus proche du code actuel ; l'alternative (scinder le contrôle en deux familles explicites) est également viable.
- **Preuve après correctif** : §C (exit 0, 0/6 ouvertes à `PUBLIC`) et **contrôles négatifs §C-2.6** — l'exemption ne transforme ni un prédicat privé de SECDEF ni une fonction absente en succès.
- **Contrôle de régression** : `test:neon:privileges` exit 1 → exit 0 → exit 1 (§D) ; `S2`/`S5` rejoués après correctif (exit 0).
- **Retour arrière** : le correctif ne touche qu'une précondition en lecture ; revenir au fichier précédent (blob `cfbc655e…`) est immédiat, sans effet de bord SQL.
- **Statut de sécurité** : ce correctif **modifie un contrôle de sécurité**. Il n'en supprime aucun et **reste soumis à votre décision** : l'appliquer à une base Neon relève du niveau D et n'a **pas** été fait.

### Défaut n°2 — la CI `verification` est rouge (bloquant)

- **Problème** : `scripts/test_routes_tenant_isolation.mjs` (ajouté sur la branche) écrit réellement en base (`update users …`, `insert into organization_memberships …`) mais n'était déclaré dans aucune liste du détecteur et n'était pas routé par le lanceur gardé. `npm run test:db-routing` — exécuté en CI **et** par `npm run build` — sortait donc en **exit 1** : « suites destructives non déclarees : `scripts/test_routes_tenant_isolation.mjs` ».
- **Preuve** : exit 1 mesuré sur `7145bb9` **non modifié** (migration restaurée à son blob d'origine pour écarter tout effet de bord), 31 `ok` / 1 échec.
- **Correctif candidat** (fichier `docs/security/patches/route-tenant-isolation-via-launcher-garde.patch`) : déclaration de la suite dans `DESTRUCTIVE_DB_SUITES` **et** routage de son unique invocation (`verify:routes:isolation`) par `scripts/run-db-suite.mjs`, c'est-à-dire le mécanisme prévu par le dépôt pour appliquer la garde de cible à **tous** les chemins d'exécution.
- **Preuve après correctif** : `test:db-routing` **exit 0** (33 `ok`), dont la ligne explicite `scripts/test_routes_tenant_isolation.mjs — 1 commande(s), toutes via scripts/run-db-suite.mjs`. La garde est en place et éprouvée : sans cible ⇒ exit 2 ; cible jetable mais harnais non déclaré ⇒ exit 3 (`REFUS — ce harnais ne s'execute pas par accident`).
- **Aucun test n'a été modifié pour « faire passer »** : la suite, ses assertions et ses refus sont intacts ; seul le câblage manquant a été complété.

---

## I. Risques résiduels

1. **La base Neon de production n'a pas été inspectée ni modifiée.** Tant que la migration corrigée n'y est pas appliquée avec le propriétaire des fonctions, la faille `EXECUTE` à `PUBLIC` y reste **ouverte par défaut** (le diagnostic de la chaîne locale montre 6/6 fonctions ouvertes avant migration). Aucune preuve de l'état distant n'est disponible dans cet environnement.
2. **Niveau D non franchi** : appliquer la migration corrigée en production, la rotation d'un secret ou un changement de permissions relèvent d'une autorisation spécifique. Rien de tel n'a été exécuté.
3. **Ordre d'exécution imposé** : après migration, `tracefab_app` doit conserver `EXECUTE` sur les 6 fonctions appelées par les politiques, faute de quoi les politiques RLS cesseraient de résoudre (`db:seed-rls` puis `test:neon:privileges` vérifient ce point — mesuré `ok` ici).
4. **Version de PostgreSQL** : la validation a été faite sur PostgreSQL 18.4. La version de la cible Neon n'a pas été confirmée ; le correctif n'emploie que des fonctions de catalogue standard, mais ce point reste à confirmer côté cible.
5. **CI non exécutée de bout en bout.** Les étapes exigeant le client Prisma (`tsc --noEmit`, `api:typecheck`, `test:prisma-client`, `test:router-load`, `test:error-reporting`) n'ont **pas** pu tourner ici. Elles ne sont donc **pas** validées.
6. **`scripts/test_routes_tenant_isolation.mjs` n'a pas été exécuté** (il exige une clé Clerk **de test** et `TF_ROUTES_TEST_HARNESS=1`) : seul son câblage est prouvé, pas ses assertions.
7. **Portée du Preview** : le SHA contrôlé et la tête de PR ont un Preview `success`, mais ce vert ne couvre **pas** les contrôles de scripts de la CI (démontré en §G.2 : `61ae908` est vert en Preview et rouge en `test:db-routing`). Deux échecs de Preview sur des ancêtres (`46fbcc9`, `911f53a`) restent **inexpliqués**, faute de journaux accessibles. Aucun check-run GitHub n'existe (Actions désactivé).
8. **Jetons et secrets** : le jeton `vcp_…` communiqué en clair le 2026-10-12 est traité comme **exposé** — jamais lu, jamais copié, jamais utilisé, jamais commité ; sa révocation doit être **prouvée par le propriétaire**. Aucune valeur secrète ne figure dans ce rapport.
9. **Portée du diff** : 6 fichiers applicatifs `api/**` et 25 documents `docs/**` sont inclus dans la branche sans lien avec la présente mission et **non validés** par ce rapport.

---

## J. Avis final argumenté

**La branche n'était pas fusionnable dans l'état de `7145bb9`.** Deux défauts bloquants, tous deux mesurés et reproduits, l'auraient empêchée d'apporter la sécurité qu'elle annonce :

1. **la migration de sécurité ne s'applique pas** — elle est refusée par sa propre précondition sur une base construite par la chaîne du dépôt (`42P17`), ce qui laisse les **6/6** fonctions visées exécutables par `PUBLIC` : le correctif est inopérant ;
2. **la CI `verification` (et `npm run build`) sort en exit 1** — une suite qui écrit en base n'était pas branchée sur le lanceur gardé.

En revanche, la **détection** et les **garde-fous** sont de bonne qualité et le restent : le refus est explicite (`42P17`, `42883`, `42501`), jamais un succès silencieux ; l'annulation en cas d'échec est **totale** (5 vérifications) ; le détecteur de privilèges attrape réellement une porte rouverte (par la fonction nommée) et ses sondes ne laissent **aucun** résidu ; la politique de workflows et ses témoins sont éprouvés dans les deux sens. La CI, elle, reste **incapable** de le prouver : aucun check-run GitHub n'existe sur ces SHA (Actions désactivé) et les Preview Vercel, tous `success` y compris sur des commits dont les contrôles de scripts échouent, ne couvrent pas cette vérification (§G.2).

Après les deux correctifs candidats (§H), tout ce qui peut être mesuré sans la base de production est **vert** : migration appliquée, `0/6` portes ouvertes, rôle applicatif préservé, exemption étroite prouvée par des contrôles négatifs, `test:db-routing` et `test:workflow-policy` verts.

**Recommandation** : revue humaine des deux patches, puis exécution de la CI/Preview sur un SHA qui les contient, **avant** toute demande d'application en production. L'application à Neon reste une opération de niveau D, à autoriser explicitement et à prouver après coup par `test:neon:privileges` (attendu : exit 0) et par un relevé des portes `EXECUTE` avant/après.

---

## K. État de sécurité (confinement, secrets, workflows, GitHub, Vercel, Neon, RLS, multi-locataire)

- **Confinement** : tous les tests ont visé une instance PostgreSQL **locale et jetable** (bases `val_*`, base `tracefab_test`), dans un worktree détaché. Aucun accès Neon, Vercel ou GitHub n'a été utilisé pour écrire autre chose que le commit de correctifs de la branche de PR.
- **Secrets** : aucune valeur secrète lue, affichée ou commitée. Chaîne de connexion locale uniquement, non sensible ; le jeton `vcp_…` reste traité comme exposé (§I.8).
- **Workflows** : `ci.yml` conserve `permissions: contents: read`, les actions restent épinglées, `persist-credentials: false` est vérifié, le déclencheur `push` du workflow d'exploitation est retiré. **Aucun workflow n'a été activé** ; deux vérifications statiques les couvrent (`test:workflow-policy`, `-temoins`).
- **GitHub** : PR #36 toujours `OPEN` et **brouillon**, non fusionnée. Le commit `5d32e79` (correctifs candidats + ce rapport) y est ajouté pour revue ; l'écriture distante se limite à cette référence de branche. Aucun changement de protection de branche, de secret ou de réglage n'a été tenté (ces API répondent 403 depuis cet environnement).
- **Vercel** : aucune configuration, variable ni déploiement modifié (aucun appel d'écriture ; les relevés passent par l'API GitHub). Des Preview `success` existent pour le SHA contrôlé `7145bb9` et pour la tête de PR `2550d19` ; leur portée est limitée (§G.2). La cause des deux échecs d'ancêtres reste inconnue.
- **Neon** : aucune connexion, aucune migration. L'état distant est **inconnu** et doit être considéré comme non conforme jusqu'à preuve du contraire.
- **RLS / privilèges / multi-locataire** : les politiques RLS **n'ont pas été modifiées ni désactivées** ; seul `EXECUTE` à `PUBLIC` est refermé, ce qui est l'objet de la migration. Le maintien des droits de `tracefab_app` est vérifié avant/après. Aucun `GRANT` large n'a été ajouté.
- **Vulnérabilités résiduelles** : la faille `EXECUTE` reste ouverte **en production** jusqu'à application autorisée ; les assertions du harnais de routes (clé Clerk de test absente) et les étapes CI dépendant du client Prisma ne sont **pas** couvertes.

---

## L. Contrôles restés bloqués (accès ou prérequis manquants)

| Contrôle | Raison | Ce qu'il faudrait |
|---|---|---|
| Application de la migration corrigée sur Neon | niveau D — autorisation requise | accord explicite + rôle propriétaire + `test:neon:privileges` après coup |
| Relevé de l'état `EXECUTE`/`SECURITY DEFINER` en production | aucune connexion autorisée | accès lecture seule encadré |
| Journaux des deux Preview d'ancêtres en échec (`46fbcc9`, `911f53a`) | `api.vercel.com` injoignable (HTTP 000), aucun jeton exploitable | accès Vercel encadré, ou relevé par le propriétaire (l'état des Preview du SHA contrôlé, lui, a été relevé) |
| Exécution complète de la CI | Actions désactivé + client Prisma non générable ici | réactivation encadrée, hors de cette mission |
| `scripts/test_routes_tenant_isolation.mjs` | clé Clerk **de test** absente | fourniture par mécanisme sécurisé |
| Réglages Actions/secrets/protection de `main` | API GitHub en 403 | accès administrateur |
| Révocation du jeton `vcp_…` exposé | hors de portée technique de l'agent | action du propriétaire + preuve de révocation |

---

*Ce rapport ne présente aucune vérification statique comme un test réussi. Chaque statut « RÉUSSI » correspond à une commande exécutée dont le code de sortie et la sortie sont reproduits ci-dessus ; les contrôles sans artefact sont indiqués « BLOQUÉ » ou « NON EXÉCUTÉ ».*
