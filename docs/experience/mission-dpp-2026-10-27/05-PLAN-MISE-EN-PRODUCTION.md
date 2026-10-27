# Plan de mise en production — migrations DPP

**Statut : PRÊT À EXÉCUTER PAR UN OPÉRATEUR. Non exécuté.**
**Date :** 27 octobre 2026 · **Révision :** 27 octobre 2026, après la migration
corrective n° 59 · **Branche de travail :** `arena/c27ddaa4-tracefab`
**Base de production (jamais touchée) :** `ep-polished-night-b1jc5941.c-5.eu-central-1.aws.neon.tech`

> ⚠️ Ce document décrit une intervention **non encore effectuée**. Aucune
> migration n'a été appliquée en production, aucun produit n'y a été recalculé,
> aucun déploiement n'a été déclenché.

---

## 1. Ce qui a été prouvé, et où

| Preuve | Environnement | Résultat |
|---|---|---|
| Chaîne complète des 59 migrations | PostgreSQL WASM | PASS (`test:dpp:migrations`, 59/59) |
| Chaîne complète, base jetable | PostgreSQL 17, CI GitHub Actions | PASS (à rejouer sur 59) |
| Reprise 56 → 58 avec données | **PostgreSQL 18.4 réel, base de forme production** | **PASS** — 56 appliquées, puis 2 |
| Chaîne complète des 59 migrations | **PostgreSQL 18.4 réel, base recréée de zéro** | **PASS** — 59/59, y compris la 59<sup>e</sup> |
| Revue et publication (6 cas + idempotence) | **PostgreSQL 18.4 réel, 59 migrations** | **PASS** (`scripts/test_dpp_review_and_publication.mjs`) |
| Simulation du recalcul avec rollback | **PostgreSQL 18.4 réel** | **PASS** — parc dérivé détecté, base restaurée à l'identique (`scripts/simuler_recalcul_dpp.mjs`) |
| Quatre contrôles du §9 | même base | PASS |
| Sept scénarios de calcul DPP | même base | PASS |
| Effet mesuré sur 18 produits | même base | voir §3 |
| Idempotence du recalcul | même base, 59 migrations | **prouvée à l'identique** : deux passages successifs ne changent plus rien (statut, score, empreinte, revue, slug, visibilité, nombre d'événements et d'audits) — voir §4.2 |

**Ce qui n'a pas été prouvé** : rien de tout cela sur une branche Neon. La
création d'une branche Neon exige un accès que cet environnement n'a pas
(`api.neon.tech` est hors du réseau autorisé). Voir §7.

## 2. Migrations à appliquer — ordre impératif

| Ordre | Migration | Effet |
|---|---|---|
| 1 | `20261021170000_dpp_readiness_truthful_gates` | profil DPP à **13 exigences** + fonction `tracefab_dpp_requirement_met` |
| 2 | `20261027100000_dpp_quality_gate_requires_assessment` | `quality.no_open_issues` exige une évaluation persistée |
| 3 | `20261027130000_dpp_review_preservation_and_publication_coherence` | la revue survit à un recalcul sans changement de contenu ; un passeport publié devenu non conforme est **suspendu** au lieu de rester visible avec un statut faux |

**L'ordre inverse efface la correction.** Les deux font un `CREATE OR REPLACE`
sur la même fonction : appliquer la seconde d'abord, puis la première, réinstalle
la version fautive **sans lever d'erreur**. `prisma migrate deploy` applique
l'ordre lexicographique, qui est le bon. C'est la raison principale de ne jamais
jouer ce SQL à la main.

Aucune autre migration n'est en attente : la production s'arrête à
`20261023120000_revoke_app_default_dml` (22/10), et les trois ci-dessus sont les
seules postérieures. La 3<sup>e</sup> **dépend des deux premières** : elle fait un
`CREATE OR REPLACE` de `tracefab_compute_dpp_readiness` et n'aurait aucun sens
appliquée avant elles. L'ordre lexicographique de `prisma migrate deploy` est le
bon ; ne pas l'inverser.

## 3. Effet mesuré sur un parc de 18 produits

Mesuré sur une base PostgreSQL 18.4 réelle, ramenée à l'état exact de la
production (56 migrations, profil à 9 exigences), peuplée de 18 produits
**synthétiques** couvrant six profils de complétude.

