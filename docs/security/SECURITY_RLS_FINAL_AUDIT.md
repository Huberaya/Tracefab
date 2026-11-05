# Audit final — RLS, `SECURITY DEFINER` et contexte de locataire

Branche : `arena/8cb8c0b6-tracefab`, base `origin/pr111` = `3d1eb1c`
(`fix/active-tenant-plm-ingest-20261105`, qui dépend de `fix/neon-migration-reconciliation-20261104` = PR #110).
Mesures faites sur PostgreSQL 17.11 réel, base jetable `tracefab_test`, rôle `tracefab_app` **sans**
`BYPASSRLS`, chaîne de **88 migrations** appliquée par `scripts/migrer_fidelement.mjs`.

Ce document n'est pas un audit documentaire : chaque affirmation ci-dessous a été **mesurée**,
et quand une mesure a contredit une lecture du code, c'est la mesure qui a été retenue et le
défaut qui a été corrigé. Les corrections sont dans quatre migrations additives
(`20261105250000` … `20261105280000`), jamais dans une migration existante.

---

## 1. Ce qui a été trouvé, et ce qui a été corrigé

Cinq défauts réels, tous **préexistants** sur la base PR #111 (reproduits sur une base montée
depuis `origin/pr111` seul, sans aucune de mes migrations).

| # | Défaut mesuré | Preuve avant | État |
|---|---|---|---|
| F1 | Les politiques de `documents`, `materials`, `suppliers`, `supplier_sites`, `certifications` accordaient la **propriété sur la seule appartenance** : un membre de A et de B, locataire A actif, lisait et modifiait les pièces et les matières de B. | `select count(*) from documents` sous `tracefab_app`, locataire A actif → **1** pièce de B ; `tracefab_can_access_document(<pièce de B>)` → **true** ; `update materials` → 1 ligne. | corrigé `20261105250000` |
| F2 | Les branches « côté marque » de `suppliers`, `supplier_sites`, `certifications` et la branche « relation » de `materials` ne portaient pas la garde de locataire. Découvert **en écrivant le test de F1** : le test de fuite passait au vert sur les documents et restait rouge sur les fournisseurs. | `select count(*) from suppliers` sous le locataire A → fournisseur de B visible. | corrigé `20261105250000` (§ 3 ter) |
| F3 | `tracefab_current_user_email()` était `SECURITY INVOKER` et lisait `public.users`, table sur laquelle `tracefab_app` n'a aucun `SELECT`. PostgreSQL contrôle les privilèges **à l'analyse**, y compris sur une branche `CASE` non empruntée. | `select id from organizations` sous `tracefab_app` → `42501 permission denied for table users` ; toute la liste des organisations était inatteignable. | corrigé `20261105260000` |
| F4 | `tracefab_app` n'avait pas `SELECT` sur `users` ni sur `tracefab_runtime_function_registry`, alors que la politique `users_select_self` existait et que `scripts/lire-disponibilite-role-app.mjs` déclare le registre « lisible par conception ». L'ACL refusait avant que la RLS ne s'applique. | `test:neon:rls` classait ces deux tables en « erreur de politique » (42501) sur base amorcée. | corrigé `20261105270000` |
| F5 | `tracefab_can_access_document()` bornait la **propriété** au locataire actif mais pas les **chemins indirects** : pièce source d'un point de donnée, pièce jointe à une certification rattachée à une relation, preuve de réponse de collecte. La politique `documents_select_authorized` délègue à cette fonction : la fuite traversait la RLS jusqu'à l'API. | Un administrateur de A et de B, locataire A actif : `tracefab_can_access_document(<pièce de B via point de donnée>)` → **true**, et `select count(*) from documents` → **1** des trois pièces de B. | corrigé `20261105280000` |

Après correction, les mêmes mesures rendent : locataire A actif → **0** pièce, fonction **false** ;
locataire B actif → **3** pièces, fonction **true**. Les deux sens sont vérifiés par
`test:neon:document-material-scope` (20 assertions).

### Ce qui a été vérifié sans anomalie

- Aucune fonction `SECURITY DEFINER` de `public` sans `search_path` figé (0 / 126).
- Aucune fonction `SECURITY DEFINER` exécutable par `PUBLIC` (0 / 126).
- Aucune table de données sans RLS **et** sans `FORCE ROW LEVEL SECURITY` : 53 / 53. La seule
  table sans RLS est `_prisma_migrations`, sur laquelle le runtime n'a aucun privilège.
