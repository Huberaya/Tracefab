# Rapport de clôture pré-fusion — PR #102

**Date** : 28 octobre 2026
**Branche** : `arena/c27ddaa4-tracefab`
**SHA initial de la mission** : `1d46902` — vérifié, c'était bien la tête.
**SHA de code validé** : `59a11d4` — CI verte, **47 étapes, 0 échec, 0
ignorée** (runs [40758795016](https://github.com/Huberaya/Tracefab/actions/runs/40758795016)
et [40758795028](https://github.com/Huberaya/Tracefab/actions/runs/40758795028)).
Ce document est ajouté par le commit qui le porte, après cette validation.
**Verdict** : **BLOQUÉE — preuve de production manquante**, nommée au §9.

---

## 1. État initial (relevé avant toute intervention)

| Élément | Valeur |
|---|---|
| SHA de `main` | `bf55f2ae6534cde84d072d9b975520216c7b6d4e` |
| SHA de tête de la PR #102 | `1d469029494d30f37e6e217b315607a5981c621c` |
| SHA de travail | identique — arbre propre, aucun travail non poussé |
| Commits en avance sur `main` | 72 |
| État de la PR | `OPEN`, **Draft**, `MERGEABLE`, `mergeState=CLEAN` |
| Fichiers modifiés | 130 (+22367 / −197) |
| Conflit avec `main` | **aucun** (0 marqueur) |
| Revue requise | aucune |

### CI sur `1d46902` — SHA exact

| Workflow | Job | Résultat |
|---|---|---|
| CI ([run 40754251043](https://github.com/Huberaya/Tracefab/actions/runs/40754251043)) | Socle — types, compilation, isolation | **success** |
| | Verification — suite de tests | **success** |
| | Base — isolation RLS executee | **success** |
| | Parcours — navigateur reel | **success** |
| Intégration migrations 34/36/41 ([run 40754251096](https://github.com/Huberaya/Tracefab/actions/runs/40754251096)) | Chaîne 34/36/41 sur Postgres 17 jetable | **success** |

Étapes ignorées : **2**, toutes deux conditionnées à un échec
(`Journaux en cas d'echec`, `Captures en cas d'echec`). Aucune étape de sécurité
ignorée. Aucun échec.

---

## 2. Corrections appliquées dans la branche

### 2.1 Comparateur de catalogue — durci, puis testé contre des mutations

Le défaut signalé (faits `G` écrasés par une clé insuffisamment discriminante)
était réel et **plus grave que décrit** : les 19 lignes `G` se réduisaient à 4,
et la comparaison ne portait que sur la **dernière de chaque famille**.

| Correction | Effet |
|---|---|
| Clé `G|objet|détail` | chaque fait de privilège est distinct |
| Doublons **refusés** (référentiel et production) | plus d'écrasement silencieux |
| Lignes mal formées refusées (genre inconnu, segment sans `=`) | une sortie abîmée ne passe plus |
| Champ produit mais non comparé → **échec** | plus d'angle mort |
| `proprietaire` déclaré **qualifié** avec sa raison, et contrôlé structurellement | propriétaire unique, **jamais un rôle runtime** |
| Surnuméraire `P`/`G` = **échec dur** (plus « à qualifier ») | une politique en trop est une capacité en plus |

**Mutations négatives couvertes** (`test:confrontation-production`, **38
vérifications**) : `BYPASSRLS`, `SUPERUSER`, appartenance de rôle ajoutée,
écriture rendue sur `documents`, écriture rendue sur une table cible, politique
surnuméraire, propriétaire de rôle runtime, doublon à valeur différente, ligne
mal formée, genre inconnu, sortie vide, sortie partielle. **Toutes refusées.**

### 2.2 Référentiel étendu aux privilèges et à l'héritage des droits

19 faits `G` : attributs des rôles (`rolsuper`, `rolbypassrls`, `rolinherit`,
`rolcreaterole`, `rolcreatedb`, `rolcanlogin`), appartenances, privilèges de
table sur les 14 cibles, `documents` et `tracefab_products`, `USAGE`/`CREATE`
sur `public`. Référentiel : **66 → 85 faits**.

### 2.3 `supplier_portal` — cas manquants et traduction HTTP

- Cas **« relation inexistante »** ajouté et **mesuré** : refusé sur la chaîne
  complète par l'**autre** déclencheur ; la branche
  `invitation_relationship_not_found` du correctif est **ombragée, pas morte**
  (elle rend la main sans l'autre déclencheur). Asserti dans les deux
  configurations.
- **Traduction HTTP verrouillée** : le contrôle existant vérifiait qu'un mapping
  existe, pas que le statut est un `4xx`. Nouvelle assertion : aucun des **200**
  gardes PostgreSQL ne doit être mappé en `5xx`. Les quatre codes du correctif
  sont en `403` / `400` / `403` / `409`.
- **45 vérifications** (42 auparavant).

### 2.4 Nouveaux moyens de preuve

| Test | Vérifications | Ce qu'il établit |
|---|---|---|
| `test:rejeu-migrations` | 4 | 10/11 rejouables ; `20261028120000` casse |
| `test:deploiement-simule` | 11 | l'état « 54 » est **impossible** ; les effets de `20261017120000` sont **prouvés présents** ; la séquence des 11 passe ; l'échec injecté bloque 5 migrations, sans trace partielle |
| `test:reconciliation-options` | 12 | options A et B comparées ; aucune ne réécrit l'historique ; **la sonde décide** |
| `test:sondes-effets` | 17 | les 11 sondes distinguent leur migration retirée seule |
| `test:confrontation-production` | 38 | le comparateur refuse 11 falsifications |

---

## 3. Résultats de tests — SHA final

| Commande | Résultat |
|---|---|
| `test:sql-errors` | **OK** — 200 gardes mappés, aucun en 5xx |
| `test:confrontation-production` | **OK** — 38/38 |
| `test:sondes-effets` | **OK** — 17/17 |
| `test:rejeu-migrations` | **OK** — 4/4 |
| `test:deploiement-simule` | **OK** — 11/11 |
| `test:reconciliation-options` | **OK** — 12/12 |
| `test:supplier-invitation-corrective` | **OK** — 45/45 |
| `test:migrations:hors-bande` | **OK** — 46/46 |
| `test:plm-erp-convergence` | **OK** — 4/4 |
| `test:plm-erp-convergence:chaine` | **OK** — 19/19 |
| `test:chantiers` | **OK** |
| `test:cross-tenant` | **OK** |
| `test:active-tenant` | **OK** — 13/13 |

Tous exécutés sous **Node 20** (version de la CI), pas seulement Node 22.

---

## 4. Confrontation de production — méthode et preuves

**Méthode** : le dépôt construit son propre référentiel en appliquant ses 65
migrations sur PGlite, puis compare **fait par fait** à la sortie de production.
Aucune relecture humaine.

**État de la mesure** : la dernière lecture disponible (68 lignes, 28/10,
branche `Primary`) a été produite par la **version précédente** de la requête.
Elle ne contient aucun fait `G`. Confrontée au référentiel actuel, elle rend
**19 « faits attendus absents »** — c'est une **lecture à refaire**, pas une
divergence de la production.

**Ce qu'elle a établi, et qui reste valable** :

| Mesure | Valeur |
|---|---|
| Tables | **14/14** existent, `rls=true`, `force=true`, propriétaire unique |
| Politiques lues une par une | **33** — dont **31 conformes** au dépôt |
| `plm_erp_sync_jobs` | **4 politiques** au lieu de **2** → `FAIL` |
| Fonctions | **14/14** `secdef=true`, `search_path=public`, `exec_public=false` |
| Correctives | `20261028140000` et `20261028150000` : `present=0` |

### La divergence PLM, qualifiée

Les deux politiques surnuméraires sont `plm_erp_sync_jobs_insert_brand` et
`plm_erp_sync_jobs_select_brand`, **absentes du dépôt**.

- **Capacité non autorisée ?** **Oui, mesurée.** PostgreSQL combine les
  politiques permissives par `OR` : `insert_brand` admet
  `ARRAY['owner','admin','manager','contributor']`, alors que la canonique
  `plm_sync_jobs_insert_brand` s'arrête à `owner/admin/manager`. Un
  `contributor` peut donc insérer là où le dépôt l'interdit.
- **Intentionnelle ?** **Aucune trace.** Les deux noms n'apparaissent dans
  aucune migration du dépôt, aucun commentaire, aucune documentation.
- **Dérive historique ?** C'est l'explication la plus simple, et **elle n'est pas
  prouvée** — la migration `20261006210000_plm_erp_gs1_interoperability` a une
  empreinte divergente en production, ce qui est cohérent avec une dérive, sans
  la démontrer.
- **Portée** : insertion uniquement. Les `SELECT` restent bornés par
  `tracefab_is_org_member`. Ce n'est **pas** une fuite inter-tenant.

**Aucune politique n'a été supprimée.** Le correctif est
`20261028150000_plm_erp_policy_convergence`, dans la branche, testé (19
vérifications), non appliqué.

---

## 5. État des onze migrations

Voir `docs/security/2026-10-28-matrice-onze-migrations.md`.

Décompte clos : **54 appliquées + 9 absentes + 2 annulées = 65**.

- **Preuve positive** : les effets de `20261017120000` sont **présents** en
  production, déduits du fait que `20261021120000` y est appliquée et **exige**
  ses trois fonctions.
- **L'état « 54, aucun effet de plus » est impossible** : sauter les onze casse
  la chaîne à la 54ᵉ.
- **Effets des dix autres** : **INCONNUS** — 10 sondes à exécuter.

---

## 6. Risques résiduels

| Risque | Mesure | État |
|---|---|---|
| `migrate deploy` casse au milieu et bloque les correctifs | `20261028120000` non rejouable ; 5 migrations bloquées | **mesuré**, procédure au §9 |
| Déclarer appliquée une migration dont l'effet manque | créerait un trou silencieux | **interdit** par la procédure : la sonde précède |
| Données non transformées par une migration dont les objets sont présents | la sonde lit des objets, pas des lignes | **non couvert** — signalé, non masqué |
| M6 (bout en bout sur production) | jamais exécuté | `NOT RUN` |

---

## 7. État de la PR

| | |
|---|---|
| Ouverte / fermée | **OPEN** |
| Draft | **oui** — non retiré, décision argumentée au §8 |
| Mergeable | **MERGEABLE**, `CLEAN` |
| Conflit avec `main` | aucun |
| CI sur `59a11d4` | **verte** — 47 étapes, 0 échec, 0 ignorée |
| CI sur le commit de ce document | voir le dernier run de la branche |

---

## 8. Pourquoi le Draft n'est pas retiré

Le critère de la mission est explicite : *« la PR ne peut être déclarée PRÊTE À
FUSIONNER que si la confrontation de production est complète et toutes les
divergences qualifiées »*. Elle ne l'est pas : **19 faits de privilèges n'ont
jamais été lus en production**, et **10 des 11 effets restent inconnus**.

Retirer le Draft reviendrait à assimiler une mesure incomplète à un `PASS` —
exactement ce que la mission interdit.

---

## 9. BLOQUÉ — preuve manquante

**Ce qui manque** : une lecture de production, en lecture seule.

**Requête exacte** :
`docs/security/2026-10-28-tour30-A-confrontation-lecture-seule.sql` (85 faits)
et `docs/security/2026-10-28-tour30-C-sondes-effets.sql` (11 sondes).

**Où** : SQL Editor de Neon, branche `Primary`. Aucune écriture.

**Résultat attendu** :

1. **85 lignes** `T|`, `P|`, `F|`, `G|`, `H|` — à comparer avec
   `node scripts/verifier_confrontation_production.mjs <fichier>` ; attendu
   `FAIL` sur `plm_erp_sync_jobs` (4 politiques), `PASS` sur tout le reste.
2. **11 lignes** `S|` — comparaison aux colonnes de référence du document de
   tour 30 §9.2.

**Qui** : le propriétaire du dépôt (accès à la branche `Primary`).
**Pourquoi je ne peux pas** : aucun identifiant de production ne m'est
accessible, et je ne dois pas en demander ni en stocker.

**Ce qui se débloque ensuite**, selon le résultat :

| Constat de la sonde | Suite |
|---|---|
| effets des 10 absents | `migrate deploy` applique les 11 dans l'ordre — mesuré sans échec |
| registre déjà présent | `resolve --applied` sur le registre **sur preuve**, puis `deploy` des 8 — mesuré sans échec |
| effets majoritairement présents | régularisation d'historique migration par migration, sur preuve, sans SQL applicatif |
| privilèges divergents (faits `G`) | nouvelle analyse, et correctif **avant** toute fusion |
