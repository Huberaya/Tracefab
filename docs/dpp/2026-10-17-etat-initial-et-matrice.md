# TRACEFAB — état initial du DPP et matrice de vérité

Date : 2026-10-17
Branche : `arena/8598837a-tracefab`
Point de départ audité : `2c93091` (`main` fusionné le 2026-10-17)
Périmètre : dépôt `Huberaya/Tracefab`, pas un environnement déployé.

## 1. Méthode

L'audit a été fait sur le code réel, pas sur un rapport antérieur :

- lecture des migrations `prisma/migrations/*` et `supabase/migrations/*` ;
- lecture des routes `api/_routes/dpp/**` et `api/_routes/products/[productId]/dpp/**` ;
- lecture de `prisma/schema.prisma`, des policies RLS et des fonctions `SECURITY DEFINER` ;
- lecture de `dpp/index.html`, `assets/js/dpp.2.js`, `brand-console/index.html` ;
- exécution des suites locales, puis d'un PostgreSQL 16.2 jetable pour les suites qui écrivent.

Les statuts utilisés sont ceux demandés :

| Statut | Sens |
|---|---|
| OPÉRATIONNELLE ET TESTÉE | exécutée sur une base ou un DOM réel, avec assertions reproductibles |
| IMPLÉMENTÉE VALIDATION INCOMPLÈTE | le code existe, une partie du parcours n'a pas pu être prouvée ici |
| PARTIELLE | une partie du besoin seulement est couverte |
| SIMULÉE | l'interface ou le test ne prouve rien sur le système réel |
| ABSENTE | aucun code |
| BLOQUÉE PAR DÉPENDANCE EXTERNE | dépend d'un service ou d'une clé indisponible dans cet environnement |
| À RISQUE | fonctionne mais crée un risque de sécurité, de conformité ou d'interprétation |

Contraintes de l'environnement d'audit, à ne pas confondre avec des défauts du produit :

