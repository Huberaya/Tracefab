# P10.8 — Réconciliation des chaînes de migrations #111 / #113 / #114

**Date** : 2026-11-07 · **Branche** : `arena/0f697b3e-tracefab` · **SHA de départ** : `8846184735d8d27314b69ffc5f03511a6e5cfef9`
**Moteur de mesure** : PostgreSQL **17.11 réel** (`PostgreSQL 17.11 on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 7.5.0-3ubuntu1~18.04) 7.5.0, 64-bit`), cluster jetable local `scripts/p108_pg17_demarrer.sh`, port 55432. Aucune base distante.
**Artefact machine** : `docs/security/2026-11-07-p108-chaine-migrations.json` (7 scénarios, empreintes sha256 de chaque migration appliquée).
**Commande** : `npm run p108:chaines`.

> Ce document est une **mesure d'exécution**, pas une lecture de fichiers : chaque chaîne est appliquée depuis une base **vierge** (`DROP DATABASE … WITH (FORCE)` + `CREATE DATABASE`), migration par migration, dans l'ordre lexicographique des noms de dossier (ordre Prisma). Une chaîne n'est déclarée appliquée que si **toutes** ses migrations passent.

---

## 1. Cartographie des références (rafraîchie le 2026-11-07 à 16:11Z)

| Ref | Tête mesurée / état | Ce qu'elle apporte |
|---|---|---|
| `main` | `788df22019c0d2b39301678ecfbc43ac868561bf` | 69 migrations historiques, **inchangé** |
| #113 (cette branche) | `8846184735d8d27314b69ffc5f03511a6e5cfef9`, `OPEN/MERGEABLE`, 5 commits | `20261105180000_active_tenant_access_guards`, `20261106120000_p107_hmac_forme_canonique_et_ttl` |
| #114 | `f0aeb51cb52ce778f7f9a5e857438603d81fa5ad`, `OPEN/MERGEABLE`, 4 commits | `20261106130000_identite_systeme_signee` (1 migration) |
| #114 ancienne tête | `537bc310d0b6e857c4f74ec0017a130987b22497` | `20261105120000_identite_systeme_signee` |
| #111 | `064fb34631bb4a897da0eedd7986d0eaebd7daf7`, **MERGED** dans #110 | `20261105235900_active_tenant_policy_and_worker_closure` + 16 autres migrations |
| #110 | `b0f7b73c0470fe84d6d3ec575fc482337b5ac933` mesuré ; **nouvelle tête `9a0fa5add34dc97dd321ee6c31ebac4c5f41ceda` à 16:10:14Z** | réécrit 7 migrations historiques |
| #112 | `da8fa542a0a98a5b4260dd8f3347ff632ae579bb`, `DRAFT` | réécrit les mêmes 7 migrations |

**Rafraîchissement #110** : la tête a avancé de `b0f7b73` vers `9a0fa5a` pendant la mission (`git fetch …:refs/remotes/audit/pr110-20261107`). `git diff --name-only b0f7b73..9a0fa5a -- prisma/migrations` = **vide** ; le diff ne porte que sur `.github/workflows/preproduction-prisma-readonly.yml` (+9/−89). **Les mesures de chaîne ci-dessous restent donc valables pour le contenu SQL**, et la nouvelle tête est consignée.

`gh pr checks 113` (lecture seule, avant push P10.8) : **7/7 PASS**, sur l'ancien SHA `8846184` — explicitement **non réutilisé** comme preuve du SHA P10.8.

---

## 2. Sept chaînes mesurées sur PostgreSQL 17.11