- Aucune politique permissive `FOR ALL USING (true)` hors `rate_limit_counters` (quatre
  politiques par commande depuis `20261019140000`, suppression bornée à `expires_at < now()`).
- `tracefab_identity_cles` reste fermée par l'ACL au runtime (42501) : c'est le seul cas de
  fermeture **par privilège** et non par politique.

---

## 2. Chantier A — inventaire des fonctions `SECURITY DEFINER`

Mesure : `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef and p.prokind = 'f'` → **126**.
Chacune a été lue individuellement (`pg_get_functiondef`), pas comptée.

| Propriété | Mesure |
|---|---|
| `SECURITY DEFINER` dans `public` | 126 |
| sans `search_path` figé | **0** |
| exécutables par `PUBLIC` | **0** |
| exécutables par `tracefab_app` | 87 |
| portant une garde de locataire actif (`tracefab_require_active_tenant_*`, `tracefab_in_active_tenant`, `tracefab_active_organization_id`) | 58 |
| propriétaires = rôle de migration | 126 (aucune possédée par `tracefab_app` — vérifié par postcondition) |

### 2.1 Les 19 fonctions de l'audit initial

Bornées par `20261105170000` (19 fonctions : graphe, PEF, DPP, qualité, collecte, produits,
mass-balance, publication, schémas), puis `20261105180000` (`tracefab_register_transaction_certificate`),
`20261105190000` (7 fonctions qualité/collecte), `20261105200000` (4 matières/certifications),
`20261105210000` (4 profil/passeport fournisseur), `20261105220000` (3 CAP), `20261105230000`
(invitations/documents/scans/revue de passeport), `20261105240000` (qualité fournisseur).
Toutes conservent OID, propriétaire et ACL, ce que chaque migration vérifie par postcondition.

### 2.2 Les 31 fonctions exécutables par le runtime sans garde de locataire — examen individuel

Elles ne sont **pas** des oublis : chacune relève d'une catégorie où un locataire actif n'a pas
de sens, ou bien elle porte sa propre vérification d'autorisation. Vérifié une par une :

| Catégorie | Fonctions | Pourquoi aucun locataire actif n'est requis |
|---|---|---|
| Lecture PUBLIQUE (passeport DPP) | `tracefab_public_dpp_claims`, `tracefab_product_is_public`, `tracefab_material_is_public`, `tracefab_supplier_site_is_public`, `tracefab_public_brand`, `tracefab_get_public_supplier_passport` | Elles ne rendent que ce qu'une politique publique rendrait déjà (`*_select_public` avec `tracefab_public_context`). Aucune donnée privée n'est atteignable, et le contexte public est posé par `withPublicContext` avant l'appel. |
| Visiteur non authentifié | `tracefab_request_passport_access` | Écrit une demande d'accès, jamais une donnée privée ; validée par le jeton/slug public du passeport. |
| Identité et adhésion | `tracefab_current_user_email`, `tracefab_can_access_org`, `tracefab_has_org_role`, `tracefab_is_org_member` | Prédicats sur l'identité **courante** (`tracefab_current_user_id()`), pas sur un locataire. Les borner au locataire actif les rendrait faux pour l'adhésion elle-même. |
| Provisionnement et synchronisation Clerk | `tracefab_ensure_clerk_user`, `tracefab_upsert_clerk_user`, `tracefab_soft_delete_clerk_user`, `tracefab_clerk_organization_uuid`, `tracefab_sync_clerk_membership`, `tracefab_sync_clerk_organization`, `tracefab_archive_clerk_organization`, `tracefab_revoke_clerk_membership`, `tracefab_create_organization`, `tracefab_register_supplier_organization` | Appelées avec l'identité **worker** (`tracefab.worker_context`), qui est une identité d'exploitation distincte ; elles sont inatteignables pour un utilisateur authentifié. `test:neon:worker-non-forgeable` prouve que ce contexte ne peut pas être posé par `tracefab_app`. |
| Invitation | `tracefab_accept_organization_invitation` | L'invité n'est pas encore membre : le jeton haché **est** l'autorisation. |
| Cycle de vie documentaire | `tracefab_apply_document_ai_verification`, `tracefab_finalize_document_upload` | Vérification interne : `tracefab_current_user_id()` non nul (`authentication_required`), puis `tracefab_can_access_document(p_document_id)` — qui porte désormais la garde de locataire (F1 et F5). La garde est donc **déléguée**, pas absente. |
| Outbox de notifications | `tracefab_claim_notification_outbox`, `tracefab_complete_notification_outbox`, `tracefab_notification_outbox_health`, `tracefab_enqueue_due_data_request_reminders`, `tracefab_enqueue_manual_data_request_reminder` | Identité worker ; `enqueue_manual` vérifie en plus l'appartenance à la marque de la demande par le rôle d'appel (route `data-requests/[requestId]/remind.ts`, couverte par le contrat de route). |

