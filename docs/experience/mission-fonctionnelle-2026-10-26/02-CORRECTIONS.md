# Corrections appliquées — mission fonctionnelle DPP

## 1. Chantier E — Prisma, build, tests API (cause racine)

**Reproduction :** `node scripts/prisma-generate.mjs` échoue avec
`request to https://binaries.prisma.sh/all_commits/c2990dca…/debian-openssl-3.0.x/schema-engine.sha256 failed, reason: Client network socket disconnected before secure TLS connection was established` (code 1). `npm run db:generate` échoue sur `schema-engine.gz.sha256`. `npm ci` échoue donc sur son `postinstall`.

**Diagnostic :** Prisma 6.19.3 / @prisma/client 6.19.3 / Node v22.22.3 / npm 10.9.8 ; `prisma/schema.prisma` inchangé (57 migrations, 49 modèles). Le CLI `prisma` embarque déjà `build/schema_engine_bg.wasm` et `build/query_engine_bg.postgresql.wasm`. Ce n'est ni une incompatibilité de version ni une erreur de schéma : c'est l'accès réseau du runner.

**Correction (sans faux client, sans modification du schéma) :**
- `scripts/db-generate-offline.mjs` + `npm run db:generate:offline` : génère le client officiel en indiquant au CLI les moteurs WASM déjà présents (`PRISMA_SCHEMA_ENGINE_BINARY`, `PRISMA_QUERY_ENGINE_LIBRARY`, `PRISMA_CLIENT_FORCE_WASM=1`), puis vérifie `index.d.ts`, `index.js`, `query_engine_bg.wasm`.
- `scripts/verify_prisma_client.mjs` : reconnaît le moteur WASM **officiel** par un contrôle structurel strict (chargeur présent, fichier > 1 Mo, magie `\0asm`, `config.engineWasm` dans le client généré). Le contrôle natif reste inchangé pour la CI/production.
- `scripts/lib/offline-prisma-preload.mjs` + `scripts/run-db-suite.mjs` + `scripts/test_router_module_load.mjs` : injectent, sur opt-in explicite `TF_OFFLINE_PRISMA_PRELOAD=1` et uniquement avec un `DATABASE_URL` jetable, le VRAI client Prisma avec l'adaptateur `@prisma/adapter-pg` via le point d'injection officiel `globalThis.tracefabPrisma`. Cela supprime une rejection non gérée du moteur WASM qui faisait échouer `test:router-load` **après** que ses assertions étaient vertes. Aucune assertion, aucun gestionnaire, aucun contrôle de sécurité n'est modifié.
- `@prisma/adapter-pg@6.19.3` installé dans `node_modules` pour les tests locaux (`--no-save --package-lock=false`) : aucun fichier versionné de dépendances n'est changé.

**Résultats :** `npm run build` = 0, `npm test` = 0, `api:typecheck` = 0, `typecheck` = 0, `verify:prisma-client` = 0 (49 délégués), `test:router-load` = 0 (136 modules), `test:product-edit:api` = 0. `npm ci` et `db:generate` natifs restent **BLOQUÉS** localement ; ils passent en CI (run `40373818672` sur `bf55f2a`, conclusion SUCCESS, étape « Generer le client Prisma » verte).

## 2. Chantier B — Documents (cause racine)

**Anomalie 1 :** aucun `GET /api/documents` pour la marque. `state.documents` n'était alimenté que par `demoData()`, d'où un Evidence Centre figé sur « non calculé » et des boutons désactivés.

**Anomalie 2 (sécurité) :** `api/_routes/documents/upload-intent.ts` appelait `activeBrandOrganizationIds(tx, user.id)` et retenait `brandIds[0]`, et utilisait `withTracefabUserContext` sans 4e argument : le locataire actif n'était jamais armé. Un compte multi-organisations pouvait donc enregistrer une preuve dans le mauvais tenant. C'est exactement le défaut documenté dans `api/_lib/tenant.ts`.