| Scénario | Composition | Total | Appliquées | Échecs | Collisions | `SECURITY DEFINER` | Tables FORCE RLS | Empreinte de chaîne |
|---|---|---|---|---|---|---|---|---|
| S1 `#114 seule` | `main + #114` | 70 | **70** | 0 | 4 acceptées | 127 | 53 | `46e484c40309…` |
| S2 `#111 seule` | `main + #111` | 86 | **86** | 0 | 4 acceptées | 126 | 53 | `b0a48f673cfa…` |
| S3 `#111 + #114` | `main + #111 + #114` | 87 | **87** | 0 | 4 acceptées | 128 | 53 | `7c109b474e2d…` |
| S4 `complet avec #113` | `main + #113 + #114` | 72 | **72** | 0 | 4 acceptées | 130 | 53 | `954405f52377…` |
| **S5 canonique définitive** | `main + #113 + #114 + correctif P10.8` | **73** | **73** | 0 | **4 acceptées, 0 nouvelle** | 130 | 53 | `64d26a68af37…` |
| T1 `#111 + ancienne #114` | `main + #111 + #114-ancien` | 87 | **87** | 0 | **5** (＋`20261105120000`) | 128 | 53 | `183fa18cf9d6…` |
| T2 `#110 + #112 + #113 + #114` | chaîne étendue exclue | 94 | **94** | 0 | **5** (＋`20261105180000`) | 131 | 53 | `7775b1bce090…` |

Les 4 collisions **historiques acceptées** sont `20261006120000`, `20261006200000`, `20261006220000`, `20261017120000`. Elles existent déjà dans `main`, sont documentées par `scripts/verifier-horodatages-migrations.mjs` et ne sont **pas** des collisions introduites par P10.8. Les deux collisions supplémentaires de T1/T2 appartiennent à des chaînes **exclues** de la chaîne canonique (voir §4) ; elles ne sont pas « résolues » en réécrivant l'historique.

**Noms identiques, contenus différents** : 7 migrations portent le même nom dans `main` et dans #110/#111/#112 avec des empreintes différentes :
`20261005090000_supplier_portal_advanced_hardening`, `20261009180000_public_read_context`, `20261028120100_worker_identity_not_forgeable`, `20261028120200_document_reserved_fields_internal_only`, `20261028130000_product_computed_fields_column_scoped`, `20261030140000_ingest_payload_role_guard_and_acl`, `20261031120000_identite_hmac_liee_au_contexte`. Les deux jeux d'empreintes sont consignés dans le JSON. Aucune de ces 7 migrations n'a été modifiée dans cette mission.

**Renommage amont #114** : `20261105120000_identite_systeme_signee` (ancienne tête `537bc31`) → `20261106130000_identite_systeme_signee` (tête `f0aeb51`). Le contenu a **aussi** changé (durcissement `registered_by`, plafond 600 s, XOR 32 octets). Ce renommage a supprimé la collision `20261105120000` : T1 l'a encore (5), S3/S4/S5 ne l'ont plus (4). Il reste **un seul renommage de préparation** pour la chaîne étendue : `20261105180000_active_tenant_access_guards` → `20261105180010_…` ; il n'est **pas appliqué** ici.

---

## 3. Ambiguïté d'ordre du candidat P10.7 — résolue

Le candidat P10.7 `docs/security/candidats/2026-11-06-proprietaire-outbox-identite-systeme.sql` portait le nom `20261106120300_outbox_owner_identite_systeme`. Il **préconditionne** le prédicat créé par #114, mais `20261106120300 < 20261106130000` : Prisma l'aurait appliqué **avant** #114. Le harnais P10.7 compensait en l'ajoutant manuellement en fin de liste ; cet ordre n'est pas reproductible par `prisma migrate deploy`.

**Décision** : le candidat n'est **pas recopié**, il est **remplacé** par une nouvelle migration réelle :

```
prisma/migrations/20261107120000_p108_outbox_proprietaire_et_dependances/migration.sql
sha256 = 6bf720822f7a361bf2703a85c7583e66f056f05e5303a6c910ce783f0e7d31dc
```

`20261107120000` trie strictement **après** #114 (`20261106130000`) et après `20261106120000`. Il n'existe aucune branche distante `outbox`/`p108` (`git ls-remote --heads`), et `gh api search/code` ne trouve ni `20261106120300` ni `outbox_owner_identite_systeme` en dehors de cette branche. Le candidat historique reste sous `docs/security/candidats/` pour comparaison, **non appliqué**.

