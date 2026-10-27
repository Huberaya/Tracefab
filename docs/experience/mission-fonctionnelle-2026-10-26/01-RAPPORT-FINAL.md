# TRACEFAB — Mission d'achèvement fonctionnel et validation réelle du DPP

**Branche de travail :** `arena/647ac97c-tracefab`
**SHA initial (`origin/main`, PR #100 fusionnée) :** `bf55f2ae6534cde84d072d9b975520216c7b6d4e`
**SHA final :** voir `03-PREUVES-TECHNIQUES.md` (renseigné après le commit local)
**Date :** 2026-10-26

---

## A. Résumé exécutif

### Ce qui a été réellement corrigé

1. **Blocage Prisma (chantier E).** La cause est l'hôte `binaries.prisma.sh`, absent de la liste des hôtes sortants autorisés du bac — pas une erreur de schéma ni de version (Prisma 6.19.3, Node 22.22.3). Un vrai client Prisma est désormais généré hors ligne avec les moteurs WASM officiels du paquet npm (`npm run db:generate:offline`), vérifié par `verify:prisma-client` (contrôle structurel strict : DMMF, délégués, `config.engineWasm`, magie `\0asm`, taille > 1 Mo). Aucun client factice.
2. **Liste et dépôt des preuves (chantier B).** `GET /api/documents` n'existait pas : l'Evidence Centre affichait « non calculé » en permanence. La route existe maintenant, bornée au locataire actif, avec la dernière décision de validation. `POST /api/documents/upload-intent` utilisait `activeBrandOrganizationIds(...)[0]`, c'est-à-dire la première organisation du compte, sans armer le contexte de tenant : **défaut d'isolation corrigé**. Le lien `metadata.productId` est validé côté serveur (le produit doit appartenir au locataire actif). La décision humaine (accepté/rejeté/à revoir, motif obligatoire au rejet, historique) réutilise les fonctions DPP déjà allowlistées.
3. **Aperçu DPP brouillon (chantier C).** `GET /api/products/:id/dpp/preview` relit uniquement des données persistées (produit, identifiants, composition, points de données, preuves, dernier dossier DPP), ne déclenche aucun calcul ni publication, répond `no-store, private` + `noindex`, et exige un locataire actif. Le bouton « Preview DPP · draft » ouvre cet aperçu privé au lieu de l'URL publique `/dpp/?gtin=…` qui exigeait un passeport publié.
4. **Interface (chantiers A/B/C).** États de chargement, erreur explicite avec code + réessai, absence de document, succès de dépôt, scan, téléchargement signé, décision avec motif, et aperçu avec champs manquants et marqueurs de confiance. 38 clés i18n ajoutées avec parité stricte sur 7 langues.
5. **Isolation (chantier D).** Base PostgreSQL 16 jetable locale réelle : 57 migrations appliquées, **50 tables sous RLS (50 FORCE), 131 politiques**, rôle `tracefab_app` sans BYPASSRLS. Nouveau scénario Alpha/Beta exécuté (22 assertions). 15 suites DB du dépôt passent.

### Ce qui fonctionne réellement de bout en bout

- Création d'un produit par la fonction métier `tracefab_create_product`, modification par `tracefab_update_product_data`, **relecture persistée dans une nouvelle transaction** (équivalent d'un rechargement / nouvelle authentification).
- Enregistrement d'une preuve liée au produit et au tenant, finalisation `available`, décision avec motif, relecture de l'historique.
- Aperçu brouillon relisant les valeurs persistées (aucune valeur de démonstration), privé et non publié.
- Refus d'accès de Beta aux produit/preuve/décision d'Alpha, y compris par identifiant connu ; requête du runtime vide sans locataire actif.
- `npm run build`, `npm test`, `api:typecheck`, `verify:prisma-client`, `test:router-load`, `test:journeys` (20/20), `test:mission-ui` (11/11), `test:mission-ui:states` (6/6), `test:mission-functional` (22/22), 15 suites DB, couverture HTTP d'auth (159/159).

### Ce qui reste bloqué et pourquoi

