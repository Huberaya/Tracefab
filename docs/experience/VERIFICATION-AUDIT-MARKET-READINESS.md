# Vérification de l'audit Market Readiness

Audit source : `TRACEFAB_MARKET_READINESS_AUDIT.md` du 6 octobre 2026
(maturité globale annoncée **2,4 / 5**, « non commercialisable en l'état »).

Vérifié le 7 octobre 2026 sur la branche `merge/experience` (`df11a5d`),
qui contient les phases 9–12 de l'équipe parallèle **et** la couche
expérience. Chaque point a été contrôlé dans le code, pas sur déclaration.

---

## Synthèse

**6 des 8 fiches de blocants critiques sont réellement corrigées.**
Une l'est partiellement. Une est codée mais **inactive**.

| Fiche | Sujet | Gravité | Statut |
|---|---|---|---|
| 1 | Injection collecte → `data_points` | P0 | **Corrigée** |
| 2 | `FORCE ROW LEVEL SECURITY` | P0 | **Corrigée** — 44/45, 1 exemption documentée |
| 3 | Isolation tenant sur download | P0 | **Corrigée** |
| 4 | API + UI Supply Chain Graph | P0 | **Corrigée** |
| 5 | API + UI DPP Readiness | P0 | **Corrigée** |
| 6 | Onboarding fournisseur autonome | P0 | **Corrigée** |
| 7 | Contrôles de partage `data_shares` | P1 | **Codée mais morte** |
| 8 | Acquittement / dérogation dans l'UI | P1 | **Corrigée** |

---

## Détail des vérifications

### Fiche 1 — Injection des réponses dans les Data Points · corrigée

`tracefab_review_data_response` contient désormais deux `INSERT INTO
data_points`, avec `product_id`, `status = verified_by_reviewer` et
`source_document_id`. L'implémentation fait du **versionnement explicite**
(lecture de la dernière version, incrément, insertion) plutôt qu'un
`ON CONFLICT` — c'est plus propre pour un référentiel auditable.

Conséquence : le blocage `product_no_data_points` qui faussait tout score
qualité produit n'a plus lieu d'être. L'endpoint manquant
`POST/GET /api/products/:id/data-points` existe aussi (125 lignes, routé).

### Fiche 2 — FORCE RLS · corrigée

| Mesure | Valeur |
|---|---|
| Tables créées | 38 |
| `ENABLE ROW LEVEL SECURITY` | 45 |
| `FORCE ROW LEVEL SECURITY` | **43** |
| Tables créées sans aucune RLS | 0 |

Deux tables ont `ENABLE` mais pas `FORCE` :

- **`tracefab_schema_catalog`** — référentiel public de schémas
  (`schema_key`, `version`, `title`, `active`), sans `organization_id`, dont
  la policy est explicitement `FOR SELECT TO PUBLIC USING (active = true)`.
  Pas de donnée de locataire : **absence acceptable**.
- **`tracefab_schema_bindings`** — porte `product_id`, `material_id` et
  `supplier_id`, et définit deux policies d'autorisation par sous-requête
  `EXISTS`. **Sans `FORCE`, ces policies sont contournées sous
  `neondb_owner`**, c'est-à-dire exactement la faille décrite par la fiche 2.
  **Écart résiduel réel.**

Correctif : une migration d'une ligne.
`ALTER TABLE tracefab_schema_bindings FORCE ROW LEVEL SECURITY;`

### Fiche 3 — Isolation tenant sur le téléchargement · corrigée

`api/_routes/documents/[documentId]/download.ts` appelle désormais
`tracefab_can_access_document(documentId)` et retourne `null` si l'accès
est refusé, avant toute génération d'URL présignée.

### Fiches 4 et 5 — Supply Chain et DPP · corrigées

Les deux fonctionnalités que l'audit notait **1,0 / 5 « conceptuel, SQL
seul »** sont désormais exposées de bout en bout :

- `products/[productId]/supply-chain.ts`, plus `supply-chain/links` et
  `supply-chain/generate-baseline` — tous routés
- `products/[productId]/dpp.ts` (104 lignes), `dpp/publish-review`, le DPP
  public `/dpp/[gtin]` et les cartes Apple / Google Wallet
- côté interface : `supplyChainView()` et `dppView()` dans la Brand Console

### Fiche 6 — Onboarding fournisseur autonome · corrigée

L'erreur bloquante `supplier_organization_not_found` **a disparu du
portail** (0 occurrence). `supplier/onboarding.ts` et
`supplier/organizations.ts` existent et sont routés, et le portail porte un
`onboarding-form` avec suivi d'état.

### Fiche 7 — Contrôles de partage · codée, morte, désormais active

C'est le constat le plus important de cette vérification.

- `api/_routes/supplier/shares.ts` existe — **85 lignes**
- le portail appelle bien `'/api/supplier/shares'` et affiche
  « Partages actifs »
- **mais la route n'est enregistrée nulle part dans `api/index.ts`**

Le routeur se termine par
`if (!route) return json(res, 404, { error: 'route_not_found' })` : il n'y a
aucun *catch-all*. L'appel renvoie donc **404 en production**. La
fonctionnalité est écrite des deux côtés et neutralisée par une ligne
manquante.

### Fiche 8 — Acquittement et dérogation · corrigée

La Brand Console contient `acknowledge` (11 occurrences), `waive` (15) et
« Dérogation » (6), adossés aux endpoints existants.

---

## Constat nouveau, absent de l'audit : 10 routes orphelines · corrigé

124 fichiers de route existent sous `api/_routes/`, **114 sont enregistrés**.
Dix handlers sont donc inatteignables :

| Fichier | Lignes | Appelé par l'UI ? |
|---|---|---|
| `data-requests/[requestId]/remind` | 65 | **oui — Brand Console** |
| `supplier/shares` | 85 | **oui — Supplier Portal** |
| `dpp/validate` | — | non |
| `integrations/plm` | 69 | non |
| `quality/audit-pack` | — | non |
| `quality/calculate-index` | — | non |
| `supplier/certifications/ocr-extract` | — | non |
| `traceability/audit-chain` | — | non |
| `traceability/lineage-graph` | — | non |
| `traceability/mass-balance` | 59 | non |

Deux de ces routes cassent une fonctionnalité visible :

1. **Relance manuelle du fournisseur** — la console appelle
   `/api/data-requests/${id}/remind`. L'audit classait cette fonction en
   **E (absente)** ; elle est en réalité **écrite mais débranchée**. La seule
   ligne contenant `remind` dans le routeur concerne
   `internal/notification-outbox/reminders`, qui est le worker cron, pas
   la relance à la demande.
2. **Partages fournisseur** — voir fiche 7.

Correctif : dix lignes dans la table `routes` de `api/index.ts`. Un test
d'intégrité « tout fichier de route doit être enregistré » éviterait la
récidive.

---

## État des chantiers de la feuille de route

Les tests écrits par l'équipe pour chaque chantier de l'audit :

| Chantier | Tests | Résultat |
|---|---|---|
| C1 Sécurité & isolation | `docai`, `security` | OK |
| C2 Pont collecte → Data Points | `plm-erp`, `bridge` | OK |
| C3 Supply Chain Graph | `pef` OK · **`supplychain` ÉCHEC** | **1 échec** |
| C4 DPP Readiness | `green-claims`, `dpp` | OK |
| C5 Onboarding fournisseur | `cap`, `quality-actions` | OK |
| C6 Brand Console & Quality | `universal-passport`, `onboarding` | OK |
| C7 Partages & matériaux | `mass-balance` | OK |
| C8 Import / export | `bulk` OK · `neon:bulk` base requise | OK |
| C9 Référentiel & infra | `wallet` OK · `neon:wallet` base requise | OK |

Portes principales : `typecheck` **OK** · `api:typecheck` **OK** ·
`schema:static` **OK** (22 tables / 61 policies).

`test:supplychain:chantier3` échoue en réclamant le littéral
`'Tier 4 · Matières'` (puis Tier 3/2/1/0), supprimé de la console par la
réécriture phases 9–12. Soit le test est périmé, soit les étapes nommées du
pipeline ont été perdues — **à trancher par l'auteur du chantier 3**.

---

## Note de méthode

Deux tests (`security:chantier1`, `wallet:chantier9`) sont apparus en échec
lors d'une première passe, puis au vert après réinstallation des
dépendances : il s'agissait de `typescript` et `jsonwebtoken` absents de
`node_modules`, pas de défauts produit.

À signaler au passage : **`tsx` n'est pas déclaré dans `package.json`**
alors que `test:wallet:chantier9` l'invoque via `npx`. Le test dépend donc
d'un téléchargement réseau au moment de l'exécution et n'est pas
reproductible hors ligne ni en CI isolée.

---

## Ce qu'il reste à faire

| # | Action | Effort | Priorité | État |
|---|---|---|---|---|
| 1 | Enregistrer les 10 routes orphelines dans `api/index.ts` | 10 lignes | **P0** | **Appliqué** |
| 2 | `FORCE RLS` sur `tracefab_schema_bindings` | 1 ligne | **P0** | **Appliqué** |
| 3 | Test d'intégrité « toute route doit être enregistrée » | ~20 lignes | P1 | **Appliqué** |
| 4 | Arbitrer `test:supplychain:chantier3` | décision | P1 | Ouvert |
| 5 | Déclarer `tsx` en devDependency | 1 ligne | P2 | Ouvert |

---

## Correctifs appliqués

### P0 nº 1 — les 10 routes orphelines sont câblées

Les dix entrées ont été insérées dans la table de `api/index.ts`. Comme le
routeur résout par `routes.find(...)`, c'est-à-dire **au premier motif qui
correspond**, chaque insertion a été placée avant son voisin plus générique.
Deux cas l'exigeaient réellement : `dpp/validate` devait précéder
`^dpp/([^/]+)$`, et `supplier/certifications/ocr-extract` devait précéder
`^supplier/certifications/([^/]+)$`. Sans cela, les routes auraient été
enregistrées tout en restant injoignables — le défaut d'origine sous une
autre forme.

Vérification : **124 fichiers de route, 124 enregistrés, 0 orphelin**, et les
14 chemins de résolution testés atteignent le bon handler.

Deux fonctionnalités visibles par l'utilisateur redeviennent actives :
les **partages fournisseur** (fiche 7, le portail appelle
`/api/supplier/shares`) et la **relance manuelle** (la console appelle
`/api/data-requests/{id}/remind`).

### P0 nº 2 — `FORCE RLS` sur `tracefab_schema_bindings`

Migration `prisma/migrations/20261007120000_force_rls_schema_bindings/`.
Le décompte passe de **43 à 44 tables en `FORCE ROW LEVEL SECURITY`**.

La seule table restante en `ENABLE` seul est `tracefab_schema_catalog`, et
c'est une exemption légitime documentée dans la migration : référentiel
public sans donnée de locataire, dont la policy est explicitement
`FOR SELECT TO PUBLIC USING (active = true)`.

### P1 nº 3 — garde-fou anti-récidive

`scripts/test_route_registry.mjs`, câblé en `npm run test:routes` et ajouté
à la chaîne `npm run build`. Il vérifie trois propriétés : tout fichier de
route est enregistré, toute route pointe vers un fichier existant, et aucun
motif n'en masque un autre.

Ce test a été validé par mutation, car un test qui ne peut pas échouer ne
prouve rien : en désenregistrant `supplier/shares` il signale l'orphelin, et
en remontant `dpp/([^/]+)` au-dessus de `dpp/validate` il signale le
masquage. Dans les deux cas il sort en code 1. Sans ce garde-fou, le défaut
d'origine était totalement silencieux : aucune porte existante ne le voyait.

### Non-régression

`typecheck`, `api:typecheck`, `schema:static` et `test:routes` au vert, et
**31 des 33 tests** de la matrice passent. Les deux exceptions ne sont pas
imputables à ces correctifs :

- `test:supplychain:chantier3` échoue **à l'identique sur `origin/main`**
  (même assertion, `Brand console must display Tier 4 stage`) — vérifié par
  exécution comparée. C'est le point nº 4, qui demande votre arbitrage.
- `test:p2` échoue sur son seul volet `staging`, qui exige
  `TRACEFAB_STAGING_URL` et un secret worker, donc un environnement live.
  Même catégorie que les tests Neon : contrainte d'environnement, pas défaut
  produit.