| Comportement | Avant | Après | Lecture |
|---|---|---|---|
| Produits complets et évalués (4) | 100 % `data_ready` | 100 % `data_ready` | aucune régression |
| **Origine matière non documentée (3)** | **100 % `data_ready`** | **92 % `in_progress`** | **faux vert supprimé** |
| Sans évaluation qualité (4) | 89 % `in_progress` | 92 % `in_progress` | restent bloqués, à juste titre |
| Description absente (3) | 67 % `review_required` | 85 % `review_required` | score plus juste, décision inchangée |
| Sans document (2) | 78 % `review_required` | 77 % `review_required` | décision inchangée |
| Brouillons (2) | 78 % `in_progress` | 85 % `in_progress` | ne peuvent pas être revus |

**Résultat décisif : 3 produits sur 18 (17 %) perdaient leur statut « prêt »
après la migration** — non parce qu'ils ont changé, mais parce que la règle
`materials.origin_documented` n'existait pas encore. Ils étaient déclarés prêts
sans que l'origine de leur matière soit documentée.

⚠️ Ces 18 produits sont **synthétiques**. Les 18 produits réels de production
n'ont pas été lus (aucun accès). Le taux de 17 % est une **illustration du
mécanisme**, pas une prévision sur vos données.

## 4. Conséquences à connaître avant d'appliquer

### 4.1 Ce qui change pour l'utilisateur

- Le compteur de préparation passe de « sur 9 » à « sur 13 » exigences.
- Les dossiers déjà calculés **restent à leur ancien score** (54 % pour un
  dossier parfait) tant qu'ils ne sont pas recalculés : leur évaluation
  persistée porte encore les 9 anciennes exigences.
- Le bouton « Valider & prêt à publier » n'apparaît qu'après recalcul **et**
  satisfaction des 13 exigences.

### 4.2 Recalcul : idempotent, et il ne détruit plus la revue

**Défaut constaté avant la migration n° 59.** `tracefab_compute_dpp_readiness`
faisait un `UPSERT` sur `(product_id, product_version, profile_key,
profile_version)` qui remettait `reviewed_at` et `reviewed_by` à `NULL` **par
défaut**, et réécrivait `readiness_status`. Un dossier revu redevenait `data_ready`
non revu pour un simple recalcul, même quand aucune donnée n'avait changé.

**Comportement après la migration n° 59** — vérifié par
`scripts/test_dpp_review_and_publication.mjs` sur PostgreSQL 18.4 :

| Situation | Avant la 59<sup>e</sup> | Après la 59<sup>e</sup> |
|---|---|---|
| Contenu inchangé | revue perdue | **revue conservée** (`reviewed_at`, `reviewed_by`, statut) |
| Contenu modifié | revue perdue, sans motif | **revue invalidée avec motif** `source_snapshot_changed`, horodatée |
| Deux recalculs successifs | empreinte et revue réécrites | **rien ne change** : statut, score, empreinte de contenu, revue, slug, visibilité, nombre d'événements et d'audits |

La comparaison porte sur une empreinte de **contenu** (`review_basis_fingerprint`)
qui exclut les valeurs techniques mouvantes — `captured_at`, `product.updated_at`,
`computed_at` et l'identifiant du dernier score. `input_fingerprint`, déjà exposée
par l'API, n'est pas modifiée.

### 4.3 Dossiers publiés : le recalcul peut désormais publier ou suspendre

`tracefab_product_is_public` exige trois conditions **ensemble** :
`public_slug` non nul, dossier `published`, **et** `reviewed_at` non nul. C'est
l'invariant « public = revu ».

Avant la n° 59, recalculer un dossier publié laissait le slug en place tout en
effaçant la revue : le passeport restait **nommé** mais devenait
**introuvable publiquement**, sans trace. C'était le pire des deux mondes.

Après la n° 59, un dossier publié qui ne satisfait plus les exigences est
**suspendu atomiquement**, dans la même transaction :

- `public_slug` effacé sur `tracefab_products` → l'URL publique ne résout plus ;
- statut ramené à `review_required`, revue invalidée avec le motif
  `publication_suspended_nonconforming` ;
