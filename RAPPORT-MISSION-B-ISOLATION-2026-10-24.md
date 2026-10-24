# Mission B — Isolation multi-organisation de bout en bout

**Date** : 2026-10-24 · **Branche** : `arena/fd3fb758-tracefab` · **PR** : #94 (ouverte)
**Point de départ** : `c21eca6522bc4c499b06c840da3c5dbcd55cfa93`

> **Verdict : PARTIELLEMENT CLOS.**
> Une faille réelle de propagation de contexte est corrigée et gardée par un
> contrôle statique à contrôle négatif vérifié. Une suite d'exécution DB
> nouvelle couvre les surfaces métier qui n'étaient prouvées nulle part
> (documents, mutations qualité, identités DPP, ingestion, export) — elle
> s'exécute dans le job CI « Base — isolation RLS executee ». La validation
> navigateur de bout en bout avec sessions Clerk réelles reste **BLOQUÉE**
> (provisioning des sessions, mission A) : elle n'est pas déclarée faite.

---

## 1. Périmètre examiné

- **137 routes** enregistrées dans `api/index.ts` : 88 arment
  `withTracefabUserContext`, 22 `withTracefabRequestContext`, 9
  `withTracefabPublicContext`, 24 exigent explicitement `requireActiveTenant`.
- Modèles d'accès : TENANT (chaîne Clerk → contexte → bornage), PUBLIC
  (passeports/wallets/résolveurs, contexte public transactionnel), WORKER
  (secret partagé, comparaison à temps constant), WEBHOOK (signature Clerk),
  REFERENCE (référentiels sans donnée locataire). `test:cross-tenant` force
  la classification explicite de toute route : **PASS**.
- **33 tables** portent une colonne d'organisation ; toutes ont RLS activée
  et des politiques ; les tables filles sans colonne d'organisation sont
  bornées par les politiques de leurs parents ou des fonctions gardées.
- **174 fonctions SECURITY DEFINER** : revue ciblée des mutations par
  identifiant — elles vérifient le rôle dans l'organisation propriétaire
  (`tracefab_has_org_role`) avant d'écrire.

## 2. Vulnérabilité reproduite et corrigée

### F1 — Contexte de sécurité non propagé (ingestion PLM/ERP) — gravité MOYENNE

