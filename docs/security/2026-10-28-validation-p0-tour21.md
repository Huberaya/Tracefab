# Validation P0 — relevé du 28/10/2026 (tour 21)

Base : branche `arena/c27ddaa4-tracefab`, PR #102. Aucune écriture distante,
aucune fusion, aucun déploiement. Toutes les mesures ci-dessous ont été
**exécutées** ; les cases non exécutées sont marquées comme telles.

SHA de départ : `7c365bc6493e2f9b3bf94f8e4967dc24b8ba4deb`

## 1. Les six suites absentes tournent réellement — et en CI

Elles étaient référencées sans être exécutées nulle part. Elles le sont
désormais dans le job *Base* (Postgres 17 jetable), et la CI le prouve.

| Suite | Commande | Résultat local (base jetable) | CI |
|---|---|---|---|
| Sécurité multi-locataires | `npm run test:neon:security` | PASS | ✅ `Base` (étape « Securite multi-tenant ») |
| Parcours produit | `npm run test:neon:product` | PASS | ✅ étape « Parcours produit » |
| Parcours fournisseur | `npm run test:neon:supplier` | PASS | ✅ étape « Parcours fournisseur » |
| Parcours qualité | `npm run test:neon:quality` | PASS | ✅ étape « Parcours qualite » |
| Collecte de données | `npm run test:neon:collection` | PASS | ✅ étape « Collecte de donnees » |
| Quotas de stockage | `npm run test:neon:storage:chantier10` | PASS | ✅ étape « Quotas de stockage » |

Trois corrections de fond ont été nécessaires ; aucune n'affaiblit un contrôle.

1. **Le rôle de test n'avait pas `SELECT`.** Le premier échec était
   `42501 permission denied for table organizations` — un refus de
   *privilège*, levé avant même que la RLS ne s'applique. Le test ne prouvait
   donc rien de la RLS. Le rôle reçoit `SELECT ON ALL TABLES` et
   `EXECUTE ON ALL FUNCTIONS`, exactement comme `tracefab_app` (51/51 tables).
2. **L'écriture directe d'un viewer.** L'assertion attendait 0 ligne ; sous un
   rôle non privilégié la base refuse d'abord (`42501`). Les deux issues sont
   désormais acceptées — refus explicite **ou** écriture invisible — ce qui est
   la propriété réellement testée.
3. **`DROP ROLE` échouait** (`2BP01 objects depend on it`) : le rôle portait des
   privilèges de table. `REVOKE ALL PRIVILEGES ON ALL TABLES` avant le `DROP`.

## 2. Garde-fou CI resserré, pas contourné

`test:ci-no-production-access` interdisait purement et simplement d'invoquer ces
cinq suites dans le workflow, parce qu'elles visaient historiquement la
production. L'interdit tenait tant qu'elles ne tournaient nulle part.

Le contrôle n'est pas retiré : il est **resserré**. Les suites ne peuvent
apparaître que dans le bloc du job `base-de-donnees` (découpe réelle du fichier),
et une assertion supplémentaire vérifie que ce job pointe `DATABASE_URL` vers la
base locale jetable `tracefab_test`. Éprouvé dans les deux sens : injection
volontaire de `test:neon:supplier` dans le job `socle` → **ÉCHEC nommé** ;
fichier restauré → **11/11**.

## 3. Dépendance au privilège du propriétaire (M3) — mesurée, non modifiée

Reconstruction depuis zéro avec un propriétaire `tracefab_owner`
`NOSUPERUSER NOBYPASSRLS` :

| Mesure | Résultat |
|---|---|
| Migrations appliquées par ce propriétaire | **blocage à la 19ᵉ / 62** — `20261006160000`, `42501` sur `dpp_requirement_profiles` |
| Cause 1 | cette migration insère un référentiel alors que la table est sous `FORCE RLS` **sans politique d'écriture** : seul un superutilisateur peut écrire |
| Lecture d'une table quelconque | `54001 stack depth limit exceeded` |
| Cause 2 | `memberships_select_member` → `tracefab_is_org_member` → `organization_memberships` : la politique appelle une fonction `SECURITY DEFINER` qui relit la même table |
| Neutralisation de cette seule politique | tout refonctionne (`count = 1`, `is_org_member = true`) |
| Seed applicatif | `product_requires_brand_organization` : le trigger `tracefab_validate_product_brand_ownership` lit `organizations` sous `FORCE RLS` et voit **0 ligne** |
| Tables `FORCE RLS` lues par ≥ 1 fonction `SECURITY DEFINER` | **22 / 51** |

Contre-expérience : `NO FORCE` sur les 51 tables → le seed passe et
`rls`, `cross-tenant`, `security`, `product` sortent en code 0, **mais**
`test:neon:privileges` échoue (assertion H « RLS activée ET forcée »).

Conclusion factuelle : le schéma ne fonctionne aujourd'hui que parce que le
propriétaire est **superutilisateur**. `FORCE RLS` empêche toute fonction
`SECURITY DEFINER` de lire ce qu'elle doit valider, y compris la table de sa
propre politique. Deux corrections s'excluent — un rôle helper `BYPASSRLS`
restreint, ou le retrait de `FORCE` sur les 22 tables avec modification de
l'assertion H. **Décision : ne rien changer** tant que les attributs réels du
propriétaire en production (`rolsuper`, `rolbypassrls`) ne sont pas mesurés
(M6). Aucune posture de sécurité n'a été modifiée.