- **Publication GitHub :** aucun push ni PR dans cette mission — la contrainte demande une autorisation explicite distincte. Le commit final n'est donc **pas encore vérifiable dans GitHub** ; des instructions exactes sont données en §D.
- **Parcours HTTP authentifiés par Clerk :** `verify:routes:isolation` exige `TF_ROUTES_TEST_HARNESS=1` et une clé `sk_test_…`; aucune clé de test n'est présente. Les preuves d'isolation ci-dessus sont donc des preuves **base de données + logique métier réelles**, pas des preuves HTTP Clerk.
- **Stockage privé / antivirus :** variables `PRIVATE_STORAGE_*` absentes. Le formulaire de dépôt et ses états sont testés avec des fixtures ; le transfert réel vers un stockage objet n'est **pas** démontré.
- **Preview/staging (chantier F) :** workflows P1/staging présents uniquement dans des PR ouvertes (#91, #92, #93, #94), secrets illisibles (403), aucun déploiement Preview pour un SHA non poussé. Intervention humaine requise.
- **Quelques suites `test:neon:*`** qui construisent `new PrismaClient()` sans adaptateur restent BLOQUÉES localement (moteur natif absent) ; elles ne sont pas non plus branchées dans la CI du dépôt.

**Le projet n'est pas déclaré prêt pour la commercialisation.**

---

## B. Tableau de clôture

| Chantier | État initial | Cause racine | Correction appliquée | Fichiers | Tests exécutés | Résultat | Intervention humaine restante |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **A — Produits persistants** | Création/modification serveur déjà réelles mais non démontrées ; interface sans état d'erreur explicite sur certaines vues | Absence de preuve de relecture après nouvelle transaction ; pas de garde visuelle sur les échecs | Parcours tracé UI→route→fonctions SQL→base ; test de persistance réel ; états d'erreur explicites | `api/_routes/products.ts`, `products/[productId].ts`, `scripts/test_mission_functional_dpp.mjs`, `assets/js/brand-console.1.js` | `test:mission-functional` A1–A3, `test:product-edit:api`, `npm test`, `test:mission-ui:states` | **PASS** | Exécuter le même parcours via HTTP avec un jeton Clerk de test sur Preview |
| **B — Documents** | `GET /api/documents` absent ; upload/téléchargement/vérification désactivés ; `upload-intent` non borné au locataire actif | Route de liste manquante ; `activeBrandOrganizationIds(...)[0]` au lieu de `requireActiveTenant` ; aucun contexte de tenant armé | Route de liste tenant-scopée, `requireActiveTenant` + `withTracefabRequestContext`, validation serveur de `metadata.productId`, décision avec motif via fonctions DPP existantes, UI complète | `api/_routes/documents.ts`, `documents/upload-intent.ts`, `documents/[documentId]/validation.ts`, `api/index.ts`, `assets/js/brand-console.1.js`, 7 catalogues i18n | `test:mission-functional` B1–B4, `test:neon:document-lifecycle`, `test:neon:storage:chantier10`, `test:mission-ui:states`, `test:routes`, `test:route-auth-coverage` | **PASS** (logique + UI) / **BLOQUÉ** (stockage objet réel) | Fournir `PRIVATE_STORAGE_*` + antivirus sur un environnement de test, puis rejouer le dépôt réel |
| **C — Aperçu DPP brouillon** | « Preview DPP · draft » ouvrait l'URL publique exigeant publication ; aucun aperçu privé | Aucune route de lecture de brouillon | Route privée lecture seule, `no-store/private/noindex`, états distincts, champs manquants, marqueurs de confiance, bouton recâblé | `api/_routes/products/[productId]/dpp/preview.ts`, `api/index.ts`, `assets/js/brand-console.1.js` | `test:mission-functional` C1–C5, `test:mission-ui:states` (aperçu), `test:routes`, `test:sql-errors` | **PASS** | Vérifier l'aperçu contre un dossier réellement publié sur Preview ; arbitrage juridique sur les exigences |
| **D — Isolation Alpha/Beta** | Suites RLS présentes mais non exécutées localement (pas de base) | Aucune base jetable dans le bac | PostgreSQL 16 jetable (`pgserver`, PyPI autorisé), 57 migrations, rôle applicatif sans BYPASSRLS, 15 suites + scénario Alpha/Beta | `scripts/test_mission_functional_dpp.mjs`, `scripts/run-db-suite.mjs` | 15/15 suites DB, 22/22 assertions fonctionnelles, identité SQL mesurée | **PASS** (DB) / **BLOQUÉ** (HTTP Clerk) | Fournir une clé `sk_test_…` et lancer `verify:routes:isolation` avec `TF_ROUTES_TEST_HARNESS=1` |
| **E — Prisma / build** | `npm ci`, `db:generate`, `build`, `api:typecheck`, `npm test`, `verify:prisma-client`, `router-load` bloqués | Téléchargement des moteurs natifs depuis `binaries.prisma.sh` (hôte non autorisé) ; `@prisma/client` restait le repli factice | `db:generate:offline` (vrais moteurs WASM), préchargement optionnel d'un client réel à adaptateur pg, vérificateur étendu | `scripts/db-generate-offline.mjs`, `scripts/lib/offline-prisma-preload.mjs`, `scripts/verify_prisma_client.mjs`, `scripts/run-db-suite.mjs`, `scripts/test_router_module_load.mjs`, `package.json` | `npm run build` (0), `npm test` (0), `api:typecheck` (0), `verify:prisma-client` (0), `test:router-load` (0) | **PASS** avec l'environnement hors ligne ; **BLOQUÉ** pour `npm ci`/`db:generate` natifs | Aucune en CI (le runner dispose déjà des moteurs). Pour un autre bac restreint : autoriser `binaries.prisma.sh` ou utiliser la procédure offline documentée |
| **F — Preview/staging** | Workflows P1/staging dans des PR ouvertes, pas dans `main` ; secrets illisibles | Approbations/environnements et secrets de test non disponibles ; aucun SHA poussé | Étude des PR #80/#91/#92/#93/#94/#70/#82 sans duplication ; inventaire des secrets requis (noms uniquement) | `.github/workflows/` (non modifié), rapports | `gh api` environnements (Preview, Production, tracefab-clerk-test), lecture des références de secrets | **BLOQUÉ** | Autoriser le push, fusionner/activer les workflows P1, fournir `CLERK_TEST_SECRET_KEY`/`TRACEFAB_STAGING_WORKER_SECRET`/`VERCEL_*_BYPASS_SECRET` dans le bon environnement, puis lancer la suite sur le déploiement du SHA exact |

---

## C. Preuves techniques

Voir `03-PREUVES-TECHNIQUES.md` : commandes exactes, codes de sortie, identité SQL, privilèges, résultats des parcours, état du build et de la CI, limites des captures.

---

## D. Livraison

- Branche isolée : `arena/647ac97c-tracefab`, créée à partir de `origin/main` = `bf55f2ae…`. Aucun `reset`, `clean`, `rebase`, ni écrasement de travail local.
- **Aucun push et aucune PR créée** : la mission impose une autorisation explicite distincte. Le SHA final est donc local et non vérifiable dans GitHub ; aucune CI ne lui est associée. La CI de référence disponible est celle du `main` de départ (`bf55f2a`, run `40373818672`, conclusion SUCCESS).
- Pour publier (à n'exécuter qu'après autorisation explicite) :

```bash
cd /home/user/Tracefab
git status                      # doit être propre apres le commit
git push -u origin arena/647ac97c-tracefab        # fast-forward uniquement, jamais --force
gh pr create --base main --head arena/647ac97c-tracefab \
  --title "DPP: real product/document persistence, private draft preview and tenant isolation" \
  --body-file docs/experience/mission-fonctionnelle-2026-10-26/01-RAPPORT-FINAL.md
gh run list --branch arena/647ac97c-tracefab --limit 3   # verifier la CI du SHA exact
```

- **Conflits à arbitrer avant publication :** la PR #98 (`feature/archived-products-workspace`, toujours ouverte, `mergeable_state: dirty`) modifie `assets/js/brand-console.1.js`, `assets/i18n/en.js`, `assets/i18n/fr.json` et `api/_routes/products/[productId].ts`. Cette branche modifie les trois premiers. #98 est une implémentation parallèle du cycle d'archivage déjà fusionné via #99, avec une logique de rôles différente (`archiveRequested || restoreRequested` contre `lifecycleRequested`). **Ne pas supprimer ses changements** : soit clore #98 après vérification de parité fonctionnelle avec #99, soit la rebaser sur `main` en conservant ses modifications API et en résolvant explicitement les trois fichiers communs avec les corrections UI/UX et i18n de cette branche.

---

## E. Cadre de vérité

- **Exigences établies :** aucune nouvelle obligation juridique n'est affirmée. Les textes réglementaires officiels n'ont pas été consultés depuis ce bac.
- **Préparation recommandée (interne TRACEFAB) :** profil `textile_readiness_mvp`, 9 exigences, 4 piliers, statuts de confiance, relecture humaine avant publication. L'aperçu le répète : ce n'est ni une certification ni une attestation de conformité.
- **Éléments sectoriels non confirmés :** PEF/PEFCR, GOTS, GRS, OEKO-TEX, SMETA, ZDHC, ISO 17025, GS1 Digital Link, CIRPASS JSON-LD restent des exemples cités par le dépôt ; leur caractère obligatoire, leur version et leur périmètre doivent être validés par l'équipe conformité.
- **Exigences internes produit :** locataire actif sur chaque appel privé, fail-closed, états dégradés explicites, aucune valeur absente présentée comme vérifiée, séparation démo/réel, aucune publication implicite.
