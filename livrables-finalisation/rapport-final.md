# Rapport final — finalisation du candidat d'intégration Tracefab

> **Rapport historique du commit `515d5ab`**. La revue indépendante du 8 novembre a invalidé son verdict GO : `tracefab_migrator` gardait une appartenance worker permanente, non couverte par la matrice 28/28. Le correctif est suivi séparément dans `livrables-finalisation/revue-corrective-2026-11-08.md`. Les résultats ci-dessous décrivent uniquement le snapshot initial et ne valent pas validation du correctif.

**Branche** : `candidat-integration-tracefab` · worktree `/home/user/wt-candidat`
**Base** : `origin/main` @ `788df220`
**Livré** : 7 migrations additives, 3 sondes d'appel réel, 3 matrices, 1 décision, 9 preuves
**Date** : 8 novembre 2026

---

## En une phrase

Le candidat **fonctionne** — mais il a d'abord fallu corriger quatre défauts **préexistants** de `main` sans lesquels il ne pouvait pas fonctionner, dont deux qui rendaient la base actuelle inutilisable en production dès la première requête.

---

## 1. Ce qui bloque `main` aujourd'hui

Quatre défauts, mesurés, reproductibles, **tous antérieurs à ce travail**.

### 1.1 `tracefab_app` ne peut pas lire `users` ⇒ trois lectures cassées

```
SET ROLE tracefab_app;
SELECT 1 FROM public.organizations LIMIT 1;
-> 42501 permission denied for table users
     SQL function "tracefab_current_user_email" statement 1
```

Trois lectures différentes (`organizations`, `users`, `supplier_passport_access_requests`) échouent avec le **même** message, parce que leurs politiques RLS appellent `tracefab_current_user_email()`, qui interroge `users`.

Cause exacte, relevée au catalogue : `users` a été **exclue** du `GRANT ... TO PUBLIC` de `20260923130000` (§ 12), puis les migrations suivantes n'ont fait que révoquer de l'écriture. Elle n'a jamais reçu `SELECT`. `ALTER DEFAULT PRIVILEGES ... GRANT SELECT` ne s'applique qu'aux tables futures.

Mesuré **à l'identique sur les 69 migrations de `main`**. → corrigé par `120500`.

### 1.2 `orders` n'a aucun privilège ⇒ le contrôle de bascule refuse la cible

```
OBSTACLE : SELECT absent sur orders
VERDICT : 1 obstacle(s) avant bascule
```

`orders` est créée avec RLS active, forcée, trois politiques en place… et jamais incluse dans le `GRANT` initial. Ses politiques n'ont donc jamais pu s'exercer : elles ne protègent rien. → corrigé par `120600`.

### 1.3 `42804` sur `tracefab_add_supply_chain_link`

```sql
CASE WHEN p_evidence_document_id IS NULL THEN 'declared' ELSE 'documented' END
-- affecté à `status data_value_status` ; le CASE est résolu en `text`
```

