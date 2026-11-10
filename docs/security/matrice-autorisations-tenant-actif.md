# Matrice d'autorisation — locataire actif et partages fournisseur

**Chantier** : isolation globale des accès et du stockage (PR #109, poursuite sur
`arena/0f697b3e-tracefab`).
**Date** : 6 novembre 2026.
**Niveau de preuve** : **1 — PostgreSQL jetable (PGlite), chaîne complète de 70
migrations**. Ce document ne valide ni Vercel Preview, ni Neon isolé, ni
Production. Voir `docs/security/preuves-isolation-globale-2026-11-06.md`.

## 1. Règle d'or

Une autorisation n'est jamais déduite du seul identifiant, chemin, clé de
stockage ou URL présentée. Elle est décidée **en base** par
`tracefab_document_accessible_in_active_tenant(uuid)` /
`tracefab_product_accessible_in_active_tenant(uuid)` (migration
`20261105180000_active_tenant_access_guards`) et par la politique **RESTRICTIVE**
`documents_restrict_active_tenant`, après :

1. `requireActiveTenant` (ou la validation centralisée de
   `withTracefabRequestContext`) : locataire demandé explicite, UUID valide,
   adhésion `active`, type/rôle autorisé, sinon 400/404 fermé ;
2. identité vérifiée (`tracefab_current_user_id()`), GUC
   `tracefab.active_organization_id` armé dans la transaction ;
3. appartenance de la ressource au tenant actif **ou** une voie inter-
   organisations explicitement documentée ci-dessous.

Aucun repli sur « toutes les organisations du compte » n'est autorisé. Aucune
URL présignée n'est émise avant cette décision. Les clés de stockage sont
préfixées par l'organisation propriétaire (`storageObjectKey`) et vérifiées par
le déclencheur `document_path_must_be_tenant_scoped` : un chemin n'est jamais un
mécanisme d'autorisation.

## 2. Acteurs et fixtures (identifiants réels, base jetable)

| Symbole | Rôle | Adhésions |
| --- | --- | --- |
| `A` | marque A | `U_A`, `U_MULTI` |
| `B` | marque B | `U_B`, `U_MULTI` |
| `C` | marque tierce sans relation | aucun utilisateur de la fixture |
| `S` | fournisseur travaillant avec A **et** B | `U_S`, `U_MULTI` |
| `S2` | second fournisseur, sans relation avec A/B | — |
| `U_MULTI` | compte multi-organisations | A, B, S |
| `REL_AS` / `REL_BS` | relations fournisseur-marque | `active`, révocables |
| `SHARE_SA` / `SHARE_SB` | partages explicites S → A / S → B | `scope.document_ids` |

Les constantes UUID sont dans `scripts/test_isolation_globale_pglite.mjs`.

## 3. Matrice formelle (les 10 scénarios de la mission)

Colonnes exigées : **propriétaire**, **tenant actif**, **organisation
fournisseur**, **organisation marque**, **relation**, **ressource**,
**permission**, **action**. `Décision` et `Preuve` sont ajoutées pour la
traçabilité. Chaque ligne est exécutée, pas seulement décrite : section B de
`npm run test:isolation:globale`.

| # | Propriétaire | Tenant actif | Organisation fournisseur | Organisation marque | Relation | Ressource | Permission | Action | Décision | Preuve |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | A | A | — | A | — | produit `P_A` | `tracefab_product_accessible_in_active_tenant` | lire le produit par son ID | **AUTORISÉ** | `1. marque A : son produit est accessible` |
| 2 | B, C | A | — | A | — | produits `P_B`, `P_C` | garde produit | lire un produit privé d'une autre marque par ID exact | **REFUSÉ** | `2. marque A : produit de B refuse par ID exact` |
| 3 | A (certificat émis au nom de S) | S | S | A | `REL_AS` active | document `D_A_VERS_S` | garde documentaire, branche certification marque→fournisseur | télécharger une pièce explicitement partagée | **AUTORISÉ** (S) / **REFUSÉ** (B) | `3. fournisseur S : certificat partage par la marque A accessible` |
| 4 | B | S | S | B | `REL_BS` active | document privé `D_B` | garde documentaire | lire les données privées d'une marque avec laquelle S travaille | **REFUSÉ** | `4. fournisseur S : document prive de B refuse` |
| 5 | S | S | S | A et B | `REL_AS` + `REL_BS` actives | `D_S_VERS_B`, `D_S_PRIVE`, `D_A_VERS_S`, `D_B`, `D_A` | propriété + partage explicite | fournisseur avec deux marques : ne pas mélanger leurs données | **AUTORISÉ** pour ses propres pièces et le seul partage A→S ; **REFUSÉ** pour `D_A`, `D_B` | `5. fournisseur S : donnee privee de la marque A inaccessible` |
| 6 | A, B, S | A puis B | S | A **ou** B | `REL_AS`, `REL_BS` | `P_A`, `P_B`, `D_A`, `D_B`, `D_S_VERS_B` | garde produit + garde documentaire | compte multi-organisations, bascule explicite de tenant | **AUTORISÉ** uniquement sur le tenant armé ; **REFUSÉ** sur l'autre, sauf partage explicite | `6. compte multi, tenant A : document de B refuse` |
| 7 | S | A | S | A | `REL_AS` **révoquée** (`ended`), `REL_BS` active | `D_S_VERS_A`, `D_CERT_S`, `D_REPONSE`, `D_S_VERS_B` | partage, certification, réponse de collecte | révocation d'une relation : retrait immédiat, sans retrait global | **REFUSÉ** immédiat pour A ; B conserve son partage | `7. apres revocation de la relation A<->S : partage retire` |
| 8 | S | A | S | A | `REL_AS` active | `D_S_VERS_A` (`SHARE_SA`) et `D_S_VERS_B` (`SHARE_SB`) | partage explicite borné par `scope.document_ids` | lire un document partagé dans le périmètre du partage | **AUTORISÉ** S→A ; **REFUSÉ** S→B | `8. marque A : document du fournisseur partage a B uniquement refuse` |
| 9 | S, B, A (supprimé) | A | S | A | `REL_AS` active | `D_S_PRIVE`, `D_B`, `D_A` (soft-delete) | garde documentaire | accès direct par ID exact, clé ou URL ; document supprimé | **REFUSÉ** dans tous les cas | `9. document supprime logiquement : refuse` |
| 10 | A / B | A → B → A | S | A et B | `REL_AS`, `REL_BS` | `D_A`, `D_B`, `P_A` | gardes liés au GUC de tenant | bascule de tenant sans héritage de droits | **AUTORISÉ** seulement dans le tenant courant ; aucun droit résiduel | `10. retour vers A : aucun droit sur B n a ete conserve` |

