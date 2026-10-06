# 21. Brand Console approfondie — Chantier 18

## Périmètre livré

La console marque est une application statique sous :

```text
/brand-console/
```

Elle consomme les APIs Vercel/Clerk existantes et couvre les parcours opérationnels suivants :

- authentification Clerk côté navigateur et sélection de l'organisation marque ;
- vue d'ensemble avec indicateurs produits, demandes, échéances et fournisseurs ;
- états de chargement, erreur de configuration, vide, succès et notifications d'action ;
- catalogue produit : création, liste, détail, édition des données produit et création d'une révision ;
- composition produit : lecture de la composition courante, ajout d'un matériau du catalogue et édition du pourcentage/unité avec contrôle de version ;
- identifiants produit : ajout et édition de la valeur, du statut principal et du type supporté ;
- invitation et liste des fournisseurs partenaires issus de la relation active marque-fournisseur ;
- profil fournisseur avec lecture de l'API fournisseur et navigation vers les demandes associées ;
- demandes de données : création à partir d'un questionnaire versionné, initialisation des items, envoi et détail ;
- revue des réponses courantes : vérification ou demande de correction avec commentaire ;
- calcul et lecture du score qualité produit et de ses issues explicables.

Le code reste volontairement sans framework frontend pour conserver un déploiement statique simple. Les styles, la navigation et l'état de l'interface sont embarqués dans `brand-console/index.html`, avec des fonctions de synchronisation séparées pour les produits, matériaux, identifiants et fournisseurs. Les mutations sensibles sont toujours déléguées aux API et aux fonctions SQL ; l'interface n'est pas une frontière de sécurité.

## Authentification et isolation

La page récupère la clé publishable via :

```text
GET /api/config
```

Elle charge ensuite Clerk JS dans le navigateur, obtient un token de session et l'envoie en `Authorization: Bearer ...` vers les APIs. La clé secrète Clerk reste exclusivement côté serveur. Les API filtrent l'organisation active, les relations fournisseur et l'accès produit dans le contexte Neon/RLS ; les données affichées en mode démonstration ne sont jamais présentées comme vérifiées ou certifiées.

`?demo=1` permet d'inspecter les états et parcours sans backend ni clé Clerk. Ce mode ne doit jamais être utilisé en production.

## API consommées

```text
GET    /api/config
GET    /api/me
GET    /api/organizations
GET    /api/suppliers
GET    /api/suppliers/:supplierId/profile
GET    /api/materials
GET    /api/products
POST   /api/products
GET    /api/products/:productId
PATCH  /api/products/:productId
POST   /api/products/:productId/revision
GET    /api/products/:productId/materials
POST   /api/products/:productId/materials
PATCH  /api/products/:productId/materials
GET    /api/products/:productId/identifiers
POST   /api/products/:productId/identifiers
PATCH  /api/products/:productId/identifiers?identifierId=:identifierId
GET    /api/data-requests
POST   /api/data-requests
GET    /api/data-requests/:requestId
POST   /api/data-requests/:requestId/items/from-template
POST   /api/data-requests/:requestId/send
POST   /api/data-requests/:requestId/remind
POST   /api/data-responses/:responseId/review
GET    /api/questionnaires
GET    /api/quality/products/:productId
POST   /api/quality/products/:productId
POST   /api/organizations/:organizationId/invitations
```

Les champs calculés de readiness restent contrôlés par le backend. Une valeur `DATA READY` ou `DPP READY` décrit une projection de données et ne constitue ni preuve, ni vérification, ni certification.

## Tests et validation

Contrats statiques et syntaxe :

```bash
npm run test:brand-console
```

Parcours navigateur Playwright en mode démonstration :

```bash
npx playwright install chromium
npm run test:brand-console:browser
```

Le scénario navigateur couvre le chargement de la console, la navigation catalogue, l'ajout d'une composition, l'édition d'un identifiant et l'ouverture d'un profil fournisseur. Le test de contrat vérifie en complément les URL browser-safe, l'absence de secret privé, la présence du bootstrap Clerk et les formulaires de mutation.

Les validations TypeScript et le contrôle de whitespace sont exécutés au niveau repository :

```bash
npm run api:typecheck
npm run typecheck
git diff --check
```

## Limites connues et dépendances externes

- le Supplier Portal complet n'est pas encore livré ;
- le Quality Center frontend complet n'est pas encore livré ;
- la relance manuelle est authentifiée côté marque et mise en file dans l'outbox ; elle est dédoublonnée pendant dix minutes et ne contourne pas le statut de la demande ;
- la revue utilise actuellement un commentaire navigateur simple ;
- le stockage privé des preuves est livré au Chantier 20 ; sa mise en service dépend d'un bucket S3-compatible privé et d'un scanner antivirus configurés ;
- le chargement de Clerk JS s'appuie sur le CDN configuré pour le déploiement ;
- les vulnérabilités de dépendances existantes nécessitent une décision d'upgrade potentiellement cassante et aucun `npm audit fix --force` n'a été appliqué ;
- la validation staging et production doit être réalisée avec des secrets Clerk/Neon renouvelés et des données représentatives non sensibles.
