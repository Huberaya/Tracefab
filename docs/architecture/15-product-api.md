# 15. Product Data API — Chantier 12

## Périmètre

Le Chantier 12 expose le modèle Product Data déjà présent dans Neon à travers le runtime Vercel/Clerk :

- produits et métadonnées descriptives ;
- matériaux et composition courante ;
- identifiants produit ;
- révisions de produit ;
- préparation `DATA READY` calculée par PostgreSQL.

`DATA READY` reste un indicateur de complétude et de cohérence minimale. Il ne constitue ni une vérification, ni une certification, ni une conformité réglementaire.

## Routes

```text
GET  /api/products?organizationId=<brand-id>
POST /api/products
GET  /api/products/:productId
PATCH /api/products/:productId
POST /api/products/:productId/revision

GET  /api/materials?organizationId=<organization-id>
POST /api/materials
GET  /api/materials/:materialId
PATCH /api/materials/:materialId

GET  /api/products/:productId/materials
POST /api/products/:productId/materials
PATCH /api/products/:productId/materials

GET  /api/products/:productId/identifiers
POST /api/products/:productId/identifiers
PATCH /api/products/:productId/identifiers?identifierId=<identifier-id>
```

## Frontière de confiance

Les mutations métier passent par des fonctions SQL `SECURITY DEFINER` qui vérifient le contexte Clerk transactionnel et le rôle de l'utilisateur :

- `tracefab_create_product(...)` ;
- `tracefab_update_product_data(...)` ;
- `tracefab_start_product_revision(...)` ;
- `tracefab_create_material(...)` ;
- `tracefab_update_material(...)` ;
- `tracefab_add_product_material(...)` ;
- `tracefab_update_product_material(...)` ;
- `tracefab_add_product_identifier(...)` ;
- `tracefab_update_product_identifier(...)`.

Les insertions ou mises à jour directes Prisma ne sont pas utilisées pour ces ressources sensibles. Le rôle de connexion Neon propriétaire des tables ne doit pas être considéré comme une preuve d'isolation RLS ; les endpoints appliquent donc également un filtrage explicite par memberships actifs.

## Versions de composition

Une nouvelle révision incrémente la version du produit et ne copie pas automatiquement l'ancienne composition. Les matériaux de la version précédente restent historiques ; les matériaux de la nouvelle version doivent être ajoutés explicitement.

La suppression directe de lignes de composition n'est pas exposée par cette première API. Cette contrainte évite d'effacer silencieusement une composition historique ; une évolution dédiée pourra ajouter un remplacement transactionnel avec audit.

## Contrôles

- les produits sont limités aux memberships actifs d'organisations `brand` ;
- la création, mise à jour et révision exigent les rôles prévus par les fonctions SQL ;
- la révision exige un rôle `owner`, `admin` ou `manager` ;
- les matériaux partagés sont vérifiés par le trigger de partage existant ;
- les pourcentages sont bornés entre 0 et 100 ;
- les identifiants sont limités à `gtin`, `ean`, `upc` et `internal` ;
- les champs calculés `data_readiness` et `data_completion` ne sont pas client-writable.

## Tests

```bash
npm run test:neon:product
```

Le test crée puis nettoie des fixtures temporaires et vérifie :

- création et mise à jour d'un produit ;
- ajout d'un matériau et d'un identifiant ;
- incrément de révision ;
- visibilité inter-tenant ;
- refus d'une mutation par un viewer ;
- impossibilité pour un viewer de contourner la fonction SQL par une mise à jour directe.
