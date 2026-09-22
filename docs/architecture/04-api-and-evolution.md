# 4. API and evolution

## Initial integration boundary

The first application can use Supabase directly for low-risk reads and authenticated mutations. Sensitive operations should go through Edge Functions or trusted database functions:

- `tracefab_invite_supplier(...)` pour créer le fournisseur invité, la relation et le token hashé ;
- `tracefab_accept_organization_invitation(...)` pour accepter l'invitation ;
- `tracefab_submit_supplier_profile(...)` pour soumettre le profil ;
- `tracefab_create_product(...)` pour créer un produit ;
- `tracefab_update_product_data(...)` pour modifier ses données ;
- `tracefab_start_product_revision(...)` pour commencer une nouvelle version ;
- `tracefab_create_data_request(...)` et `tracefab_add_data_request_item(...)` pour préparer une collecte ;
- `tracefab_send_data_request(...)` pour l'envoyer ;
- `tracefab_submit_data_response(...)` et `tracefab_submit_data_request(...)` pour les réponses fournisseur ;
- `tracefab_review_data_response(...)` pour la revue marque ;
- créer une relation brand/supplier hors du parcours d'invitation ;
- generate signed document URLs;
- submit a request;
- compute a data-quality score;
- compute DPP readiness;
- publish a public projection.

## API conventions

When the HTTP API is introduced:

```text
/api/v1/organizations
/api/v1/supplier-invitations
/api/v1/suppliers
/api/v1/suppliers/{supplierId}/profile
/api/v1/suppliers/{supplierId}/sites
/api/v1/products
/api/v1/products/{productId}/data
/api/v1/products/{productId}/materials
/api/v1/products/{productId}/identifiers
/api/v1/data-requests
/api/v1/data-requests/{requestId}/items
/api/v1/data-requests/{requestId}/responses
/api/v1/documents
/api/v1/dpp-records
```

Requirements:

- versioned URLs;
- idempotency keys for imports and invitations;
- organization scope derived from the authenticated token, never accepted blindly from the browser;
- pagination and cursors for large collections;
- structured error codes;
- audit event for sensitive mutations;
- OpenAPI contract before building ERP/PLM connectors.

## Import strategy

CSV/Excel import is the first integration. Every import should produce:

- import job id;
- source filename and hash;
- row-level validation errors;
- accepted/rejected counts;
- idempotency behavior;
- audit event.

## Future compatibility

The canonical domain uses stable identifiers, versions and JSON values for evolving attributes. JSON is used at the edges; key operational fields remain typed columns with indexes and constraints.

No blockchain, graph database or enterprise connector is required for the first release.
