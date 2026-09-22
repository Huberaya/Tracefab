# 4. API and evolution

## Initial integration boundary

The first application can use Supabase directly for low-risk reads and authenticated mutations. Sensitive operations should go through Edge Functions or trusted database functions:

- `tracefab_invite_supplier(...)` pour créer le fournisseur invité, la relation et le token hashé ;
- `tracefab_accept_organization_invitation(...)` pour accepter l'invitation ;
- `tracefab_submit_supplier_profile(...)` pour soumettre le profil ;
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
/api/v1/data-requests
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
