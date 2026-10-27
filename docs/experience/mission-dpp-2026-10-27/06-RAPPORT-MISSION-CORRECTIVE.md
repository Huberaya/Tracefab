# Mission corrective DPP — recalcul sécurisé, publication cohérente, parc réel

**Date :** 27 octobre 2026 · **Branche :** `arena/c27ddaa4-tracefab` ·
**PR :** #102 (brouillon, fusion différée)
**Production :** jamais touchée. Aucune migration, aucun recalcul, aucun
déploiement.

> Ce rapport ne compte **aucune recommandation comme une correction**, aucun
> test écrit comme un test réussi, aucune page accessible comme un parcours
> fonctionnel. Chaque affirmation est suivie de l'environnement qui la porte :
> **base de test locale**, **test automatisé exécuté**, **lecture de code**, ou
> **non prouvé**.

---

## Registre d'avancement

| # | Étape | Statut | Preuve / justification |
|---|---|---|---|
| 1 | A — état initial de la base et du registre | **TERMINÉE ET VÉRIFIÉE** (local) | PostgreSQL 18.4 recréé de zéro, 59/59 migrations, registre lu |
| 2 | A — état de la production | **TERMINÉE ET VÉRIFIÉE** (lecture seule, 27/10 matin) | 56 migrations appliquées, 2 manquantes ; voir `04-ECART-PRODUCTION-CONSTATE.md` |
| 3 | B — branche Neon isolée `tracefab-dpp-readiness-validation` | **BLOQUÉE** — JUSTIFICATION FOURNIE | `api.neon.tech` et `console.neon.tech` injoignables (`000`) ; aucune clé API Neon dans l'environnement. Le proxy Postgres (TCP 5432) répond, mais **créer** une branche exige l'API. Procédure opérateur fournie (§8.3) |
| 4 | C — `npm run db:deploy` sur la branche | **BLOQUÉE** (dépend de 3) — JUSTIFICATION FOURNIE | Sans branche, pas de cible. En local, le CLI Prisma est inutilisable (moteur de schéma injoignable) : `scripts/migrer_fidelement.mjs` a servi de substitut et **ne vaut pas preuve officielle**. En revanche `prisma migrate deploy` a bien été exécuté, par la CI, sur un PostgreSQL 17 jetable (§3) |
| 5 | D — les 4 requêtes du §9 | **TERMINÉE ET VÉRIFIÉE** (base de test) | Exécutées par `scripts/valider_branche_dpp.mjs` : 4/4 conformes (§4) |
| 6 | E — 5 scénarios de calcul DPP | **TERMINÉE ET VÉRIFIÉE** (base de test) | 7 scénarios exécutés (S1–S7), tous conformes ; aucun forcé à 100 % (§5) |
| 7 | F — identifier et recalculer les 18 produits | **BLOQUÉE** — JUSTIFICATION FOURNIE | Les produits réels n'ont pas été lus (aucun accès, aucune autorisation). Ce qui est fait à leur place : simulation lecture seule **prouvée** (§6) |
| 8 | G — corriger les échecs constatés | **TERMINÉE ET VÉRIFIÉE** | Migration corrective n° 59 + 8 cas de non-régression exécutés (§7) |
| 9 | H — plan de production | **TERMINÉE ET VÉRIFIÉE** (rédigé, non exécuté) | `05-PLAN-MISE-EN-PRODUCTION.md`, révisé pour 3 migrations (§8) |
| 10 | Correction A1 — la revue ne doit pas être effacée par défaut | **TERMINÉE ET VÉRIFIÉE** | CAS 1, 2, 7, 8 : conservation, invalidation motivée, reprise des revues antérieures |
| 11 | Correction A2 — cohérence de la publication publique | **TERMINÉE ET VÉRIFIÉE** | CAS 3, 4, 5, 6 : reste publié, suspension, republication, retrait |
| 12 | Correction A3 — idempotence complète | **TERMINÉE ET VÉRIFIÉE** | Deux passages : statut, score, empreinte, revue, slug, visibilité, événements, audits identiques |
| 13 | C — simulation lecture seule sur parc réel | **TERMINÉE ET VÉRIFIÉE** (mécanisme), **NON EXÉCUTÉE** sur les données réelles | `scripts/simuler_recalcul_dpp.mjs` : parc dérivé détecté, base restaurée à l'identique (empreintes + compteurs) |
| 14 | Politique de routage des suites destructives (CI) | **TERMINÉE ET VÉRIFIÉE** | `npm run test:db-routing` : OK après classification et ajout des modes `--dry-run` |
| 15 | Mission de clôture — migration sur la branche Neon | **BLOQUÉE** — JUSTIFICATION FOURNIE | aucune chaîne de connexion fournie (gabarit dans la consigne, rien dans l'environnement) ; API Neon injoignable. Voir §11 |
| 16 | Mission de clôture — outillage prêt à exécuter | **TERMINÉE ET VÉRIFIÉE** (local) | `verifier_identite_branche.mjs` (codes 0/3/5 éprouvés), `simuler_recalcul_dpp.mjs` réécrit (tableau + classement), `--dry-run` sur le harnais §9 |
| 17 | Mission de clôture — procédure opérationnelle | **TERMINÉE ET VÉRIFIÉE** | `07-PROCEDURE-VALIDATION-NEON.md` : étapes bloquantes, valeurs attendues, conditions d'arrêt, modèle de rapport |
| 18 | Mission de clôture (3ᵉ passe, `br-sweet-king-b1n2f4u6`) | **BLOQUÉE** — JUSTIFICATION FOURNIE | ni `DATABASE_URL`, ni accès réseau : `api.neon.tech` et le Preview Vercel répondent `000`. Voir §11.4 |
| 19 | Parcours DPP sous le rôle applicatif réel, sous RLS | **TERMINÉE ET VÉRIFIÉE** (local) | `test:dpp:role-applicatif` : lecture bornée, isolation par non-appartenance, écriture directe refusée, calcul/revue accessibles, aucune trace après `ROLLBACK` |
| 20 | Privilèges et RLS du rôle applicatif | **TERMINÉE ET VÉRIFIÉE** (local) | section dédiée de `verifier_identite_branche.mjs` : SELECT seul sur les tables DPP, `PUBLIC` sans `EXECUTE` |
| 21 | Vérifier qu'aucune route publique ne sert un passeport suspendu | **PARTIELLEMENT PROUVÉE** | Preuve en base (CAS 4, 6) ; côté API, **lecture de code** : le résolveur public exige `public_slug` + `published` + `reviewed_at`. Aucun test HTTP exécuté |

---

## 1. Résultat global

**Le recalcul DPP ne détruit plus une approbation humaine, et un passeport
public ne peut plus devenir invisible en silence.**

Deux défauts réels ont été reproduits, puis corrigés par une migration
corrective (la 59<sup>e</sup>), et la correction est tenue par huit cas de
non-régression exécutés sur un PostgreSQL 18.4 réel :

| Défaut reproduit | Conséquence mesurée avant correction | État |
|---|---|---|
| `tracefab_compute_dpp_readiness` remettait `reviewed_at`/`reviewed_by` à `NULL` à chaque recalcul | un dossier approuvé redevenait « non revu » **même sans aucun changement de données** | corrigé, testé |
| `tracefab_product_is_public` exige `public_slug` **et** `published` **et** `reviewed_at` | recalculer un dossier publié le rendait **invisible publiquement tout en gardant son slug** | corrigé, testé |
| Aucune politique de suspension n'existait | un passeport publié devenu non conforme restait « publié » à l'écran | corrigé, testé (suspension atomique, réversible, tracée) |
| Les revues antérieures à la migration n'avaient pas d'empreinte de contenu | **risque réel découvert en cours de route** : elles seraient toutes tombées au premier recalcul | corrigé, testé (CAS 7 et 8) |

Trois choses ne sont **pas** faites, et le resteront tant qu'un opérateur n'aura
pas agi : la branche Neon isolée, `prisma migrate deploy` en conditions
officielles, et le recalcul des produits réels. Aucune des trois n'est
contournée par un substitut présenté comme équivalent.

## 2. Identité environnement

| Élément | Valeur | Vérifié comment |
|---|---|---|
| Base de test locale | PostgreSQL **18.4**, `127.0.0.1:55435`, base `tf59` | `SELECT version()` |
| Base de reprise | même serveur, base `tf58` (58 migrations, puis la 59<sup>e</sup>) | registre `_prisma_migrations` |
| Migrations du dépôt | **59** | `ls prisma/migrations/*/migration.sql \| wc -l` |
| Registre local | 59 terminées, 0 en échec | requête A3 du §9 |
| Production | `ep-polished-night-…eu-central-1.aws.neon.tech` — **jamais contactée en écriture** | refus codés dans tous les scripts |
| Neon (branche) | **inaccessible** : API HTTP injoignable, aucune clé | `curl` → `000`, variables d'environnement absentes |

Aucune URL de connexion complète, aucun mot de passe, aucun secret ne figure
dans ce rapport, dans les scripts ou dans les journaux produits : seul l'hôte
est imprimé.

## 3. Migrations

| Ordre | Migration | État dépôt | Appliquée en production ? |
|---|---|---|---|
| 57 | `20261021170000_dpp_readiness_truthful_gates` | présente | **non** |
| 58 | `20261027100000_dpp_quality_gate_requires_assessment` | présente | **non** |
| 59 | `20261027130000_dpp_review_preservation_and_publication_coherence` | **nouvelle, corrigée dans cette mission** | **non** |

Ce que fait la 59<sup>e</sup> :

1. ajoute quatre colonnes à `dpp_records` — `review_basis_fingerprint`,
   `reviewed_basis_fingerprint`, `review_invalidated_at`,
   `review_invalidation_reason` ;
2. calcule une empreinte de **contenu** distincte de `input_fingerprint`, en
   excluant les valeurs techniques qui bougent à chaque écriture
   (`captured_at`, `product.updated_at`, `computed_at`, identifiant du dernier
   score). **`input_fingerprint` n'est pas modifiée** : elle est déjà exposée
   par l'API, la changer serait une rupture ;
3. ne conserve une revue que si le contenu examiné est identique ; sinon
   l'invalide avec date et motif (`source_snapshot_changed`) ;
4. suspend atomiquement un passeport publié qui ne satisfait plus les
   exigences : slug effacé, statut `review_required`, événement
   `publication_suspended`, audit `dpp.publication_auto_suspended` ;
5. ne pose ni `BEGIN` ni `COMMIT` : Prisma gère la transaction, comme les 58
   autres.

**Chaîne complète vérifiée trois fois** :

1. base locale recréée de zéro → 59/59 appliquées (harnais local) ;
2. base locale laissée à 58 → la 59<sup>e</sup> s'ajoute seule, sans erreur, et
   les quatre revues posées avant la migration survivent ;
3. **CI, job « Base — isolation RLS exécutée »** : `prisma migrate deploy`
   (l'outil officiel, pas un substitut) applique les 59 migrations sur un
   PostgreSQL 17 jetable, puis la suite de non-régression revue/publication y
   passe. Étape « Appliquer les migrations sur la base jetable » : `success` ;
   étape « Revue et publication — non-régression sur base migrée » : `success`
   (exécution CI n° 40520806155).

C'est la seule exécution **officielle** du registre de migrations dont ce dépôt
dispose aujourd'hui. Elle ne remplace pas une branche Neon dérivée de la
production : le moteur est le même, les données ne le sont pas.

## 4. Les quatre requêtes du §9

Exécutées sur `tf59` (59 migrations), par `scripts/valider_branche_dpp.mjs` :

| # | Contrôle | Résultat obtenu | Attendu | Verdict |
|---|---|---|---|---|
| 1 | Profil actif | `textile_readiness_mvp` v1.0, actif, **13** exigences | 13 | **conforme** |
| 2 | Fonction vs profil | 13 exigences de profil, **toutes implantées** ; 15 clés au total (2 branches héritées conservées) ; `quality.no_open_issues` présente | 13 implantées | **conforme** |
| 3 | Registre | **59** migrations terminées, **0** en échec | 59 | **conforme** |
| 4 | Privilèges | `PUBLIC` : `false` · `tracefab_app` : `false` | `false`, `false` | **conforme** |

**Ces quatre requêtes n'ont pas été exécutées en production.** Elles y restent à
faire par un opérateur, requête par requête (§8.2).

## 5. Tests DPP

### 5.1 Sept scénarios de calcul (`valider_branche_dpp.mjs`) — **PASS**

| Scénario | Résultat |
|---|---|
| S1 produit complet | `data_ready`, 13/13 exigences |
| S2 sans évaluation qualité | `in_progress`, `quality.no_open_issues = false` |
| S3 description trop courte | `review_required` |
| S4 anomalie ouverte | bascule `data_ready` → `in_progress` |
| S5 sans document | `review_required`, traçabilité non documentée |
| S6 quatre revues refusées pour dossier incomplet | refus obtenus |
| S7 brouillon | `in_progress`, `product.not_draft = false` |

Aucun scénario n'est forcé à 100 % : les statuts sont ceux que le moteur
produit, y compris les refus.

### 5.2 Revue et publication (`test_dpp_review_and_publication.mjs`) — **PASS, 32 vérifications**

| Cas | Ce qu'il prouve |
|---|---|
| CAS 1 | données inchangées → revue conservée, statut revu conservé, empreintes identiques |
| CAS 2 | données modifiées → revue invalidée, horodatée, motif `source_snapshot_changed`, dossier retombé sous `data_ready` |
| CAS 3 | publié et conforme → reste `published`, slug conservé, toujours visible |
| CAS 4 | publié devenu non conforme → **suspendu**, slug effacé, plus visible, événement + audit tracés, revue invalidée avec motif de suspension |
| CAS 5 | republication : refusée sans nouvelle revue, acceptée après correction + revue + publication, historique des deux publications conservé |
| CAS 6 | suspension manuelle et retrait → slug et visibilité retirés ; le dossier reste revu et republicable |
| CAS 7 | **revue antérieure à la migration**, contenu inchangé → survit et est mise à niveau |
| CAS 8 | revue antérieure, contenu modifié → invalidée |

### 5.3 Idempotence (A3) — **PASS**

Deux recalculs successifs sur le même dossier : **rien ne change** — statut,
score (13/13), empreinte, `reviewed_at`, `reviewed_by`, slug, visibilité
publique, nombre de lignes, nombre d'événements, nombre d'audits.

Une nuance, mesurée et assumée : le **premier** recalcul qui suit une
publication peut réécrire `input_fingerprint`, parce que celle-ci contient
`product.updated_at` et que publier écrit ce champ. C'est une valeur technique ;
l'empreinte de revue, elle, ne bouge pas. Le test sépare explicitement les deux
assertions — les confondre était la cause d'un faux échec.

## 6. Produits concernés

**Les 18 produits réels de production n'ont pas été lus.** Aucun accès, aucune
autorisation. Rien ici ne prétend décrire vos données.

Ce qui est disponible à leur place :

| Preuve | Portée | Résultat |
|---|---|---|
| Parc synthétique de 18 produits (6 profils de complétude), état 58 → 59 | mécanisme | **18/18 inchangés** par la 59<sup>e</sup> ; 4 revues posées avant migration **conservées et mises à niveau** |
| Mesure antérieure sur le même parc (56 → 58) | mécanisme | 3 produits sur 18 (17 %) perdaient leur statut « prêt » : la règle `materials.origin_documented` n'existait pas |
| Simulation sur un parc dérivé volontairement | outil | 1 dossier détecté : `published` → `in_progress`, score 13/13 → 12/13, revue invalidée, slug effacé, visibilité perdue ; **rollback vérifié**, base identique à l'octet près sur les empreintes |

La simulation (`scripts/simuler_recalcul_dpp.mjs`) est l'outil qui produira le
bilan exigé sur le parc réel : dossiers examinés, changements de statut et de
score, revues invalidées, **passeports dont la visibilité changerait**, plan et
bilan attendu. Elle refuse la production, exige que la cible soit nommée
explicitement, n'imprime jamais l'URL, et vérifie après coup que la base est
restaurée (code de sortie 4 sinon).

## 7. Corrections apportées

| # | Correction | Fichier | Vérifiée par |
|---|---|---|---|
| 1 | Empreinte de revue distincte du contenu, figée à la revue | migration 59 | CAS 1, 2 |
| 2 | Suspension atomique et tracée d'un passeport non conforme | migration 59 | CAS 4 |
| 3 | Republier sans revue effectivement refusé | migration 59 | CAS 5 |
| 4 | **Revues antérieures : ancienne règle appliquée, puis mise à niveau** — sans quoi le premier recalcul en production aurait invalidé toutes les revues existantes d'un coup | migration 59 | CAS 7, 8 |
| 5 | Modèle Prisma aligné sur les quatre nouvelles colonnes | `prisma/schema.prisma` | `schema:static`, `typecheck`, `api:typecheck` |
| 6 | Outil de simulation non destructif | `scripts/simuler_recalcul_dpp.mjs` | exécution sur parc dérivé |
| 7 | Harness de migration : borne `--jusqu-a` pour reconstituer un état antérieur sans réécrire d'historique | `scripts/migrer_fidelement.mjs` | base `tf58` |
| 8 | Registres de suivi remis à jour (59 migrations) | `CHANTIERS-RESTANTS.md`, scripts de contrôle | `test:chantiers`, `test:dpp:migrations` |
| 9 | **Validation TLS rétablie** sur six scripts de connexion (dont `preflight_etat_base.mjs`, qui était déjà fautif avant cette mission) : ils passaient `rejectUnauthorized: false`, ce qui annule la vérification du certificat. Tous emploient désormais `sslDepuisUrl()` | `scripts/lib/pg-ssl.mjs` importé par les six | `npm run test:tls:validation` : 0 site fautif |
| 11 | Suite de non-régression branchée en CI, sur le PostgreSQL jetable migré par `prisma migrate deploy` (job « Base ») — c'est la **seule exécution officielle du registre de migrations** dont ce dépôt dispose | `.github/workflows/ci.yml` | à confirmer par la CI de la PR |
| 10 | Politique de routage des suites destructives respectée : la suite de non-régression passe par la garde de cible, la simulation est classée « écriture annulée par ROLLBACK », les harnais de migration sont classés outils d'exploitation — **et ont reçu un vrai mode sans écriture** (`--dry-run`) | `package.json`, `scripts/test_destructive_suite_routing.mjs`, `scripts/{migrer_fidelement,mesure_effet_migrations_dpp,valider_branche_dpp}.mjs` | `test:db-routing` : OK ; quatre modes `--dry-run` exécutés |

Le point 4 mérite d'être souligné : il n'a **pas** été trouvé par relecture mais
en rejouant la migration sur une base restée à 58 migrations, avec de vraies
revues posées. Sans ce test, la mise en production aurait invalidé des
approbations humaines parfaitement valides — exactement le défaut que la mission
demandait de corriger, sous une autre forme.

## 8. Plan de production

Rédigé, **non exécuté** : `05-PLAN-MISE-EN-PRODUCTION.md`, révisé pour trois
migrations.

### 8.1 Ordre

1. `20261021170000_dpp_readiness_truthful_gates`
2. `20261027100000_dpp_quality_gate_requires_assessment`
3. `20261027130000_dpp_review_preservation_and_publication_coherence`

L'ordre inverse efface les corrections sans lever d'erreur : les trois font un
`CREATE OR REPLACE` sur la même fonction. `prisma migrate deploy` applique
l'ordre lexicographique, qui est le bon.

### 8.2 Ce que l'opérateur fait

```bash
DATABASE_URL='…' npx prisma migrate status     # attendu : 59 trouvées, 3 en attente
DATABASE_URL='…' npm run db:deploy
# puis les 4 requêtes du §9, à la main, une par une
```

Aucun script du dépôt n'est autorisé à écrire en production : c'est voulu.

### 8.3 Sans branche Neon accessible, la procédure minimale

`api.neon.tech` est hors du réseau autorisé de cet environnement. Pour obtenir
une répétition sur branche, l'opérateur (ou une personne avec accès à la
console Neon) doit, en quatre gestes :

1. créer une branche depuis **l'état actuel** de la production, nommée
   `tracefab-dpp-readiness-validation` ;
2. vérifier que le parent affiché est bien la branche de production principale ;
3. fournir à l'agent **l'URL de la branche** (jamais celle de la production),
   par le canal habituel de secrets ;
4. l'agent exécute alors : `migrer_fidelement.mjs --etat` (lecture seule),
   `db:deploy`, les 4 requêtes du §9, les 7 scénarios, la simulation, puis rend
   les résultats.

Sans le point 3, la mission reste bloquée à cette étape — et c'est l'état
actuel.

## 9. Non prouvé, bloqué, restant à faire

| Élément | Statut | Pourquoi |
|---|---|---|
| `prisma migrate deploy` sur une branche Neon / en production | **non exécuté** | la CI l'exécute sur un PostgreSQL 17 jetable, ce qui prouve la chaîne et le registre, pas l'effet sur vos données |
| CLI Prisma dans cet environnement | **inutilisable** | `binaries.prisma.sh` injoignable ; d'où le harnais local, assumé comme substitut |
| Branche Neon isolée | **bloquée** | API HTTP injoignable, aucune clé |
| Les 4 requêtes §9 en production | **à faire** | aucun accès écriture/lecture à la production |
| Recalcul des 18 produits réels | **bloqué et non autorisé** | dépend des deux lignes ci-dessus |
| Aucune route publique ne sert un passeport suspendu | **preuve en base seulement** ; côté API, **lecture de code** | le résolveur public exige les trois conditions ; aucun test HTTP exécuté |
| Fermeture de l'angle mort sur les routes hors résolveur (`/api/dpp/[gtin]`, wallet, GS1) | **lecture de code** | cohérents avec l'invariant, non éprouvés en exécution |
| Effet réel sur vos données | **inconnu** | la simulation n'a pas tourné sur le parc réel |

## 10. Prochaine action unique

**Fournir, par un canal de secrets, la chaîne de connexion de la branche
`tracefab-dpp-readiness-validation-20261027` (base `neondb`)** — la branche
existe déjà, il ne reste qu'à la nommer. Dès qu'elle est disponible, la
séquence est écrite et outillée (`07-PROCEDURE-VALIDATION-NEON.md`) :
`npm run verifier:identite-cible`, `npm run db:deploy`, les quatre contrôles du
§9, les neuf cas de non-régression, la simulation du parc, puis le bilan
avant/après. Aucune migration, aucun recalcul et aucune publication ne sont
lancés sans cette chaîne de connexion.
## 11. Mission de clôture — tentative de validation Neon (27/10, seconde passe)

**Résultat : bloquée avant la première écriture.** La chaîne de connexion de la
branche `tracefab-dpp-readiness-validation-20261027` n'a pas été fournie : le
message de mission contient un gabarit (« [INSÉRER ICI LA CHAÎNE DE
CONNEXION…] »), et l'environnement de travail ne porte aucune `DATABASE_URL`,
aucune variable Neon et aucun `.env`. L'API Neon reste injoignable
(`api.neon.tech` → `000`), seul le proxy Postgres répond.

Condition d'arrêt appliquée, sans exception : **l'identité de la cible n'étant
pas prouvable, aucune migration, aucun recalcul, aucune publication n'a été
tenté.** Aucun résultat local ou de CI n'est présenté comme un résultat Neon.

### 11.1 Ce qui a été vérifié sur le dépôt (phase A)

| Point | Résultat |
|---|---|
| Branche / SHA | `arena/c27ddaa4-tracefab` / `e52f7697899632686c2b510c600b92a2a812b258`, arbre propre |
| Migration n° 59 | `20261027130000_dpp_review_preservation_and_publication_coherence`, dernière dans l'ordre |
| Migrations 57 et 58 | présentes |
| Total dépôt | 59 |
| Compatibilité 58 → 59 | rejouée : les revues antérieures survivent et sont mises à niveau |
| Compatibilité 59 → 59 | rejouée sur base recréée : 59/59, suite verte |
| CI du SHA | run **40522253482**, 4 jobs verts (§8) |

### 11.2 Ce qui a été livré pour rendre la session Neon exécutable

Rien ne dépend plus d'une improvisation : la procédure complète est écrite et
outillée.

| Livrable | Rôle |
|---|---|
| `docs/experience/mission-dpp-2026-10-27/07-PROCEDURE-VALIDATION-NEON.md` | mode opératoire pas à pas, valeurs attendues, conditions d'arrêt, modèle de rapport |
| `scripts/verifier_identite_branche.mjs` (+ `npm run verifier:identite-cible`) | prouve l'identité de la cible **avant écriture** : hôte déclaré, base, rôle, attributs, schéma, registre, profil, agrégats du parc et trois invariants de visibilité. Refuse la production, refuse une cible non nommée |
| `scripts/simuler_recalcul_dpp.mjs` (réécrit) | produit le tableau avant/après exigé : identifiants pseudonymisés, score, exigences manquantes, évaluation, décision de revue, slug et visibilité, motif, **classement** en correction attendue / anomalie technique / décision métier, quantification, et contrôle « aucune publication par effet de bord » |
| `scripts/valider_branche_dpp.mjs --dry-run` | rejoue les quatre contrôles du §9 en lecture seule seulement |

Ces trois outils ont été exécutés sur un PostgreSQL 18.4 local avant d'être
livrés : le vérificateur d'identité rend `0` sur une cible conforme et `5` sur
un écart déclaré ; la simulation détecte une dérive volontaire (passeport publié
devenu non conforme → suspension annoncée, slug effacé, visibilité perdue,
classée « correction attendue ») et restaure la base à l'identique.

### 11.3 Ce qui reste bloqué, sans substitut

| Élément | Motif | Action nécessaire |
|---|---|---|
| Migration officielle sur la branche Neon | pas de chaîne de connexion | fournir `DATABASE_URL` de la branche par un canal de secrets |
| Contrôles post-migration, scénarios, simulation sur le parc réel | dépendent de la ligne ci-dessus | §2.4 à §2.6 de la procédure |
| Volet HTTP de la visibilité publique | aucune API déployée dans cet environnement, client Prisma hors ligne sans moteur | trois appels `curl` documentés au §2.7 |
| Recalcul des produits réels | interdit tant que la simulation n'est pas lue et approuvée | décision explicite après le tableau de la simulation |
| Cas 9 (état initial à 58) | ne se rejoue pas après migration sur la même branche | à exécuter avant `db:deploy`, ou sur une branche restée à 58 |
### 11.4 Troisième passe — branche `br-sweet-king-b1n2f4u6`

**Toujours bloquée au même endroit, pour la même raison.** La consigne nomme une
branche précise (`br-sweet-king-b1n2f4u6`, projet `autumn-breeze-47342493`,
base `neondb`) mais ne fournit aucune chaîne de connexion, et l'environnement
n'en contient aucune (`env` : ni `DATABASE_URL`, ni `PG*`, ni variable Neon).

| Sonde | Résultat |
|---|---|
| `https://api.neon.tech` | `000` (injoignable) |
| `https://tracefab-i33lw8714-…vercel.app` (Preview du SHA `a23da42`) | `000` (injoignable) |

Les deux portes sont fermées par le réseau de cet environnement, pas par une
authentification. Aucune migration, aucun recalcul, aucune publication n'a donc
été tenté — et le volet HTTP de la visibilité publique reste **non prouvé**.

### 11.5 Ce qui a été corrigé et ajouté dans cette passe

Trois défauts ont été trouvés **dans mes propres outils**, en les exécutant
contre un PostgreSQL 18.4 local — pas en les relisant.

| Défaut reproduit | Conséquence si livré tel quel | Correction | Preuve |
|---|---|---|---|
| Le banc d'essai sous rôle applicatif appelait le recalcul **hors transaction** | il aurait modifié un dossier réel du parc, exactement ce que la mission interdit | tout est enveloppé dans `BEGIN` … `ROLLBACK`, avec vérification que statut, revue et slug sont identiques après coup | « les appels simulés n'ont laissé aucune trace » : ok |
| Le contrôle négatif d'isolation armait un autre **locataire** | faux positif : un membre légitime voit ses organisations, c'est voulu | le contrôle emploie un **autre utilisateur, non membre** | « un utilisateur non membre ne voit pas le dossier » : ok (0 ligne) |
| Le banc cherchait tout seul un dossier à éprouver | impossible : `users` n'est pas lisible par `tracefab_app` et la RLS masque le reste | le produit, l'organisation et l'acteur sont **exigés** en paramètres, comme l'API les reçoit du jeton | exécution avec les trois identifiants : ok |

Ajouts vérifiés :

- `scripts/verifier_identite_branche.mjs` — nouvelle section **rôle applicatif,
  privilèges et RLS** : `tracefab_app` sans `SUPERUSER` ni `BYPASSRLS`, RLS
  active sur les quatre tables DPP, **SELECT seul** sur `dpp_records` et
  `dpp_lifecycle_events` (aucune écriture directe), `PUBLIC` sans `EXECUTE` sur
  les cinq fonctions DPP. Mesuré sur `tf59` : tout conforme ;
  `tracefab_dpp_requirement_met` n'est pas exécutable par le rôle applicatif,
  ce qui correspond au quatrième contrôle du §9 (`false`).
- `scripts/test_dpp_role_applicatif.mjs` — le parcours DPP exécuté **avec le
  rôle de l'application**, sous RLS : lecture bornée, isolation par
  non-appartenance, refus de l'écriture directe, calcul, revue et visibilité
  accessibles, aucune trace laissée.

### 11.6 État des phases de la mission de clôture

| Phase | État | Motif |
|---|---|---|
| A — dépôt et révision | **TERMINÉE** | SHA `a23da42`, arbre propre, migration n° 59 présente, 59 au dépôt |
| B — identité de la branche Neon | **BLOQUÉE** | aucune chaîne de connexion ; identité non prouvable ⇒ arrêt |
| C — `npm run db:deploy` | **BLOQUÉE** | dépend de B |
| D — critères D1 à D6 | **NON MESURÉS SUR NEON** | prouvés en local et en CI seulement |
| E — scénarios | **PARTIELLE** | 9 cas exécutés en local et en CI ; pas sur Neon ; cas 9 (état à 58) rejoué sur `tf58` |
| F — simulation du parc réel | **OUTIL PRÊT, NON EXÉCUTÉ** | aucune cible accessible |
| G — contrôles post-migration | **BLOQUÉE** | dépend de C ; le volet HTTP reste non prouvé |
| H — CI | **TERMINÉE** | run de la CI sur `a23da42`, 4 jobs verts |