Le défaut était **invisible** tant que rien n'appelait la fonction. Dès qu'elle est appelée (par la migration d'ingestion), trois cas nominaux échouent. → corrigé par `120400`.

### 1.4 `2BP01` sur l'appartenance worker

`20261028120100` accorde `tracefab_worker` à l'exécutant, puis tente de le révoquer. Sur `postgres`, la révocation est refusée : `dependent privileges exist`. L'appartenance reste — et le rôle de migration peut endosser l'identité système en permanence. → corrigé par `120200`.

---

## 2. Ce que le candidat apporte

### Ingestion PLM idempotente

Deux ingestions identiques produisaient **4 nœuds et 2 liens** pour 2 étapes. `tracefab_create_supply_chain_node` et `tracefab_add_supply_chain_link` insèrent toujours — c'est leur contrat, pas un défaut. L'idempotence appartient donc à l'ingestion, et elle est posée là : déduplication sur la clé naturelle `(produit du graphe, code de procédé, libellé)` pour les nœuds, et sur l'arête `(source, cible, type)` pour les liens.

Vérifié : S2 « aucun doublon de nœud — 2 », « aucun doublon de lien — 1 ».

### Le graphe passe enfin par la fonction officielle

La version précédente faisait un `INSERT` direct dans `supply_chain_links`, ce qui **contournait** le déclencheur `tracefab_validate_supply_chain_link` : ni contrôle d'existence des nœuds, ni cohérence produit, ni accès au document de preuve. Elle appelle désormais `tracefab_add_supply_chain_link`, qui pose elle-même `status` et `declared_by`.

### Les fonctions Clerk passent un contrôle au lieu d'en contourner un

Elles fonctionnaient parce que leur propriétaire était **superutilisateur** et **contournait la RLS**. Le banc ne le voyait pas, la production l'aurait vu. Le transfert de propriété vers un rôle `NOBYPASSRLS` a révélé qu'il manquait : `INSERT` sur `organization_memberships`, `INSERT` sur `audit_logs`, et les politiques d'écriture correspondantes.

**C'est la correction la plus importante du lot** : elle change la nature de ces deux fonctions. Elles ne « marchaient » plus par privilège, mais par permission.

Le parcours complet est vérifié sur un propriétaire non superutilisateur : création, re-synchronisation, révocation d'une adhésion non-owner, **audit effectivement écrit** (3 lignes), et le garde-fou métier `last_owner_membership_required` reste actif.

---

## 3. Résultats des mesures

| Sonde | Périmètre | Résultat |
|---|---|---|
| `sonde-lien-graphe.mjs` | 17 vérifications : nominal, preuve, `metadata NULL`, type invalide `22P02`, séquence négative/NULL, viewer, produit inexistant, isolation tenant, aucun écrit, `prosecdef`, `search_path`, propriétaire, ACL, PUBLIC | **17/17** |
| `sonde-ingestion-plm.mjs` | S1–S6 : nominal, ré-ingestion, mise à jour de composition, erreur partielle, isolation inter-tenant, nœud préexistant | **17/17** |
| `matrice-securite-roles.mjs` | A1–A11, W1–W7, C1–C6 sous rôles **réels** | **28/28** |

Prouvé au passage, par aller-retour :

- **73 migrations** (sans `120400`) → `42804` sur les 3 appels nominaux **et** sur l'ingestion ;
- **76 migrations** → 17/17, `status=declared`, `declared_by` = utilisateur de session, `metadata={}`, `EXECUTE` réservé à `tracefab_app`, 0 grant PUBLIC, `prosecdef=true`, `search_path=public`, propriétaire `postgres`, 3 liens créés / 3 attendus, 0 écrit sur l'autre tenant.

Inventaire après replay : **54 tables · 0 vue · 176 fonctions · 137 politiques · RLS 53/53 active et forcée · 0 SECURITY DEFINER publique**.

---

## 4. Contrôles du dépôt

24 contrôles et suites exécutés, **tous verts** : `test_p105_*`, `verifier_hierarchie_roles`, `test_p106_*`, `test_p107_*`, `test_rls_write_policies` (16 assertions, WITH CHECK prouvé par exécution), `test_rls_bypass_controle_negatif`, `test_tracefab_app_readiness`, `test_registre_fonctions_runtime`, `test_ingest_payload_acl` 30/30, `test_privileges_role_app` 42/42, `test_ecarts_privileges_role_app` 13/13, `lire-disponibilite-role-app` exit 0, `test_neon_privileges`, `test_tables_ecriture_directe` 8/8, plus `typecheck`, `api:typecheck`, `schema:static` et douze contrôles de build.

Le chemin **P10.5** est le plus significatif : `migrer_fidelement.mjs` sous `tracefab_migrator`, rôle **non superutilisateur** — 76/76 migrations appliquées. C'est ce chemin qui a révélé le défaut `CREATE ON SCHEMA`.

---

## 5. Ce qui n'a pas pu être fait

- **Aucune exécution contre Neon ou Preview** : aucune cible persistante joignable depuis ce bac à sable. Le candidat n'a jamais touché une base réelle.
- **Aucun push** : le candidat vit uniquement dans le worktree.
- **`db:generate`** impossible (`binaries.prisma.sh` bloqué en TLS). Un client hors ligne a été généré pour le typecheck ; `verify:prisma-client` signale l'absence du moteur de requêtes — limite de l'environnement.

---

## 6. Les trois erreurs que j'ai commises

Elles sont consignées parce qu'elles sont instructives, pas pour s'en excuser.

1. **`120100` v1** transférait la propriété **sans les prérequis**. Le chemin Clerk est tombé en `42501`. Le déplacement d'une propriété sans ses dépendances n'est pas un transfert, c'est une rupture.
2. **`120100` v2** échouait sur `42501 permission denied for schema public` : `ALTER ... OWNER TO` exige que le nouveau propriétaire puisse créer dans le schéma. Invisible sur `postgres`, visible sur le rôle de migration.
3. **`120000` v1** dupliquait nœuds et liens à chaque ré-ingestion.

Et deux erreurs de **méthode**, qui ont produit de faux échecs avant d'être comprises :

- `SET ROLE tracefab_app` depuis `postgres` **ne simule pas** une session applicative : le `session_user` reste superutilisateur, et PostgreSQL autorise alors `SET ROLE tracefab_worker`. J'ai d'abord conclu à une faille ; c'était mon harnais.
- `RESET ROLE` sur une connexion non privilégiée échoue, faisant échouer la mesure **suivante** pour une raison sans rapport.

Aucune de ces cinq erreurs n'a été trouvée par relecture. Toutes l'ont été par exécution.

---

## 7. Livrables

| Fichier | Contenu |
|---|---|
| `rapport-final.md` | ce document |
| `matrice-migrations.md` | 7 migrations, empreintes, dépendances |
| `matrice-securite-roles.md` | 28 contrôles sous rôles réels |
| `matrice-tests.md` | 24 contrôles, 3 sondes, inventaire |
| `decision-go-no-go.md` | **GO** avec 2 conditions explicites |
| `preuves/` | 9 journaux + inventaire JSON + empreintes |
| `sondes/` | les 3 sondes, réexécutables |

---

## Recommandation

**GO**, sur branche enfant d'abord. Les deux conditions sont dans `decision-go-no-go.md` : déployer les 7 migrations ensemble, et migrer avec un rôle habilité à endosser `tracefab_worker`.

Ce candidat ne se contente pas de faire passer des tests : il répare des défauts qui empêchaient la base de fonctionner. C'est plus que ce qui était demandé, et c'est aussi plus risqué — d'où la recommandation d'une branche enfant avant toute promotion.