**Corrections :**
- Nouveau `GET /api/documents` : `requireActiveTenant(types:['brand'])`, filtre `owner_organization_id = tenantFilter(tenant)`, `status <> 'deleted'`, joint la dernière décision de `verification_records`, filtre serveur optionnel `?productId`, `Cache-Control: no-store`.
- `upload-intent` réécrit avec `withTracefabRequestContext` + `requireActiveTenant` ; `metadata.productId` doit être un UUID d'un produit appartenant au même locataire (sinon 404), le chemin de stockage reste `storageObjectKey(tenant, filename)` donc préfixé par l'organisation.
- Nouveau `POST /api/documents/:id/validation` : décision `accepted|rejected|needs_review`, motif obligatoire au rejet, vérifie l'accès au document (`tracefab_can_access_document`), le statut `available`, le locataire actif via `accessibleProduct`, puis enregistre la décision **en réutilisant** `tracefab_add_dpp_claim` + `tracefab_link_dpp_claim_evidence` (fonctions déjà autorisées), avec motif et historique. Aucune nouvelle fonction SQL, aucune migration, aucune modification de l'allowlist des privilèges — les contrôles CI `test:neon:privileges-role-app` (7/7 assertions statiques) et `test:sql-errors` restent verts.
- Routes enregistrées dans `api/index.ts` ; `test:routes` = 140 routes, 139 fichiers, aucun motif masqué ; `test:route-auth-coverage` = 159 refus anonymes observés, 0 échec.
- Interface : chargement réel, erreur avec code + réessai, vide, succès, formulaire de dépôt (types/taille contrôlés côté client ET serveur), PUT signé, scan, téléchargement signé, décision avec motif. 38 clés i18n ajoutées aux 7 catalogues à parité stricte.

**Limite honnête :** les variables `PRIVATE_STORAGE_*` sont absentes du bac ; le PUT signé et l'antivirus sont testés avec des fixtures côté navigateur. Le transfert réel vers un stockage objet n'est **pas** démontré ici.

## 3. Chantier C — Aperçu DPP brouillon (cause racine)

**Anomalie :** « Preview DPP · draft » ouvrait `/dpp/?gtin=…`, URL publique qui n'affiche un passeport que s'il est publié. Aucun aperçu du dossier non publié.

**Correction :**
- `GET /api/products/:id/dpp/preview` : authentifié, `withTracefabRequestContext`, `accessibleProduct` (accès + locataire actif), lectures seules du produit, identifiants, composition, points de données, preuves liées et dernier `dpp_records` via `fetchLatestDppRecord` + `buildDppSummary`. Réponse `preview:true`, `private:true`, `published`, `state` (`draft|incomplete|validated|published`), `missingFields`, `blockingCount`, `trust`, `generatedAt`. En-têtes `Cache-Control: no-store, private` et `X-Robots-Tag: noindex, nofollow`. Aucune écriture, aucun recalcul, aucune publication.
- Bouton de la fiche produit et bouton de la vue DPP recâblés sur une modale d'aperçu privé (états chargement/erreur/réessai/contenu), avec bandeau « brouillon privé — non publié », champs manquants, données persistées et disclaimer « ni certification ni conformité réglementaire ».
- `test:sql-errors` respecté : la route classe les erreurs métier SQL via `sqlBusinessError`.

## 4. Chantier A — Persistance produit

Le parcours serveur existait (`tracefab_create_product`, `tracefab_update_product_data`, `GET/PATCH /api/products/:id`). Il n'était pas démontré. Le nouveau test `test:mission-functional` prouve : création → modification → **relecture dans une nouvelle transaction** (A1–A3), rattachement au tenant, absence de slug public. Aucun faux succès n'a été trouvé dans ce parcours ; les états d'erreur de l'interface ont été renforcés (code d'erreur affiché, réessai).

## 5. Chantier D — Isolation

Base jetable locale obtenue avec `pgserver==0.1.4` (PyPI, hôte autorisé) : PostgreSQL 16.2 sur `127.0.0.1:55432`, base `tracefab_test`. Les 57 migrations sont appliquées dans l'ordre ; seule la ligne `CREATE EXTENSION IF NOT EXISTS pgcrypto;` est neutralisée **localement** car `gen_random_uuid()` est natif dans PostgreSQL 16 et que c'est la seule fonction de cette extension utilisée par le schéma. Aucune politique RLS, aucun rôle, aucun privilège n'est modifié : 50 tables RLS (50 FORCE), 131 politiques, `tracefab_app` sans BYPASSRLS.

15 suites DB du dépôt passent. Le scénario Alpha/Beta ajoute 22 assertions positives et négatives (voir `03-PREUVES-TECHNIQUES.md`).

## 6. Tests de non-régression ajoutés

| Fichier | Rôle |
| --- | --- |
| `scripts/test_mission_functional_dpp.mjs` (`npm run test:mission-functional`) | 22 assertions réelles sur PostgreSQL jetable : persistance produit, preuve, décision, aperçu, isolation Alpha/Beta. |
| `scripts/test_mission_ui_real_states.mjs` (`npm run test:mission-ui:states`) | 6 contrôles navigateur sur les états UI avec fixtures explicitement étiquetées. |
| `scripts/db-generate-offline.mjs` | Génération Prisma hors ligne vérifiée. |
| `scripts/lib/offline-prisma-preload.mjs` | Injection d'un client réel à adaptateur pour les suites hors ligne. |

Aucun test existant n'a été assoupli : `verify_prisma_client` a été **étendu** (nouveau contrôle structurel), `test_router_module_load` et `run-db-suite` n'ajoutent que l'injection optionnelle d'un client réel.
