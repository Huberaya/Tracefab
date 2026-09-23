# 16. Data Collection API — Chantier 13

## Périmètre

Le Chantier 13 expose le workflow de collecte déjà présent dans Neon :

```text
Brand crée une demande brouillon
  → ajoute les items
  → envoie la demande
  → Supplier répond
  → Supplier soumet
  → Brand vérifie ou demande des changements
```

Les statuts de collecte restent distincts de la qualité, de la vérification et de la certification des données.

## Routes

```text
GET  /api/data-requests
POST /api/data-requests
GET  /api/data-requests/:requestId

GET  /api/data-requests/:requestId/items
POST /api/data-requests/:requestId/items
POST /api/data-requests/:requestId/send
POST /api/data-requests/:requestId/submit

POST /api/data-request-items/:itemId/response
POST /api/data-responses/:responseId/review
```

Les mutations délèguent aux fonctions SQL de workflow :

- `tracefab_create_data_request(...)` ;
- `tracefab_add_data_request_item(...)` ;
- `tracefab_send_data_request(...)` ;
- `tracefab_submit_data_response(...)` ;
- `tracefab_submit_data_request(...)` ;
- `tracefab_review_data_response(...)`.

## Accès et rôles

- une marque voit ses demandes, y compris ses brouillons ;
- un fournisseur ne voit une demande qu'après son envoi ;
- les items sont modifiables par la marque uniquement au stade `draft` ;
- les réponses sont créées par les rôles fournisseur `owner`, `admin`, `manager` ou `contributor` ;
- la revue exige côté marque `owner`, `admin`, `manager` ou `auditor` ;
- les transitions de statut et les réponses ne sont pas réalisées par des écritures Prisma directes.

Les lectures appliquent en plus un filtrage explicite par memberships actifs, car le rôle propriétaire de la connexion Neon ne doit pas être considéré comme une frontière RLS suffisante.

## Validation

L'API vérifie notamment :

- UUID des organisations, demandes, items, réponses et documents source ;
- types `text`, `number`, `boolean`, `date`, `country`, `percentage`, `json` et `document` ;
- règles et valeurs JSON ;
- items obligatoires et types de preuves ;
- date d'échéance et clé d'idempotence.

La soumission fournisseur exige que tous les items obligatoires disposent d'une réponse courante. Une réponse `declared` ou `documented` n'est pas une preuve vérifiée.

## Corrections de workflow

Les migrations `20260923170000` et `20260923180000` maintiennent visible le contexte de mutation aux triggers `SECURITY DEFINER` et réarment le garde après le trigger de progression d'un item. Elles empêchent qu'une mise à jour directe des statuts contourne le workflow tout en permettant aux fonctions officielles de progresser.

## Tests

```bash
npm run test:neon:collection
```

Le test vérifie la création de demande, l'ajout d'un item, l'envoi, la réponse fournisseur, la soumission, la revue de marque et le refus d'une revue par un viewer.
