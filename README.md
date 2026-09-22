# Tracefab

Infrastructure de données fournisseurs pour la traçabilité textile, la qualité des données et la préparation au Digital Product Passport.

## Statut

**Chantier 5 — Documents / Certifications**

Le repository contient les fondations d'architecture, l'onboarding fournisseur, le parcours produit, la collecte de données et la chaîne privée de documents, certifications et vérifications. Les interfaces Brand Console et Supplier Portal restent à construire.

## Principes

- Le produit central est la donnée fournisseur structurée, pas le QR code.
- Le système est multi-tenant dès la première migration.
- Une donnée déclarée n'est pas automatiquement vérifiée.
- Les documents sont privés par défaut.
- Les données peuvent être partagées par périmètre entre un fournisseur et ses marques clientes.
- Le domaine TRACEFAB reste séparé du domaine marketplace Ethimarket.
- Le modèle DPP est versionné et adaptable aux exigences réglementaires futures.

## Structure

```text
docs/architecture/
  01-system-context.md
  02-multi-tenancy-and-security.md
  03-data-model.md
  04-api-and-evolution.md
  05-rls-test-plan.md
  06-supplier-profile.md
  07-product-data.md
  08-data-collection.md
  09-documents-and-certifications.md

scripts/
  validate_schema.py

src/domain/tracefab/
  types.ts
  index.ts

supabase/migrations/
  20260922000000_tracefab_core.sql
  20260922010000_tracefab_supplier_profile.sql
  20260922020000_tracefab_product_data.sql
  20260922030000_tracefab_data_collection.sql
  20260922040000_tracefab_documents_certifications.sql
```

## Appliquer la migration

La migration est prévue pour un projet Supabase vierge ou dédié à Tracefab :

```bash
supabase db reset
# ou, sur un projet distant après revue :
supabase db push
```

Avant toute application en production :

1. configurer un projet Supabase dédié ;
2. sauvegarder la base ;
3. inspecter le SQL ;
4. exécuter les tests RLS d'intégration ;
5. configurer Storage privé dans un chantier dédié.

La création initiale d'une organisation et de son membership owner passe par `tracefab_create_organization(...)`. Pour le parcours fournisseur, `tracefab_invite_supplier(...)`, `tracefab_accept_organization_invitation(...)` et `tracefab_submit_supplier_profile(...)` sont les fonctions de transition sécurisées. Pour les produits, `tracefab_create_product(...)`, `tracefab_update_product_data(...)` et `tracefab_start_product_revision(...)` centralisent les mutations sensibles. Pour la collecte, `tracefab_create_data_request(...)`, `tracefab_send_data_request(...)`, `tracefab_submit_data_response(...)`, `tracefab_submit_data_request(...)` et `tracefab_review_data_response(...)` pilotent le workflow. Pour les documents et certifications, `tracefab_register_document(...)`, `tracefab_finalize_document_upload(...)`, `tracefab_register_certification(...)` et `tracefab_review_certification(...)` encadrent les transitions. La génération du token brut, l'envoi email, les notifications, le scan antivirus et les imports catalogue restent à implémenter dans des fonctions ou services de confiance.

## Ce qui n'est pas encore implémenté

- invitations et emails transactionnels ;
- interface Brand Console ;
- Supplier Portal ;
- moteur de questionnaires ;
- OCR/Document Intelligence ;
- score de qualité calculé ;
- rendu public DPP ;
- API publique et connecteurs ERP/PLM/PIM.

Voir `docs/architecture/` pour les décisions prises au cours du chantier 1.