`POST /api/integrations/ingest` valide correctement l'appartenance
(l'organisation demandée doit figurer dans les organisations marque de
l'utilisateur), puis appelait `ingestPlmErpData(...)`, qui exécutait
`tracefab_ingest_plm_erp_payload` via le **client Prisma global** — une autre
connexion, sans aucun GUC. Or la fonction exige `tracefab_current_user_id()`
et lève `authentication_required` sinon.

Conséquences : la route échoue fermée (500) dans tous les cas, **et** la
barrière d'appartenance implémentée en base n'est jamais exercée — le jour où
quelqu'un « répare » la route en armant le contexte au mauvais endroit, la
défense en profondeur a déjà disparu. C'est exactement la classe de défaut de
la mission (« contexte pas correctement établi, propagé ou vérifié »).

**Correctif** (changement minimal) : `ingestPlmErpData(tx, ...)` reçoit la
transaction qui porte le contexte ; la route la transmet. Le paramètre est
obligatoire : l'oubli devient impossible à écrire.

**Garde permanente** : `test:route-context-coverage` rejette désormais toute
librairie métier exécutant via le client global (exceptions explicites et
justifiées : wrappers de contexte, sonde `SELECT 1`, provisioning de compte,
compteurs de débit). **Contrôle négatif vérifié** : sur l'ancien code, la
garde échoue en nommant `api/_lib/plm-erp/ingestor.ts` ; sur le code corrigé,
elle passe. Les trois autres occurrences trouvées par la garde étaient des
faux positifs (paramètre injecté nommé `prisma`) ou de l'infrastructure sans
donnée locataire (rate-limit) — documentés en exceptions.

## 3. Ce qui a été vérifié sain (revue ciblée, pas seulement statique)

- **Exports** : `catalog/export/products` borne par organisation et filtré
  par RLS (0 ligne étrangère — aussi prouvé par la nouvelle suite, requête
  d'export rejouée) ; les exports par route catalogue exigent
  `requireActiveTenant` avec filtre `tenantFilter`.
- **Téléchargements** : marque et fournisseur passent par
  `tracefab_can_access_document` ou par `owner_organization_id` du fournisseur
  résolu côté serveur ; un identifiant étranger rend 404.
- **Mutations par ID** (qualité acknowledge/waive, CAP, identités DPP,
  passeport fournisseur, ingestion) : les fonctions SECURITY DEFINER
  vérifient le rôle dans l'organisation propriétaire avant d'écrire.
- **Routes sans contexte valide** : sans GUC armé, les politiques ne rendent
  aucune ligne tenant (prouvé par exécution, assertion 10 de la suite).
- **Worker/public** : secrets comparés à temps constant ; les lectures
  publiques exigent le contexte public transactionnel et des produits
  explicitement publiés.

## 4. Tests — résultats

| Test | Type | Résultat |
|---|---|---|
| `test:cross-tenant` (classification des 137 routes) | statique | **PASS** (local) |
| `test:route-context-coverage` + garde de propagation | statique | **PASS** (local) ; contrôle négatif **PASS** |
| `test:neon:mission-b` (nouveau, 13 assertions : documents, qualité ×2 refus sans effet, DPP, export, ingestion ×2, sans-contexte) | exécution DB | **exécuté en CI** sur le SHA final (job « Base — isolation RLS executee », Postgres 17 jetable, rôle `tracefab_app` sans BYPASSRLS) |
| Suites DB préexistantes (rls, write-policies, cross-tenant, active-tenant, document-lifecycle, bypass-control…) | exécution DB | relancées par la même CI — voir §5 |
| E2E navigateur deux organisations | navigateur | **BLOQUÉ** — dépend des sessions Clerk (mission A) ; la suite existe (`scripts/test_p1_staging.mjs`, 4 plans d'isolation) mais n'a pas tourné |

En local, l'exécution DB est impossible (aucun Postgres disponible, binaires
Prisma injoignables) : la suite sort en 2 plutôt que de simuler un vert —
c'est la CI qui exécute, comme pour toutes les suites `test:neon:*` du dépôt.

## 5. Preuves CI

À compléter avec les identifiants du run sur le SHA final (voir le commentaire
de la PR #94) : job « Base — isolation RLS executee », étape
« Mission B — isolation des surfaces métier par exécution ».

## 6. Routes restantes non vérifiées par exécution

- Les surfaces couvertes uniquement par RLS + fonctions gardées mais non
  rejouées requête par requête : `quality/caps/*` (revue/remédiation),
  `supplier/passport/access-requests`, `data-requests/*` (participants
  marque/fournisseur via `accessibleRequest`), `traceability/*`. Le modèle
  est le même que celui des surfaces prouvées (appartenance + rôle en base),
  mais la preuve par exécution route-par-route reste à faire — c'est un
  chantier d'extension de la suite, pas une faille identifiée.
- Le même-utilisateur multi-organisations (locataire actif) n'est armé que
  par 24 routes + les prédicats `tracefab_in_active_tenant` de quelques
  agrégats ; les routes restantes bornent à l'union des organisations du
  compte. Un membre légitime de deux tenants peut donc y voir les deux —
  c'est le comportement historique documenté (incident 2026-10-17 corrigé
  surface par surface), pas un accès *inter*-organisations au sens
  confidentialité entre clients distincts. Généraliser `requireActiveTenant`
  à toutes les surfaces TENANT reste recommandé.

## 7. Sécurité — confirmations

Aucune RLS désactivée, aucune politique affaiblie, aucun test supprimé ou
assoupli. Aucune migration ajoutée (le correctif est applicatif). Aucune base
de production touchée ; les exécutions DB ont lieu sur le Postgres jetable de
la CI. Aucun secret manipulé.
