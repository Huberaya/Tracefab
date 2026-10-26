# Mission d'achèvement fonctionnel et validation réelle du DPP — état des tâches

**Branche :** `arena/647ac97c-tracefab` · **SHA de départ :** `bf55f2ae6534cde84d072d9b975520216c7b6d4e`
**Date :** 2026-10-26 · États : `À FAIRE` / `EN COURS` / `BLOQUÉ` / `TERMINÉ AVEC PREUVES`

| # | Chantier | Tâche | État |
| --- | --- | --- | --- |
| 0 | Préparation | Vérifier SHA, branches, PR (#98 ouverte, #99/#100 fusionnées), CI, fichiers | TERMINÉ AVEC PREUVES |
| 0 | Préparation | Consulter les 4 rapports UI/UX publiés | TERMINÉ AVEC PREUVES |
| 0 | Préparation | Inventorier routes, modèle Prisma, stockage, workflows, tests existants | TERMINÉ AVEC PREUVES |
| 0 | Préparation | Espace isolé sur la branche de session, sans reset/clean/rebase | TERMINÉ AVEC PREUVES |
| E | Prisma | Reproduire le blocage `binaries.prisma.sh` et en identifier la cause | TERMINÉ AVEC PREUVES |
| E | Prisma | Obtenir un VRAI client Prisma hors ligne (`db:generate:offline`, moteur WASM officiel + adaptateur pg) | TERMINÉ AVEC PREUVES |
| E | Prisma | Étendre `verify_prisma_client` au moteur WASM (contrôle structurel strict) | TERMINÉ AVEC PREUVES |
| E | Prisma | `npm run build`, `npm test`, `api:typecheck`, `verify:prisma-client`, `test:router-load` | TERMINÉ AVEC PREUVES (avec environnement hors ligne documenté) |
| E | Prisma | `npm ci` / `db:generate` natifs | BLOQUÉ (hôte `binaries.prisma.sh` non autorisé ; PASS en CI sur `main`) |
| A | Produits | Tracer UI → route → service → base ; créer/modifier/relire | TERMINÉ AVEC PREUVES |
| A | Produits | Corriger faux succès / erreurs muettes / validation serveur | TERMINÉ AVEC PREUVES (états explicites, `sqlBusinessError`) |
| A | Produits | Persistance après nouvelle transaction + isolation | TERMINÉ AVEC PREUVES (`test:mission-functional` A1–A3) |
| B | Documents | `GET /api/documents` tenant-scopé (liste réelle) | TERMINÉ AVEC PREUVES |
| B | Documents | Corriger `upload-intent` : locataire ACTIF au lieu de la 1re organisation du compte | TERMINÉ AVEC PREUVES |
| B | Documents | Lien produit/dossier via `metadata.productId` validé côté serveur | TERMINÉ AVEC PREUVES |
| B | Documents | Décision accepté/rejeté avec motif + historique (réutilisation des fonctions DPP existantes) | TERMINÉ AVEC PREUVES |
| B | Documents | États UI chargement/erreur/vide/succès/dépôt/scan/téléchargement | TERMINÉ AVEC PREUVES (6/6 navigateur) |
| B | Documents | Vrai stockage privé + antivirus sur environnement de test | BLOQUÉ (secrets `PRIVATE_STORAGE_*` absents ; parcours dépôt testé avec fixtures, pas présenté comme opérationnel) |
| C | DPP brouillon | Route privée `GET /api/products/:id/dpp/preview` (lecture seule, no-store, noindex) | TERMINÉ AVEC PREUVES |
| C | DPP brouillon | Bouton « Preview DPP · draft » câblé sur l'aperçu privé, plus l'URL publique | TERMINÉ AVEC PREUVES |
| C | DPP brouillon | Distinction brouillon/incomplet/validé/publié, champs manquants, marqueurs de confiance | TERMINÉ AVEC PREUVES |
| C | DPP brouillon | Aucune publication par simple consultation | TERMINÉ AVEC PREUVES (C1/C4/C5) |
| D | Isolation | Étudier PR #80/#91/#70/#82 sans dupliquer | TERMINÉ AVEC PREUVES (PR étudiées, non modifiées) |
| D | Isolation | PostgreSQL jetable réel : 57 migrations, 50 tables RLS, 131 politiques | TERMINÉ AVEC PREUVES |
| D | Isolation | Scénarios Alpha/Beta réels (produit, preuve, décision, locataire vide) | TERMINÉ AVEC PREUVES (D1–D6) |
| D | Isolation | Identité SQL et privilèges effectifs mesurés | TERMINÉ AVEC PREUVES |
| D | Isolation | 15 suites DB du dépôt | TERMINÉ AVEC PREUVES (15/15 PASS) |
| D | Isolation | HTTP authentifié par vrais jetons Clerk de test | BLOQUÉ (clé `sk_test_` absente ; `verify:routes:isolation` refuse de tourner) |
| F | Preview | Workflows P1/staging, environnements, secrets | BLOQUÉ (workflows uniquement dans des PR ouvertes ; lecture des secrets 403 ; aucun déploiement Preview pour un SHA non poussé) |
| F | Preview | Suite authentifiée sur Preview | BLOQUÉ (approbation humaine + secrets de test requis) |
| Z | Livraison | Rapport final, commits locaux sur branche isolée | TERMINÉ AVEC PREUVES |
| Z | Livraison | Push et PR | BLOQUÉ (aucune autorisation explicite dans cette mission ; instructions fournies) |
