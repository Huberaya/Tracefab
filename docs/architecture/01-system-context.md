# 1. System context

## Decision

Tracefab is an infrastructure layer for collecting, structuring, documenting and sharing textile supply-chain data. It is not a QR-code product and it does not replace a brand's ERP, PLM or PIM.

## Actors

- **Brand**: owns products and requests information.
- **Supplier**: owns its organization profile and decides what can be shared.
- **Verifier / auditor**: reviews evidence within an explicitly authorized scope.
- **Platform operator**: operates Tracefab, without automatically receiving every customer document.
- **Public consumer**: only accesses a future public projection of selected DPP data.

## Context diagram

```text
                 ┌──────────────────────────┐
                 │       Brand systems       │
                 │ ERP / PLM / PIM / Buying  │
                 └────────────┬─────────────┘
                              │ API / import
                              ▼
┌──────────────┐      ┌──────────────────────────┐      ┌──────────────┐
│ Brand Console│◄────►│        Tracefab          │◄────►│Supplier Portal│
└──────────────┘      │ collection / evidence    │      └──────────────┘
                      │ quality / traceability   │
                      │ DPP readiness            │
                      └───────────┬─────────────┘
                                  │ controlled projection
                                  ▼
                         ┌─────────────────┐
                         │ Public DPP view │
                         └─────────────────┘
```

## Domain boundary

Tracefab uses a new domain model instead of extending the historical Ethimarket marketplace tables. This protects the existing marketplace and prevents agricultural/commerce fields from becoming the canonical textile data model.

The first migration therefore creates only Tracefab-owned tables in the Tracefab repository. There is no destructive alteration of Ethimarket tables.

## Core invariants

1. Every tenant-owned record is reachable from an organization.
2. Supplier data is reusable but never automatically visible to every brand.
3. A declared value, a documented value and a verified value are different states.
4. Every DPP readiness result is computed against a versioned requirement profile.
5. A public DPP projection is not a direct read of private supplier tables.
6. Historical changes must remain explainable through versions and audit logs.