## 4. Voies inter-organisations autorisées (limitées et testées)

| Voie | Condition stricte | Décision |
| --- | --- | --- |
| Propriété | `owner_organization_id = tenant actif` + adhésion active | autorisée, tous états non supprimés du cycle documentaire |
| Partage explicite `data_shares` | `grantee = tenant actif`, `status='active'`, fenêtre temporelle valide, `scope.all` ou `scope.document_ids` contenant l'ID, **relation `active`** cohérente | autorisée |
| Réponse de collecte | `data_requests.brand_organization_id` (ou `supplier_organization_id`) = tenant actif, relation de la demande active si `relationship_id` est renseigné | autorisée |
| Certificat de la marque active | `certifications.owner_organization_id = tenant actif` ou produit de la marque active | autorisée |
| Certificat fournisseur via relation | certificat **et** document appartiennent au fournisseur, relation `brand_supplier_relationships.status='active'` avec la marque active | autorisée — **durcie après une fuite mesurée** : un certificat déposé par A au nom de S rendait un document de A visible à B via `REL_BS` |
| Certificat émis par une marque au nom du fournisseur | `cert.owner_organization_id = propriétaire du document`, `supplier.organization_id = tenant fournisseur`, relation active avec la marque émettrice | autorisée (scénario 3) |
| Point de donnée | `data_points.source_document_id` rattaché à un produit de la marque active | autorisée |
| Types `platform` / `verifier` | aucune voie inter-organisations par défaut | refusée |

Toute autre voie est fermée. La révocation d'une relation (`ended`) retire les
droits immédiatement ; la politique restrictive RLS applique la même décision
aux requêtes SQL qui ne passent pas par un garde de route.

## 5. Surfaces couvertes

- **Routes** : les 138 entrées de `api/index.ts` sont classées dans
  `docs/security/route-tenant-matrix.json` (102 métier avec tenant actif validé
  + garde SQL, 25 publiques/worker, 11 compte/calcul documentées, 0 non
  classifiée). Contrat exécutable : `npm run test:tenant:matrix`.
- **Import / export** : `catalog/import/*`, `catalog/export/*`,
  `catalog/products/import|export`, `supplier/materials/import-bom`,
  `catalog/audit-export` utilisent `withTracefabTenantContext` et
  `tenantFilter(tenant)` ; l'export applique les mêmes permissions que la
  consultation.
- **Documents / stockage** : `upload-intent` (clé préfixée propriétaire,
  quota), `scan` (fail-closed, trois transactions, tenant propriétaire
  conservé), `download` (garde documentaire + `status='available'` avant URL
  présignée), rapports, `verify-ai`, preuves de nœuds/liens/points de donnée,
  remplacement, suppression logique. Le téléchargement fournisseur utilise
  désormais le garde de tenant : les partages légitimes A→S ne sont plus
  perdus, aucune union d'adhésions n'est réintroduite.
- **Portail / intégrations / webhooks / workers** : `currentSupplier` exige le
  tenant ; `supplier/organizations` ne choisit plus implicitement la première
  adhésion ; les contextes worker/public n'arment aucun tenant et conservent
  leur comportement historique (mesuré en A3). Les traitements asynchrones
  documentaires propagent `ownerOrganizationId` (contrat
  `test_private_storage.mjs`, `test_active_tenant_routes.mjs`).
- **SQL / RLS** : `tracefab_can_access_document` et
  `tracefab_can_access_shared_subject` sont réécrits par la 70e migration
  (`CREATE OR REPLACE`, OID/propriétaire/ACL préservés, aucun checksum
  historique modifié) pour être liés au tenant actif quand il est armé ; la
  politique RESTRICTIVE `documents_restrict_active_tenant` ferme la branche
  `tracefab_can_access_org` de la politique permissive historique. 128
  fonctions `SECURITY DEFINER` inventoriées : toutes avec `search_path`, aucune
  exécutable par `PUBLIC`, propriétaires `postgres` / `tracefab_worker`.

## 6. Ce que cette matrice ne prouve pas

Aucun parcours HTTP réel sur Vercel Preview, aucune branche Neon isolée, aucune
vérification Production (état de `main`, SHA déployé, migrations appliquées,
rôles, variables sans valeurs secrètes). Une réussite sur base jetable n'est
jamais une validation de ces environnements. Les contrôles restant à autoriser
sont listés dans `docs/security/preuves-isolation-globale-2026-11-06.md` §5.
