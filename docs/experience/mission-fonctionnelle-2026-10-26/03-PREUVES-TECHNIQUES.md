# Preuves techniques — mission fonctionnelle DPP (2026-10-26)

## 1. SHA, Git, publication

| Élément | Valeur |
| --- | --- |
| SHA initial (`origin/main`, HEAD de départ) | `bf55f2ae6534cde84d072d9b975520216c7b6d4e` |
| Branche de session | `arena/647ac97c-tracefab` |
| État Git initial | propre, shallowClone (`grafted`), `origin/main` = HEAD = `bf55f2a` |
| **SHA final local** | **communiqué dans la réponse de livraison** (commit local, aucun push) |
| Push / PR | **aucun** — autorisation explicite distincte requise ; voir `01-RAPPORT-FINAL.md` §D |
| CI associée au SHA final | **aucune** (SHA non poussé). CI de référence : run `40373818672`, `push` sur `bf55f2a`, conclusion **SUCCESS**, 4/4 jobs |

PR ouvertes vérifiées : #98 (`dirty`), #94, #93 (draft), #92, #91, #82, #80, #70 (draft). Fermées récentes : #100, #99, #97, #96, #95 fusionnées. Fichiers et CI de chaque PR examinés via l'API REST (le endpoint GraphQL a renvoyé 504 une fois, sans incidence).

## 2. Environnement

- Node v22.22.3, npm 10.9.8, Python 3.11.2, PostgreSQL 16.2 jetable (`pgserver` 0.1.4 depuis PyPI).
- Variables sensibles absentes : `DATABASE_URL`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `VERCEL_TOKEN`, `RESEND_API_KEY`, `PRIVATE_STORAGE_BUCKET`. Aucune valeur de secret, aucun cookie, aucun jeton ni document confidentiel n'apparaît dans ce rapport ou les captures.
- URLs de test locales : propriétaire `postgresql://postgres@127.0.0.1:55432/tracefab_test`, applicatif `postgresql://tracefab_app:***@127.0.0.1:55432/tracefab_test` (mot de passe local jetable, non secret).
- Chromium de test : binaire épinglé `@sparticuz/chromium` + bibliothèques natives extraites du paquet npm, `LD_LIBRARY_PATH` hors dépôt.

## 3. Commandes et codes de sortie (exécutées, pas déduites)

### Prisma / build (avec environnement hors ligne documenté)

```
npm run db:generate:offline                0   client 6.19.3, DMMF complet, moteur WASM 2 297 601 octets
npm run verify:prisma-client              0   49 modeles, 49 delegues, moteur WASM magie \0asm
npm run typecheck                         0
npm run api:typecheck                     0
npm test                                  0
npm run build                             0   (avec TF_OFFLINE_PRISMA_PRELOAD=1)
npm run test:router-load                  0   136 modules charges, 200/404 sans correlationId
npm run test:product-edit:api              0   (avec preload)
node scripts/prisma-generate.mjs          1   BLOQUE : binaries.prisma.sh/schema-engine.sha256
npm run db:generate (natif)               1   BLOQUE : binaries.prisma.sh/schema-engine.gz.sha256
npm ci (postinstall)                      BLOQUE : meme cause ; installe via --ignore-scripts
```

Variables utilisées pour les commandes hors ligne :
`PRISMA_SCHEMA_ENGINE_BINARY=<repo>/node_modules/prisma/build/schema_engine_bg.wasm`,
`PRISMA_QUERY_ENGINE_LIBRARY=<repo>/node_modules/prisma/build/query_engine_bg.postgresql.wasm`,
`PRISMA_CLIENT_FORCE_WASM=1`, et `TF_OFFLINE_PRISMA_PRELOAD=1` + `DATABASE_URL` pour les étapes qui chargent les modules de l'API.

### Statique, routes, i18n, navigateur

```
test:routes                       0   140 routes, 139 fichiers, aucun motif masque, chaque handler repond
test:route-auth-coverage          0   159 refus d'acces anonyme, 0 echec (avec preload)
test:sql-errors                  0   toutes les routes SQL classent les erreurs metier
test:i18n                         0   2436 cles EN, parite stricte FR/DE/IT/ES/NL/PT, TR/ZH partielles
test:copy                         0   2545 chaines analysees sur 9 pages, 0 non traduite
test:assets                       0   77 references, empreintes exactes
test:brand-console / brand-journey / brand-journey-58 / customer-journey:blockers   0
test:mission-ui                   0   11/11
test:journeys                     0   20/20
test:mission-ui:states            0   6/6
test:accessibilite / touch / pagination / catalogue / coherence / donnees-demo /
surfaces / systeme-design / console-css / demo-declaree / dossier / phases      0
```

### Base jetable réelle (15/15 suites + scénario fonctionnel)

```
test:neon:rls                     0   isolation prouvee par execution, 50 tables
test:neon:cross-tenant            0   15 assertions, ecritures comprises
test:neon:document-lifecycle      0
test:neon:dpp-lifecycle           0
test:neon:dpp-provenance          0
test:neon:active-tenant           0
test:neon:privileges              0
test:neon:app-readiness           0
test:neon:sonde-identite          0
test:neon:write-policies          0
test:neon:bypass-control          0
test:neon:auth-provisioning       0
test:neon:storage:chantier10      0
db:migration-owner-guard          0
test:mission-functional           0   22/22 assertions
```

Commande de reproduction du scénario :
`source` des deux URLs + `npm run test:mission-functional` (le lanceur `run-db-suite` applique la garde de cible jetable).

## 4. Preuves de persistance après rechargement

`test:mission-functional` (base réelle, rôle `tracefab_app`, deux transactions distinctes) :

