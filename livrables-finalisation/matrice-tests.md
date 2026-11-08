# Matrices du candidat d'intégration — Tracefab

**Branche** : `candidat-integration-tracefab`, worktree `/home/user/wt-candidat`
**Base** : `788df220` (`origin/main`) + **7 migrations additives**
**Date des mesures** : 8 novembre 2026
**Environnement** : PostgreSQL 17.11, cluster jetable, Node v22.22.3, Prisma 6.19.3, `@prisma/adapter-pg` 7.10.1, pg 8.11.5

Toutes les mesures de ce document sont **reproductibles** : chaque ligne renvoie à un journal de `preuves/` ou à une commande exacte.

---

## 1. Matrice des migrations

Sept migrations additives. Aucune migration existante n'est modifiée. Les cinq premières viennent des PR candidates, les deux dernières (`120500`, `120600`) sont **nouvelles dans ce tour** et corrigent deux défauts préexistants mesurés.

| # | Migration | Lignes | sha256 (12 premiers) | Ce qu'elle corrige | Défaut préexistant ? |
|---|---|---|---|---|---|
| 1 | `20261108120000_ingest_plm_graphe_versionne` | 693 | `eebb9f2107c6` | Ingestion PLM : passe par la fonction officielle du graphe + **idempotence** nœuds/liens | Non — fonction absente de `main` |
| 2 | `20261108120100_worker_fonctions_systeme_completes` | 245 | `f3cb1f41fff8` | Propriété des 2 fonctions Clerk au worker **+ leurs prérequis réels** | Non — `main` n'est pas rejouable hors superutilisateur |
| 3 | `20261108120200_corrections_p106_ownership_et_appartenance` | 104 | `13a869c9273c` | Appartenance worker bornée (INHERIT/SET, sans ADMIN) ; objets existants | Oui — `2BP01` sur `main` |
| 4 | `20261108120300_acl_colonnes_bornees_au_runtime` | 145 | `205d108bc f03` | ACL de colonnes : 24 produits / 7 documents → **9 produits / 0 documents** | Oui |
| 5 | `20261108120400_lien_graphe_statut_enum_type` | 119 | `b4e1afd9d5df` | `42804` : `CASE` de `tracefab_add_supply_chain_link` non typé `data_value_status` | Oui — invisible tant que rien n'appelait |
| 6 | **`20261108120500_lecture_users_requise_par_les_politiques`** | 100 | `0d51bea0e19f` | `tracefab_app` ne pouvait pas lire `users` ⇒ **3 lectures applicatives cassées** | **Oui — identique sur `main`** |
| 7 | **`20261108120600_lecture_orders_requise_par_le_runtime`** | 91 | `8d1fc35d245e` | `orders` : table RLS sans aucun privilège ⇒ **obstacle de bascule** | **Oui — identique sur `main`** |

Empreintes complètes dans `preuves/empreintes-migrations.txt`.

### Ordre et dépendances

```
20261108120000  ingestion PLM            ── dépend de ──> 20261108120400 (type ENUM)
20261108120100  propriété worker         ── exige ──────> CREATE sur public (posé puis RETIRÉ)
20261108120200  appartenance bornée      ── exige ──────> rôle tracefab_worker créé par 20261028120100
20261108120300  ACL colonnes
20261108120400  type ENUM du lien
20261108120500  lecture users            ── exige ──────> users_select_self (RLS forcée)
20261108120600  lecture orders           ── exige ──────> orders_select_participant (RLS forcée)
```

Chaque migration vérifie ses prérequis et **échoue** plutôt que de réussir partiellement. C'est volontaire : un déploiement vert qui casse à la première requête est le pire des états, et c'est exactement ce qui s'est produit deux fois dans ce tour (voir § 6).

---

## 2. Matrice de sécurité des rôles

Source : `preuves/matrice-securite-roles.log` — **28/28 conformes**.

