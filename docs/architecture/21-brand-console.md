# 21. Brand Console minimale — Chantier 18

## Périmètre livré

La première console marque est livrée comme une application statique sous :

```text
/brand-console/
```

Elle consomme les APIs Vercel/Clerk existantes et couvre le premier parcours opérationnel :

- authentification Clerk côté navigateur ;
- sélection de l'organisation marque ;
- vue d'ensemble avec indicateurs produits, demandes, échéances et fournisseurs ;
- création d'un produit ;
- invitation d'un fournisseur ;
- liste des demandes de données ;
- création d'une demande à partir d'un questionnaire versionné ;
- initialisation des items depuis le template ;
- envoi de la demande ;
- détail d'une demande avec avancement, items et réponses courantes ;
- vérification d'une réponse ou demande de correction ;
- catalogue produit ;
- calcul et lecture du score qualité produit ;
- lecture des issues qualité.

Le code est volontairement sans framework frontend pour conserver un premier déploiement statique simple. Les styles, la navigation et l'état de l'interface sont embarqués dans `brand-console/index.html`.

## Authentification

La page récupère la clé publishable via :

```text
GET /api/config
```

Elle charge ensuite Clerk JS dans le navigateur, obtient un token de session et l'envoie en `Authorization: Bearer ...` vers les APIs. La clé secrète Clerk reste exclusivement côté serveur.

`?demo=1` permet d'inspecter l'interface sans backend ni clé Clerk. Ce mode ne doit jamais être utilisé comme mode de production.

## API consommées

```text
GET  /api/me
GET  /api/organizations
GET  /api/products
POST /api/products
GET  /api/data-requests
POST /api/data-requests
GET  /api/data-requests/:requestId
POST /api/data-requests/:requestId/items/from-template
POST /api/data-requests/:requestId/send
POST /api/data-responses/:responseId/review
GET  /api/questionnaires
GET  /api/quality/products/:productId
POST /api/quality/products/:productId
POST /api/organizations/:organizationId/invitations
```

Les règles d'autorisation restent côté API et SQL. L'interface ne constitue pas une frontière de sécurité.

## Limites connues

- le Supplier Portal n'est pas encore livré ;
- le Quality Center complet n'est pas encore livré ;
- la revue utilise actuellement un commentaire navigateur simple ;
- l'upload de preuves documentaires attend le chantier de stockage privé ;
- le chargement de Clerk JS s'appuie sur le CDN configuré pour le déploiement ;
- les tests actuels vérifient le contrat statique et la syntaxe, mais pas encore un parcours navigateur automatisé Playwright.

## Validation

```bash
npm run test:brand-console
```

Le test vérifie la syntaxe JavaScript embarquée, la présence des contrats API, les actions principales et l'absence d'appel navigateur à `localhost`.