Conclusion du chantier A : aucune fonction `SECURITY DEFINER` n'est exécutable par `PUBLIC`,
aucune n'a de `search_path` mutable, aucune n'est possédée par le rôle HTTP, et celles qui
n'ont pas de garde de locataire ont une raison écrite ci-dessus. Les deux fonctions qui
délèguent (`apply_document_ai_verification`, `finalize_document_upload`) délèguent à une
fonction qui, elle, porte la garde.

---

## 3. Chantier B — inventaire et classification des politiques RLS

Mesure : `pg_policies` → **134 politiques** sur **53 tables**, toutes en RLS **activée et
forcée**. 23 politiques portent `tracefab_in_active_tenant` ; 14 portent une branche publique
`tracefab_public_context`.

Huit catégories, avec leur modèle d'autorisation et la justification de l'absence — ou de la
présence — d'une condition de locataire actif :

| Cat. | Modèle | Tables | Politiques | Locataire actif ? |
|---|---|---|---|---|
| 1 | **Propriété privée de locataire** | `tracefab_products`, `materials`, `documents`, `suppliers`, `supplier_sites`, `certifications`, `data_points`, `product_materials`, `product_green_claims`, `product_pef_assessments`, `plm_erp_integrations`, `plm_erp_sync_jobs`, `tracefab_catalog_import_jobs`, `verification_records`, `data_quality_issues`, `data_quality_scores` | 33 | **oui** — la propriété ne suffit pas, l'appartenance est vraie pour toutes les organisations du compte |
| 2 | **Propriété + projection publique (DPP)** | `dpp_records`, `dpp_claims`, `dpp_lifecycle_events`, `dpp_resolvable_identifiers`, `product_identifiers`, `supply_chain_nodes`, `supply_chain_links`, `mass_balance_reconciliations` | 24 | oui sur les politiques privées, **non** sur les politiques publiques : un passeport publié doit être lisible sans session, et le prédicat public est `tracefab_public_context`, posé par `withPublicContext` |
| 3 | **Lien métier partagé (fournisseur ↔ marque)** | `data_shares`, `brand_supplier_relationships`, `supplier_universal_passports`, `supplier_passport_access_requests` | 11 | **non au niveau du partage**, oui au niveau du bénéficiaire : `tracefab_can_access_shared_subject` exige que le **bénéficiaire** soit le locataire actif (ajouté par `20261105250000`). C'est le modèle voulu : le partage est explicite, borné par portée et par dates. |
| 4 | **Demande de collecte (parties prenantes)** | `data_requests`, `data_request_items`, `data_responses`, `orders`, `transaction_certificates` | 16 | **non** : la politique nomme les **parties** (marque demandeuse, fournisseur répondant). Les borner à un locataire unique casserait la relation elle-même. Les routes qui les servent bornent le locataire et arment le sujet (migrations 78/79). |
| 5 | **Identité et adhésion** | `users`, `organizations`, `organization_memberships`, `organization_invitations` | 16 | **non** : ce sont les objets qui *définissent* l'appartenance. `users_select_self` et `memberships_select_member` bornent à l'identité courante, ce qui est strictement plus étroit qu'un locataire. |
| 6 | **Interne / worker** | `organization_memberships` (worker), `organizations` (worker), `users` (worker), `data_requests`/`items`/`responses` (worker), `tracefab_notification_outbox`, `tracefab_identity_cles`, `tracefab_identity_politique`, `tracefab_runtime_function_registry` | 12 | **non** : identité worker ou propriétaire de migration. `test:neon:worker-non-forgeable` prouve que `tracefab_app` ne peut pas poser ce contexte. |
| 7 | **Référentiel public** | `tracefab_schema_catalog`, `pef_emission_factors`, `green_claims_rules`, `dpp_requirement_profiles` | 4 | **non** : données de référence, identiques pour tous. Aucune donnée d'organisation. |
| 8 | **Infrastructure** | `rate_limit_counters`, `audit_logs`, `quality_corrective_action_plans`, `quality_cap_messages`, `green_claims_audits`, `tracefab_schema_bindings`, `mass_balance_allocations` | 18 | mixte, justifié politique par politique : les compteurs ne portent aucune donnée métier ; les CAP et messages portent une garde de partie ; les audits verts portent une garde d'organisation. |