## 4. Autres chemins d'autorisation (M4)

**Défaut corrigé — e-mail non vérifié.** La politique `passport_access_select`
autorise la lecture d'une demande d'accès fournisseur par simple égalité
`requester_email = current_setting('tracefab.user_email', true)`. Mesure, rôle
`tracefab_app` sans `BYPASSRLS`, demande créée pour `victime@example.test` :

| Contexte | Lignes visibles |
|---|---|
| sans GUC | 0 |
| `tracefab.user_email = victime@example.test` | **1** |
| `tracefab.user_email = autre@example.test` | 0 |

Le GUC est donc la **seule** barrière. Or `api/_lib/auth.ts` le remplissait avec
l'adresse primaire Clerk **sans vérifier `verification.status`** : une adresse
non vérifiée suffisait à lire la demande d'un tiers (nom, société, e-mail).

Correctif : le contrôle de vérification est exigé, le refus porte un motif nommé
`clerk_email_unverified` (403 — identité établie, autorisation absente). Deux
assertions ajoutées à `test:context-integrity`, suite déjà exécutée par
`npm test`, avec contrôle négatif (neutralisation → 1 échec, exit 1).

**Non exploitable (mesuré).** `tracefab.internal_data_collection_update` reste
positionnable par `tracefab_app`, mais le rôle n'a **aucun privilège `UPDATE`**
sur `data_request_items` : la tentative sort en `42501`, le drapeau n'a pas
d'effet. Le privilège de table est la barrière réelle.

**Inventaire.** 124 fonctions `SECURITY DEFINER`, **124/124** avec
`search_path` figé ; 85 exécutables par `tracefab_app` ; **0** exécutable non
déclarée au registre runtime (91 entrées). `tracefab_soft_delete_document` :
non exécutable par `tracefab_app`, aucun appelant applicatif.

## 5. Validation locale (M5) — 33 PASS, 7 bloqués par le banc, 0 régression

Séquence du job CI *Base* rejouée intégralement sur une base reconstruite
depuis zéro (62 migrations, puis `db:prepare-ci-role`, `audit:privileges`,
`db:seed-rls`), dans l'ordre du workflow.

| État | Nombre | Détail |
|---|---|---|
| PASS | 33 | toutes les suites RLS, privilèges, isolation, cycle documentaire, DPP, registre, worker, écritures, quotas |
| NOT RUN | 1 | `npm ci` — dépendances déjà installées |
| BLOCKED (banc) | 7 | voir ci-dessous ; **toutes vertes en CI** |

Les sept blocages sont des artefacts du banc local, pas du code :

- `db:generate` et `db:generate`-dépendants : les moteurs Prisma ne sont pas
  téléchargeables hors ligne ; le client généré hors ligne utilise le moteur
  `client` (WASM), d'où `P2038 driver adapter required` dans
  `test:neon:deploiement-publication`, `test:router-load` et, indirectement,
  `test:neon:ecriture-non-authentifiee` (le compteur de débit partagé passe par
  le client Prisma ; sans compteur, la classe sensible est refusée en 503 par
  conception — `counter_unavailable`, fail-closed).
- `db:deploy:throwaway`, `test:garde-fous:neon`, `test:audit-script` : la base a
  été reconstruite par rejeu des fichiers SQL, sans table `_prisma_migrations`.
  Ces suites lisent l'historique des migrations.

Preuve alternative pour ces sept points : elles sont vertes dans les jobs
*Socle* et *Base* de la CI sur le même SHA.

Résultats hors séquence : `npm test` **exit 0** ; `typecheck`, `api:typecheck`,
`schema:static`, `test:assets`, `test:routes`, `test:minified-comments`,
`test:i18n`, chantiers 3/4/5, landings, `db-guard`, `db-guard-driver`,
`db-routing`, `workflow-policy`, `workflow-policy-temoins`, `error-reporting` :
**exit 0**.

## 6. Validation distante (M6) — NON EXÉCUTÉE

Aucun accès en lecture seule n'est disponible dans cet environnement et aucun
secret n'est demandé ni affiché. Restent à mesurer, côté production, par un
opérateur habilité :

1. `SELECT current_user, session_user` et, pour le rôle runtime,
   `rolsuper`, `rolbypassrls`, `rolcreaterole`, `rolcreatedb` ;
2. propriétaire effectif du schéma `public` et des 51 tables, des 124 fonctions
   `SECURITY DEFINER` et des 27 types ;
3. contenu de `_prisma_migrations` (nombre, empreintes, ordre) ;
4. `pg_policies` / `pg_class.relrowsecurity` / `relforcerowsecurity` sur les 51
   tables ;
5. privilèges effectifs de `tracefab_app` (tables et fonctions) et absence de
   privilège `PUBLIC`.

Ces cinq relevés n'exigent que des lectures de catalogue.

## 7. Non résolu

- **M3** : dépendance structurelle au propriétaire privilégié. Décision en
  attente de la mesure M6. Le rôle runtime `tracefab_app` n'a besoin ni de
  superutilisateur ni de `BYPASSRLS` — cela est prouvé, mais ne suffit pas à
  rendre la base migrable par un propriétaire non privilégié.
- Un script orphelin, `scripts/test_production_hardening.mjs`, échoue sur
  `api/index.ts` (« Router must fail closed ») et n'est appelé ni par
  `package.json` ni par la CI. Non corrigé : il ne s'exécute nulle part, et le
  réparer suppose de trancher ce qu'il doit vérifier aujourd'hui.
