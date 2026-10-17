# Contrat d’édition produit — 17 octobre 2026

## Cause racine

Après #54, la fiche s’ouvrait, mais le formulaire contenait `countryOfSpinning`, absent du modèle éditable et de la liste autorisée PATCH. Le sérialiseur du formulaire étalait tous les champs (`...data`) ; toute sauvegarde, même du seul pays de fabrication, était refusée avant écriture. `description`, déjà exposée par le sérialiseur API et obligatoire pour la readiness DPP, n’était pas éditable.

## Correction

- Retrait du pays de filature non supporté ; description détaillée éditable (10 000 caractères max).
- Liste explicite de champs UI sérialisés ; PATCH différentiel (description seule / pays seul).
- Valeurs inconnues affichées vides, jamais remplacées par des données de démonstration. `Inconnu`/`unknown` saisis comme sentinelles sont convertis en `null` (tailles : liste vide).
- Validation serveur extraite, utilisée par le vrai gestionnaire : pays ISO 3166-1 alpha-2 assignés, poids numérique fini 0–1 000 000 g, au plus 50 tailles non vides de 40 caractères maximum.
- Erreurs 400 structurées avec `field` et `message`, affichées dans un `role=alert` du formulaire, sans perdre la saisie.
- Sérialiseur de lecture inchangé : conserve les `null` de la base. Aucun seed, migration ou changement de publication.

## Preuves automatisées

- `test:product-edit:api` : gestionnaire HTTP réel avec dépendances auth/transaction simulées ; GET vide, PATCH description seule / pays seul, nulls, clés interdites, erreurs explicites et scope tenant. Ce test ne prétend pas démontrer la RLS.
- `test:brand-console:schema-bindings` : navigateur réel, réseau simulé ; vérifie les champs vides, absence de champ non supporté, payloads différentiels exacts, absence de valeurs de démo, sauvegardes et erreur visible.
- `test:brand-console:empty` existant : tenant réel vide, démo seulement avec `?demo=1`, aucune substitution en cas d’échec API.
- `test:neon:cross-tenant` étendu : PostgreSQL jetable, rôle applicatif sans BYPASSRLS, produit vierge, éditions successives description/pays, inconnus NULL conservés, refus de la fonction d’édition chez le voisin ; recalcul DPP initial, intermédiaire et final prouvant description/pays conformes. Aucun marquage prêt à publier ni publication.

## Limites d’exécution locale

Le sandbox ne peut pas télécharger les moteurs Prisma (binaries.prisma.sh interdit), ni exécuter Chromium (libnspr4 absente). Client Prisma généré sans moteur pour les tests de types et HTTP simulés. La CI standard est l’autorité pour le build complet, le navigateur et PostgreSQL jetable. Aucun secret ni endpoint de production n’est utilisé pour les tests.
