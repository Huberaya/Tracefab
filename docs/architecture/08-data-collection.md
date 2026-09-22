# 8. Data Collection — Chantier 4

## Objectif

Permettre à une marque de demander un jeu de données à un fournisseur, au fournisseur de répondre avec des versions et des preuves, puis à la marque de revoir chaque réponse.

```text
Brand crée une demande brouillon
  → ajoute les items du questionnaire
  → envoie la demande
  → Supplier répond item par item
  → Supplier soumet la demande
  → Brand accepte ou demande des changements
```

Les templates de questionnaires restent versionnés dans l'application pour ce chantier. Les instances envoyées sont persistées dans `data_requests` et `data_request_items`.

## Modèle livré

La migration `20260922030000_tracefab_data_collection.sql` ajoute :

- relation explicite entre demande et `brand_supplier_relationships` ;
- clé d'idempotence de création ;
- progression des items requis ;
- aide, règles de validation et types de preuves par item ;
- révisions de réponses avec une seule réponse courante par item ;
- commentaire et état de revue.

Les valeurs restent dans `data_responses.value` avec un `data_type` typé. Une réponse peut être `declared` ou `documented` avant toute revue.

## Fonctions sécurisées

### Côté marque

- `tracefab_create_data_request(...)` crée une demande brouillon uniquement pour une relation active ;
- `tracefab_add_data_request_item(...)` ajoute des items tant que la demande est brouillon ;
- `tracefab_send_data_request(...)` verrouille la définition et notifie fonctionnellement le fournisseur ;
- `tracefab_review_data_response(...)` accepte une réponse comme `verified_by_reviewer` ou la marque `needs_review`.

### Côté fournisseur

- `tracefab_submit_data_response(...)` crée une nouvelle révision et désactive la précédente ;
- `tracefab_submit_data_request(...)` vérifie les items obligatoires puis passe la demande à `submitted`.

Les fonctions workflow sont `SECURITY DEFINER`, retirées de `PUBLIC` et exposées uniquement à `authenticated`. Les mutations de statut, progression et revue ne sont pas accessibles par une écriture directe RLS.

## Statuts

### Demande

`draft` → `sent` → `in_progress` → `submitted` → `approved`

Une revue négative passe par `changes_requested`. Une demande peut aussi être `cancelled` via un futur flux d'administration.

### Réponse

Une réponse commence en `declared` ou `documented`. La marque peut ensuite la passer en `verified_by_reviewer` ou `needs_review`. `certified_by_third_party` reste réservé à un futur flux de certification externe.

## Révisions et provenance

Chaque nouvelle réponse :

- incrémente `response_version` ;
- pointe vers `supersedes_id` ;
- marque l'ancienne réponse `is_current = false` ;
- conserve l'historique.

Une seule réponse courante est autorisée par item via un index unique partiel. Un document source doit appartenir à l'organisation fournisseur qui répond.

## RLS

- Une marque voit ses brouillons et les demandes de ses relations.
- Un fournisseur ne voit une demande qu'après son envoi.
- Une marque construit et modifie les items uniquement au stade brouillon.
- Un fournisseur ne peut ni modifier la définition d'une question, ni écrire directement une réponse révisée par SQL client.
- La relation, les organisations participantes et le produit associé sont validés par trigger.
- Une demande ne peut viser qu'un produit de la marque émettrice.

## Progression

`completion_percentage` est calculée à partir des items obligatoires ayant une réponse courante. Elle mesure l'avancement de collecte, pas la qualité, la vérification ou la certification des données.

## Reste à faire

- Edge Function de notification email et relances ;
- templates de questionnaires configurables en base ;
- validations JSON Schema côté serveur ;
- interface Supplier Portal de réponse ;
- interface Brand Console de revue ;
- règles de SLA et relance ;
- tests RLS exécutés sur un projet Supabase réel.
