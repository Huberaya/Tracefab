# Chantier P1 — Import / export catalogue et onboarding

## Objectif

Permettre à une organisation marque de charger et de récupérer son catalogue produit, d’inviter des fournisseurs en masse et d’exporter un dossier exploitable d’audit, sans contourner les autorisations existantes ni transformer les états de préparation en certification.

Le format d’échange retenu est le CSV UTF-8 compatible Excel et LibreOffice. Le support des fichiers Excel binaires `.xlsx` est hors de ce lot : un classeur peut être enregistré en CSV depuis Excel/LibreOffice avant import.

## Contrats API

```text
POST /api/catalog/products/import
GET  /api/catalog/products/export?organizationId=:organizationId
GET  /api/catalog/products/import-jobs/:jobId
POST /api/catalog/suppliers/import
GET  /api/catalog/audit-export?organizationId=:organizationId
```

Les deux imports partagent la table `tracefab_catalog_import_jobs`. Le champ `import_kind` vaut `products` ou `suppliers` et permet de distinguer les traitements dans l’historique.

## Import produits

Le corps JSON contient `brandOrganizationId`, `filename`, `idempotencyKey`, `dryRun` et `csvContent`. Les colonnes `reference` et `name` sont obligatoires. Les colonnes optionnelles comprennent `category`, `sku`, `description`, `productFamily`, `colorName`, `sizeRange`, `countryOfDesign`, `countryOfManufacture`, `weightGrams` et `careInstructions` en JSON.

Le mode `dryRun` ne crée aucune donnée et retourne le nombre total de lignes, les lignes acceptables et rejetées, ainsi que les erreurs par ligne/champ et les avertissements non bloquants.

L’import confirmé :

- limite le fichier à 5 MiB et 10 000 lignes ;
- refuse les références déjà présentes dans le catalogue de l’organisation ;
- crée uniquement les lignes valides ;
- conserve un job identifiable avec nom de fichier, SHA-256, compteurs, erreurs JSON et clé d’idempotence ;
- ne conserve jamais le CSV brut ;
- écrit `catalog_import_completed` dans `audit_logs`.

## Import groupé de fournisseurs

`POST /api/catalog/suppliers/import` accepte un CSV de 500 lignes maximum. Les colonnes obligatoires sont `email` et `legalName`; `displayName` et `countryCode` sont optionnelles. Les emails sont normalisés, validés et dédoublonnés dans le fichier. Une invitation active existante est rejetée explicitement sans créer de seconde invitation.

Le mode `dryRun` retourne l’aperçu sans créer d’organisation, de relation ni d’invitation. L’import confirmé :

- crée chaque fournisseur valide via la fonction SQL métier `tracefab_invite_supplier` ;
- ne transmet à SQL que le hash SHA-256 du token, jamais le token brut ;
- stocke le token uniquement en mémoire le temps de l’envoi ;
- utilise l’adaptateur email existant et retourne des compteurs `sent`, `pending` ou `failed` ;
- n’envoie aucun email réel lorsque le fournisseur email n’est pas configuré ; dans ce cas, le fallback manuel reste soumis à la règle d’environnement existante ;
- journalise le job avec `import_kind = suppliers` et l’action `supplier_bulk_import_completed`.

Une invitation créée mais non distribuée peut être traitée par le parcours manuel existant ; les tokens ne sont jamais affichés dans l’interface d’import ni dans les logs.

## Export catalogue et dossier audit

L’export produit est un CSV UTF-8 réimportable contenant les champs produits, les états calculés et la composition de la version courante sous `compositionJson`.

`GET /api/catalog/audit-export` est réservé aux memberships marque actives `owner`, `admin`, `manager` ou `auditor`. Il produit un CSV sans cache avec des lignes `PRODUCT`, `DATA_POINT` et `AUDIT_EVENT`, incluant les références produit, valeurs déclarées, statuts de données, identifiants de source, actions d’audit et horodatages. Il n’expose pas d’URL publique et reste tenant-scoped.

Ces exports sont des extractions opérationnelles et historiques. Ils ne transforment pas une valeur `declared`, un état `DATA READY` ou `DPP READY` en preuve, vérification ou certification.

## Interface Brand Console

La page Produits expose :

- `Importer CSV` avec prévisualisation avant écriture ;
- erreurs par ligne et compteurs d’acceptation/rejet ;
- `Exporter CSV` pour le catalogue réimportable ;
- `Exporter audit` pour les fiches produit, data points et événements d’audit accessibles ;
- un parcours `Importer CSV` dans Fournisseurs avec prévisualisation, création des invitations valides et état de distribution ;
- un mode démonstration explicitement signalé, sans preuve de validation réelle.

## Sécurité et limites

- les routes dérivent l’identité de Clerk et contrôlent le tenant via memberships, `activeBrandOrganizationIds`, fonctions SQL et RLS Neon ;
- aucun fichier source n’est conservé dans le stockage applicatif ;
- le hash source sert à la traçabilité et à la détection d’une même opération ;
- la contrainte d’unicité `(organization_id, idempotency_key)` empêche les doubles imports lors d’un retry ;
- une autre organisation ne peut ni prévisualiser, ni importer, ni consulter le job ;
- l’import catalogue ne crée pas de certifications, de preuves ou de données `verified` ;
- le support `.xlsx` binaire reste volontairement hors de ce lot afin de garder un parseur serveur auditable.

## Validation

```bash
npm run test:p1-catalog
npm run test:brand-console
npm run test:p1:browser
npm run test:p1:staging
npm run typecheck
npm run api:typecheck
npm run schema:static
git diff --check
```