- **A1** `tracefab_create_product(orgA, 'MISSION-…', …)` → UUID réel.
- **A2** `tracefab_update_product_data(…, description, …)` → nouvelle transaction de lecture retrouve exactement `Donnee persistee apres rechargement — mission fonctionnelle.`
- **A3** `brand_organization_id = orgA`.
- **C1** `public_slug` absent : un brouillon n'est pas publié par une lecture.

## 5. Preuves documentaires et aperçu

- **B1** `tracefab_register_document` avec `storage_path = <orgA>/mission/…` et `metadata.productId` → preuve liée au tenant et au produit.
- **B2** `tracefab_finalize_document_upload` → statut `available` (un échec de scan reste `scanning`, jamais « vérifié »).
- **B3** `tracefab_add_dpp_claim` + `tracefab_link_dpp_claim_evidence` → `verification_result='accepted'`, motif conservé.
- **B4** historique relu (`dpp_claim_evidence`).
- **C2/C3** l'aperçu relit la description persistée et la preuve du bon produit, sans objet de démonstration.
- **C4/C5** aucun `dpp_records` en statut `published` après consultation.

## 6. Preuves d'isolation Alpha / Beta

- **D1** Beta ne lit pas le produit d'Alpha par identifiant connu.
- **D2** Beta ne lit pas la preuve d'Alpha.
- **D3** `tracefab_can_access_document(preuveAlpha)` = `false` pour Beta.
- **D4** requête exacte du runtime (`tracefab_can_access_org` + `tracefab_in_active_tenant`) vide sans locataire actif — fail-closed.
- **D5** décision sur la preuve d'Alpha depuis Beta refusée.
- **D6** aucune écriture parasite après la tentative.

## 7. Identité SQL et privilèges effectifs (mesurés, pas déduits)

Connexion avec `TF_RLS_APP_URL` :

```
current_user = tracefab_app
rolbypassrls = f · rolsuper = f · rolcreaterole = f · current_database = tracefab_test
```

| Table | SELECT | INSERT | UPDATE | DELETE |
| --- | --- | --- | --- | --- |
| `tracefab_products` | t | t | t | t |
| `documents` | t | t | t | t |
| `dpp_records` | t | f | f | f |
| `dpp_claim_evidence` | t | f | f | f |
| `verification_records` | t | f | f | f |

Catalogue : **50 tables RLS, 50 FORCE, 131 politiques, 84 fonctions exécutables** par le rôle applicatif. Les écritures sur les tables DPP/validation passent exclusivement par les fonctions SECURITY DEFINER allowlistées.

## 8. État du build, du client Prisma et de la CI

- Client Prisma : **réel**, généré hors ligne (WASM officiel), vérifié. Le client natif de CI n'est pas remplacé : `npm run db:generate` reste la référence en CI/production.
- `npm run build` : **0** avec l'environnement hors ligne ; toutes les étapes de la chaîne (db:generate, verify, typechecks, schema, assets, routes, minified-comments, i18n, chantiers, db-guard, db-routing, workflow-policy, router-load, error-reporting) passent.
- CI GitHub du SHA de départ `bf55f2a` : run `40373818672`, `push`, **SUCCESS**, 4/4 jobs (Socle, Verification, Parcours, Base). Aucune CI n'est attachée au SHA final tant qu'il n'est pas poussé.

## 9. Tests BLOQUÉS / NON EXÉCUTÉS (distinction conservée)

| Commande | Statut | Cause exacte |
| --- | --- | --- |
| `npm ci` (postinstall), `npm run db:generate` | BLOQUÉ | `binaries.prisma.sh/.../schema-engine.gz.sha256` injoignable depuis le bac (hôte non autorisé). PASS en CI. |
| `verify:routes:isolation` | BLOQUÉ | exige `TF_ROUTES_TEST_HARNESS=1` et `CLERK_SECRET_KEY=sk_test_…`; aucune clé de test fournie. Le harnais refuse de tourner (code 3), ce qui est le comportement attendu. |
| `test:neon:product`, `supplier`, `collection`, `quality`, `security`, `wallet:chantier9` | BLOQUÉ | construisent `new PrismaClient()` sans adaptateur ; le moteur natif est absent localement. Ces suites ne sont pas branchées dans `ci.yml` (seules `dpp-lifecycle`, `cross-tenant`, `document-lifecycle` le sont). |
| `test:neon:privileges-role-app`, `test:neon:compteurs-debit`, `test:neon:deploiement-publication`, `test:neon:isolation-lignes` | BLOQUÉ (partiel) | leurs assertions statiques passent (7/7 ; 25/39 pour les compteurs) mais leurs bases éphémères échouent sur `extension "pgcrypto" is not available` dans le build minimal de `pgserver`. |
| `test:neon:ecriture-non-authentifiee` | PASS avec préchargement | 8/8 assertions après injection du client réel. |
| Dépôt réel vers stockage privé + antivirus | NON EXÉCUTÉ | `PRIVATE_STORAGE_*` absents ; états UI vérifiés avec fixtures. |
| Suite P1 staging authentifiée (chantier F) | BLOQUÉ | workflows présents seulement dans des PR ouvertes, secrets illisibles (403), aucun déploiement Preview pour un SHA non poussé, protection Vercel à conserver. |

## 10. Captures

- `captures/preuves-reelles.png` — liste des preuves avec statut, décision et actions (données de test fictives).
- `captures/apercu-brouillon-prive.png` — modale d'aperçu privé avec données persistées, champs manquants et disclaimer.

Aucune donnée personnelle, aucun secret, aucun cookie, aucun jeton n'apparaît dans ces images.