- événement `publication_suspended` dans `dpp_lifecycle_events` et audit
  `dpp.publication_auto_suspended` ;
- le dossier reste **republiable** après correction, recalcul et nouvelle revue
  humaine (vérifié : republier sans revue est refusé).

Conséquence opérationnelle : un recalcul n'est plus « neutre » sur un parc
publié — il peut retirer des passeports du public. **Ce n'est pas une raison de
ne pas recalculer, c'est une raison de mesurer avant.** La simulation du §5.6
donne la liste exacte des passeports qui changeraient de visibilité.

En production, aucun dossier n'est publié à ce jour (`dossiers_publies_sans_evaluation: 0`),
donc l'effet immédiat attendu est nul ; le mécanisme protège l'avenir.

## 5. Procédure d'intervention

### 5.1 Prérequis

- [ ] Autorisation explicite du responsable de la production.
- [ ] Point de restauration : branche Neon créée depuis la production (retour
      arrière par bascule de branche, sans perte).
- [ ] `DATABASE_URL` de production fournie par le canal habituel, **jamais**
      dans un ticket ou un journal.
- [ ] Fenêtre de faible activité : la migration pose des verrous sur
      `dpp_requirement_profiles` et redéfinit une fonction.

### 5.2 Commandes

```bash
# 1. Se placer sur le code validé
git fetch origin && git checkout <SHA validé>
npm ci

# 2. Vérifier AVANT (lecture seule)
DATABASE_URL='…' npx prisma migrate status
#    attendu : « 59 migrations found », 3 non appliquées

# 3. Sauvegarde logique des tables concernées (recommandé : la 59e ajoute des
#    colonnes et peut effacer des slugs si un dossier publié est non conforme)
pg_dump "$DATABASE_URL" --data-only -t dpp_requirement_profiles -t dpp_records \
  -t tracefab_products \
  > dpp_avant_$(date +%Y%m%d%H%M).sql

# 4. Appliquer
DATABASE_URL='…' npm run db:deploy

# 5. Contrôles immédiats (voir 5.3)
```

`npm run db:deploy` = `prisma migrate deploy`. Il n'écrit **aucune donnée
métier** : il crée/redéfinit des objets et consigne les trois migrations dans
`_prisma_migrations`.

### 5.3 Contrôles immédiats après migration

```bash
DATABASE_URL='…' npm run test:dpp:branche
```

Ce script exécute les quatre contrôles du §9 et les sept scénarios de calcul.
Il refuse de s'exécuter si l'hôte est celui de la production… **il faut donc
lancer les contrôles à la main en production**, requête par requête, avec le
contenu du §9 de `04-ECART-PRODUCTION-CONSTATE.md`. C'est volontaire : les
scripts de ce dépôt ne sont pas autorisés à écrire en production.

Les quatre valeurs attendues :

| Contrôle | Attendu |
|---|---|
| Profil actif | `textile_readiness_mvp` v1.0, **13** exigences |
| Fonction | les 13 exigences du profil implantées, dont `quality.no_open_issues` |
| Registre | **59** migrations terminées, aucune en échec |
| Colonnes de revue | `dpp_records` porte `review_basis_fingerprint`, `reviewed_basis_fingerprint`, `review_invalidated_at`, `review_invalidation_reason` |
| Privilèges | `PUBLIC` : false · `tracefab_app` : false |

### 5.4 Surveillance (24 h)

- Erreurs 5xx sur `/api/products/*/dpp`, `/dpp/publish-review`, `/dpp/publication`.
- Aucune écriture attendue dans `dpp_records` par la migration elle-même.
- Les écrans DPP affichent « sur 13 exigences » : c'est le signe que le code et
  la base sont enfin alignés.

### 5.5 Conditions d'arrêt

- Une migration échoue → **arrêt immédiat**, ne pas relancer, ne pas corriger à
  chaud : restaurer la branche et analyser.
- `prisma migrate status` signale une dérive (`checksum` modifié) → arrêt.
- Les contrôles §9 donnent autre chose que le tableau ci-dessus → arrêt.

### 5.6 Simulation obligatoire avant tout recalcul

Aucun recalcul ne doit être lancé sur le parc réel avant d'avoir mesuré son
effet. `scripts/simuler_recalcul_dpp.mjs` le mesure **sans rien conserver** :