Contrôle : 33 + 24 + 11 + 16 + 16 + 12 + 4 + 18 = **134**. Les catégories ne sont pas une
numérotation de confort : elles décrivent **qui** porte l'autorisation (locataire, bénéficiaire
d'un partage, partie à une demande, identité, worker, référentiel), et c'est cette distinction
qui explique pourquoi une condition de locataire actif n'est pas ajoutée partout.

### 3.1 Chemins indirects — ce que la RLS délègue

Trois politiques ne portent pas la garde **elles-mêmes** parce qu'elles délèguent à une
fonction `SECURITY DEFINER` : `documents_select_authorized` (→ `tracefab_can_access_document`),
`materials_select_authorized` (→ `tracefab_material_visible_via_product` +
`tracefab_can_access_shared_subject`), `certifications_select_authorized` (→ produit de la marque).
La leçon de F5 est que **la garde doit être dans la fonction délégataire**, sinon la politique
l'hérite absente. C'est désormais le cas, et une postcondition de `20261105280000` refuse une
définition où l'une des branches indirectes ne porte pas le prédicat.

---

## 4. Scénarios obligatoires — résultat mesuré

Tous exécutés sous `tracefab_app` (sans `BYPASSRLS`), dans PostgreSQL, par
`scripts/test_neon_document_material_tenant_scope.mjs` (20 assertions) et les suites
`test:neon:cross-tenant`, `test:neon:active-tenant`, `test:neon:document-lifecycle`,
`test:neon:dpp-lifecycle`.

| Scénario | Attendu | Mesuré |
|---|---|---|
| Marque A lit ses propres produits | autorisé | oui (1 ligne) |
| Marque A lit les produits de B, même compte, A actif | refusé | oui (0 ligne) |
| Marque A modifie un produit de B | refusé | oui (0 ligne, intégrité vérifiée en relecture propriétaire) |
| Fournisseur S lit ses propres informations | autorisé | oui |
| Marque A accède à une matière **explicitement partagée** par S | autorisé | oui (partage `data_shares` actif, portée `material_ids`) |
| Marque A accède à une matière **non partagée** de S | refusé | oui (0 ligne) |
| Marque A accède à une pièce fournisseur **partagée** | autorisé | oui |
| Marque A accède à une pièce fournisseur **non partagée** | refusé | oui (0 ligne, fonction false) |
| Marque A atteint une pièce de B par **point de donnée / certification** | refusé | oui (0 ligne, fonction false) — après F5 |
| Utilisateur sans locataire actif | fail-closed | oui (0 ligne, fonction false) |
| Utilisateur membre de plusieurs organisations | borné au locataire | oui |
| Bascule de locataire (A puis B, mêmes requêtes) | les deux voient leurs données, jamais celles de l'autre | oui |
| Identifiant d'organisation fourni par le client mais non membre | refusé | oui (`resolveActiveTenant` → 404 `organization_not_found`) |
| Contournement par appel SQL direct d'une fonction `SECURITY DEFINER` | refusé | oui (gardes de locataire, `test:neon:active-tenant` : refus positifs et négatifs par fonction) |
| Passeport DPP public | autorisé sans session | oui (`tracefab_public_context`) |
| Passeport DPP privé (brouillon) | refusé sans session et hors locataire | oui |

---

## 5. Chantier C — chaîne documentaire

Chaîne vérifiée de bout en Bout : téléversement (`upload-intent` → `tracefab_register_document`),
métadonnées, association, bucket privé (`tracefab-private`, trigger
`tracefab_validate_document_location` qui exige un chemin préfixé par l'organisation
propriétaire — mesuré : `document_path_must_be_tenant_scoped`), propriété et partage, lecture et
téléchargement, vérification IA (`tracefab_apply_document_ai_verification`), preuve
(`verification_records`), suppression.

- L'état initial est contraint : `new_documents_must_start_uploaded` (mesuré en écrivant le test —
  une insertion directe en `available` est refusée, la garde n'a pas été désarmée).
- La disponibilité passe par le canal interne documenté
  (`set_config('tracefab.internal_document_update','true',false)`), jamais en désactivant le trigger.
- `sourceDocumentId` : les pièces de collecte restent accessibles aux **parties** de la demande, et
  désormais seulement si la partie concernée est le locataire actif (F5).
