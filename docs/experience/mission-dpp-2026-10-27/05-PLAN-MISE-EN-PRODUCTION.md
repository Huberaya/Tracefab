# Plan de mise en production — migrations DPP

**Statut : PRÊT À EXÉCUTER PAR UN OPÉRATEUR. Non exécuté.**
**Date :** 27 octobre 2026 · **Branche de travail :** `arena/c27ddaa4-tracefab`
**Base de production (jamais touchée) :** `ep-polished-night-b1jc5941.c-5.eu-central-1.aws.neon.tech`

> ⚠️ Ce document décrit une intervention **non encore effectuée**. Aucune
> migration n'a été appliquée en production, aucun produit n'y a été recalculé,
> aucun déploiement n'a été déclenché.

---

## 1. Ce qui a été prouvé, et où

| Preuve | Environnement | Résultat |
|---|---|---|
| Chaîne complète des 58 migrations | PostgreSQL WASM | PASS (`test:dpp:migrations`) |
| Chaîne complète, base jetable | PostgreSQL 17, CI GitHub Actions | PASS |
| Reprise 56 → 58 avec données | **PostgreSQL 18.4 réel, base de forme production** | **PASS** — 56 appliquées, puis 2 |
| Quatre contrôles du §9 | même base | PASS |
| Sept scénarios de calcul DPP | même base | PASS |
| Effet mesuré sur 18 produits | même base | voir §3 |
| Idempotence du recalcul | même base | prouvée en nombre de lignes, **mais voir §4.3** |

**Ce qui n'a pas été prouvé** : rien de tout cela sur une branche Neon. La
création d'une branche Neon exige un accès que cet environnement n'a pas
(`api.neon.tech` est hors du réseau autorisé). Voir §7.

## 2. Migrations à appliquer — ordre impératif

| Ordre | Migration | Effet |
|---|---|---|
| 1 | `20261021170000_dpp_readiness_truthful_gates` | profil DPP à **13 exigences** + fonction `tracefab_dpp_requirement_met` |
| 2 | `20261027100000_dpp_quality_gate_requires_assessment` | `quality.no_open_issues` exige une évaluation persistée |

**L'ordre inverse efface la correction.** Les deux font un `CREATE OR REPLACE`
sur la même fonction : appliquer la seconde d'abord, puis la première, réinstalle
la version fautive **sans lever d'erreur**. `prisma migrate deploy` applique
l'ordre lexicographique, qui est le bon. C'est la raison principale de ne jamais
jouer ce SQL à la main.

Aucune autre migration n'est en attente : la production s'arrête à
`20261023120000_revoke_app_default_dml` (22/10), et les deux ci-dessus sont les
seules postérieures.

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

### 4.2 Recalcul : idempotent, mais destructeur de revue

`tracefab_compute_dpp_readiness` fait un `UPSERT` sur
`(product_id, product_version, profile_key, profile_version)` :

- **idempotent en nombre de lignes** — vérifié : 18 lignes avant, 18 après deux
  passages ;
- **mais il remet `reviewed_at` et `reviewed_by` à `NULL`**, et réécrit
  `readiness_status`. Vérifié : un dossier `ready_to_publish` revu redevient
  `data_ready` non revu après un simple recalcul.

### 4.3 Dossiers publiés : ne pas recalculer sans décision

`tracefab_product_is_public` ne dépend que de `public_slug`, pas du statut du
dossier. Recalculer un dossier `published` :

- laisse le slug en place → **le passeport reste publiquement accessible** ;
- remet le dossier à un statut calculé → **l'état affiché ne dit plus « publié »**.

C'est une incohérence d'état, pas une fuite. En production, **aucun dossier
n'est publié** (`dossiers_publies_sans_evaluation: 0`, et aucune publication
réalisée à ce jour), donc le cas ne se présente pas aujourd'hui. Il se
présentera au premier passeport publié : la procédure devra alors suspendre,
recalculer, puis republier.

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
#    attendu : « 58 migrations found », 2 non appliquées

# 3. Sauvegarde logique des deux tables concernées (facultatif mais recommandé)
pg_dump "$DATABASE_URL" --data-only -t dpp_requirement_profiles -t dpp_records \
  > dpp_avant_$(date +%Y%m%d%H%M).sql

# 4. Appliquer
DATABASE_URL='…' npm run db:deploy

# 5. Contrôles immédiats (voir 5.3)
```

`npm run db:deploy` = `prisma migrate deploy`. Il n'écrit **aucune donnée
métier** : il crée/redéfinit des objets et consigne les deux migrations dans
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
| Registre | **58** migrations terminées, aucune en échec |
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

## 6. Retour arrière — limites

**Les migrations de schéma ne sont pas annulables par un simple rollback.**

| Objet | Réversible ? |
|---|---|
| Corps de `tracefab_dpp_requirement_met` | oui, en réappliquant le SQL de `20261021170000` puis de `20260923130000` |
| Ligne du profil (9 → 13 exigences) | oui, en restaurant `dpp_requirement_profiles` depuis la sauvegarde |
| Lignes `_prisma_migrations` | **non** : les retirer à la main désynchronise le registre. La bonne voie est la restauration de branche |
| `dpp_records` (recalculs) | seulement depuis la sauvegarde ; les revues perdues ne se reconstituent pas |

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