Méthode : session **réellement authentifiée** sous `tracefab_app` (mot de passe synthétique, jamais journalisé). `SET ROLE` depuis `postgres` ne simule rien : le `session_user` reste superutilisateur, et PostgreSQL autorise alors n'importe quel endossement. Cette erreur de méthode a produit deux faux échecs avant d'être corrigée (voir § 6).

### `tracefab_app` — rôle du runtime

| # | Contrôle | Résultat mesuré |
|---|---|---|
| A0 | identité réellement endossée | `session_user=tracefab_app` |
| A1 | lecture de sa propre organisation | 1 ligne |
| A2 | lecture d'une autre organisation | **0 ligne** (RLS) |
| A3 | écriture d'une colonne réservée de document | `42501` |
| A4 | `INSERT` direct dans `documents` | `42501` |
| A5 | écriture du périmètre runtime | 1 ligne |
| A6 | écriture d'un champ calculé du produit | `42501` |
| A7 | exécution d'une fonction hors registre | `42501` |
| A8 | création d'objet dans `public` | `42501` |
| A9 | appartenance à `tracefab_worker` | `false` |
| A10 | `SET ROLE tracefab_worker` | `42501` |
| A11 | `SET SESSION AUTHORIZATION tracefab_worker` | `42501` |

### `tracefab_worker` — identité système

| # | Contrôle | Résultat mesuré |
|---|---|---|
| W1 | fonctions possédées | 8 |
| W2 | exécution d'une fonction système qu'il possède | OK |
| W3 | création d'objet dans `public` | `42501` |
| W4 | attributs | `NOLOGIN, NOBYPASSRLS, NOSUPERUSER, NOCREATEROLE` |
| W5 | `EXECUTE` sur une fonction d'ingestion de l'allowlist | `false` |
| W6 | isolation app ↔ worker (deux sens) | `false` / `false` |
| W7 | worker accordé à `PUBLIC` | 0 octroi |

### Chemins Clerk (SECURITY DEFINER), appelés sous `tracefab_app`

Parcours complet, sur un propriétaire **non superutilisateur** — c'est le cas de production, celui que le banc masquait.

| # | Contrôle | Résultat |
|---|---|---|
| C1 | `tracefab_sync_clerk_organization` | OK |
| C2 | `tracefab_sync_clerk_membership` (OWNER, création) | OK |
| C2b | `tracefab_sync_clerk_membership` (VIEWER, création) | OK |
| C2c | deux adhésions distinctes en base | 2 |
| C3 | `tracefab_revoke_clerk_membership` (VIEWER) | `status=revoked` |
| C3b | **garde-fou** : révocation du dernier OWNER | **refusée** `last_owner_membership_required` |
| C4 | re-synchronisation idempotente | 1 organisation |
| C4b | **audit écrit** par les fonctions | 3 lignes |
| C6 | GUC `tracefab.user_id` falsifié | sans effet — autorisation = rôle de session |

### Écarts qualifiés sur `main` (69 migrations) vs candidat (76)

| Contrôle sous `tracefab_app` | `main` (69) | Candidat (76) |
|---|---|---|
| `SELECT organizations` | **`42501` users** | OK |
| `SELECT supplier_passport_access_requests` | **`42501` users** | OK |
| `SELECT users` | **`42501` users** | OK |
| `SELECT organization_memberships` | OK | OK |
| `SELECT tracefab_products` | OK | OK |
| `lire-disponibilite-role-app` (bascule) | **OBSTACLE : SELECT absent sur orders** | **prêt pour la bascule** |

**Les trois premiers écarts et l'obstacle `orders` sont préexistants** : mesurés à l'identique sur `origin/main`, ils ne viennent d'aucune migration de ce candidat.

---

## 3. Matrice des tests