Chaîne canonique définitive : **`main(69) + #113(2) + #114(1) + correctif P10.8(1) = 73 entrées`**, manifeste `docs/security/2026-11-07-p108-chaine-canonique.json` (73 empreintes sha256, 69 historiques byte-pour-byte). Le manifeste P10.7 du 06/11 est **conservé sans réécriture** (`docs/security/2026-11-06-p107-chaine-canonique.json`) : c'est une preuve historique, pas la source de vérité courante.

---

## 4. Exclusions explicites — aucune migration historique modifiée

#110/#111/#112 **réécrivent 7 migrations déjà appliquées sur `main`**. Les intégrer à la chaîne canonique exigerait de modifier l'historique publié : interdit par la mission. Elles sont donc mesurées (S2, S3, T2) mais **exclues** de la chaîne canonique, et la décision est consignée dans le manifeste.

`git diff 788df220..HEAD -- prisma/migrations` : **aucun fichier de migration historique modifié ou supprimé** ; un seul dossier ajouté (`20261107120000_…`). Vérifié aussi par `npm run test:reconciliation-chaine-canonique` : **94 assertions / 0 échec**, dont « les 72 migrations du dépôt figurent toutes dans la chaîne », « le correctif trie APRÈS #114 », « ancien candidat `20261106120300` absent », « substitution explicitement documentée ».

---

## 5. Cohérence Prisma ↔ SQL ↔ fonctions ↔ rôles

Lecture du catalogue après S5 (connexion d'administration du cluster **jetable**) :

* 130 fonctions `SECURITY DEFINER`, **0 exécutable par PUBLIC** ; 53 tables avec RLS active **et** forcée ; 3 politiques sur `tracefab_notification_outbox` (`insert_trusted`, `select_trusted`, `update_trusted`).
* `pg_proc.proowner` / `pg_get_userbyid` : les 13 opérations système gardées par #114 sont possédées par `tracefab_worker` après la corrective (avant : 6 par `tracefab_worker`, 7 par le rôle de migration).
* `pg_get_functiondef` : `claim` et `complete` portent la garde `IF NOT public.tracefab_identite_systeme() THEN RAISE EXCEPTION 'authentication_required'` et un `search_path` figé.
* `pg_policies` : `notification_outbox_update_trusted` = `(CURRENT_USER = 'tracefab_worker'::name)` en **USING et WITH CHECK**. C'est la seconde dépendance, indépendante du `GRANT EXECUTE`.
* `tracefab_identite_systeme()` est `SECURITY INVOKER`, `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO tracefab_worker` ; le vérificateur HMAC est `SECURITY DEFINER`, `search_path = pg_catalog, public`.
* `tracefab_app` : `NOSUPERUSER NOBYPASSRLS NOCREATEROLE`, aucun `INSERT`/`UPDATE` sur l'outbox, aucun `EXECUTE` sur le prédicat, aucun `SELECT` sur `tracefab_identity_cles`, et **pas membre** de `tracefab_worker`.

La déclaration / référencement est donc explicite : #114 **déclare** le prédicat et le accorde au worker ; la corrective **rend** les opérations appelantes propriété du worker ; les politiques RLS **exigent** le worker. Aucune dépendance implicite de rôle ne subsiste.

---

## 6. Reproduction des bases distantes — `BLOCKED`

| Contrôle | Statut | Motif mesuré |
|---|---|---|
| `_prisma_migrations` Production / Préproduction | **BLOCKED** | aucune variable `DATABASE_URL`/`DIRECT_URL`, pas de CLI `psql`/`neonctl`, connecteur Neon `unsupported` |
| SHA servi, corrélation Vercel → Prisma → Neon | **BLOCKED** | connecteur Vercel `enabled` mais `list_projects` → `Access denied` (token/team scope) ; `validate_credential` seul ne donne aucun droit |
| Parcours HTTP authentifiés / protection SSO | **BLOCKED** | Preview sous Vercel SSO, aucun contournement tenté ; connecteur Clerk `unsupported` |
| `main` inchangé | **PASS** | `git ls-remote --heads origin main` = `788df220…` avant et après |

Aucun `BLOCKED` n'a été converti en `PASS`. Aucune action distante modificatrice n'a été exécutée.