- Le rôle `tracefab_app` n'a **pas** `UPDATE` sur `documents` : les tests acceptent
  `permission denied` **ou** `rowCount 0`, et prouvent l'intégrité en relisant côté propriétaire.
  Aucun privilège n'a été élargi pour faire passer un test.

---

## 6. Chantier D — modèle fournisseur/marque

- `tracefab_material_visible_via_product` : visibilité d'une matière par la **composition d'un
  produit de la marque active**, ou par partage explicite. La branche composition est bornée par
  `tracefab_in_active_tenant(p.brand_organization_id)` (`20261105250000` § 3 ter) — sans cela, la
  relation produit-matière d'un produit de B restait lisible depuis A.
- `suppliers`, `supplier_sites`, `certifications` : les branches « côté marque » exigent le
  locataire actif de la marque détentrice de la relation.
- Le partage explicite conserve sa sémantique : `data_shares` avec `scope` (`material_ids`,
  `document_ids`), `status = 'active'`, fenêtre de validité, et **bénéficiaire actif**.

---

## 7. Chantier E — contexte de locataire dans les routes

Trois constats, un correctif structurel :

1. `resolveActiveTenant()` **vérifie** l'adhésion mais **n'arme rien** dans la session SQL. Un
   route qui appelait `withTracefabUserContext(...)` sans quatrième argument puis
   `resolveActiveTenant(...)` bornait ses `where` Prisma mais laissait `tracefab_in_active_tenant`
   fausse : fail-closed, et **silencieux** (liste vide au lieu d'une erreur).
2. La variante `withTracefabRequestContext(req, user, cb)` arme `requestedTenantId(req)` **et**
   signe le jeton d'identité avec la même organisation — c'est la seule forme qui garantit la
   cohérence entre le GUC et le HMAC (armer après coup invaliderait le jeton signé, donc ce
   n'est **pas** une option).
3. **41 appels** dans 41 fichiers de route ont été convertis de `withTracefabUserContext(...)`
   vers `withTracefabRequestContext(req, user, ...)` ; la chaîne documentaire est couverte
   intégralement (7 fichiers : `documents.ts`, `upload-intent.ts`, `scan.ts`, `download.ts`,
   `security-report.ts`, `verification-report.ts`, `verify-ai.ts`).

Les 48 appels restants ont été examinés et laissés tels quels pour une raison explicite :
soit ils arment déjà explicitement un locataire (quatrième argument
`activeOrganizationId`/`requestedOrganizationId`/`requestedOrgId`/`organizationId`), soit ils
résolvent un **sujet** (fournisseur désigné par un identifiant de route, gravures de collecte),
soit ils n'ont aucun locataire (provisionnement, `me.ts`, `organizations.ts`, acceptation
d'invitation, `document-scan-flow` qui arme le propriétaire dans ses trois transactions).

Contrat statique : `scripts/lib/tenant-arming.mjs` définit **une** reconnaissance des deux formes
légitimes d'armement, et les contrats de route (`test:active-tenant:routes`, 147 contrôles)
l'utilisent. La reconnaissance ne considère **pas** comme armé un `withTracefabUserContext` à
trois arguments : c'est précisément l'oubli que ces contrats doivent refuser.

---

## 8. Chantier F — registre d'erreurs SQL

`api/_lib/sql-errors.ts` : **25 codes ajoutés** (13 pour `20261105250000`–`20261105270000`, 12 pour `20261105280000`), tous en `409` parce que ce sont des invariants
d'état de schéma ou de provisionnement (cible absente, OID/propriétaire/ACL modifiés,
`search_path` perdu, privilège de lecture manquant ou écriture accordée par erreur), jamais une
panne serveur ni une erreur de validation. L'audit `test:sql-errors` mappe désormais
**261 gardes PostgreSQL** et vérifie par nom **22 gardes multi-tenant** ; il échoue si une
migration introduit un code métier non mappé — ce qui est exactement ce qui s'est produit, et
ce qui a été corrigé.

---

## 9. Chantier G/H — migrations et tests

| Migration | Rôle | Idempotence | Préconditions | Postconditions |
|---|---|---|---|---|
| `20261105250000_active_tenant_document_material_access` | locataire actif sur documents/matières/fournisseurs/sites/certifications + bénéficiaire du partage | remplace des politiques et deux fonctions (rejeu sans effet de bord) | cibles présentes, `SECURITY DEFINER`, propriétaire ≠ runtime | texte des 7 politiques, préservation des politiques publiques, EXECUTE du runtime |
| `20261105260000_runtime_user_email_definer_guard` | email du porteur évaluable par le runtime | `CREATE OR REPLACE` | OID, propriétaire, ACL capturés avant | même OID/propriétaire/ACL, `prosecdef`, `proconfig` contient `search_path` |
| `20261105270000_runtime_read_users_and_registry` | `SELECT` seul sur `users` et le registre runtime | `GRANT` idempotent | tables présentes, RLS forcée | aucun `INSERT/UPDATE/DELETE/TRUNCATE`, RLS forcée, politique de lecture présente |
| `20261105280000_active_tenant_document_indirect_paths` | branches indirectes de `tracefab_can_access_document` | `CREATE OR REPLACE` | cible présente, `DEFINER`, propriétaire ≠ runtime | OID/propriétaire/ACL, `search_path`, EXECUTE runtime, non-exécutable par `PUBLIC`, ≥ 7 occurrences du prédicat |

Ordre : elles s'appliquent après les 84 migrations de la base PR #111, dans l'ordre
lexicographique, et la chaîne complète (88) s'applique en une passe sur une base vierge.
Rejeu : `test:rejeu-migrations`, `test:application-une-par-une`,
`test:neon-migration-reconciliation` (PGlite, 19 corrections forward appliquées puis rejouées).

---

## 10. Chantier I — CI

Le job `Base — isolation RLS executee` monte un PostgreSQL 17 jetable et applique la chaîne
réelle. Une étape ajoutée exécute `test:neon:document-material-scope` (20 assertions), placée
avant les suites d'étanchéité : le test fait son **ménage** de fixtures, vérifié, parce qu'une
suite voisine (`test:neon:worker-non-forgeable`) mesure « aucune autre organisation visible » et
échouait à cause de fixtures laissées en place — mesuré, puis corrigé.

Aucun test n'a été désactivé, aucun `continue-on-error`, aucune exclusion de fichier, aucune
assertion affaiblie. Les contrats statiques qui ne reconnaissaient qu'une seule des deux formes
légitimes d'armement ont été **généralisés par un module partagé**, pas contournés : la propriété
vérifiée est la même, et elle est vérifiée pour davantage de routes.

---

## 11. Ce qui n'est pas vérifié en environnement réel

| Point | Statut | Raison |
|---|---|---|
| Suites navigateur (21 suites : `test:catalogue`, `test:journeys`, `test:*:browser`, …) | **bloqué en local** | Le binaire Chromium est téléchargé depuis un CDN inaccessible dans cet environnement ; la CI les exécute avec ses propres navigateurs. |
| `test:neon:security`, `test:neon:dpp-provenance`, suites produit/fournisseur/qualité/collecte | **bloqué en local** | `prisma generate --no-engine` (les binaires Prisma viennent du même CDN) ; l'erreur est `PrismaClientValidationError … '--no-engine'`. Reproduite à l'identique sur une base PR #111 seule : indépendante de mes changements. |
| Parcours de bout en bout sur branche Neon isolée | **non réalisé** | Aucun accès à une branche Neon dans cette session ; aucune écriture n'a été tentée sur Production ni Préproduction. |
| Application des migrations en Préproduction/Production | **non réalisé, volontairement** | Exige une autorisation opérateur et une réconciliation en lecture seule ; voir `SECURITY_MIGRATION_EVIDENCE.md` § 6. |

---

## 12. Compatibilité avec les PR #110 et #111

- Base : `origin/pr111` = `3d1eb1c` (branche `fix/active-tenant-plm-ingest-20261105`, PR #111,
  qui cible `fix/neon-migration-reconciliation-20261104`, PR #110).
- Mes migrations sont **postérieures** aux 84 de cette base et n'en modifient aucune : ni
  `migration.sql`, ni `_prisma_migrations`, ni checksum.
- Elles supposent acquises les corrections de #110 (réconciliation de l'historique, correctif
  PLM/GS1) et de #111 (gardes de locataire actif sur 13 migrations, dont
  `20261105170000`–`20261105240000`) : la mienne réutilise `tracefab_in_active_tenant`,
  `tracefab_require_active_tenant_*` et `tracefab_can_access_shared_subject`, toutes créées par
  #111 ou antérieures.
- Ordre d'application : #110, puis #111, puis ces quatre migrations. Aucune ne doit être
  appliquée seule sans les précédentes.