| Suite | Résultat | Preuve |
|---|---|---|
| `migrate deploy` (76 migrations, base vierge) | **exit 0**, 76 appliquées | `preuves/replay-76.log` |
| rejeu immédiat (idempotence) | **exit 0**, aucune migration en attente | `preuves/replay-76.log` |
| inventaire après replay | 54 tables · 0 vue · 176 fonctions · 137 politiques · RLS 53/53 active **et forcée** · 0 SECURITY DEFINER publique | `preuves/inventaire.json` |
| `migrer_fidelement.mjs` sous `tracefab_migrator` (non superutilisateur) | **76/76 appliquées** | sortie console |
| `test_p105_roles_et_migrations` | 21/21 | `preuves/suite-p10.log` |
| `test_p105_hmac_identite` | OK | idem |
| `test_p105_ingestion_isolation` | OK | idem |
| `verifier_hierarchie_roles` | 19 OK | idem |
| `test_p106_identite_negative` | OK | idem |
| `test_p106_rejouabilite_chaine` | 25 OK | idem |
| `test_p106_preflight_avant_ecriture` | 19 OK | idem |
| `test_p107_sonde_runtime` | OK | idem |
| `test_p107_demonstration_strict` | OK | idem |
| `test_rls_write_policies` (avec `db:seed-rls`) | **16 assertions**, WITH CHECK prouvé par exécution | `preuves/test-rls-write-policies.log` |
| `test_rls_bypass_controle_negatif` | OK | `preuves/suite-p10.log` |
| `test_tracefab_app_readiness` | OK | idem |
| `test_registre_fonctions_runtime` | **conforme** | `preuves/controles-depot.log` |
| `test_ingest_payload_acl` | 30/30 | idem |
| `test_privileges_role_app` | 42/42 | idem |
| `test_ecarts_privileges_role_app` | **13/13** | idem |
| `lire-disponibilite-role-app` | **exit 0 — prêt pour la bascule** | `preuves/disponibilite-role-app.log` |
| `test_neon_privileges` | OK | `preuves/controles-depot.log` |
| `test_tables_ecriture_directe` | 8/8 | idem |
| `npm run typecheck` | **exit 0** | idem |
| `npm run api:typecheck` | **exit 0** | idem |
| `npm run schema:static` | « schema validation passed » | idem |
| `npm run test:routes`, `test:assets`, `test:i18n`, `test:db-guard*`, `test:db-routing`, `test:workflow-policy`, `test:error-reporting`, `test:router-load` | **tous exit 0** | idem |
| `sonde-lien-graphe.mjs` | **17/17** | `preuves/sonde-lien-graphe.log` |
| `sonde-ingestion-plm.mjs` | **17/17** | `preuves/sonde-ingestion-plm.log` |
| `matrice-securite-roles.mjs` | **28/28** | `preuves/matrice-securite-roles.log` |

### Non exécuté, et pourquoi

| Élément | Statut | Raison |
|---|---|---|
| `npm run db:generate` (moteur Prisma) | **impossible ici** | `binaries.prisma.sh` inaccessible (TLS). Client généré hors ligne pour le typecheck (`scripts/generate_prisma_client_offline.mjs`) ; `verify:prisma-client` signale l'absence du moteur — limite de l'environnement, pas du code |
| Tests contre Neon / Preview | **non exécutés** | Aucune cible distante joignable depuis ce bac à sable. Aucune migration n'a été poussée |

---

## 4. Écart ouvert, assumé et documenté

**La base `main` fusionnée n'est pas déployable telle quelle.** Quatre défauts préexistants la rendent inutilisable en production, dont deux bloquants :

1. `tracefab_app` ne peut pas lire `users` ⇒ trois lectures cassées dès la première requête (corrigé par `120500`) ;
2. `orders` sans privilège ⇒ le contrôle de bascule du dépôt refuse la cible (corrigé par `120600`) ;
3. `42804` sur le lien du graphe ⇒ ingestion PLM impossible (corrigé par `120400`) ;
4. `2BP01` sur l'appartenance worker ⇒ chaîne non rejouable (corrigé par `120200`).

Ces quatre défauts existaient **avant** ce candidat et ne sont pas de son fait. Les corriger était nécessaire pour que le candidat soit déployable ; les documenter était nécessaire pour que la décision reste informée. Voir `decision-go-no-go.md`.
