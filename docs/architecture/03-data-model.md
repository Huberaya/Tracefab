# 3. Data model

## Aggregate roots

- `organizations`: tenant and legal identity.
- `suppliers`: supplier-specific profile attached one-to-one to an organization.
- `tracefab_products`: brand-owned product reference.
- `data_requests`: a brand's request for a supplier dataset.
- `documents`: private evidence owned by an organization.
- `dpp_records`: versioned readiness calculation for a product.

## Relationship map

```text
organizations ──< organization_memberships >── auth.users
      │
      ├──< suppliers ──< supplier_sites
      ├──< tracefab_products ──< product_materials >── materials
      ├──< documents
      ├──< data_requests ──< data_request_items ──< data_responses
      ├──< data_points
      └──< audit_logs

organizations (brand) ──< brand_supplier_relationships >── organizations (supplier)
brand_supplier_relationships ──< data_shares
tracefab_products ──< dpp_records
supply_chain_nodes ──< supply_chain_links >── supply_chain_nodes
```

## Data provenance

A `data_point` records:

- its subject: supplier, site, product or material;
- a stable `data_key`;
- a JSON value and declared type;
- its evidence document, when available;
- who declared it;
- its validity period;
- its version;
- its quality status.

The status is deliberately not boolean. A certificate PDF can be present while the value remains `documented` or `needs_review`.

## Request model

`data_requests` and `data_request_items` are the first version of a configurable collection engine. Questionnaire templates are kept in the application layer for now; a future migration can promote them to database configuration after the MVP questions are validated with pilot suppliers.

## Graph model

`supply_chain_nodes` and `supply_chain_links` support a product-oriented graph without forcing the first version to implement a full graph database. PostgreSQL adjacency tables are sufficient for the initial scale and preserve transactionality with products, materials and evidence.

## DPP model

`dpp_records` stores the result of a computation, not the only source of truth. The product and data-point tables remain authoritative. A new regulatory profile creates a new computation version rather than a destructive schema change.

## Deliberate exclusions from this migration

- OCR extraction tables;
- API keys and webhooks;
- billing/subscriptions;
- consumer accounts;
- QR/data-carrier generation;
- carbon calculation methodology;
- external certification registry connectors.

Those belong to later validated workstreams.
