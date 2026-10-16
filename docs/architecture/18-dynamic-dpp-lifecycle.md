# Passeport dynamique — registre de cycle de vie et publication

## Portée livrée

Cette évolution ajoute un **registre applicatif append-only** au DPP existant. Elle ne revendique ni immutabilité cryptographique, ni conformité réglementaire automatique, ni véracité intrinsèque des déclarations.

### Source de vérité

- Les données métier restent dans `tracefab_products`, `product_materials`, `data_points`, le graphe de supply chain et les documents.
- `dpp_records` est une projection versionnée de readiness et porte l'état de publication.
- `dpp_lifecycle_events` conserve les faits déclarés, corrections et transitions significatives.
- `/api/dpp/:identifiant` calcule la vue publique à partir des données autorisées et ajoute uniquement la projection publique de l'historique.

## États et transitions

1. `tracefab_compute_dpp_readiness` calcule `data_ready` ou un état incomplet.
2. `POST /api/products/:id/dpp/publish-review` effectue la revue : `data_ready → ready_to_publish`.
3. `POST /api/products/:id/dpp/publication` avec `{ "action": "publish", "publicSlug": "..." }` effectue atomiquement `ready_to_publish → published`, pose le slug et journalise l'événement.
4. `suspend` ou `withdraw` retire atomiquement le slug, ramène le record à `ready_to_publish` et conserve l'historique.

Un identifiant public ne doit pas être changé lors d'une actualisation ordinaire. Un retrait rend la résolution publique impossible sans effacer les données privées.

## API événements privée

`GET /api/products/:id/dpp/events` retourne au plus 200 événements accessibles au tenant.

`POST /api/products/:id/dpp/events` accepte notamment :

```json
{
  "eventType": "data_corrected",
  "summary": "Composition corrigée après revue documentaire",
  "businessOccurredAt": "2026-10-16T10:00:00Z",
  "sourceKind": "document",
  "validationStatus": "documented",
  "publicSummary": "Composition mise à jour",
  "evidenceDocumentIds": ["uuid"],
  "correctsEventId": "uuid",
  "idempotencyKey": "erp-event-124"
}
```

Les types, statuts, tailles, dates et UUID sont validés. La base vérifie le tenant des preuves, le rôle, la cible corrigée et l'idempotence. Une correction est un nouvel événement : `UPDATE` et `DELETE` sont refusés par trigger.

## Confiance

Statuts explicites : `declared`, `documented`, `controlled`, `corroborated`, `third_party_verified`, `rejected`.

- contributeur : déclaration/documentation ;
- owner/admin/manager/auditor : statuts de contrôle ;
- owner/admin/manager : transitions de publication.

Ces statuts décrivent le processus enregistré. `documented` ne signifie pas « certifié ». Un hash de document protège l'intégrité relative, pas l'authenticité ou la véracité.

## Confidentialité

- RLS activée et forcée sur les événements ;
- accès privé conditionné au tenant ;
- historique anonyme seulement si le produit est publié, `public_summary` est renseigné et l'événement n'est pas rejeté ;
- projection publique en liste blanche : `id`, type, dates, statut et résumé public ;
- acteurs, détails, documents, métadonnées et organisation ne sont jamais sélectionnés par la route publique ;
- droits directs d'écriture révoqués ; fonctions contrôlées uniquement.

Le cache public est limité à 60 secondes avec 300 secondes de revalidation. Le retrait supprime immédiatement le slug en base ; un cache intermédiaire déjà rempli peut rester visible jusqu'à son expiration. Une invalidation CDN explicite reste un chantier d'exploitation.

## Déploiement

1. Sauvegarde et environnement jetable.
2. Appliquer `20261016130000_dynamic_dpp_lifecycle` avec le propriétaire de migration approuvé.
3. Vérifier fonctions, politiques, privilèges et triggers avec le rôle runtime sans `BYPASSRLS`.
4. Déployer l'API après la migration.
5. Exécuter les scénarios tenant/publication/correction/retrait.

Aucune migration de production n'a été exécutée pendant ce chantier.