```bash
DATABASE_URL='…'                       # la base visée (jamais la production)
TF_SIMULATION_CIBLE='<hôte exact>'     # l'opérateur nomme la cible
node scripts/simuler_recalcul_dpp.mjs --sortie sim_$(date +%Y%m%d%H%M).json
```

Il ouvre une transaction, exécute le vrai moteur de calcul, relève avant/après
(statut, score, revue, slug, visibilité publique), puis fait **toujours
`ROLLBACK`** et vérifie que la base est identique à l'instant d'avant
(compteurs et empreintes de `dpp_records`, `tracefab_products`,
`dpp_lifecycle_events`, `audit_logs`). Si la vérification échoue, il sort en
code 4.

Il refuse de s'exécuter si l'hôte est celui de la production, et si
`TF_SIMULATION_CIBLE` ne correspond pas exactement à l'hôte de `DATABASE_URL`.
Il n'imprime jamais l'URL de connexion.

Ce que le bilan doit contenir avant d'autoriser un recalcul : nombre de dossiers
examinés, dossiers dont le statut ou le score changerait, revues qui seraient
invalidées, et **passeports dont la visibilité publique changerait**. Si ce
dernier nombre est supérieur à zéro, la décision revient au responsable
métier — pas à l'opérateur.

## 6. Retour arrière — limites

**Les migrations de schéma ne sont pas annulables par un simple rollback.**

| Objet | Réversible ? |
|---|---|
| Corps de `tracefab_dpp_requirement_met` | oui, en réappliquant le SQL de `20261021170000` puis de `20260923130000` |
| Ligne du profil (9 → 13 exigences) | oui, en restaurant `dpp_requirement_profiles` depuis la sauvegarde |
| Lignes `_prisma_migrations` | **non** : les retirer à la main désynchronise le registre. La bonne voie est la restauration de branche |
| `dpp_records` (recalculs) | seulement depuis la sauvegarde ; les revues perdues ne se reconstituent pas |
| Colonnes ajoutées par la 59<sup>e</sup> | sans effet si laissées en place ; les retirer à la main (`DROP COLUMN`) n'apporte rien et perd l'historique d'invalidation |
| Corps de `tracefab_compute_dpp_readiness` | oui, en réappliquant `20261027100000`, mais on réinstalle alors le défaut A1/A2 — à ne faire qu'en même temps qu'une restauration de branche |

**Stratégie recommandée : branche de restauration Neon**, pas de rollback SQL.
La branche se bascule en quelques secondes et restaure l'état complet.

## 7. Ce qui manque pour valider sur une vraie branche Neon

Cet environnement ne peut pas créer de branche Neon (`api.neon.tech` hors
réseau autorisé). Deux options, au choix :

**Option A — l'opérateur exécute, l'agent analyse.** Sur une branche Neon créée
depuis la production :

```bash
export DATABASE_URL='postgresql://…/<branche>'   # URL de LA BRANCHE, pas de la production
node scripts/migrer_fidelement.mjs --etat          # lecture seule : liste les migrations en attente
npm run db:deploy                                  # application réelle par Prisma
DATABASE_URL=… npm run test:dpp:branche            # §9 + scénarios
```

> `migrer_fidelement.mjs` n'existe que parce que le CLI Prisma est inutilisable
> ici (moteur de schéma indisponible). Sur un poste normal, seul `db:deploy`
> est nécessaire, et c'est lui qui doit être utilisé.

**Option B — l'agent exécute.** Fournir l'URL de connexion d'une **branche de
test** (jamais la production). L'agent lance `db:deploy` et `test:dpp:branche`,
et rend les résultats.

Dans les deux cas, la validation sur branche reste **une répétition** : elle ne
remplace pas l'autorisation d'intervenir en production.

## 8. Preuves à conserver

- Sortie de `prisma migrate status` avant et après.
- Sortie de `npm run db:deploy` (deux migrations appliquées).
- Résultats des quatre contrôles §9.
- Sortie de `npm run test:dpp:branche`.
- Tableau avant/après des produits recalculés.
- Sauvegarde `dpp_avant_*.sql`.
- Rapport JSON de la simulation (`sim_*.json`) **et** le bilan avant/après des
  produits réellement recalculés, s'ils diffèrent.