- `npm ci` ne peut pas télécharger les binaires Prisma (`binaries.prisma.sh` hors réseau autorisé) ;
- aucun binaire Chromium n'est installé, donc les suites Playwright ne s'exécutent pas ;
- `CLERK_SECRET_KEY` absente, donc les suites qui passent par l'authentification réelle refusent de s'exécuter ;
- le PostgreSQL local a été monté avec `pgcrypto` retiré des migrations (extension indisponible dans l'image), sans modifier les migrations du dépôt.

## 2. Inventaire réel du DPP au point de départ

### Modèles et tables

- `tracefab_products`, `product_identifiers`, `materials`, `product_materials`
- `dpp_records` (readiness historique : profil, score, champs manquants)
- `dpp_requirement_profiles`
- `dpp_lifecycle_events` (registre append-only, ajouté le 2026-10-16)
- `dpp_claims`, `dpp_claim_evidence` (chaîne de preuve, ajoutée le 2026-10-16)
- `dpp_resolvable_identifiers` (identité modèle/variante/lot/unité, remplacement)
- `verification_records`, `certifications`
- `documents`, `data_points`, `data_quality_scores`

### Routes

| Route | Rôle réel au départ |
|---|---|
| `GET /api/dpp/:gtin` | lecture publique, mais renvoyait la sortie du résolveur interne avec sources techniques et `productId` |
| `GET/POST /api/products/:id/dpp` | readiness (calcul déterministe), pas le cycle de vie |
| `GET/POST /api/products/:id/dpp/events` | événements append-only |
| `GET/POST /api/products/:id/dpp/claims` | affirmations, mais le POST acceptait un statut initial arbitraire |
| `POST .../claims/:id/evidence` | liaison de preuve |
| `POST /api/products/:id/dpp/publish-review` | revue de publication |
| `POST /api/products/:id/dpp/publication` | publication/suspension/retrait |
| `GET /api/dpp/portfolio` | agrégat de préparation |
| `GET /api/resolve/:publicId` + `/qr` | résolution stable + QR |
| `GET /api/dpp/:gtin/apple-wallet`, `google-wallet` | passes mobiles |

### Pages

- `dpp/index.html` : passeport public, contenu de démonstration très riche, hydratation partielle par `assets/js/dpp.2.js`.
- `brand-console/index.html` : vue DPP de préparation ; seul `publish-review` était câblé.
- `supplier-portal/index.html`, `catalog`, `quality-center`, `operations` : données fournisseur, pas de vue DPP de confiance.
- `passport/` : ancienne page publique résiduelle.

## 3. Constats qui ont déclenché le chantier

1. **Fuite de forme dans l'API publique.** `/api/dpp/:gtin` renvoyait les objets du résolveur interne : `productId`, sources du type `tracefab_products.sku`, noms de tables. Une API publique ne doit pas dépendre du schéma interne.
2. **Statut de confiance auto-attribuable.** `dpp_claims` acceptait un statut initial `third_party_verified` ; aucun mandat de vérificateur n'existait. Un acteur pouvait donc se déclarer vérifié par un tiers.
3. **Preuve décorative.** Un statut `documented` pouvait être posé sans preuve acceptée ; `corroborated` sans deux preuves concordantes.
4. **Page publique non honnête en mode réel.** Les badges `GOTS Certified`, `OEKO-TEX Class 1`, `100% certified materials` et la mention « Official Digital Product Passport » étaient dans le HTML de démonstration. L'hydratation ne les masquait pas : un passeport réel affichait des certifications fictives.
5. **JSON-LD de démonstration.** Le JSON-LD statique décrivait un produit et des certifications d'exemple ; un moteur de recherche pouvait l'indexer comme réel.
6. **Historique public incomplet.** Les événements n'étaient pas tous exposés ; les corrections et les attestations tierces n'avaient pas de représentation publique lisible.
7. **Console privée incomplète.** Aucune interface pour déclarer une affirmation, lier une preuve, reviewer, accorder ou révoquer un mandat. Le parcours existait en SQL, pas pour un utilisateur.
8. **Badge réglementaire ambigu.** « ESPR-aligned DPP format » suggérait une conformité sans source officielle versionnée.

## 4. Matrice de vérité au point de départ

| Domaine | Statut initial | Preuve / justification | Limite |
|---|---|---|---|
| Identité produit et identifiants | OPÉRATIONNELLE ET TESTÉE | `product_identifiers`, `dpp_resolvable_identifiers`, `GET /api/resolve/:publicId`, test `test_dpp_resolvable_identity.mjs` (15 assertions), QR réel | Pas de validation GS1 externe |
| Identité lot / unité | PARTIELLE | `granularity IN (model, variant, batch, unit)`, `dpp_resolvable_identifiers`, résolution 308 sur remplacement | Pas de généalogie lot→unité complète, pas d'agrégation de volumes |
| Données produit structurées | IMPLÉMENTÉE VALIDATION INCOMPLÈTE | `tracefab_products`, `product_materials`, résolveur DPP, projection | Certains champs restent déclaratifs ; pas de schéma par catégorie |
| Composition / matières | IMPLÉMENTÉE VALIDATION INCOMPLÈTE | `product_materials`, matériaux dans le payload public, rendu DOM | Pas de composition multi-niveaux (fil → tissu → produit) |
| Traçabilité transformation | PARTIELLE | `supply_chain_nodes`, `supply_chain_links`, `supplyChainSummary` | Le public reçoit un résumé, pas la chaîne détaillée ; pas de preuve par étape |
| Cycle de vie append-only | OPÉRATIONNELLE ET TESTÉE | migration `20261016130000`, trigger anti-UPDATE/DELETE, suite lifecycle (55 preuves en base réelle) | Pas d'interface publique de correction pour un acteur non-marque |
| Publication explicite | OPÉRATIONNELLE ET TESTÉE | `tracefab_set_dpp_publication`, événements système, slug, suspension, retrait | Pas d'expiration automatique de publication |
| Affirmations (claims) | PARTIELLE | `dpp_claims`, `tracefab_add_dpp_claim`, `tracefab_public_dpp_claims` | Au départ : statut initial libre, pas de revue |
| Preuves liées | PARTIELLE | `dpp_claim_evidence`, `tracefab_link_dpp_claim_evidence` | Au départ : `documented` sans preuve acceptée, preuve contradictoire non exposée |
| Niveaux de confiance | SIMULÉE au départ | chaînes `declared/documented/controlled/...` présentes, aucune règle serveur complète | Un badge pouvait être changé sans revue ni preuve |
| Mandat de vérificateur tiers | ABSENTE au départ | aucune table ni fonction | `brand_supplier_relationships` ne pouvait pas porter ce rôle (trigger de validation des types d'organisation) |
| Revue d'affirmation | ABSENTE au départ | aucune table `dpp_claim_reviews` | Statut modifiable directement |
| API publique en liste blanche | ABSENTE au départ | route renvoyant le résolveur interne | Fuite de `productId` et de noms de colonnes |
| Page publique dynamique | PARTIELLE | hydratation de quelques champs, historique | Badges de certification fictifs, JSON-LD fictif, sections manquantes |
| Console privée de confiance | ABSENTE au départ | aucun formulaire claim/evidence/review/mandate | Parcours uniquement SQL |
| RLS multi-locataires | OPÉRATIONNELLE ET TESTÉE | 50 tables sous RLS au départ (52 après le chantier), `test_rls_isolation.mjs`, `test_neon_cross_tenant.mjs` 12/12 | Les routes HTTP avec Clerk réel ne sont pas exécutables ici |
| QR / GS1 Digital Link | PARTIELLE | `buildGs1DigitalLink` (`/01/`, `/21/`, `?10=`), endpoint QR SVG | Pas de certification GS1 ; `linkType` maison |
| Wallet Apple / Google | IMPLÉMENTÉE VALIDATION INCOMPLÈTE | générateurs présents, résolveur réel | Signature Apple/Google non testée (clés absentes) |
| Export interopérable | PARTIELLE | JSON public, JSON-LD généré côté page, wallet | Pas d'export CIRPASS/JSON-LD versionné côté serveur, pas de CSV/PDF |
| Base réglementaire | ABSENTE | aucun document officiel versionné dans le dépôt | ESPR (UE) 2024/1781 cité en UI, pas d'acte délégué vérifié |
| IA documentaire | ABSENTE | routes IA existantes hors DPP de confiance | Aucune extraction DPP avec validation humaine |
| Tests navigateur | BLOQUÉE PAR DÉPENDANCE EXTERNE | Playwright installé, Chromium absent | Aucune exécution E2E locale |
| CI | À RISQUE au départ | CI GitHub existante, non observée sur ce commit dans cet environnement | Ne pas confondre CI verte et preuve locale |

## 5. Ce que le point de départ faisait déjà bien

- Un registre d'événements réellement append-only, avec trigger anti-mutation et preuves d'exécution.
- Une publication explicite (pas de « brouillon visible par accident ») et une résolution stable par identifiant public.
- Une isolation multi-locataires prouvée par exécution, pas par inventaire.
- Un calcul de préparation DPP déterministe, distinct d'une conformité.
- Des suites de tests sérieuses, souvent exécutables sans navigateur.

Le chantier n'a donc pas consisté à « ajouter un DPP » : il a consisté à rendre vérifiable ce qui était déjà là, et à retirer ce qui était décoratif.

## 6. Verdict de la phase 1

Le DPP initial était **un bon moteur de cycle de vie avec une couche publique et une couche de confiance incomplètes**. Les deux risques majeurs étaient :

1. la **confiance auto-attribuée** (statut sans preuve, tiers sans mandat) ;
2. la **présentation publique de données fictives** à côté de données réelles.

Les deux ont été traités dans les phases 2 à 4 ; les preuves sont dans le rapport final et dans les suites citées.
