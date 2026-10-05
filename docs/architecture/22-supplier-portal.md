# 22. Supplier Portal approfondi — Chantier 19

## Périmètre livré

Le premier portail fournisseur est une application statique sous :

```text
/supplier-portal/
```

Il couvre un parcours fournisseur authentifié et multi-tenant :

- connexion Clerk et chargement de l'organisation fournisseur courante ;
- tableau de bord avec complétude du profil, demandes ouvertes, échéances proches et réponses soumises ;
- profil fournisseur : lecture, édition des champs autorisés et soumission ;
- sites de production : création, édition, activation/désactivation et activités déclarées ;
- matériaux fournisseur : création, édition, origine et composition JSON déclarée ;
- certificats : déclaration, édition, rattachement à un site et dates de validité ;
- qualité fournisseur : score explicable, champs manquants, issues et recalcul ;
- liste des demandes de données visibles par le fournisseur, à l'exclusion des brouillons marque ;
- détail versionné d'une demande et réponses item par item ;
- contrôles adaptés aux types `text`, `number`, `percentage`, `country`, `date`, `boolean` et `json` ;
- sauvegarde d'une réponse via l'API de réponse versionnée ;
- soumission de la demande à la marque ;
- affichage explicite des statuts déclarés et de la limite entre déclaration et vérification ;
- états loading, erreur de configuration, vide, succès et notifications d'action ;
- mode `?demo=1` pour parcourir le portail sans secret ni backend.

La surface reste volontairement distincte de la Brand Console. Le fournisseur ne peut pas modifier une définition de demande, un statut de revue, une organisation marque ou une donnée produit de marque depuis le navigateur.

## API du portail

Le portail consomme les contrats existants de collecte et deux façades limitées à l'organisation fournisseur courante :

```text
GET    /api/config
GET    /api/me
GET    /api/supplier/profile
PATCH  /api/supplier/profile
POST   /api/supplier/profile/submit
GET    /api/supplier/sites
POST   /api/supplier/sites
PATCH  /api/supplier/sites/:siteId
GET    /api/supplier/certifications
POST   /api/supplier/certifications
PATCH  /api/supplier/certifications/:certificationId
GET    /api/supplier/quality
POST   /api/supplier/quality
GET    /api/materials?organizationId=:organizationId
POST   /api/materials
PATCH  /api/materials/:materialId
GET    /api/data-requests?scope=supplier
GET    /api/data-requests/:requestId?scope=supplier
POST   /api/data-request-items/:itemId/response
POST   /api/data-requests/:requestId/submit
```

`/api/supplier/profile` résout le fournisseur à partir du membership Clerk actif de type `supplier`. Les variantes `/api/suppliers/:supplierId/profile` restent disponibles pour les parcours administrés ou marque, mais le portail n'accepte jamais un identifiant fournisseur fourni par l'utilisateur pour choisir son tenant.

Les mutations de profil et de soumission passent par `tracefab_update_supplier_profile(...)` et `tracefab_submit_supplier_profile(...)`. Les réponses passent par `tracefab_submit_data_response(...)`; la soumission passe par `tracefab_submit_data_request(...)`. Le paramètre `scope=supplier` active une lecture strictement bornée aux organisations fournisseur actives et exclut les brouillons, y compris lorsqu'un utilisateur possède plusieurs memberships. L'autorisation métier reste côté API, contexte Neon et RLS.

## Réponses et preuves

Chaque enregistrement d'une réponse crée une nouvelle version et conserve l'historique. Le portail affiche le statut `declared` sans le transformer en vérification ou certification. Les items signalant `evidenceRequired` peuvent associer une preuve déjà disponible ; le document doit avoir passé le contrôle serveur et antivirus avant d'être sélectionnable.

Pour les réponses JSON de composition, le portail applique uniquement le contrat de forme côté serveur ; il ne crée pas directement de matériaux ni de produit. Les champs `document` restent contrôlés par l'API et ne deviennent disponibles qu'après le cycle de stockage privé.

## Tests et validation

Contrat statique et syntaxe :

```bash
npm run test:supplier-portal
```

Parcours navigateur Playwright en mode démonstration :

```bash
npx playwright install chromium
npm run test:supplier-portal:browser
```

Le scénario navigateur couvre le chargement, la modification du profil, la réponse à plusieurs types d'items et la soumission d'une demande.

Validations repository :

```bash
npm run api:typecheck
npm run typecheck
npm run schema:static
git diff --check
```

## Limites explicites

- les data points structurés, les membres et le contexte multi-organisation sont livrés au Chantier 23 ;
- révocation d'invitations en attente et synchronisation d'annuaire Clerk restent hors de cette surface ;
- bucket et scanner antivirus réels à configurer sur staging/production ;
- suppression objet interactive, rétention et nettoyage Storage restent à industrialiser ;
- la gestion avancée des utilisateurs et la navigation multi-organisation fournisseur restent à construire ;
- le rattachement avancé des matériaux aux produits et aux graphes de traçabilité reste hors de cette surface ;
- les validations staging et production doivent être réalisées avec des secrets Clerk/Neon renouvelés et des données représentatives non sensibles ;
- les vulnérabilités de dépendances existantes restent à traiter séparément sans upgrade cassant automatique.
