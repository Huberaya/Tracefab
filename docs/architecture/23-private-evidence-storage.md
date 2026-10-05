# 23. Stockage privé des preuves — Chantier 20

## Périmètre livré

Le repository ajoute un adaptateur serveur S3-compatible pour les preuves privées. Neon conserve uniquement la métadonnée et le cycle de vie du document ; l'objet est stocké dans un bucket privé externe.

Le cycle livré est :

```text
POST /api/supplier/documents/upload-intent
  → tracefab_register_document(...)
  → URL PUT présignée courte
  → upload direct navigateur vers l'objet privé
  → POST /api/supplier/documents/:documentId/scan
  → HEAD + taille + type + téléchargement serveur
  → hash SHA-256 serveur
  → scanner antivirus
  → tracefab_finalize_document_upload(...)
  → available ou rejected
```

Les endpoints fournisseur livrés sont :

```text
GET  /api/supplier/documents
POST /api/supplier/documents/upload-intent
POST /api/supplier/documents/:documentId/scan
GET  /api/supplier/documents/:documentId/download
GET  /api/documents/:documentId/download
```

Le téléchargement retourne une URL présignée temporaire uniquement après un contrôle d'accès et lorsque le document est `available`. Les documents `uploaded`, `scanning`, `rejected` et `deleted` ne sont pas téléchargeables.

## Contrôles de sécurité

- bucket fixe `tracefab-private` et visibilité privée côté fonction SQL ;
- chemin généré serveur : `<organizationId>/<uuid>/<filename-sanitized>` ;
- aucun chemin fourni par le navigateur n'est utilisé ;
- limite de taille à 50 MiB ;
- liste MIME initiale limitée à PDF, PNG, JPEG et texte brut ;
- le hash est calculé côté serveur après lecture de l'objet ;
- la taille et le type annoncés sont comparés à l'objet ;
- le navigateur ne peut pas déclarer `scanPassed`, `available` ou `sha256` ;
- les champs gérés par SQL restent protégés par le trigger de document ;
- les URLs PUT/GET expirent après une fenêtre courte et ne sont jamais persistées ;
- l'accès marque éventuel passe par `/api/documents/:documentId/download` et les policies Neon/RLS ;
- un scanner absent ou une réponse antivirus invalide bloque la disponibilité du document.

Le scanner antivirus est volontairement un contrat explicite et non un faux contrôle local. `PRIVATE_STORAGE_ANTIVIRUS_URL` reçoit les octets bruts avec `X-Tracefab-Scan-Protocol: tracefab-v1` et doit répondre par `{ "clean": true|false, "mimeType": "..." }`. Sans ce service, l'objet reste enregistré mais ne peut pas devenir `available`.

## Intégrations Supplier Portal

Le portail affiche les documents privés, permet leur téléversement et propose un téléchargement temporaire. Les documents disponibles peuvent être associés :

- à un certificat fournisseur ;
- à une réponse de collecte qui demande une preuve.

La présence d'un document fait passer une donnée à l'état documenté selon la fonction métier, mais ne constitue jamais une vérification ou une certification.

## Configuration requise

```text
PRIVATE_STORAGE_ENDPOINT
PRIVATE_STORAGE_BUCKET=tracefab-private
PRIVATE_STORAGE_REGION
PRIVATE_STORAGE_ACCESS_KEY_ID
PRIVATE_STORAGE_SECRET_ACCESS_KEY
PRIVATE_STORAGE_PRESIGN_SECONDS
PRIVATE_STORAGE_ANTIVIRUS_URL
```

Le fournisseur S3-compatible doit désactiver l'accès public au bucket, limiter les permissions de la clé au bucket Tracefab et configurer CORS uniquement pour les origines d'application autorisées avec `PUT` et les headers nécessaires. Les secrets doivent être renouvelés avant staging/production.

## Validation

```bash
npm run build
npm run test:private-storage
npm run test:supplier-portal
npm run test:supplier-portal:browser
npm run api:typecheck
npm run typecheck
npm run schema:static
git diff --check
```

Le test navigateur utilise uniquement le mode démo. Une validation réelle nécessite un bucket privé S3-compatible et un scanner antivirus de staging ; aucune URL d'objet réelle ne doit être ajoutée aux fixtures ou aux logs.

## Limites restantes

- pas de suppression objet interactive dans le portail ; la suppression reste un workflow de confiance à planifier ;
- pas de job asynchrone de reprise pour les documents bloqués en `uploaded` ;
- pas de quarantaines ou d'OCR ;
- le scanner est un contrat HTTP à connecter à une implémentation opérationnelle ;
- rotation, rétention et nettoyage des objets supprimés restent à industrialiser ;
- les permissions IAM/CORS du fournisseur doivent être validées sur staging puis production.
